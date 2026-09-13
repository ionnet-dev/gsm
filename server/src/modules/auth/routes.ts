import { Hono } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../../app.ts";
import { config, isDev } from "../../config.ts";
import { forbidden, tooManyRequests } from "../../lib/errors.ts";
import { clientIp, parseBody } from "../../lib/http.ts";
import { createRateLimiter } from "../../lib/rate-limit.ts";
import { currentUser, requireAuth } from "./middleware.ts";
import {
  ChallengeRef,
  ChangePasswordBody,
  DisableTwoFactorBody,
  ForgotPasswordBody,
  LoginBody,
  PasswordBody,
  ResetPasswordBody,
  SetupBody,
  TotpConfirmBody,
  VerifyCodeBody,
} from "./schemas.ts";
import * as auth from "./service.ts";
import * as passwordReset from "./password-reset.ts";
import * as twoFactor from "./two-factor.ts";
import { createToken, listTokens, revokeToken } from "./tokens.ts";
import { z } from "zod";
import { auditFrom } from "../audit/service.ts";
import { idParam } from "../../lib/http.ts";
import type { Context } from "hono";

export const authRoutes = new Hono<AppEnv>();

// Per-IP and per-account limits: the account limit still holds when the source IP is spoofed or
// spread across many addresses; the IP limit holds when many accounts are tried from one place.
const loginIpLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
const loginAccountLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const codeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
// Forgot password: the address limit is keyed on what was typed, so it behaves the same whether
// or not the account exists.
const resetIpLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const resetAccountLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 5 });

function limit(limiter: ReturnType<typeof createRateLimiter>, key: string, c: Context<AppEnv>) {
  const res = limiter.check(key);
  if (!res.ok) {
    c.header("Retry-After", String(res.retryAfterSeconds));
    throw tooManyRequests("Too many attempts, try again later");
  }
}

function setSessionCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, auth.SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: !isDev && config.SITE_URL.startsWith("https://"),
    path: "/",
    maxAge: auth.SESSION_TTL_MS / 1000,
  });
}

function sessionMeta(c: Context<AppEnv>): auth.SessionMeta {
  return { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? null };
}

/** Second-factor management is for browser sessions only; API tokens act with what they have. */
function browserOnly(c: Context<AppEnv>) {
  if (c.get("apiToken")) throw forbidden("Not available with an API token; use a browser session");
}

authRoutes.get("/status", async (c) => {
  const user = c.get("user");
  const mailAvailable = await twoFactor.isAvailable();
  return c.json({
    setupRequired: await auth.setupRequired(),
    user: user?.toPublic() ?? null,
    emailCodesAvailable: user ? mailAvailable : false,
    passwordResetAvailable: mailAvailable,
  });
});

authRoutes.post("/setup", async (c) => {
  const body = await parseBody(c, SetupBody);
  const meta = sessionMeta(c);
  const user = await auth.setup(body, meta.ip);
  const { token } = await auth.createSession(user, meta);
  setSessionCookie(c, token);
  return c.json({ user: user.toPublic() }, 201);
});

authRoutes.post("/login", async (c) => {
  const ip = clientIp(c) ?? "unknown";
  limit(loginIpLimiter, ip, c);
  const body = await parseBody(c, LoginBody);
  const account = body.email.toLowerCase();
  limit(loginAccountLimiter, account, c);
  const meta = sessionMeta(c);
  const user = await auth.authenticate(body.email, body.password, meta.ip);
  if (user.hasTwoFactor) {
    // Password was right: hand out a challenge instead of a session. The limiters stay charged
    // until the code is verified so a stolen password cannot be used to spam the mailbox.
    const challenge = await twoFactor.startLogin(user, meta);
    return c.json({ twoFactorRequired: true, ...challenge });
  }
  loginIpLimiter.reset(ip);
  loginAccountLimiter.reset(account);
  const { token } = await auth.completeLogin(user, meta, { twoFactor: false });
  setSessionCookie(c, token);
  return c.json({ user: user.toPublic() });
});

authRoutes.post("/login/verify", async (c) => {
  const ip = clientIp(c) ?? "unknown";
  limit(codeLimiter, ip, c);
  const body = await parseBody(c, VerifyCodeBody);
  const meta = sessionMeta(c);
  const { user, method } = await twoFactor.verifyLogin(
    body.challengeId,
    body.code,
    body.method,
    meta.ip,
  );
  loginIpLimiter.reset(ip);
  loginAccountLimiter.reset(user.email);
  const { token } = await auth.completeLogin(user, meta, { twoFactor: method });
  setSessionCookie(c, token);
  return c.json({ user: user.toPublic() });
});

authRoutes.post("/login/resend", async (c) => {
  const ip = clientIp(c) ?? "unknown";
  limit(codeLimiter, ip, c);
  const body = await parseBody(c, ChallengeRef);
  return c.json(await twoFactor.resend(body.challengeId, "login", clientIp(c)));
});

