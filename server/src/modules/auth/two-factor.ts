/**
 * Second sign-in factors. A correct password yields a login challenge that any enabled factor
 * completes: an authenticator-app code (TOTP, see totp.ts), an emailed one-time code, or one of the
 * user's one-time recovery codes. Email codes are 6 digits, live 10 minutes and can be sent 3 times
 * per challenge. A challenge allows 5 wrong codes, and a user 10 wrong codes an hour across all
 * challenges. Email and recovery codes are stored as hashes; the TOTP seed is sealed with
 * lib/secret-box.ts.
 */
import { Op } from "sequelize";
import type {
  SecondFactor,
  TotpSetup,
  TwoFactorChallenge,
  TwoFactorMethod,
  TwoFactorStatus,
} from "@gsm/shared";
import { sequelize } from "../../db/sequelize.ts";
import { LoginChallenge, RecoveryCode, User } from "../../db/models.ts";
import { randomId, sha256Hex, timingSafeEqual } from "../../lib/ids.ts";
import { badRequest, HttpError, unauthorized } from "../../lib/errors.ts";
import { log } from "../../lib/logger.ts";
import { createRateLimiter } from "../../lib/rate-limit.ts";
import * as secretBox from "../../lib/secret-box.ts";
import { getGeneral, getSmtp } from "../settings/service.ts";
import { sendMail } from "../../lib/mailer.ts";
import * as audit from "../audit/service.ts";
import { endSessions, type SessionMeta, verifyPassword } from "./service.ts";
import * as totp from "./totp.ts";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const MAX_SENDS = 3;
export const RESEND_INTERVAL_MS = 30_000;
export const RECOVERY_CODE_COUNT = 10;
const CODE_DIGITS = 6;

const tlog = log.child("2fa");

/**
 * Wrong codes per user across challenges. Someone holding the password can open a new challenge
 * 10 times per 15 minutes (login limiter); this caps their total guesses however many they open.
 */
const userFailures = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });

/** Uniform random numeric code (rejection sampling avoids modulo bias). */
export function generateCode(digits = CODE_DIGITS): string {
  const max = 10 ** digits;
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return String(n % max).padStart(digits, "0");
}

export function normalizeCode(input: string): string {
  return input.replace(/[\s-]/g, "");
}

export function codeHash(challengeId: string, code: string): Promise<string> {
  return sha256Hex(`${challengeId}:${code}`);
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const shown = local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2);
  return `${shown}${"*".repeat(Math.max(3, local.length - shown.length))}@${domain}`;
}

// ---- recovery code format ----

/** 31 symbols without the look-alikes 0/o and 1/i/l. */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** 12 symbols (about 59 bits) shown as xxxx-xxxx-xxxx; bytes ≥ 248 are dropped to stay uniform. */
export function generateRecoveryCode(): string {
  const chars: string[] = [];
  const buf = new Uint8Array(16);
  while (chars.length < 12) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 248 && chars.length < 12) chars.push(RECOVERY_ALPHABET[b % 31]);
    }
  }
  return [0, 4, 8].map((i) => chars.slice(i, i + 4).join("")).join("-");
}

export function normalizeRecoveryCode(input: string): string {
  return input.toLowerCase().replace(/[\s-]/g, "");
}

export function recoveryCodeHash(userId: number, code: string): Promise<string> {
  return sha256Hex(`recovery:${userId}:${normalizeRecoveryCode(code)}`);
}

/** Without an explicit method: 6 digits are an app or email code, anything else a recovery code. */
export function guessFactor(methods: TwoFactorMethod[], code: string): SecondFactor {
  if (!/^\d{6}$/.test(normalizeCode(code))) return "recovery";
  return methods.includes("totp") ? "totp" : "email";
}

// ---- email delivery ----

/** Email codes can only be delivered when SMTP is configured under Settings → General. */
export async function isAvailable(): Promise<boolean> {
  const smtp = await getSmtp();
  return Boolean(smtp.host && smtp.from);
}

