import { z } from "zod";
import type { BackupStatus } from "../enums.ts";

export interface BackupDto {
  id: number;
  backupId: string;
  instanceId: number;
  name: string;
  status: BackupStatus;
  size: number | null;
  sha256: string | null;
  files: number | null;
  error: string | null;
  /** Progress while running, bytes archived so far. */
  progressBytes: number;
  /** Whether the archive is still on the node (deleted by hand otherwise). */
  createdBy: { id: number; name: string } | null;
  createdAt: string;
  completedAt: string | null;
}

export const CreateBackupBody = z.object({
  name: z.string().max(120).default(""),
  /** Globs to leave out, on top of the template's defaults. */
  ignore: z.array(z.string().max(200)).max(100).default([]),
});

export const RestoreBackupBody = z.object({
  /** Empty the data directory before unpacking. */
  wipe: z.boolean().default(false),
});
