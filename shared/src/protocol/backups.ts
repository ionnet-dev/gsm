/**
 * Backups are gzipped tars of an instance's data directory, kept on the node under
 * <dataDir>/backups/<uuid>/<backupId>.tar.gz. Creating and restoring stream progress; the archive
 * travels to the browser through the same transfer relay as file downloads.
 */
import { z } from "zod";
import { DatabaseSpec, InstanceUuid } from "./instances.ts";

export const BackupId = z.string().uuid();

export const BackupProgress = z.object({
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
});

export const backupMethods = {
  /**
   * Archive the data directory, leaving out paths that match `ignore` (gitignore-style globs).
   * With `database`, a dump of it goes into the archive as .gsm/database.sql.gz.
   */
  "backup.create": {
    params: z.object({
      uuid: InstanceUuid,
      backupId: BackupId,
      ignore: z.array(z.string().max(200)).max(200),
      database: DatabaseSpec.nullable().default(null),
    }),
    result: z.object({
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      files: z.number().int().nonnegative(),
    }),
    stream: BackupProgress,
  },
  /**
   * Unpack the archive over the data directory (with `wipe`, empty it first). Refused while the
   * instance runs. With `database`, a dump in the archive replaces the database's contents.
   */
  "backup.restore": {
    params: z.object({
      uuid: InstanceUuid,
      backupId: BackupId,
      wipe: z.boolean(),
      database: DatabaseSpec.nullable().default(null),
    }),
    result: z.object({ files: z.number().int().nonnegative() }),
    stream: BackupProgress,
  },
  "backup.delete": {
    params: z.object({ uuid: InstanceUuid, backupId: BackupId }),
    result: z.object({}),
  },
  /** Post the archive to the transfer `token` (see fs.download). */
  "backup.download": {
    params: z.object({
      opId: z.string().min(1).max(64),
      token: z.string().min(16).max(128),
      uuid: InstanceUuid,
      backupId: BackupId,
    }),
    result: z.object({
      size: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  },
  /** What is on disk, for reconciling after a lost result. */
  "backup.list": {
    params: z.object({ uuid: InstanceUuid }),
    result: z.object({
      backups: z.array(
        z.object({ backupId: BackupId, size: z.number().int(), mtime: z.string().datetime() }),
      ),
    }),
  },
} as const;