async function deliver(
  user: User,
  code: string,
  purpose: LoginChallenge["purpose"],
  ip: string | null,
) {
  const { siteName } = await getGeneral();
  const minutes = Math.round(CODE_TTL_MS / 60_000);
  const what = purpose === "login" ? "sign-in code" : "verification code";
  const intro = purpose === "login"
    ? `Someone is signing in to ${siteName} as ${user.email}.`
    : `Use this code to finish turning on email sign-in codes on ${siteName}.`;
  const outro = purpose === "login"
    ? "If this was not you, someone knows your password: sign in and change it."
    : "If you did not request this, you can ignore this email.";
  const text = [
    intro,
    "",
    `Your ${what}: ${code}`,
    "",
    `It expires in ${minutes} minutes.${ip ? ` Request came from ${ip}.` : ""}`,
    outro,
  ].join("\n");
  const html = `<p>${escapeHtml(intro)}</p>
<p style="font-size:24px;font-family:monospace;letter-spacing:4px"><strong>${code}</strong></p>
<p>It expires in ${minutes} minutes.${ip ? ` Request came from ${escapeHtml(ip)}.` : ""}</p>
<p style="color:#666">${outro}</p>`;
  await sendMail(user.email, `[${siteName}] Your ${what}: ${code}`, text, html);
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!,
  );
}

/** Put a fresh email code on the challenge and send it. Returns an error message, never throws. */
async function sendEmailCode(
  challenge: LoginChallenge,
  user: User,
  ip: string | null,
): Promise<string | null> {
  const code = generateCode();
  challenge.codeHash = await codeHash(challenge.id, code);
  challenge.sends += 1;
  await challenge.save();
  try {
    await deliver(user, code, challenge.purpose, ip);
  } catch (err) {
    tlog.error("could not send code", { userId: user.id, purpose: challenge.purpose, err });
    return "Could not send the verification email. Check the SMTP settings or ask an administrator.";
  }
  challenge.lastSentAt = new Date();
  await challenge.save();
  return null;
}

// ---- challenges ----

function toDto(
  challenge: LoginChallenge,
  user: User,
  emailError: string | null = null,
): TwoFactorChallenge {
  return {
    challengeId: challenge.id,
    methods: challenge.purpose === "login" ? user.twoFactorMethods : ["email"],
    sentTo: challenge.lastSentAt ? maskEmail(user.email) : null,
    emailError,
    expiresInSeconds: Math.max(0, Math.round((challenge.expiresAt.getTime() - Date.now()) / 1000)),
  };
}

/** A fresh challenge (replacing any pending one of the same purpose); no code is sent yet. */
async function newChallenge(user: User, purpose: LoginChallenge["purpose"], meta: SessionMeta) {
  await LoginChallenge.destroy({ where: { userId: user.id, purpose } });
  return await LoginChallenge.create({
    id: randomId(24),
    userId: user.id,
    purpose,
    codeHash: null,
    sends: 0,
    lastSentAt: null,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 512) ?? null,
  });
}

async function load(challengeId: string, purpose: LoginChallenge["purpose"]) {
  if (!challengeId || challengeId.length > 64) return null;
  const challenge = await LoginChallenge.findOne({
    where: { id: challengeId, purpose, expiresAt: { [Op.gt]: new Date() } },
    include: [{ model: User, as: "user" }],
  });
  if (!challenge?.user || challenge.user.disabled) return null;
  return challenge;
}

const invalidCode = () => unauthorized("Invalid or expired code");

function assertNotBlocked(user: User) {
  const wait = userFailures.retryAfter(String(user.id));
  if (wait) {
    throw new HttpError(
      429,
      "too_many_requests",
      `Too many wrong codes; try again in ${Math.ceil(wait / 60)} min`,
    );
  }
}

