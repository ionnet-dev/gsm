/**
 * Files inside one instance's data directory: browse, read, edit, and transfer. Paths are relative
 * to the instance root ("" or "." is the root); the agent refuses anything that resolves outside
 * it, symlinks included. Small operations are plain requests; file bytes never ride the control
 * socket. For an upload the agent fetches them from the server (GET /api/v1/agents/transfers/:token),
 * for a download it posts them there.
 */
import { z } from "zod";
import { InstanceUuid } from "./instances.ts";

export const FILE_TYPES = ["file", "dir", "symlink", "other"] as const;
export type FileType = (typeof FILE_TYPES)[number];

/** Relative to the instance root, at most 1024 bytes, no NUL, no `..` segment. */
export const FILE_PATH_MAX = 1024;
export const InstancePath = z.string().max(FILE_PATH_MAX).refine(
  (p) => !p.includes("\0") && !p.split("/").includes("..") && !p.startsWith("/"),
  "Must be a relative path inside the instance",
);

/** Permission bits, 0 to 0o777. */
export const FileMode = z.number().int().min(0).max(0o777);

export const FileEntry = z.object({
  name: z.string(),
  type: z.enum(FILE_TYPES),
  size: z.number().int().nonnegative(),
  mode: FileMode,
  mtime: z.string().datetime(),
  /** What a symlink resolves to inside the instance; null when broken or outside it. */
  targetType: z.enum(FILE_TYPES).nullable(),
});
export type FileEntry = z.infer<typeof FileEntry>;

/** At most this many entries of a directory are listed; the rest is reported as truncated. */
export const FILE_LIST_MAX = 10_000;

export const FileListResult = z.object({
  /** The directory actually listed, cleaned ("" for the root). */
  path: z.string(),
  entries: z.array(FileEntry),
  truncated: z.boolean(),
});
export type FileListResult = z.infer<typeof FileListResult>;

export const FileReadResult = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  mtime: z.string().datetime(),
  mode: FileMode,
  /** Of the whole file; "" when it was too large to read. */
  sha256: z.string(),
  /** Over the limit the server asked for: nothing was read. */
  tooLarge: z.boolean(),
  /** Holds NUL bytes or isn't UTF-8: no content is sent. */
  binary: z.boolean(),
  content: z.string().nullable(),
});
export type FileReadResult = z.infer<typeof FileReadResult>;

export const FileWriteResult = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
  mtime: z.string().datetime(),
});
export type FileWriteResult = z.infer<typeof FileWriteResult>;

export const FileTransferResult = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string(),
});
export type FileTransferResult = z.infer<typeof FileTransferResult>;

const opId = z.string().min(1).max(64);
const token = z.string().min(16).max(128);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = InstanceUuid;

export const fileMethods = {
  "fs.list": { params: z.object({ uuid, path: InstancePath }), result: FileListResult },
  "fs.stat": {
    params: z.object({ uuid, path: InstancePath }),
    /** `entry.name` is the base name; symlinks are not followed. */
    result: z.object({ path: z.string(), entry: FileEntry }),
  },
  "fs.read": {
    params: z.object({ uuid, path: InstancePath, maxBytes: z.number().int().min(1).max(16 << 20) }),
    result: FileReadResult,
  },
  /**
   * Replace (or, with `create`, add) a text file: written beside it and renamed over it. Refused
   * when `expectSha256` no longer matches (someone changed it).
   */
  "fs.write": {
    params: z.object({
      uuid,
      path: InstancePath,
      content: z.string(),
      expectSha256: sha256.nullable(),
      create: z.boolean(),
    }),
    result: FileWriteResult,
  },
  "fs.mkdir": {
    params: z.object({ uuid, path: InstancePath }),
    result: z.object({ path: z.string() }),
  },
  /** Rename or move inside the instance; refused when `to` exists. */
  "fs.rename": {
    params: z.object({ uuid, from: InstancePath, to: InstancePath }),
    result: z.object({ path: z.string() }),
  },
  /** Deletes files and directories (recursively); refuses the root itself. */
  "fs.delete": {
    params: z.object({ uuid, paths: z.array(InstancePath).min(1).max(1000) }),
    result: z.object({ deleted: z.number().int() }),
  },
  /** chmod on files or directories (not recursive into symlinks). */
  "fs.chmod": {
    params: z.object({
      uuid,
      paths: z.array(InstancePath).min(1).max(1000),
      mode: FileMode,
      recursive: z.boolean(),
    }),
    result: z.object({ changed: z.number().int() }),
  },
  /** Unpack a .zip, .tar, .tar.gz or .tgz inside the instance (entries outside `dest` are refused). */
  "fs.extract": {
    params: z.object({ uuid, path: InstancePath, dest: InstancePath }),
    result: z.object({ files: z.number().int() }),
  },
  /** Pack `paths` into `dest` (.tar.gz or .zip by extension). */
  "fs.compress": {
    params: z.object({
      uuid,
      paths: z.array(InstancePath).min(1).max(1000),
      dest: InstancePath,
    }),
    result: FileTransferResult,
  },
  /** Stops a running fs.upload, fs.download, fs.extract or fs.compress. */
  "fs.cancel": { params: z.object({ opId }), result: z.object({}) },
  /**
   * Fetch `size` bytes from the transfer `token` into `path`: written beside it, checked against
   * the server's SHA-256 (`GET …/:token/digest`), then renamed into place.
   */
  "fs.upload": {
    params: z.object({
      opId,
      token,
      uuid,
      path: InstancePath,
      size: z.number().int().nonnegative(),
      overwrite: z.boolean(),
    }),
    result: FileTransferResult,
  },
  /**
   * Post one regular file (`archive` false), or a gzipped tar of `paths` (named relative to their
   * common parent), to the transfer `token`.
   */
  "fs.download": {
    params: z.object({
      opId,
      token,
      uuid,
      paths: z.array(InstancePath).min(1).max(1000),
      archive: z.boolean(),
    }),
    result: FileTransferResult,
  },
} as const;
