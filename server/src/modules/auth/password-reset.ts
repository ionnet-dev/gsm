/**
 * Forgotten passwords ("Forgot password?" on the sign-in page). Asking always gets the same answer
 * whether or not the address has an account, and the email goes out in the background, so neither
 * the reply nor its timing tells which addresses are registered. The emailed link carries a 256-bit
 * token in the URL fragment; only its SHA-256 is stored. A token lives 30 minutes, works once, and
 * asking again replaces it. Setting the new password signs the user out everywhere but does not
 * sign them in: the next sign-in still needs any second factor they have.
 */
import { Op } from "sequelize";
import { sequelize } from "../../db/sequelize.ts";
import { LoginChallenge, PasswordReset, User } from "../../db/models.ts";
import { config } from "../../config.ts";
import { randomId, sha256Hex } from "../../lib/ids.ts";
import { badRequest, HttpError } from "../../lib/errors.ts";
import { log } from "../../lib/logger.ts";
import { createRateLimiter } from "../../lib/rate-limit.ts";
import { getGeneral } from "../settings/service.ts";
import { sendMail } from "../../lib/mailer.ts";
import * as audit from "../audit/service.ts";
import { endSessions, hashPassword, type SessionMeta } from "./service.ts";
import { escapeHtml, isAvailable } from "./two-factor.ts";

export const RESET_TTL_MS = 30 * 60 * 1000;
/** At most one reset email per account per minute, so the form cannot flood a mailbox. */
export const RESEND_INTERVAL_MS = 60_000;

const rlog = log.child("password-reset");

/** Checked before the background send starts, so requests in quick succession cannot race it. */
const perAccount = createRateLimiter({ windowMs: RESEND_INTERVAL_MS, max: 1 });

export function tokenHash(token: string): Promise<string> {
  return sha256Hex(`password-reset:${token}`);
}

/** The token goes in the fragment, which browsers never send, so it stays out of proxy logs. */
export function resetLink(token: string, siteUrl = config.SITE_URL): string {
  return `${siteUrl.replace(/\/+$/, "")}/reset-password#${token}`;
}

async function deliver(user: User, token: string, ip: string | null) {
  const { siteName } = await getGeneral();
  const link = resetLink(token);
  const minutes = Math.round(RESET_TTL_MS / 60_000);
  const intro = `Someone asked to reset the password for ${user.email} on ${siteName}.`;
  const note = `The link works once and expires in ${minutes} minutes.${
    ip ? ` Request came from ${ip}.` : ""
  }`;
  const outro = "If this was not you, ignore this email: your password stays the same.";
  const text = [intro, "", "Choose a new password:", link, "", note, outro].join("\n");
  const html = `<p>${escapeHtml(intro)}</p>
<p><a href="${escapeHtml(link)}">Choose a new password</a></p>
<p style="color:#666;word-break:break-all">${escapeHtml(link)}</p>
<p>${escapeHtml(note)}</p>
<p style="color:#666">${outro}</p>`;
  await sendMail(user.email, `[${siteName}] Reset your password`, text, html);
}

/** Create a token for the user (replacing any earlier one) and email the link. */
async function issue(user: User, meta: SessionMeta): Promise<void> {
  const token = randomId(32);
  const hash = await tokenHash(token);
  await sequelize.transaction(async (transaction) => {
    await PasswordReset.destroy({ where: { userId: user.id }, transaction });
    await PasswordReset.create({
      tokenHash: hash,
      userId: user.id,
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
    }, { transaction });
  });
  await audit.record({
    actorUserId: null,
    action: "auth.password_reset_requested",
    targetType: "user",
    targetId: user.id,
    ip: meta.ip,
  });
  await deliver(user, token, meta.ip);
}

/**
 * Email a reset link if the address belongs to an active account. Answers the same way either way;
 * only a missing SMTP setup, which is true for every address, is reported.
 */
export async function requestReset(email: string, meta: SessionMeta): Promise<void> {
  if (!(await isAvailable())) {
    throw badRequest(
      "Password reset by email is not set up. Ask an administrator to reset your password.",
    );
  }
  const user = await User.findOne({ where: { email: email.toLowerCase() } });
  if (!user || user.disabled) return;
  if (!perAccount.check(String(user.id)).ok) return;
  // Not awaited: the SMTP round trip would show that the account exists.
  issue(user, meta).catch((err) =>
    rlog.error("could not send reset email", { userId: user.id, err })
  );
}

const invalidToken = () =>
  new HttpError(
    400,
    "invalid_reset_token",
    "This reset link is invalid or has expired. Ask for a new one.",
  );

/**
 * Set a new password with an emailed token. Signs the user out everywhere and drops pending sign-in
 * challenges, which were opened with the old password. Returns the user.
 */
export async function resetPassword(
  token: string,
  newPassword: string,
  ip: string | null,
): Promise<User> {
  const row = await PasswordReset.findOne({
    where: { tokenHash: await tokenHash(token), expiresAt: { [Op.gt]: new Date() } },
    include: [{ model: User, as: "user" }],
  });
  const user = row?.user;
  if (!row || !user || user.disabled) throw invalidToken();
  const passwordHash = await hashPassword(newPassword);
  await sequelize.transaction(async (transaction) => {
    // Deleting the row claims the token: of two submissions racing on one link, only one wins.
    const claimed = await PasswordReset.destroy({
      where: { tokenHash: row.tokenHash },
      transaction,
    });
    if (claimed !== 1) throw invalidToken();
    user.passwordHash = passwordHash;
    await user.save({ transaction });
    await endSessions(user.id, { transaction });
    await LoginChallenge.destroy({ where: { userId: user.id }, transaction });
  });
  await audit.record({
    actorUserId: user.id,
    action: "auth.password_reset",
    targetType: "user",
    targetId: user.id,
    ip,
  });
  return user;
}

export async function purgeExpiredResets(): Promise<number> {
  return await PasswordReset.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
}
