/**
 * Agent-facing WebSocket (/ws/agent). One connection per node. Provides a typed request() API to
 * the rest of the server with streaming support, and routes agent events to the services.
 */
import type { WSContext } from "hono/ws";
import { z } from "zod";
import {
  agentEvents,
  type AgentMethod,
  agentMethods,
  type AgentParams,
  type AgentResult,
  decodeEnvelope,
  encodeEnvelope,
  type Envelope,
  RPC_ERROR_CODES,
  type RpcError,
  serverMethods,
} from "@gsm/shared";
import { HttpError } from "../lib/errors.ts";
import { events } from "../lib/events.ts";
import { randomId } from "../lib/ids.ts";
import { log } from "../lib/logger.ts";
import * as nodes from "../modules/nodes/service.ts";
import * as instanceEvents from "../modules/instances/agent-events.ts";
import * as sftp from "../modules/sftp/service.ts";

const glog = log.child("ws:agent");
const DEFAULT_TIMEOUT_MS = 30_000;

export class AgentRpcError extends HttpError {
  /** A request the agent refused (invalid_params) is the caller's mistake; anything else is 502. */
  constructor(
    public readonly rpc: RpcError,
    status = rpc.code === RPC_ERROR_CODES.invalidParams ? 400 : 502,
  ) {
    super(status, `agent_${rpc.code}`, rpc.message, rpc.data);
  }
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onStream?: (chunk: unknown, seq: number) => void | Promise<void>;
  timer: ReturnType<typeof setTimeout>;
  streamDone: boolean;
}

export interface RequestOptions<M extends AgentMethod> {
  timeoutMs?: number;
  onStream?: (typeof agentMethods)[M] extends { stream: infer S extends z.ZodTypeAny }
    ? (chunk: z.infer<S>, seq: number) => void | Promise<void>
    : never;
}

class AgentConnection {
  readonly pending = new Map<string, Pending>();
  readonly connectedAt = new Date();
  helloReceived = false;

  constructor(
    public readonly nodeId: number,
    public readonly ws: WSContext,
    /** The address the agent connects from, as the server (or its trusted proxy) saw it. */
    public readonly remoteAddress: string | null,
  ) {}

  send(env: Envelope) {
    this.ws.send(encodeEnvelope(env));
  }

  failAll(reason: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new AgentRpcError({ code: RPC_ERROR_CODES.unavailable, message: reason }));
      this.pending.delete(id);
    }
  }
}

class AgentGateway {
  private conns = new Map<number, AgentConnection>();

  isConnected(nodeId: number): boolean {
    return this.conns.get(nodeId)?.helloReceived ?? false;
  }

  /** When the node's current connection opened, if its hello was accepted. */
  connectedSince(nodeId: number): Date | null {
    const conn = this.conns.get(nodeId);
    return conn?.helloReceived ? conn.connectedAt : null;
  }

  /** The address the node's agent connects from, while it is connected. */
  remoteAddress(nodeId: number): string | null {
    const conn = this.conns.get(nodeId);
    return conn?.helloReceived ? conn.remoteAddress : null;
  }

  connectedIds(): number[] {
    return [...this.conns.values()].filter((c) => c.helloReceived).map((c) => c.nodeId);
  }

  disconnect(nodeId: number, reason: string) {
    const conn = this.conns.get(nodeId);
    if (!conn) return;
    conn.failAll(reason);
    this.conns.delete(nodeId);
    try {
      conn.ws.close(1000, reason);
    } catch { /* already closed */ }
  }

