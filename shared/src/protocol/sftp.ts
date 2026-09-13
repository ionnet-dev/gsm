/**
 * SFTP. The agent serves SFTP on one port per node and asks the server about every sign-in with
 * `sftp.auth`, the one agent -> server request. Mirrored in agent/internal/protocol/types.go.
 */
import { z } from "zod";

/** Sent in agent.configure; `port: null` turns SFTP off on the node. */
export const SftpConfig = z.object({
  port: z.number().int().min(1).max(65535).nullable(),
  bindAddress: z.string(),
});
export type SftpConfig = z.infer<typeof SftpConfig>;

/** The agent's answer to agent.configure. */
export const SftpStatus = z.object({
  listening: z.boolean(),
  port: z.number().int().nullable(),
  /** Fingerprint of the agent's host key, "SHA256:…". */
  hostKey: z.string(),
  /** Why it is not listening (port taken, …); null when fine or turned off. */
  error: z.string().nullable(),
});
export type SftpStatus = z.infer<typeof SftpStatus>;

export const SFTP_AUTH_METHODS = ["password", "publickey"] as const;
export type SftpAuthMethod = (typeof SFTP_AUTH_METHODS)[number];

/** `username` is `<sftp name>.<first 8 characters of the instance uuid>`, passed on verbatim. */
export const SftpAuthParams = z.object({
  username: z.string().max(200),
  method: z.enum(SFTP_AUTH_METHODS),
  password: z.string().max(1024).optional(),
  /** authorized_keys form: "ssh-ed25519 AAAA…". */
  publicKey: z.string().max(16_384).optional(),
  remoteAddress: z.string().max(100),
});
export type SftpAuthParams = z.infer<typeof SftpAuthParams>;

export const SftpAuthResult = z.object({
  allowed: z.boolean(),
  userId: z.number().int().optional(),
  uuid: z.string().optional(),
  /** Opaque; handed back in sftp.sessions so the server can re-check the session later. */
  credential: z.string().optional(),
});
export type SftpAuthResult = z.infer<typeof SftpAuthResult>;

export const SftpSession = z.object({
  id: z.string(),
  userId: z.number().int(),
  uuid: z.string(),
  method: z.enum(SFTP_AUTH_METHODS),
  credential: z.string(),
  remoteAddress: z.string(),
  openedAt: z.string(),
});
export type SftpSession = z.infer<typeof SftpSession>;

export const SftpStats = z.object({
  uploads: z.number().int().nonnegative(),
  downloads: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  renamed: z.number().int().nonnegative(),
  mkdirs: z.number().int().nonnegative(),
  bytesIn: z.number().int().nonnegative(),
  bytesOut: z.number().int().nonnegative(),
});
export type SftpStats = z.infer<typeof SftpStats>;

/** One SSH connection: "opened" once signed in, "closed" with what it did. */
export const SftpSessionEvent = z.object({
  id: z.string(),
  state: z.enum(["opened", "closed"]),
  userId: z.number().int(),
  uuid: z.string(),
  method: z.enum(SFTP_AUTH_METHODS),
  remoteAddress: z.string(),
  stats: SftpStats.nullish(),
});
export type SftpSessionEvent = z.infer<typeof SftpSessionEvent>;

/** Server -> agent. */
export const sftpMethods = {
  /** Open sessions, optionally only those of some users. */
  "sftp.sessions": {
    params: z.object({ userIds: z.array(z.number().int()).optional() }),
    result: z.object({ sessions: z.array(SftpSession) }),
  },
  "sftp.disconnect": {
    params: z.object({ ids: z.array(z.string()) }),
    result: z.object({ closed: z.number().int() }),
  },
} as const;

/** Agent -> server events. */
export const sftpEvents = { "sftp.session": SftpSessionEvent } as const;

/** Method table: agent -> server requests. */
export const serverMethods = {
  "sftp.auth": { params: SftpAuthParams, result: SftpAuthResult },
} as const;
export type ServerMethod = keyof typeof serverMethods;
