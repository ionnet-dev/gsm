import type { Context } from "hono";
import { type IncludeOptions, Op, type WhereOptions } from "sequelize";
import { AuditEntry, User } from "../../db/models.ts";
import { config } from "../../config.ts";
import { clientIp } from "../../lib/http.ts";
import { log } from "../../lib/logger.ts";
import type { AppEnv } from "../../app.ts";

export interface AuditInput {
  actorUserId: number | null;
  action: string;
  targetType?: string;
  targetId?: number | null;
  details?: Record<string, unknown>;
  ip?: string | null;
}

export async function record(input: AuditInput): Promise<void> {
  try {
    await AuditEntry.create({
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      details: input.details ?? null,
      ip: input.ip ?? null,
    });
  } catch (err) {
    log.child("audit").error("failed to write audit entry", { err, action: input.action });
  }
}

/** Record an action performed by the current request's user. */
export function auditFrom(
  c: Context<AppEnv>,
  action: string,
  target?: { type: string; id?: number | null },
  details?: Record<string, unknown>,
): Promise<void> {
  return record({
    actorUserId: c.get("user")?.id ?? null,
    action,
    targetType: target?.type,
    targetId: target?.id ?? null,
    details,
    ip: clientIp(c),
  });
}

const withActor: IncludeOptions = { model: User, as: "actor", attributes: ["id", "name", "email"] };

export function entryDto(e: AuditEntry) {
  return {
    id: e.id,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId,
    details: e.details,
    ip: e.ip,
    createdAt: e.createdAt.toISOString(),
    actor: e.actor ? { id: e.actor.id, name: e.actor.name, email: e.actor.email } : null,
  };
}
type EntryDto = ReturnType<typeof entryDto>;

export async function list(
  opts: {
    page: number;
    pageSize: number;
    action?: string;
    actorUserId?: number;
    targetType?: string;
    targetId?: number;
  },
) {
  const where: Record<string, unknown> = {};
  if (opts.action) where.action = opts.action;
  if (opts.actorUserId) where.actorUserId = opts.actorUserId;
  if (opts.targetType) where.targetType = opts.targetType;
  if (opts.targetId) where.targetId = opts.targetId;
  const { rows, count } = await AuditEntry.findAndCountAll({
    where,
    include: [withActor],
    order: [["id", "DESC"]],
    limit: opts.pageSize,
    offset: (opts.page - 1) * opts.pageSize,
  });
  return {
    items: rows.map(entryDto),
    total: count,
    page: opts.page,
    pageSize: opts.pageSize,
  };
}

// ---------------------------------------------------------------------------
// Export and archive
// ---------------------------------------------------------------------------

export const EXPORT_FORMATS = ["csv", "jsonl"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportFilter {
  action?: string;
  actorUserId?: number;
  from?: Date;
  to?: Date;
}

const EXPORT_PAGE = 1000;
const ARCHIVE_BATCH = 5000;
const CSV_HEADER =
  "id,created_at,actor_email,actor_name,action,target_type,target_id,ip,details\r\n";

/**
 * One CSV cell: quoted when it holds a delimiter, and prefixed with ' when a string starts like a
 * spreadsheet formula, because details carry machine names and commands that users typed.
 */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function csvLine(e: EntryDto): string {
  const cells = [
    e.id,
    e.createdAt,
    e.actor?.email,
    e.actor?.name,
    e.action,
    e.targetType,
    e.targetId,
    e.ip,
    e.details,
  ];
  return cells.map(csvCell).join(",") + "\r\n";
}

const jsonLine = (e: EntryDto) => JSON.stringify(e) + "\n";

function exportWhere(f: ExportFilter, afterId: number): WhereOptions {
  const createdAt: Record<symbol, Date> = {};
  if (f.from) createdAt[Op.gte] = f.from;
  if (f.to) createdAt[Op.lt] = f.to;
  return {
    id: { [Op.gt]: afterId },
    ...(f.action ? { action: f.action } : {}),
    ...(f.actorUserId ? { actorUserId: f.actorUserId } : {}),
    ...(f.from || f.to ? { createdAt } : {}),
  };
}

/** Matching entries oldest first, fetched a page at a time so a large log never sits in memory. */
export function exportStream(
  format: ExportFormat,
  filter: ExportFilter,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const line = format === "csv" ? csvLine : jsonLine;
  let head = format === "csv" ? CSV_HEADER : "";
  let afterId = 0;
  return new ReadableStream({
    async pull(ctrl) {
      const rows = await AuditEntry.findAll({
        where: exportWhere(filter, afterId),
        include: [withActor],
        order: [["id", "ASC"]],
        limit: EXPORT_PAGE,
      });
      if (rows.length) afterId = rows[rows.length - 1].id;
      ctrl.enqueue(enc.encode(head + rows.map((r) => line(entryDto(r))).join("")));
      head = "";
      if (rows.length < EXPORT_PAGE) ctrl.close();
    },
  });
}

export const archiveDir = () => `${config.DATA_DIR}/archive/audit`;

/**
 * Move entries created before `before` into gzip'd JSON-lines files, then delete them. Each file is
 * complete (written to .tmp, then renamed) before its rows are deleted, so an interruption can
 * leave an entry in two places but never in none.
 */
export async function archiveAndPrune(before: Date, dir = archiveDir()) {
  const files: string[] = [];
  let archived = 0;
  for (;;) {
    const rows = await AuditEntry.findAll({
      where: { createdAt: { [Op.lt]: before } },
      include: [withActor],
      order: [["id", "ASC"]],
      limit: ARCHIVE_BATCH,
    });
    if (!rows.length) break;
    const first = rows[0];
    const last = rows[rows.length - 1];
    const name = `audit-${day(first.createdAt)}_${
      day(last.createdAt)
    }_${first.id}-${last.id}.jsonl.gz`;
    await Deno.mkdir(dir, { recursive: true });
    await writeGzip(`${dir}/${name}`, rows.map((r) => jsonLine(entryDto(r))).join(""));
    await AuditEntry.destroy({ where: { id: rows.map((r) => r.id) } });
    files.push(name);
    archived += rows.length;
    if (rows.length < ARCHIVE_BATCH) break;
  }
  if (archived) {
    await record({
      actorUserId: null,
      action: "audit.archived",
      details: { count: archived, before: before.toISOString(), dir, files },
    });
  }
  return { archived, files };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

async function writeGzip(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`;
  const gz = ReadableStream.from([new TextEncoder().encode(text)])
    .pipeThrough(new CompressionStream("gzip"));
  await Deno.writeFile(tmp, gz);
  await Deno.rename(tmp, path);
}
