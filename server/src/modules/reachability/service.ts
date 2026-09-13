/**
 * Can players and SFTP clients reach an instance from outside? The panel server connects to the
 * node's public address the way a player would. A running server's TCP ports are simply connected
 * to; while the instance is stopped the agent listens on its ports (`net.probe`) and a one-time
 * token is sent to them, which also covers UDP. The SFTP port must answer with the agent's SSH
 * greeting. Checks run on demand, after an instance starts, finishes installing or changes ports,
 * and after a node's SFTP comes up.
 */
import type {
  InstanceReachability,
  PortReachability,
  ProbeState,
  SftpReachability,
} from "@gsm/shared";
import { PROBE_PREFIX, RPC_ERROR_CODES } from "@gsm/shared";
import { Instance, Node } from "../../db/models.ts";
import { tooManyRequests } from "../../lib/errors.ts";
import { events } from "../../lib/events.ts";
import { randomId } from "../../lib/ids.ts";
import { log } from "../../lib/logger.ts";
import { createRateLimiter } from "../../lib/rate-limit.ts";
import { agentGateway, AgentRpcError } from "../../ws/agent-gateway.ts";
import { uiGateway } from "../../ws/ui-gateway.ts";
import * as instances from "../instances/service.ts";
import { publicAddressOf } from "../nodes/service.ts";
import { type Outcome, tcpCheck, udpSend } from "./net.ts";

const rlog = log.child("reachability");
const PROBE_TIMEOUT_MS = 6_000;

/** Manual checks per instance or node and minute. */
const manual = createRateLimiter({ windowMs: 60_000, max: 6 });
const inflight = new Map<string, Promise<unknown>>();

