/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP) with the parameters Google
 * Authenticator and every other common app use: HMAC-SHA-1, 6 digits, 30-second steps.
 */
import { encodeBase32 } from "@std/encoding/base32";
import { timingSafeEqual } from "../../lib/ids.ts";

export const PERIOD_SECONDS = 30;
export const DIGITS = 6;
/** Steps accepted either side of the current one, for phones whose clock is a little off. */
export const DRIFT_STEPS = 1;

/** 160-bit seed, the size RFC 4226 recommends for SHA-1. */
export const generateSecret = (): Uint8Array<ArrayBuffer> =>
  crypto.getRandomValues(new Uint8Array(20));

/** Base32 without padding, the form apps accept for manual entry and in otpauth URLs. */
export const toBase32 = (secret: Uint8Array): string => encodeBase32(secret).replace(/=+$/, "");

export const stepAt = (ms: number): number => Math.floor(ms / 1000 / PERIOD_SECONDS);

export async function hotp(
  secret: Uint8Array<ArrayBuffer>,
  counter: number,
  digits = DIGITS,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const msg = new DataView(new ArrayBuffer(8));
  msg.setUint32(0, Math.floor(counter / 0x1_0000_0000));
  msg.setUint32(4, counter >>> 0);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg.buffer));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * The time step whose code equals `code`, checking the current step and DRIFT_STEPS either side,
 * or null. Every candidate is computed and compared so timing does not reveal which one matched.
 */
export async function matchStep(
  secret: Uint8Array<ArrayBuffer>,
  code: string,
  now = Date.now(),
): Promise<number | null> {
  if (code.length !== DIGITS || !/^\d+$/.test(code)) return null;
  const current = stepAt(now);
  let found: number | null = null;
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
    if (timingSafeEqual(await hotp(secret, step), code) && found === null) found = step;
  }
  return found;
}

/** Key URI understood by authenticator apps (and turned into the setup QR code). */
export function otpauthUrl(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD_SECONDS}`;
}