  /** Send a typed request to a connected agent. Rejects with AgentRpcError when offline/errored. */
  request<M extends AgentMethod>(
    nodeId: number,
    method: M,
    params: AgentParams<M>,
    opts: RequestOptions<M> = {},
  ): Promise<AgentResult<M>> {
    const conn = this.conns.get(nodeId);
    if (!conn || !conn.helloReceived) {
      return Promise.reject(
        new AgentRpcError({
          code: RPC_ERROR_CODES.unavailable,
          message: "The node is not connected",
        }, 409),
      );
    }
    const id = randomId(9);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<AgentResult<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(
          new AgentRpcError({
            code: RPC_ERROR_CODES.timeout,
            message: `${method} timed out after ${timeoutMs}ms`,
          }, 504),
        );
      }, timeoutMs);
      conn.pending.set(id, {
        method,
        resolve: (v) => resolve(v as AgentResult<M>),
        reject,
        onStream: opts.onStream as Pending["onStream"],
        timer,
        streamDone: false,
      });
      try {
        conn.send({ t: "req", id, method, params: agentMethods[method].params.parse(params) });
      } catch (err) {
        clearTimeout(timer);
        conn.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ---- lifecycle hooks used by the Hono upgrade handler ----

  onOpen(nodeId: number, ws: WSContext, remoteAddress: string | null = null) {
    const existing = this.conns.get(nodeId);
    if (existing) {
      glog.warn("replacing existing connection", { nodeId });
      existing.failAll("replaced by a new connection");
      try {
        existing.ws.close(4000, "replaced");
      } catch { /* ignore */ }
    }
    this.conns.set(nodeId, new AgentConnection(nodeId, ws, remoteAddress));
    glog.debug("socket open", { nodeId });
  }

  async onMessage(nodeId: number, ws: WSContext, raw: string | ArrayBuffer) {
    const conn = this.conns.get(nodeId);
    if (!conn || conn.ws !== ws) return;
    let env: Envelope;
    try {
      env = decodeEnvelope(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch (err) {
      glog.warn("bad envelope from agent", { nodeId, err: String(err) });
      return;
    }
    switch (env.t) {
      case "event":
        // A bad payload from one agent must never take the process (and every other agent) down.
        try {
          await this.handleEvent(conn, env.event, env.data);
        } catch (err) {
          glog.error("agent event handler failed", { nodeId, event: env.event, err });
        }
        break;
      case "res": {
        const p = conn.pending.get(env.id);
        if (!p) return;
        clearTimeout(p.timer);
        conn.pending.delete(env.id);
        if (env.ok) {
          const schema = agentMethods[p.method as AgentMethod]?.result;
          const parsed = schema
            ? schema.safeParse(env.result)
            : { success: true as const, data: env.result };
          if (parsed.success) p.resolve(parsed.data);
          else {
            glog.warn("malformed result", {
              nodeId,
              method: p.method,
              issues: parsed.error.issues.slice(0, 3),
            });
            p.reject(
              new AgentRpcError({
                code: "bad_result",
                message: `Malformed result for ${p.method}`,
              }),
            );
          }
        } else {
          p.reject(new AgentRpcError(env.error));
        }
        break;
      }
      case "stream": {
        const p = conn.pending.get(env.id);
        if (!p) return;
        if (env.done) {
          p.streamDone = true;
          return;
        }
        if (p.onStream) {
          try {
            await p.onStream(env.chunk, env.seq);
          } catch (err) {
            glog.error("stream handler failed", { nodeId, method: p.method, err });
          }
        }
        break;
      }
      case "req": {
        // The one method agents call on the server: may this SFTP sign-in go ahead?
        if (!conn.helloReceived || env.method !== "sftp.auth") {
          conn.send({
            t: "res",
            id: env.id,
            ok: false,
            error: { code: RPC_ERROR_CODES.unknownMethod, message: `unknown method ${env.method}` },
          });
          break;
        }
        const params = serverMethods["sftp.auth"].params.safeParse(env.params);
        if (!params.success) {
          conn.send({
            t: "res",
            id: env.id,
            ok: false,
            error: { code: RPC_ERROR_CODES.invalidParams, message: "invalid sftp.auth params" },
          });
          break;
        }
        try {
          const result = await sftp.authenticate(conn.nodeId, params.data);
          conn.send({ t: "res", id: env.id, ok: true, result });
        } catch (err) {
          glog.error("sftp.auth failed", { nodeId, err });
          conn.send({
            t: "res",
            id: env.id,
            ok: false,
            error: { code: RPC_ERROR_CODES.internal, message: "sign-in check failed" },
          });
        }
        break;
      }
    }
  }

  async onClose(nodeId: number, ws: WSContext, reason: string) {
    const conn = this.conns.get(nodeId);
    if (!conn || conn.ws !== ws) return; // a newer connection has taken over
    conn.failAll("connection closed");
    this.conns.delete(nodeId);
    glog.info("agent disconnected", { nodeId, reason });
    await nodes.setStatus(nodeId, "offline");
  }

  private async handleEvent(conn: AgentConnection, event: string, data: unknown) {
    switch (event) {
      case "hello": {
        const hello = agentEvents.hello.safeParse(data);
        if (!hello.success) return this.badEvent(conn, event, hello.error);
        const result = await nodes.onAgentHello(conn.nodeId, hello.data);
        if (!result.ok) {
          glog.warn("rejecting agent", { nodeId: conn.nodeId, reason: result.reason });
          conn.ws.close(1008, result.reason);
          return;
        }
        conn.helloReceived = true;
        nodes.configureAgent(conn.nodeId).catch((err) =>
          glog.warn("agent.configure failed", { nodeId: conn.nodeId, err: String(err) })
        );
        // Only now, so listeners can send requests to the agent straight away.
        events.emit("agent.hello", { nodeId: conn.nodeId });
        break;
      }
      case "metrics": {
        const metrics = agentEvents.metrics.safeParse(data);
        if (!metrics.success) return this.badEvent(conn, event, metrics.error);
        if (conn.helloReceived) await nodes.onAgentMetrics(conn.nodeId, metrics.data);
        break;
      }
      case "inst.status": {
        const state = agentEvents["inst.status"].safeParse(data);
        if (!state.success) return this.badEvent(conn, event, state.error);
        if (conn.helloReceived) await instanceEvents.onState(conn.nodeId, state.data);
        break;
      }
      case "inst.console": {
        const batch = agentEvents["inst.console"].safeParse(data);
        if (!batch.success) return this.badEvent(conn, event, batch.error);
        if (conn.helloReceived) await instanceEvents.onConsole(conn.nodeId, batch.data);
        break;
      }
      case "inst.stats": {
        const batch = agentEvents["inst.stats"].safeParse(data);
        if (!batch.success) return this.badEvent(conn, event, batch.error);
        if (conn.helloReceived) await instanceEvents.onStats(conn.nodeId, batch.data.stats);
        break;
      }
      case "agent.log": {
        const entry = agentEvents["agent.log"].safeParse(data);
        if (!entry.success) return this.badEvent(conn, event, entry.error);
        glog.info("agent log", { nodeId: conn.nodeId, ...entry.data });
        break;
      }
      case "sftp.session": {
        const session = agentEvents["sftp.session"].safeParse(data);
        if (!session.success) return this.badEvent(conn, event, session.error);
        if (conn.helloReceived) await sftp.onSession(conn.nodeId, session.data);
        break;
      }
      default:
        glog.warn("unknown event from agent", { nodeId: conn.nodeId, event });
    }
  }

  private badEvent(conn: AgentConnection, event: string, error: z.ZodError) {
    glog.warn("invalid event payload", {
      nodeId: conn.nodeId,
      event,
      issues: error.issues.slice(0, 3),
    });
  }
}

export const agentGateway = new AgentGateway();