/** At most one check per instance (or node) at a time; callers share the running one. */
function once<T>(key: string, run: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function assertManualAllowed(key: string) {
  const r = manual.check(key);
  if (!r.ok) throw tooManyRequests(`Checked a moment ago; try again in ${r.retryAfterSeconds} s`);
}

// ---------------------------------------------------------------------------
// Instance ports
// ---------------------------------------------------------------------------

type Target = Pick<PortReachability, "name" | "label" | "port" | "protocol">;
type Verdict = { status: PortReachability["status"]; detail: string | null };

const keyOf = (t: Target) => `${t.name}/${t.port}/${t.protocol}`;

function targetsOf(i: Instance): Target[] {
  return (i.ports ?? []).flatMap((p) =>
    (p.protocol === "both" ? (["tcp", "udp"] as const) : [p.protocol as "tcp" | "udp"]).map((
      protocol,
    ) => ({ name: p.name, label: p.label, port: p.port, protocol }))
  );
}

function verdict(
  t: Target,
  v: Verdict,
  method: PortReachability["method"],
  at: string,
): PortReachability {
  return {
    ...t,
    status: v.status,
    detail: v.status === "open" ? null : v.detail,
    method,
    checkedAt: at,
  };
}

/** Check an instance's ports now and store the result. */
export function checkInstance(id: number): Promise<InstanceReachability> {
  return once(`instance:${id}`, async () => {
    const i = await instances.get(id);
    const node = i.node!;
    const host = publicAddressOf(node);
    const at = new Date().toISOString();
    const targets = targetsOf(i);
    const previous = new Map((i.reachability?.ports ?? []).map((p) => [keyOf(p), p]));
    // What cannot be tested right now keeps its last result, if there is one.
    const keep = (t: Target, why: string) =>
      previous.get(keyOf(t)) ?? verdict(t, { status: "untested", detail: why }, null, at);

    let ports: PortReachability[];
    if (!agentGateway.isConnected(node.id)) {
      ports = targets.map((t) => keep(t, "The node is offline"));
    } else if (i.status === "running") {
      ports = await Promise.all(
        targets.map(async (t) =>
          t.protocol === "tcp"
            ? verdict(t, await tcpCheck(host, t.port), "connect", at)
            : keep(t, "UDP ports are tested while the server is stopped")
        ),
      );
    } else if (i.status === "starting" || i.status === "stopping" || i.status === "installing") {
      ports = targets.map((t) => keep(t, "Tested once the server is running or stopped"));
    } else {
      ports = await probe(node, host, targets, at, keep);
    }
    const reachability: InstanceReachability = { host, checkedAt: at, ports };
    await Instance.update({ reachability }, { where: { id } });
    uiGateway.broadcast("instance.updated", { instanceId: id });
    return reachability;
  });
}

/** The agent listens on the stopped instance's ports; we send the token from outside. */
async function probe(
  node: Node,
  host: string,
  targets: Target[],
  at: string,
  keep: (t: Target, why: string) => PortReachability,
): Promise<PortReachability[]> {
  if (!targets.length) return [];
  const token = randomId(18);
  const payload = PROBE_PREFIX + token;
  const sent = new Map<string, Outcome>();
  let sending: Promise<unknown> = Promise.resolve();
  let state: ProbeState;
  try {
    state = await agentGateway.request(node.id, "net.probe", {
      bindAddress: node.bindAddress,
      token,
      timeoutMs: PROBE_TIMEOUT_MS,
      listeners: targets.map((t) => ({ port: t.port, protocol: t.protocol })),
    }, {
      timeoutMs: PROBE_TIMEOUT_MS + 10_000,
      onStream: (ready) => {
        sending = Promise.all(
          ready.listeners.filter((l) => l.bound).map(async (l) => {
            if (l.protocol === "tcp") {
              sent.set(`${l.port}/tcp`, await tcpCheck(host, l.port, { payload: `${payload}\n` }));
            } else {
              await udpSend(host, l.port, payload).catch((err) =>
                sent.set(`${l.port}/udp`, { status: "error", detail: String(err) })
              );
            }
          }),
        );
      },
    });
    await sending;
  } catch (err) {
    if (err instanceof AgentRpcError && err.rpc.code === RPC_ERROR_CODES.unknownMethod) {
      return targets.map((t) => keep(t, "Update the agent on this node to test stopped servers"));
    }
    const detail = `The node could not test it: ${err instanceof Error ? err.message : err}`;
    return targets.map((t) => verdict(t, { status: "error", detail }, "probe", at));
  }
  return targets.map((t) => {
    const l = state.listeners.find((x) => x.port === t.port && x.protocol === t.protocol);
    if (!l) return verdict(t, { status: "error", detail: "The node did not test it" }, "probe", at);
    if (l.received) return verdict(t, { status: "open", detail: null }, "probe", at);
    if (!l.bound) {
      return verdict(
        t,
        {
          status: "error",
          detail: `Another program has this port on the node (${l.error ?? "in use"})`,
        },
        "probe",
        at,
      );
    }
    const s = sent.get(`${t.port}/${t.protocol}`);
    if (s && s.status !== "open") return verdict(t, s, "probe", at);
    return verdict(
      t,
      t.protocol === "tcp"
        ? {
          status: "error",
          detail: "Something answered, but not this node; is the port forwarded elsewhere?",
        }
        : { status: "timeout", detail: "No packet arrived; UDP may be blocked or not forwarded" },
      "probe",
      at,
    );
  });
}

// ---------------------------------------------------------------------------
// SFTP
// ---------------------------------------------------------------------------

/** Check the node's SFTP port from outside and store the result; null when SFTP is off. */
export function checkNodeSftp(nodeId: number): Promise<SftpReachability | null> {
  return once(`node:${nodeId}`, async () => {
    const node = await Node.findByPk(nodeId);
    if (!node || node.sftpPort === null) return null;
    const host = publicAddressOf(node);
    let v: Verdict;
    if (!agentGateway.isConnected(nodeId)) {
      v = { status: "untested", detail: "The node is offline" };
    } else {
      const r = await tcpCheck(host, node.sftpPort, { readLine: true });
      if (r.status !== "open") v = r;
      else if (r.line?.startsWith("SSH-2.0-GSM")) v = { status: "open", detail: null };
      else {
        v = {
          status: "error",
          detail: r.line?.startsWith("SSH-")
            ? `Another SSH server answers on this port (${r.line.slice(0, 80)})`
            : "Something other than the node's SFTP server answers on this port",
        };
      }
    }
    const sftpReachability: SftpReachability = {
      host,
      port: node.sftpPort,
      ...v,
      checkedAt: new Date().toISOString(),
    };
    await Node.update({ sftpReachability }, { where: { id: nodeId } });
    uiGateway.broadcast("node.updated", { nodeId });
    return sftpReachability;
  });
}

/** An instance's ports and its node's SFTP, together. */
export async function checkInstanceAndSftp(id: number) {
  const i = await instances.get(id);
  const [reachability, sftp] = await Promise.all([checkInstance(id), checkNodeSftp(i.nodeId)]);
  return { reachability, sftp };
}

// ---------------------------------------------------------------------------
// Automatic checks
// ---------------------------------------------------------------------------

function automatic(what: string, run: () => Promise<unknown>, delayMs = 0) {
  setTimeout(() => {
    run().catch((err) => rlog.warn(`automatic ${what} check failed`, { err: String(err) }));
  }, delayMs);
}

// A moment after "running", so the game has certainly opened its ports.
events.on(
  "instance.running",
  ({ instanceId }) => automatic("port", () => checkInstance(instanceId), 2_000),
);
events.on(
  "instance.ports_changed",
  ({ instanceId }) => automatic("port", () => checkInstance(instanceId)),
);
events.on(
  "instance.firewall",
  ({ instanceId }) => automatic("port", () => checkInstanceAndSftp(instanceId), 1_000),
);
events.on("node.sftp", ({ nodeId, listening }) => {
  if (listening) automatic("SFTP", () => checkNodeSftp(nodeId), 1_000);
});
