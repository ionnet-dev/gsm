/**
 * Reachability probes. While an instance is stopped, the agent listens briefly on its ports (TCP
 * and/or UDP) and the server sends a one-time token to the node's public address; a port counts
 * as reachable when the token arrives. Mirrored in agent/internal/protocol/types.go.
 */
import { z } from "zod";

/** What the server sends: `GSM-PROBE <token>`, as a line over TCP and one datagram over UDP. */
export const PROBE_PREFIX = "GSM-PROBE ";

export const ProbeListener = z.object({
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["tcp", "udp"]),
});
export type ProbeListener = z.infer<typeof ProbeListener>;

export const ProbeParams = z.object({
  bindAddress: z.string(),
  token: z.string().min(16).max(128),
  timeoutMs: z.number().int().min(1000).max(15_000),
  listeners: z.array(ProbeListener).min(1).max(32),
});

export const ProbeListenerState = ProbeListener.extend({
  /** False when the port could not be opened (in use); `error` says why. */
  bound: z.boolean(),
  error: z.string().nullable(),
  /** Whether the token arrived (always false in the ready chunk). */
  received: z.boolean(),
});
export type ProbeListenerState = z.infer<typeof ProbeListenerState>;

export const ProbeState = z.object({ listeners: z.array(ProbeListenerState) });
export type ProbeState = z.infer<typeof ProbeState>;

export const probeMethods = {
  /**
   * Listen on the ports, stream one `ProbeState` once they are open, and return when every open
   * listener got the token or `timeoutMs` passed.
   */
  "net.probe": { params: ProbeParams, result: ProbeState, stream: ProbeState },
} as const;
