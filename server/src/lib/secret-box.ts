/**
 * Authenticated encryption for small secrets the server must read back (authenticator seeds).
 * AES-256-GCM under a key derived from SESSION_SECRET with HKDF, so a database dump alone does not
 * reveal them. `context` is bound in as associated data (e.g. `totp:<userId>`), so a sealed value
 * copied to another row does not open. Changing SESSION_SECRET makes every sealed value unreadable:
 * `open` then returns null.
 */
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { config } from "../config.ts";

const VERSION = "v1";
const IV_BYTES = 12;
const utf8 = (s: string) => new TextEncoder().encode(s);

let keyPromise: Promise<CryptoKey> | null = null;

function key(): Promise<CryptoKey> {
  keyPromise ??= (async () => {
    const base = await crypto.subtle.importKey(
      "raw",
      utf8(config.SESSION_SECRET),
      "HKDF",
      false,
      ["deriveKey"],
    );
    return await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: utf8("ionnet-gsm"), info: utf8("secret-box v1") },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  })();
  return keyPromise;
}

export async function seal(plain: Uint8Array<ArrayBuffer>, context: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8(context) },
      await key(),
      plain,
    ),
  );
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv);
  out.set(sealed, IV_BYTES);
  return `${VERSION}:${encodeBase64(out)}`;
}

export async function open(
  value: string,
  context: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const [version, body] = value.split(":", 2);
  if (version !== VERSION || !body) return null;
  try {
    const raw = decodeBase64(body);
    if (raw.length <= IV_BYTES) return null;
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: raw.slice(0, IV_BYTES), additionalData: utf8(context) },
        await key(),
        raw.slice(IV_BYTES),
      ),
    );
  } catch {
    return null; // tampered, wrong context, or sealed under a different SESSION_SECRET
  }
}