/** Count a wrong code against the challenge and the user, audit it, and throw. */
async function reject(
  challenge: LoginChallenge,
  user: User,
  method: SecondFactor,
  ip: string | null,
): Promise<never> {
  challenge.attempts += 1;
  const exhausted = challenge.attempts >= MAX_ATTEMPTS;
  if (exhausted) await challenge.destroy();
  else await challenge.save();
  userFailures.check(String(user.id));
  await audit.record({
    actorUserId: null,
    action: "auth.2fa_failed",
    targetType: "user",
    targetId: user.id,
    details: { purpose: challenge.purpose, method, attempts: challenge.attempts, exhausted },
    ip,
  });
  throw exhausted ? unauthorized("Too many wrong codes; start again") : invalidCode();
}

async function emailCodeMatches(challenge: LoginChallenge, code: string): Promise<boolean> {
  if (!challenge.codeHash) return false;
  return timingSafeEqual(challenge.codeHash, await codeHash(challenge.id, normalizeCode(code)));
}

// ---- authenticator app ----

const totpContext = (userId: number) => `totp:${userId}`;

async function totpSecret(user: User) {
  if (!user.totpSecret) return null;
  const secret = await secretBox.open(user.totpSecret, totpContext(user.id));
  if (!secret) {
    tlog.error("authenticator seed cannot be decrypted (was SESSION_SECRET changed?)", {
      userId: user.id,
    });
  }
  return secret;
}

/** Accept the step atomically, only if it is newer than the last one used (no replays). */
async function claimStep(user: User, step: number): Promise<boolean> {
  const [claimed] = await User.update({ totpLastStep: step }, {
    where: {
      id: user.id,
      [Op.or]: [{ totpLastStep: null }, { totpLastStep: { [Op.lt]: step } }],
    },
  });
  if (claimed) user.totpLastStep = step;
  return claimed === 1;
}

async function totpMatches(user: User, code: string): Promise<boolean> {
  if (!user.totpEnabledAt) return false;
  const secret = await totpSecret(user);
  if (!secret) return false;
  const step = await totp.matchStep(secret, normalizeCode(code));
  return step !== null && await claimStep(user, step);
}

// ---- recovery codes ----

export function recoveryCodesRemaining(userId: number): Promise<number> {
  return RecoveryCode.count({ where: { userId, usedAt: null } });
}

/** Replace the user's recovery codes with a new set and return it; it is never shown again. */
async function issueRecoveryCodes(user: User): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const rows = await Promise.all(
    codes.map(async (code) => ({
      userId: user.id,
      codeHash: await recoveryCodeHash(user.id, code),
    })),
  );
  await sequelize.transaction(async (transaction) => {
    await RecoveryCode.destroy({ where: { userId: user.id }, transaction });
    await RecoveryCode.bulkCreate(rows, { transaction });
  });
  return codes;
}

/** When a factor is turned on: a fresh set unless unused codes remain. */
async function recoveryCodesIfNone(user: User): Promise<string[] | null> {
  return (await recoveryCodesRemaining(user.id)) > 0 ? null : await issueRecoveryCodes(user);
}

async function useRecoveryCode(user: User, code: string, ip: string | null): Promise<boolean> {
  if (!/^[a-z0-9]{12}$/.test(normalizeRecoveryCode(code))) return false;
  const row = await RecoveryCode.findOne({
    where: { userId: user.id, codeHash: await recoveryCodeHash(user.id, code), usedAt: null },
  });
  if (!row) return false;
  const [used] = await RecoveryCode.update({ usedAt: new Date() }, {
    where: { id: row.id, usedAt: null },
  });
  if (used !== 1) return false;
  await audit.record({
    actorUserId: user.id,
    action: "auth.recovery_code_used",
    targetType: "user",
    targetId: user.id,
    details: { remaining: await recoveryCodesRemaining(user.id) },
    ip,
  });
  return true;
}

// ---- login second factor ----

/**
 * Open a login challenge. Authenticator users are not emailed unless they ask; email-only users get
 * a code straight away, and if SMTP fails the challenge stays open for a recovery code.
 */
