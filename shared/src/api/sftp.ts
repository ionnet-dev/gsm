import { z } from "zod";
import type { SftpReachability } from "./reachability.ts";

/** How the requester reaches one instance over SFTP. */
export interface InstanceSftpDto {
  /** False when SFTP is off on the node or the node cannot serve it right now (see `problem`). */
  available: boolean;
  problem: string | null;
  host: string;
  port: number | null;
  /** `<sftp name>.<first 8 characters of the instance uuid>`. */
  username: string;
  /** The node's host key fingerprint ("SHA256:…"), to compare on the first connection. */
  hostKey: string | null;
  /** The requester's SFTP password for this instance, if they made one (never its value). */
  password: { createdAt: string; lastUsedAt: string | null } | null;
  /** How many SSH keys the requester has; every key works on every instance they manage files on. */
  sshKeys: number;
  /** The last check of the node's SFTP port from outside; null before the first. */
  reachable: SftpReachability | null;
}

export interface SshKeyDto {
  id: number;
  name: string;
  /** "ssh-ed25519", "ecdsa-sha2-nistp256", … */
  type: string;
  /** "SHA256:…", as `ssh-keygen -l` prints it. */
  fingerprint: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export const AddSshKeyBody = z.object({
  name: z.string().trim().min(1).max(120),
  /** One authorized_keys line: "ssh-ed25519 AAAA… comment". */
  publicKey: z.string().trim().min(1).max(16_384),
});
export type AddSshKeyBody = z.input<typeof AddSshKeyBody>;
