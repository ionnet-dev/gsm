/**
 * Browser-facing WebSocket (/ws/ui). The server fans out typed events that the web app uses to
 * invalidate TanStack Query caches and show live updates. Browsers only send console subscriptions
 * (`{ t: "sub", instanceId }`); everything else goes over REST.
 */
import type { WSContext } from "hono/ws";
import type { UiEvent, UiEventData } from "@gsm/shared";
import { UiClientMessage } from "@gsm/shared";
import { log } from "../lib/logger.ts";
import { inScope, type InstanceScope } from "../modules/instances/access.ts";
import { inNodeScope, type NodeScope } from "../modules/nodes/access.ts";

interface UiClient {
  ws: WSContext;
  userId: number;
  admin: boolean;
  /** Fixed at connect time; sockets are closed when the user's access changes. */
  scope: InstanceScope;
  /** Nodes the user manages, fixed at connect time like `scope`. */
  nodes: NodeScope;
  /** Instances whose console output this socket wants. */
  consoles: Set<number>;
}

/** Close code the browser treats as "reconnect now" (a plain 4001 means the session ended). */
export const CLOSE_RECONNECT = 4002;

const wlog = log.child("ws:ui");

/**
 * Does a client get this event? Instance events follow the instance scope, node events the node
 * scope (admins and the node's owners), template events are for admins.
 */
export function visibleTo(
  c: Pick<UiClient, "admin" | "scope" | "nodes" | "consoles">,
  event: UiEvent,
  data: Record<string, unknown>,
): boolean {
  if (typeof data.instanceId === "number") {
    if (!inScope(c.scope, data.instanceId)) return false;
    if (event === "instance.console") return c.consoles.has(data.instanceId);
    return true;
  }
  if (typeof data.nodeId === "number") return inNodeScope(c.nodes, data.nodeId);
  if (event === "template.updated") return c.admin;
  return true;
}

class UiGateway {
  private clients = new Set<UiClient>();

  add(
    ws: WSContext,
    userId: number,
    admin: boolean,
    scope: InstanceScope,
    nodes: NodeScope,
  ): UiClient {
    const client: UiClient = { ws, userId, admin, scope, nodes, consoles: new Set() };
    this.clients.add(client);
    wlog.debug("client connected", { userId, clients: this.clients.size });
    return client;
  }

  remove(client: UiClient) {
    this.clients.delete(client);
    wlog.debug("client disconnected", { userId: client.userId, clients: this.clients.size });
  }

  onMessage(client: UiClient, raw: string | ArrayBuffer) {
    let msg: UiClientMessage;
    try {
      msg = UiClientMessage.parse(
        JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)),
      );
    } catch {
      return;
    }
    if (msg.t === "sub") {
      if (inScope(client.scope, msg.instanceId)) client.consoles.add(msg.instanceId);
    } else client.consoles.delete(msg.instanceId);
  }

  broadcast<E extends UiEvent>(event: E, data: UiEventData<E>): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify({ t: "event", event, data });
    for (const c of this.clients) {
      if (visibleTo(c, event, data as Record<string, unknown>)) this.safeSend(c, payload);
    }
  }

  /** True when at least one browser follows the instance's console (the agent always sends). */
  hasConsoleListeners(instanceId: number): boolean {
    for (const c of this.clients) if (c.consoles.has(instanceId)) return true;
    return false;
  }

  sendToUser<E extends UiEvent>(userId: number, event: E, data: UiEventData<E>): void {
    const payload = JSON.stringify({ t: "event", event, data });
    for (const c of this.clients) if (c.userId === userId) this.safeSend(c, payload);
  }

  /** Force-close every socket for a user (logout elsewhere, account disabled). */
  disconnectUser(userId: number) {
    for (const c of this.clients) if (c.userId === userId) c.ws.close(4001, "session ended");
  }

  /** Drop a user's sockets so they reconnect and pick up a changed scope. */
  reconnectUser(userId: number) {
    for (const c of this.clients) {
      if (c.userId === userId) c.ws.close(CLOSE_RECONNECT, "access changed");
    }
  }

  get size() {
    return this.clients.size;
  }

  private safeSend(c: UiClient, payload: string) {
    try {
      c.ws.send(payload);
    } catch {
      this.clients.delete(c);
    }
  }
}

export const uiGateway = new UiGateway();
export type { UiClient };
