/**
 * Keeps instance rows in step with their nodes: reconciles after every agent hello (and starts
 * instances marked autoStart), and marks a node's instances unknown when it goes offline.
 */
import { Instance } from "../../db/models.ts";
import { events } from "../../lib/events.ts";
import { log } from "../../lib/logger.ts";
import { agentGateway } from "../../ws/agent-gateway.ts";
import { uiGateway } from "../../ws/ui-gateway.ts";
import { applyState } from "./agent-events.ts";
import * as instances from "./service.ts";

const slog = log.child("instances:supervisor");

async function reconcile(nodeId: number) {
  const rows = await Instance.findAll({ where: { nodeId } });
  if (!rows.length) return;
  const { instances: states } = await agentGateway.request(nodeId, "inst.list", {}, {
    timeoutMs: 60_000,
  });
  const byUuid = new Map(states.map((s) => [s.uuid, s]));
  for (const row of rows) {
    const state = byUuid.get(row.uuid);
    if (state) {
      await applyState(row, state);
    } else if (row.status !== "installing" && row.status !== "install_failed") {
      // The node knows nothing about it: no container yet (never started) or files gone.
      const status = row.installedAt
        ? "stopped"
        : row.status === "unknown"
        ? "stopped"
        : row.status;
      if (row.status !== status) {
        row.status = status;
        row.containerId = null;
        await row.save();
        uiGateway.broadcast("instance.status", { instanceId: row.id, status, error: row.error });
      }
    }
  }
  // Auto-start after the states are known, one at a time so a node is not flooded.
  for (const row of rows) {
    if (!row.autoStart || !row.installedAt) continue;
    const fresh = await Instance.findByPk(row.id);
    if (!fresh || (fresh.status !== "stopped" && fresh.status !== "crashed")) continue;
    try {
      await instances.power(row.id, "start", 0);
      slog.info("auto-started", { id: row.id, name: row.name });
    } catch (err) {
      slog.warn("auto-start failed", { id: row.id, err: String(err) });
    }
  }
}

async function markUnknown(nodeId: number) {
  const rows = await Instance.findAll({ where: { nodeId } });
  for (const row of rows) {
    if (row.status === "unknown" || row.status === "install_failed") continue;
    row.status = "unknown";
    await row.save();
    uiGateway.broadcast("instance.status", {
      instanceId: row.id,
      status: "unknown",
      error: row.error,
    });
  }
}

export function startInstanceSupervisor(): () => void {
  const offHello = events.on(
    "agent.hello",
    ({ nodeId }) =>
      reconcile(nodeId).catch((err) => slog.warn("reconcile failed", { nodeId, err: String(err) })),
  );
  const offOffline = events.on(
    "node.offline",
    ({ nodeId }) =>
      markUnknown(nodeId).catch((err) =>
        slog.warn("mark unknown failed", { nodeId, err: String(err) })
      ),
  );
  return () => {
    offHello();
    offOffline();
  };
}
