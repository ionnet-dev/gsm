import { argon2id, argon2Verify } from "hash-wasm";
import { Op, type Transaction } from "sequelize";
import type { SecondFactor } from "@gsm/shared";
import { sequelize } from "../../db/sequelize.ts";
import { Session, User } from "../../db/models.ts";
import { config } from "../../config.ts";
import { randomId } from "../../lib/ids.ts";
import { conflict, unauthorized } from "../../lib/errors.ts";
import * as audit from "../audit/service.ts";

export const SESSION_COOKIE = "gsm_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export type SessionMeta = { ip: string | null; userAgent: string | null };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return await argon2id({
    password,
    salt,
    parallelism: 1,
    iterations: 3,
    memorySize: 65536,
    hashLength: 32,
    outputType: "encoded",
  });
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return argon2Verify({ password, hash }).catch(() => false);
}

export async function setupRequired(): Promise<boolean> {
  return (await User.count()) === 0;
}

/** First-run: create the initial admin. Only allowed while there are no users at all. */
export async function setup(
  input: { email: string; name: string; password: string },
  ip: string | null,
) {
  if (!(await setupRequired())) throw conflict("Setup has already been completed");
  const passwordHash = await hashPassword(input.password);
  // Re-check inside a transaction so two concurrent first-run requests cannot both create an admin.
  const user = await sequelize.transaction(async (transaction) => {
    const existing = await User.findOne({ transaction, lock: transaction.LOCK.UPDATE });
    if (existing) throw conflict("Setup has already been completed");
    return await User.create({
      email: input.email.toLowerCase(),
      name: input.name,
      passwordHash,
      role: "admin",
      lastLoginAt: new Date(),
    }, { transaction });
  });
  await audit.record({
    actorUserId: user.id,
    action: "auth.setup",
    targetType: "user",
    targetId: user.id,
    ip,
  });
  return user;
}

/**
 * Check email + password. Returns the user without creating a session; the caller decides whether
 * a second factor is needed (see two-factor.ts) before calling `completeLogin`.
 */
export async function authenticate(email: string, password: string, ip: string | null) {
  const user = await User.findOne({ where: { email: email.toLowerCase() } });
  // Always run a verify so timing does not reveal whether the account exists.
  const ok = user
    ? await verifyPassword(password, user.passwordHash)
    : await verifyPassword(password, DUMMY_HASH).then(() => false);
  if (!user || !ok) {
    await audit.record({
      actorUserId: null,
      action: "auth.login_failed",
      details: { email },
      ip,
    });
    throw unauthorized("Invalid email or password");
  }
  if (user.disabled) throw unauthorized("This account is disabled");
  return user;
}

/** Issue a session once every required factor has been satisfied. */
export async function completeLogin(
  user: User,
  meta: SessionMeta,
  details: { twoFactor: SecondFactor | false },
) {
  const created = await createSession(user, meta);
  user.lastLoginAt = new Date();
  await user.save();
  await audit.record({
    actorUserId: user.id,
    action: "auth.login",
    targetType: "user",
    targetId: user.id,
    details,
    ip: meta.ip,
  });
  return created;
}

/**
 * Session ids are stored as HMAC-SHA256(SESSION_SECRET, cookie value): the cookie alone is the
 * credential, so neither a database dump nor a log of the table can be replayed.
 */
export async function sessionKey(token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(config.SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Create a session row; `token` is the value to put in the cookie and is never stored. */
export async function createSession(
  user: User,
  meta: SessionMeta,
): Promise<{ session: Session; token: string }> {
  const token = randomId(32);
  const session = await Session.create({
    id: await sessionKey(token),
    userId: user.id,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 512) ?? null,
  });
  return { session, token };
}

/** Load a live session (and its user) from a cookie value, sliding the expiry occasionally. */
export async function resolveSession(
  token: string,
): Promise<{ session: Session; user: User } | null> {
  if (!token || token.length > 128) return null;
  const session = await Session.findOne({
    where: { id: await sessionKey(token), expiresAt: { [Op.gt]: new Date() } },
    include: [{ model: User, as: "user" }],
  });
  if (!session || !session.user || session.user.disabled) return null;
  if (Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    session.lastSeenAt = new Date();
    session.expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    session.save().catch(() => {});
  }
  return { session, user: session.user };
}

export async function logout(session: Session, ip: string | null) {
  await session.destroy();
  await audit.record({ actorUserId: session.userId, action: "auth.logout", ip });
}

/** Changing the password signs out every other session of the user (the current one stays). */
export async function changePassword(
  user: User,
  currentPassword: string,
  newPassword: string,
  meta: { ip: string | null; keepSessionId: string | null },
) {
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw unauthorized("Current password is incorrect");
  }
  user.passwordHash = await hashPassword(newPassword);
  await user.save();
  await endSessions(user.id, { keepSessionId: meta.keepSessionId });
  await audit.record({
    actorUserId: user.id,
    action: "auth.password_changed",
    targetType: "user",
    targetId: user.id,
    ip: meta.ip,
  });
}

/**
 * Sign a user out everywhere but `keepSessionId`.
 */
export async function endSessions(
  userId: number,
  opts: { keepSessionId?: string | null; transaction?: Transaction } = {},
): Promise<void> {
  const keep = opts.keepSessionId;
  await Session.destroy({
    where: { userId, ...(keep ? { id: { [Op.ne]: keep } } : {}) },
    transaction: opts.transaction,
  });
}

export async function purgeExpiredSessions(): Promise<number> {
  return await Session.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
}

// A valid argon2id hash of a random string, used to equalise timing for unknown accounts.
const DUMMY_HASH = await hashPassword(randomId(16));
