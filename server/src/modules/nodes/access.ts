/**
 * Who may manage a node. Admins manage every node; a user an admin made owner of a node
 * (`node_users`) manages it too and is owner of every instance on it (instances/access.ts).
 * Nodes a user does not own answer 404, like instances, so ids cannot be probed.
 */
import type { Context } from "hono";
import type { AppEnv } from "../../app.ts";
import { NodeUser } from "../../db/models.ts";
import { notFound } from "../../lib/errors.ts";
import { currentUser } from "../auth/middleware.ts";
import type { User } from "../users/models.ts";

/** The node ids a user owns; null for admins (every node). */
export type NodeScope = Set<number> | null;

export async function nodeScopeForUser(user: Pick<User, "id" | "role">): Promise<NodeScope> {
  if (user.role === "admin") return null;
  const rows = await NodeUser.findAll({ where: { userId: user.id }, attributes: ["nodeId"] });
  return new Set(rows.map((r) => r.nodeId));
}

export function inNodeScope(scope: NodeScope, nodeId: number): boolean {
  return scope === null || scope.has(nodeId);
}

export async function ownsNode(user: Pick<User, "id" | "role">, nodeId: number): Promise<boolean> {
  if (user.role === "admin") return true;
  return (await NodeUser.count({ where: { userId: user.id, nodeId } })) > 0;
}

/** The requester's node scope, computed once per request. */
export async function nodeScope(c: Context<AppEnv>): Promise<NodeScope> {
  const cached = c.get("nodeScope");
  if (cached !== undefined) return cached;
  const scope = await nodeScopeForUser(currentUser(c));
  c.set("nodeScope", scope);
  return scope;
}

/** Check that the requester manages the node: an admin or one of its owners; 404 otherwise. */
export async function assertNodeAccess(c: Context<AppEnv>, nodeId: number): Promise<void> {
  if (!(await ownsNode(currentUser(c), nodeId))) throw notFound("Node");
}

/** Users who own the node (their sockets reconnect when its instances come and go). */
export async function nodeOwnerIds(nodeId: number): Promise<number[]> {
  const rows = await NodeUser.findAll({ where: { nodeId }, attributes: ["userId"] });
  return rows.map((r) => r.userId);
}
