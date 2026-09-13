/**
 * The node's firewall, driven by its agent (ufw or firewalld). A node allows it with its "Manage
 * firewall" switch; then an instance's owners may open its ports there, and the agent keeps the
 * node's SFTP port open. Opened ports follow the instance's port changes and go when it is
 * deleted. The agent only ever removes rules it added itself.
 */
import type { FirewallRule } from "@gsm/shared";
import { Instance } from "../../db/models.ts";
import { conflict, forbidden } from "../../lib/errors.ts";
import { events } from "../../lib/events.ts";
import { log } from "../../lib/logger.ts";
import { agentGateway } from "../../ws/agent-gateway.ts";
import { uiGateway } from "../../ws/ui-gateway.ts";
import * as instances from "../instances/service.ts";
import { configureAgent } from "../nodes/service.ts";

const flog = log.child("firewall");

function portsOf(i: Instance) {
  return (i.ports ?? []).flatMap((p) =>
    (p.protocol === "both" ? (["tcp", "udp"] as const) : [p.protocol as "tcp" | "udp"]).map((
      protocol,
    ) => ({ port: p.port, protocol }))
  );
}

async function apply(i: Instance, open: boolean): Promise<FirewallRule[]> {
  const res = await agentGateway.request(i.nodeId, "fw.apply", {
    key: `instance:${i.uuid}`,
    ports: open ? portsOf(i) : [],
  }, { timeoutMs: 60_000 });
  // Only marked open when something is open now; a failed attempt is reported, not recorded.
  const opened = open && res.rules.some((r) => r.state !== "error");
  await Instance.update({
    firewall: opened ? { open: true, rules: res.rules, updatedAt: new Date().toISOString() } : null,
  }, { where: { id: i.id } });
  return res.rules;
}

/**
 * Open (or close) the instance's ports in its node's firewall. Opening also makes sure the node's
 * SFTP port is open. Closing works even when the node no longer allows firewall management.
 */
export async function setInstanceFirewall(id: number, open: boolean): Promise<FirewallRule[]> {
  const i = await instances.get(id);
  const node = i.node!;
  if (!agentGateway.isConnected(node.id)) throw conflict(`${node.name} is offline`);
  if (open && !node.firewallManaged) {
    throw forbidden(
      "Firewall management is off on this node; an admin or the node's owner can turn it on",
    );
  }
  const rules = await apply(i, open);
  if (open && node.sftpPort !== null) {
    await configureAgent(node.id).catch((err) =>
      flog.warn("SFTP firewall rule not refreshed", { nodeId: node.id, err: String(err) })
    );
  }
  uiGateway.broadcast("instance.updated", { instanceId: id });
  events.emit("instance.firewall", { instanceId: id });
  return rules;
}

// Opened ports follow the instance's ports.
events.on("instance.ports_changed", async ({ instanceId }) => {
  try {
    const i = await instances.get(instanceId);
    if (!i.firewall?.open || !agentGateway.isConnected(i.nodeId)) return;
    await apply(i, true);
    uiGateway.broadcast("instance.updated", { instanceId });
  } catch (err) {
    flog.warn("re-applying firewall rules failed", { instanceId, err: String(err) });
  }
});
