/**
 * Pure helpers for SFTP sign-in: OpenSSH public keys and their fingerprints, SFTP names,
 * usernames and generated passwords.
 */

/** Key types the agent's SSH server accepts. */
export const SSH_KEY_TYPES = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
  "ssh-rsa",
] as const;

const MIN_RSA_BITS = 2048;

export interface ParsedKey {
  type: string;
  blob: Uint8Array;
  comment: string;
}

function readString(buf: Uint8Array, offset: number): { value: Uint8Array; next: number } | null {
  if (offset + 4 > buf.length) return null;
  const len = new DataView(buf.buffer, buf.byteOffset + offset, 4).getUint32(0);
  if (offset + 4 + len > buf.length) return null;
  return { value: buf.subarray(offset + 4, offset + 4 + len), next: offset + 4 + len };
}

function bitLength(mpint: Uint8Array): number {
  let i = 0;
  while (i < mpint.length && mpint[i] === 0) i++;
  if (i === mpint.length) return 0;
  return (mpint.length - i - 1) * 8 + (32 - Math.clz32(mpint[i]));
}

/** Parse one authorized_keys line ("type base64 [comment]"); an error message when it is not one. */
export function parsePublicKey(line: string): ParsedKey | string {
  const text = line.trim();
  if (text.includes("PRIVATE KEY")) {
    return "That is a private key. Paste the public one (the .pub file) instead";
  }
  const [type, b64, ...rest] = text.split(/\s+/);
  if (!type || !b64) return 'Paste a public key such as "ssh-ed25519 AAAA… you@laptop"';
  if (!(SSH_KEY_TYPES as readonly string[]).includes(type)) {
    return `Unsupported key type ${type}; use ed25519, ECDSA or RSA`;
  }
  let blob: Uint8Array;
  try {
    blob = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return "The key is not valid base64";
  }
  const inner = readString(blob, 0);
  if (!inner || new TextDecoder().decode(inner.value) !== type) {
    return "The key data does not match its type";
  }
  if (type === "ssh-rsa") {
    const e = readString(blob, inner.next);
    const n = e && readString(blob, e.next);
    if (!n) return "The key data is incomplete";
    if (bitLength(n.value) < MIN_RSA_BITS) return `RSA keys need at least ${MIN_RSA_BITS} bits`;
  } else if (!readString(blob, inner.next)) {
    return "The key data is incomplete";
  }
  return { type, blob, comment: rest.join(" ") };
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** OpenSSH's fingerprint: "SHA256:" and the unpadded base64 of the key blob's SHA-256. */
export async function fingerprint(blob: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", blob as BufferSource));
  return "SHA256:" + base64(digest).replace(/=+$/, "");
}

/** The stored form: type and key, no comment. */
export function canonicalKey(key: ParsedKey): string {
  return `${key.type} ${base64(key.blob)}`;
}

/** An SFTP name from an email: its local part, lowercased, letters, digits, `_` and `-` only. */
export function sftpNameBase(email: string): string {
  const local = email.split("@")[0].toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return local || "user";
}

/** The instance part of an SFTP username. */
export function shortId(uuid: string): string {
  return uuid.slice(0, 8);
}

const USERNAME_RE = /^([a-z0-9_-]{1,40})\.([0-9a-f]{8})$/;

/** `<sftp name>.<short instance id>`, case-insensitively; null when it is not one. */
export function parseSftpUsername(username: string): { name: string; shortId: string } | null {
  const m = USERNAME_RE.exec(username.trim().toLowerCase());
  return m ? { name: m[1], shortId: m[2] } : null;
}

const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A random password without look-alike characters (about 137 bits at the default length). */
export function generatePassword(length = 24): string {
  const out: string[] = [];
  const buf = new Uint8Array(1);
  while (out.length < length) {
    crypto.getRandomValues(buf);
    // Rejection sampling keeps every character equally likely.
    if (buf[0] < 256 - (256 % PASSWORD_ALPHABET.length)) {
      out.push(PASSWORD_ALPHABET[buf[0] % PASSWORD_ALPHABET.length]);
    }
  }
  return out.join("");
}
