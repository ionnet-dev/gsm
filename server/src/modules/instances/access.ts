/**
 * Who may do what on an instance. Admins may do everything; users who own the instance's node
 * (`node_users`, see nodes/access.ts) are its owner; other users have a per-instance role
 * (`instance_users`). Scoped users get 404 rather than 403 for instances they cannot see, so ids
 * cannot be probed.
 */
import type { Context } from "hono";
import { Op } from "sequelize";
import type { InstancePermission, InstanceRole } from "@gsm/shared";
import { roleAllows } from "@gsm/shared";
import type { AppEnv } from "../../app.ts";
import { Instance, InstanceUser, NodeUser } from "../../db/models.ts";
import { forbidden, notFound } from "../../lib/errors.ts";
import { currentUser } from "../auth/middleware.ts";
import { ownsNode } from "../nodes/access.ts";
import type { User } from "../users/models.ts";

/** The instances a user may see, with their role on each; null for admins (everything). */
export type InstanceScope = Map<number, InstanceRole> | null;

export async function scopeForUser(user: Pick<User, "id" | "role">): Promise<InstanceScope> {
  if (user.role === "admin") return null;
  const [grants, nodes] = await Promise.all([
    InstanceUser.findAll({ where: { userId: user.id }, attributes: ["instanceId", "role"] }),
    NodeUser.findAll({ where: { userId: user.id }, attributes: ["nodeId"] }),
  ]);
  const scope: Map<number, InstanceRole> = new Map(grants.map((g) => [g.instanceId, g.role]));
  if (nodes.length) {
    const onOwnedNodes = await Instance.findAll({
      where: { nodeId: { [Op.in]: nodes.map((n) => n.nodeId) } },
      attributes: ["id"],
    });
    for (const i of onOwnedNodes) scope.set(i.id, "owner");
  }
  return scope;
}

export function inScope(scope: InstanceScope, instanceId: number): boolean {
  return scope === null || scope.has(instanceId);
}

/** The role a scope gives on an instance; "owner" for admins, null without access. */
export function roleIn(scope: InstanceScope, instanceId: number): InstanceRole | null {
  return scope === null ? "owner" : scope.get(instanceId) ?? null;
}

/** The user's role on the instance; "owner" for admins and node owners, null without access. */
export async function roleOn(
  user: Pick<User, "id" | "role">,
  instanceId: number,
): Promise<InstanceRole | null> {
  if (user.role === "admin") return "owner";
  const [grant, instance] = await Promise.all([
    InstanceUser.findOne({ where: { userId: user.id, instanceId } }),
    Instance.findByPk(instanceId, { attributes: ["id", "nodeId"] }),
  ]);
  if (!instance) return null;
  if (await ownsNode(user, instance.nodeId)) return "owner";
  return grant?.role ?? null;
}

/** The requester's scope, computed once per request. */
export async function instanceScope(c: Context<AppEnv>): Promise<InstanceScope> {
  const cached = c.get("instanceScope");
  if (cached !== undefined) return cached;
  const scope = await scopeForUser(currentUser(c));
  c.set("instanceScope", scope);
  return scope;
}

/**
 * Check that the requester may `permission` on the instance. No access at all is a 404; access
 * without the permission is a 403. Returns the role for callers that filter what they show.
 */
export async function assertInstancePermission(
  c: Context<AppEnv>,
  instanceId: number,
  permission: InstancePermission,
): Promise<InstanceRole> {
  const role = await roleOn(currentUser(c), instanceId);
  if (role === null) throw notFound("Instance");
  if (!roleAllows(role, permission)) {
    throw forbidden(`Requires the ${permissionRole(permission)} role on this instance`);
  }
  return role;
}

function permissionRole(permission: InstancePermission): string {
  switch (permission) {
    case "access":
    case "delete":
    case "reinstall":
    case "firewall":
      return "owner";
    case "view":
    case "console":
      return "viewer";
    default:
      return "operator";
  }
}
