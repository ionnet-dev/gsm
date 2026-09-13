/**
 * Who may do what on an instance. Admins may do everything; other users have a per-instance role
 * (`instance_users`). Scoped users get 404 rather than 403 for instances they cannot see, so ids
 * cannot be probed.
 */
import type { Context } from "hono";
import type { InstancePermission, InstanceRole } from "@gsm/shared";
import { roleAllows } from "@gsm/shared";
import type { AppEnv } from "../../app.ts";
import { InstanceUser } from "../../db/models.ts";
import { forbidden, notFound } from "../../lib/errors.ts";
import { currentUser } from "../auth/middleware.ts";
import type { User } from "../users/models.ts";

/** The instance ids a user may see; null for admins (everything). */
export type InstanceScope = Set<number> | null;

export async function scopeForUser(user: Pick<User, "id" | "role">): Promise<InstanceScope> {
  if (user.role === "admin") return null;
  const rows = await InstanceUser.findAll({
    where: { userId: user.id },
    attributes: ["instanceId"],
  });
  return new Set(rows.map((r) => r.instanceId));
}

export function inScope(scope: InstanceScope, instanceId: number): boolean {
  return scope === null || scope.has(instanceId);
}

/** The user's role on the instance; "owner" for admins, null without access. */
export async function roleOn(
  user: Pick<User, "id" | "role">,
  instanceId: number,
): Promise<InstanceRole | null> {
  if (user.role === "admin") return "owner";
  const row = await InstanceUser.findOne({ where: { userId: user.id, instanceId } });
  return row?.role ?? null;
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
      return "owner";
    case "view":
    case "console":
      return "viewer";
    default:
      return "operator";
  }
}
