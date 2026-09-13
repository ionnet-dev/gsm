import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Role } from "@gsm/shared";
import type { AppEnv } from "../../app.ts";
import { forbidden, unauthorized } from "../../lib/errors.ts";
import { resolveSession, SESSION_COOKIE } from "./service.ts";
import { API_TOKEN_PREFIX, resolveApiToken } from "./tokens.ts";
import { User } from "../users/models.ts";

const ROLE_RANK: Record<Role, number> = { user: 0, admin: 1 };

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Attaches user + session to the context when a valid session cookie is present. Never rejects. */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.req.header("authorization");
  if (auth?.startsWith("Bearer " + API_TOKEN_PREFIX)) {
    const token = await resolveApiToken(auth.slice(7));
    const user = token ? await User.findByPk(token.userId) : null;
    if (user && !user.disabled) {
      c.set("user", user);
      c.set("apiToken", true);
    }
    await next();
    return;
  }
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) {
    const resolved = await resolveSession(sid);
    if (resolved) {
      c.set("user", resolved.user);
      c.set("session", resolved.session);
    }
  }
  await next();
};

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user")) throw unauthorized();
  await next();
};

export function requireRole(min: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) throw unauthorized();
    if (!roleAtLeast(user.role, min)) throw forbidden(`Requires ${min} role`);
    await next();
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence for cookie-authenticated requests: state-changing calls must carry a custom header,
 * which browsers only add for same-origin scripts (cross-site forms/images cannot). Paths used by
 * agents (bearer tokens, no cookies) are exempted by the caller.
 */
export function csrfGuard(exemptPrefixes: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (
      !SAFE_METHODS.has(c.req.method) && !c.get("apiToken") &&
      !exemptPrefixes.some((p) => c.req.path.startsWith(p))
    ) {
      if (c.req.header("x-gsm-client") !== "web") {
        throw forbidden("Missing X-Gsm-Client header");
      }
    }
    await next();
  };
}

export function currentUser(c: Context<AppEnv>) {
  const user = c.get("user");
  if (!user) throw unauthorized();
  return user;
}
