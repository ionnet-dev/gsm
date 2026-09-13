/** Hono routes that upgrade /ws/agent and /ws/ui, delegating socket lifecycle to the gateways. */
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { upgradeWebSocket } from "hono/deno";
import type { AppEnv } from "../app.ts";
import { config } from "../config.ts";
import { clientIp } from "../lib/http.ts";
import { log } from "../lib/logger.ts";
import { type InstanceScope, scopeForUser } from "../modules/instances/access.ts";
import { resolveSession, SESSION_COOKIE } from "../modules/auth/service.ts";
import * as nodes from "../modules/nodes/service.ts";
import { agentGateway } from "./agent-gateway.ts";
import { type UiClient, uiGateway } from "./ui-gateway.ts";

export const wsRoutes = new Hono<
  AppEnv & {
    Variables: {
      nodeId: number;
      uiUserId: number;
      uiAdmin: boolean;
      uiScope: InstanceScope;
    };
  }
>();
const wlog = log.child("ws");

wsRoutes.get(
  "/agent",
  async (c, next) => {
    const auth = c.req.header("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const node = await nodes.authenticateAgent(bearer);
    if (!node) {
      wlog.warn("agent auth failed", { ip: clientIp(c) });
      return c.json({ error: { code: "unauthorized", message: "Invalid agent token" } }, 401);
    }
    c.set("nodeId", node.id);
    await next();
  },
  upgradeWebSocket((c) => {
    const nodeId = c.get("nodeId");
    const remote = clientIp(c);
    return {
      onOpen: (_evt, ws) => agentGateway.onOpen(nodeId, ws, remote),
      onMessage: (evt, ws) => agentGateway.onMessage(nodeId, ws, evt.data as string | ArrayBuffer),
      onClose: (evt, ws) => agentGateway.onClose(nodeId, ws, evt.reason || `code ${evt.code}`),
      onError: (evt) =>
        wlog.warn("agent socket error", {
          nodeId,
          err: String((evt as ErrorEvent).message ?? evt.type),
        }),
    };
  }),
);

wsRoutes.get(
  "/ui",
  async (c, next) => {
    // Cookie-authenticated: check Origin to block cross-site WebSocket hijacking.
    const origin = c.req.header("origin");
    const allowed = new Set([
      config.SITE_URL,
      `${new URL(c.req.url).protocol}//${c.req.header("host")}`,
    ]);
    if (origin && !allowed.has(origin)) return c.text("forbidden origin", 403);
    const sid = getCookie(c, SESSION_COOKIE);
    const resolved = sid ? await resolveSession(sid) : null;
    if (!resolved) return c.text("unauthorized", 401);
    c.set("uiUserId", resolved.user.id);
    c.set("uiAdmin", resolved.user.role === "admin");
    c.set("uiScope", await scopeForUser(resolved.user));
    await next();
  },
  upgradeWebSocket((c) => {
    const userId = c.get("uiUserId");
    const admin = c.get("uiAdmin");
    const scope = c.get("uiScope");
    let client: UiClient | null = null;
    return {
      onOpen: (_evt, ws) => {
        client = uiGateway.add(ws, userId, admin, scope);
        ws.send(JSON.stringify({ t: "event", event: "hello", data: { userId } }));
      },
      onMessage: (evt) => {
        if (client) uiGateway.onMessage(client, evt.data as string | ArrayBuffer);
      },
      onClose: () => {
        if (client) uiGateway.remove(client);
      },
      onError: () => {
        if (client) uiGateway.remove(client);
      },
    };
  }),
);