export async function startLogin(user: User, meta: SessionMeta): Promise<TwoFactorChallenge> {
  const challenge = await newChallenge(user, "login", meta);
  const emailError = user.twoFactorMethods[0] === "email"
    ? await sendEmailCode(challenge, user, meta.ip)
    : null;
  return toDto(challenge, user, emailError);
}

export async function verifyLogin(
  challengeId: string,
  code: string,
  method: SecondFactor | undefined,
  ip: string | null,
): Promise<{ user: User; method: SecondFactor }> {
  const challenge = await load(challengeId, "login");
  if (!challenge) throw invalidCode();
  const user = challenge.user!;
  assertNotBlocked(user);
  const factor = method ?? guessFactor(user.twoFactorMethods, code);
  const ok = factor === "totp"
    ? await totpMatches(user, code)
    : factor === "email"
    ? user.twoFactorEmail && await emailCodeMatches(challenge, code)
    : await useRecoveryCode(user, code, ip);
  if (!ok) return await reject(challenge, user, factor, ip);
  await challenge.destroy();
  return { user, method: factor };
}

/** Send, or re-send with a new code, the email code for a pending challenge (limited). */
export async function resend(
  challengeId: string,
  purpose: LoginChallenge["purpose"],
  ip: string | null,
): Promise<TwoFactorChallenge> {
  const challenge = await load(challengeId, purpose);
  if (!challenge) throw invalidCode();
  const user = challenge.user!;
  if (purpose === "login" && !user.twoFactorEmail) {
    throw badRequest("Email codes are not turned on for this account");
  }
  if (challenge.sends >= MAX_SENDS) throw badRequest("Code was sent too many times; start again");
  const since = challenge.lastSentAt ? Date.now() - challenge.lastSentAt.getTime() : Infinity;
  if (since < RESEND_INTERVAL_MS) {
    throw new HttpError(
      429,
      "too_many_requests",
      `Wait ${Math.ceil((RESEND_INTERVAL_MS - since) / 1000)}s before requesting another code`,
    );
  }
  const error = await sendEmailCode(challenge, user, ip);
  if (error) throw new HttpError(503, "two_factor_unavailable", error);
  return toDto(challenge, user);
}

// ---- managing factors for the signed-in user ----

async function requirePassword(user: User, password: string) {
  if (!(await verifyPassword(password, user.passwordHash))) {
    throw unauthorized("Password is incorrect");
  }
}

function auditChange(
  user: User,
  action: "auth.2fa_enabled" | "auth.2fa_disabled",
  method: TwoFactorMethod,
  ip: string | null,
) {
  return audit.record({
    actorUserId: user.id,
    action,
    targetType: "user",
    targetId: user.id,
    details: { method },
    ip,
  });
}

export async function status(user: User): Promise<TwoFactorStatus> {
  return {
    methods: user.twoFactorMethods,
    totpEnabledAt: user.totpEnabledAt?.toISOString() ?? null,
    recoveryCodesRemaining: user.hasTwoFactor ? await recoveryCodesRemaining(user.id) : 0,
  };
}

/** Email codes: send a code first, so a mailbox that cannot receive is never depended on. */
export async function startEmail(user: User, meta: SessionMeta): Promise<TwoFactorChallenge> {
  if (user.twoFactorEmail) throw badRequest("Email codes are already turned on");
  if (!(await isAvailable())) {
    throw badRequest("Email codes need SMTP to be configured (Settings → General)");
  }
  const challenge = await newChallenge(user, "enable", meta);
  const error = await sendEmailCode(challenge, user, meta.ip);
  if (error) {
    await challenge.destroy().catch(() => {});
    throw new HttpError(503, "two_factor_unavailable", error);
  }
  return toDto(challenge, user);
}

