/** Instance file manager: REST shapes and path helpers shared by the server and the web app. */
import { z } from "zod";
import { InstancePath } from "../protocol/files.ts";

/** Settings → General → Files. */
export const FilesSettings = z.object({
  /** Largest file the browser opens, edits or saves (default 2 MiB). */
  viewMaxBytes: z.number().int().min(4096).max(10 << 20).default(2 << 20),
  /** Largest upload or download; 0 = no limit (default 4 GiB). */
  transferMaxBytes: z.number().int().min(0).default(4 * 1024 ** 3),
});
export type FilesSettings = z.infer<typeof FilesSettings>;
export const DEFAULT_FILES_SETTINGS: FilesSettings = FilesSettings.parse({});

export const ListQuery = z.object({ path: InstancePath.default("") });
export const PathQuery = z.object({ path: InstancePath });
export const UploadQuery = z.object({
  path: InstancePath,
  overwrite: z.enum(["0", "1", "true", "false"]).default("0").transform((v) =>
    v === "1" || v === "true"
  ),
});
export const WriteBody = z.object({
  path: InstancePath,
  content: z.string(),
  expectSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  create: z.boolean().default(false),
});
export const MkdirBody = z.object({ path: InstancePath });
export const RenameBody = z.object({ from: InstancePath, to: InstancePath });
export const PathsBody = z.object({ paths: z.array(InstancePath).min(1).max(1000) });
export const ChmodBody = PathsBody.extend({
  mode: z.number().int().min(0).max(0o777),
  recursive: z.boolean().default(false),
});
export const ExtractBody = z.object({ path: InstancePath, dest: InstancePath.default("") });
export const CompressBody = PathsBody.extend({ dest: InstancePath });

/** `rwxr-xr-x` prefixed by the type letter. */
export function modeString(mode: number, type: "file" | "dir" | "symlink" | "other" = "file") {
  const kind = type === "dir" ? "d" : type === "symlink" ? "l" : type === "other" ? "?" : "-";
  const bit = (b: number, ch: string) => (mode & b ? ch : "-");
  return kind +
    bit(0o400, "r") + bit(0o200, "w") + bit(0o100, "x") +
    bit(0o040, "r") + bit(0o020, "w") + bit(0o010, "x") +
    bit(0o004, "r") + bit(0o002, "w") + bit(0o001, "x");
}

/** Octal as chmod takes it: "644", "755". */
export const modeOctal = (mode: number) => (mode & 0o777).toString(8).padStart(3, "0");

/** Join a directory and a name; "" is the instance root. */
export function joinPath(dir: string, name: string): string {
  const d = dir.replace(/\/+$/, "");
  return d ? `${d}/${name}` : name;
}

/** The parent directory; "" for the root and its children. */
export function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "" : trimmed.slice(0, i);
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "";
}

/** A name that can go in a directory: not empty, `.` or `..`, no slash or NUL. */
export function validFileName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name !== "." && name !== ".." &&
    !/[/\0]/.test(name);
}

/** Archives the file manager can unpack on the node. */
export function isArchiveName(name: string): boolean {
  return /\.(zip|tar|tar\.gz|tgz)$/i.test(name);
}