authRoutes.post("/logout", async (c) => {
  const session = c.get("session");
  if (session) await auth.logout(session, clientIp(c));
  deleteCookie(c, auth.SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/me", requireAuth, (c) => c.json({ user: currentUser(c).toPublic() }));

authRoutes.post("/password", requireAuth, async (c) => {
  browserOnly(c);
  const body = await parseBody(c, ChangePasswordBody);
  await auth.changePassword(currentUser(c), body.currentPassword, body.newPassword, {
    ip: clientIp(c),
    keepSessionId: c.get("session")?.id ?? null,
  });
  return c.json({ ok: true });
});

// ---- forgotten password (signed out) ----
authRoutes.post("/password/forgot", async (c) => {
  limit(resetIpLimiter, clientIp(c) ?? "unknown", c);
  const body = await parseBody(c, ForgotPasswordBody);
  limit(resetAccountLimiter, body.email.toLowerCase(), c);
  await passwordReset.requestReset(body.email, sessionMeta(c));
  return c.json({ ok: true });
});

authRoutes.post("/password/reset", async (c) => {
  limit(codeLimiter, clientIp(c) ?? "unknown", c);
  const body = await parseBody(c, ResetPasswordBody);
  const user = await passwordReset.resetPassword(body.token, body.newPassword, clientIp(c));
  // The owner knows the password again, so lift any lockout from failed sign-ins. Every session
  // was ended, this browser's included.
  loginAccountLimiter.reset(user.email);
  deleteCookie(c, auth.SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// ---- two-factor authentication for the current user ----
authRoutes.get("/2fa", requireAuth, async (c) => c.json(await twoFactor.status(currentUser(c))));

// Email codes: a code is sent first, so a mailbox that cannot receive is never depended on.
authRoutes.post("/2fa/enable/start", requireAuth, async (c) => {
  browserOnly(c);
  limit(codeLimiter, clientIp(c) ?? "unknown", c);
  return c.json(await twoFactor.startEmail(currentUser(c), sessionMeta(c)));
});

authRoutes.post("/2fa/enable/resend", requireAuth, async (c) => {
  browserOnly(c);
  limit(codeLimiter, clientIp(c) ?? "unknown", c);
  const body = await parseBody(c, ChallengeRef);
  return c.json(await twoFactor.resend(body.challengeId, "enable", clientIp(c)));
});

authRoutes.post("/2fa/enable/confirm", requireAuth, async (c) => {
  browserOnly(c);
  limit(codeLimiter, clientIp(c) ?? "unknown", c);
  const body = await parseBody(c, VerifyCodeBody);
  const user = currentUser(c);
  const recoveryCodes = await twoFactor.confirmEmail(
    user,
    body.challengeId,
    body.code,
    clientIp(c),
  );
  return c.json({ user: user.toPublic(), recoveryCodes });
});

// Authenticator app (TOTP): starting needs the password, confirming needs a code from the app.
authRoutes.post("/2fa/totp/start", requireAuth, async (c) => {
  browserOnly(c);
  limit(loginAccountLimiter, currentUser(c).email, c);
  const body = await parseBody(c, PasswordBody);
  return c.json(await twoFactor.startTotp(currentUser(c), body.password));
});

authRoutes.post("/2fa/totp/confirm", requireAuth, async (c) => {
  browserOnly(c);
  limit(codeLimiter, clientIp(c) ?? "unknown", c);
  const body = await parseBody(c, TotpConfirmBody);
  const user = currentUser(c);
  const recoveryCodes = await twoFactor.confirmTotp(user, body.code, clientIp(c));
  return c.json({ user: user.toPublic(), recoveryCodes });
});

authRoutes.post("/2fa/disable", requireAuth, async (c) => {
  browserOnly(c);
  limit(loginAccountLimiter, currentUser(c).email, c);
  const body = await parseBody(c, DisableTwoFactorBody);
  await twoFactor.disable(currentUser(c), body.method, body.password, clientIp(c));
  return c.json({ user: currentUser(c).toPublic() });
});

authRoutes.post("/2fa/recovery-codes", requireAuth, async (c) => {
  browserOnly(c);
  limit(loginAccountLimiter, currentUser(c).email, c);
  const body = await parseBody(c, PasswordBody);
  const recoveryCodes = await twoFactor.regenerateRecoveryCodes(
    currentUser(c),
    body.password,
    clientIp(c),
  );
  return c.json({ recoveryCodes });
});

// ---- personal API tokens ----
authRoutes.get(
  "/tokens",
  requireAuth,
  async (c) => c.json({ items: await listTokens(currentUser(c).id) }),
);
authRoutes.post("/tokens", requireAuth, async (c) => {
  if (c.get("apiToken")) throw forbidden("Tokens cannot mint tokens; use a browser session");
  const body = await parseBody(
    c,
    z.object({
      name: z.string().min(1).max(120),
      expiresInDays: z.number().int().min(1).max(3650).nullable().default(90),
    }),
  );
  const res = await createToken(currentUser(c).id, body.name, body.expiresInDays);
  await auditFrom(c, "api_token.create", { type: "api_token", id: res.token.id }, {
    name: body.name,
  });
  return c.json(res, 201);
});
authRoutes.delete("/tokens/:id", requireAuth, async (c) => {
  const id = idParam(c);
  await revokeToken(currentUser(c).id, id);
  await auditFrom(c, "api_token.revoke", { type: "api_token", id });
  return c.json({ ok: true });
});