/** Returns recovery codes when this was the user's first factor (or all codes were used). */
export async function confirmEmail(
  user: User,
  challengeId: string,
  code: string,
  ip: string | null,
): Promise<string[] | null> {
  const challenge = await load(challengeId, "enable");
  if (!challenge || challenge.userId !== user.id) throw invalidCode();
  assertNotBlocked(user);
  if (!(await emailCodeMatches(challenge, code))) return await reject(challenge, user, "email", ip);
  await challenge.destroy();
  user.twoFactorEmail = true;
  await user.save();
  await auditChange(user, "auth.2fa_enabled", "email", ip);
  return await recoveryCodesIfNone(user);
}

/**
 * Start authenticator setup. Needs the password, so a hijacked session cannot enrol an attacker's
 * phone and lock the owner out. Stores a new, not yet active seed and returns it for the app.
 */
export async function startTotp(user: User, password: string): Promise<TotpSetup> {
  await requirePassword(user, password);
  if (user.totpEnabledAt) {
    throw badRequest("An authenticator app is already set up; remove it first");
  }
  const secret = totp.generateSecret();
  user.totpSecret = await secretBox.seal(secret, totpContext(user.id));
  user.totpLastStep = null;
  await user.save();
  const { siteName } = await getGeneral();
  const key = totp.toBase32(secret);
  return { secret: key, otpauthUrl: totp.otpauthUrl(key, user.email, siteName) };
}

/** Finish setup with a code from the app. Returns recovery codes when the user had none. */
export async function confirmTotp(
  user: User,
  code: string,
  ip: string | null,
): Promise<string[] | null> {
  if (user.totpEnabledAt) throw badRequest("An authenticator app is already set up");
  const secret = await totpSecret(user);
  if (!secret) throw badRequest("Start the authenticator setup again");
  const step = await totp.matchStep(secret, normalizeCode(code));
  if (step === null) {
    throw unauthorized(
      "That code doesn't match. Make sure your phone sets its clock automatically, then enter the newest code.",
    );
  }
  user.totpEnabledAt = new Date();
  user.totpLastStep = step;
  await user.save();
  await auditChange(user, "auth.2fa_enabled", "totp", ip);
  return await recoveryCodesIfNone(user);
}

/** Needs the password, so a hijacked session cannot weaken the account. */
export async function disable(
  user: User,
  method: TwoFactorMethod,
  password: string,
  ip: string | null,
): Promise<void> {
  await requirePassword(user, password);
  if (!user.twoFactorMethods.includes(method)) return;
  if (method === "totp") {
    user.totpSecret = null;
    user.totpEnabledAt = null;
    user.totpLastStep = null;
  } else {
    user.twoFactorEmail = false;
  }
  await user.save();
  await LoginChallenge.destroy({ where: { userId: user.id } });
  // Recovery codes stand in for a factor; with none left they would be a password bypass risk.
  if (!user.hasTwoFactor) await RecoveryCode.destroy({ where: { userId: user.id } });
  await auditChange(user, "auth.2fa_disabled", method, ip);
}

export async function regenerateRecoveryCodes(
  user: User,
  password: string,
  ip: string | null,
): Promise<string[]> {
  await requirePassword(user, password);
  if (!user.hasTwoFactor) throw badRequest("Turn on a second factor first");
  const codes = await issueRecoveryCodes(user);
  await audit.record({
    actorUserId: user.id,
    action: "auth.recovery_codes_generated",
    targetType: "user",
    targetId: user.id,
    ip,
  });
  return codes;
}

/** Administrative reset for a locked-out user: every factor and code off, signed out everywhere. */
export async function adminReset(user: User): Promise<void> {
  user.twoFactorEmail = false;
  user.totpSecret = null;
  user.totpEnabledAt = null;
  user.totpLastStep = null;
  await user.save();
  await LoginChallenge.destroy({ where: { userId: user.id } });
  await RecoveryCode.destroy({ where: { userId: user.id } });
  await endSessions(user.id);
  userFailures.reset(String(user.id));
}

export async function purgeExpiredChallenges(): Promise<number> {
  return await LoginChallenge.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
}
