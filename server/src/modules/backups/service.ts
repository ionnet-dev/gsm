/**
 * Backups: gzipped tars of an instance's data directory made by the agent and kept on the node.
 * The row tracks progress and the result; the archive travels to the browser through the file
 * transfer relay.
 */
import type { Context } from "hono";
import type { BackupDto } from "@gsm/shared";
import { isOutdatedVersion, RPC_ERROR_CODES } from "@gsm/shared";
import type { AppEnv } from "../../app.ts";
import { Backup, User } from "../../db/models.ts";
import { conflict, notFound } from "../../lib/errors.ts";
import { log } from "../../lib/logger.ts";
import { agentGateway, AgentRpcError } from "../../ws/agent-gateway.ts";
import { uiGateway } from "../../ws/ui-gateway.ts";
import * as audit from "../audit/service.ts";
import { currentUser } from "../auth/middleware.ts";
import { issueTicket } from "../files/tickets.ts";
import type { Instance } from "../instances/models.ts";
import { CONTAINER_OPTIONS_AGENT, databaseSpec, volumeBackupIgnore } from "../instances/spec.ts";
import { getHistoryRetention } from "../settings/service.ts";

const blog = log.child("backups");
const BACKUP_TIMEOUT_MS = 6 * 3_600_000;

export function backupDto(b: Backup): BackupDto {
  return {
    id: b.id,
    backupId: b.backupId,
    instanceId: b.instanceId,
    name: b.name,
    status: b.status,
    size: b.size,
    sha256: b.sha256,
    files: b.files,
    error: b.error,
    progressBytes: b.progressBytes,
    createdBy: b.creator ? { id: b.creator.id, name: b.creator.name } : null,
    createdAt: b.createdAt.toISOString(),
    completedAt: b.completedAt?.toISOString() ?? null,
  };
}

const withCreator = { include: [{ model: User, as: "creator", attributes: ["id", "name"] }] };

export async function list(instanceId: number): Promise<BackupDto[]> {
  const rows = await Backup.findAll({
    where: { instanceId },
    ...withCreator,
    order: [["createdAt", "DESC"]],
  });
  return rows.map(backupDto);
}

async function get(instanceId: number, backupId: string): Promise<Backup> {
  const b = await Backup.findOne({ where: { instanceId, backupId }, ...withCreator });
  if (!b) throw notFound("Backup");
  return b;
}

function assertOnline(i: Instance) {
  if (!agentGateway.isConnected(i.nodeId)) throw conflict("The node is not connected");
}

/** The database to dump into (or restore from) the archive; older agents cannot. */
function databaseFor(i: Instance) {
  const db = databaseSpec(i, i.template!.definition);
  if (db && isOutdatedVersion(i.node?.agentVersion, CONTAINER_OPTIONS_AGENT)) {
    throw conflict(
      `Backups of a database need agent ${CONTAINER_OPTIONS_AGENT} or newer; update the node's agent first`,
    );
  }
  return db;
}

const RUNNING = new Set(["running", "starting", "stopping", "installing"]);

function stamp(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${
    p(d.getMinutes())
  }`;
}

/** Start a backup; the row is returned at once and finishes in the background. */
export async function create(
  c: Context<AppEnv>,
  i: Instance,
  input: { name: string; ignore: string[] },
): Promise<BackupDto> {
  assertOnline(i);
  const database = databaseFor(i);
  const { backupsPerInstance } = await getHistoryRetention();
  if (backupsPerInstance > 0) {
    const count = await Backup.count({ where: { instanceId: i.id } });
    if (count >= backupsPerInstance) {
      throw conflict(
        `This instance already has ${count} backups (the limit is ${backupsPerInstance}); delete one first`,
      );
    }
  }
  const actor = currentUser(c);
  const row = await Backup.create({
    backupId: crypto.randomUUID(),
    instanceId: i.id,
    name: input.name.trim() || `${i.name} ${stamp()}`,
    createdBy: actor.id,
  });
  await audit.record({
    actorUserId: actor.id,
    action: "backup.create",
    targetType: "instance",
    targetId: i.id,
    details: { backupId: row.backupId, name: row.name },
  });
  const def = i.template!.definition;
  const ignore = [
    ...new Set([...def.backupIgnore, ...volumeBackupIgnore(def), ...input.ignore]),
  ];
  run(i, row, ignore, database).catch((err) =>
    blog.warn("backup failed", { id: row.id, err: String(err) })
  );
  return backupDto(await get(i.id, row.backupId));
}

async function run(
  i: Instance,
  row: Backup,
  ignore: string[],
  database: ReturnType<typeof databaseSpec>,
) {
  row.status = "running";
  await row.save();
  uiGateway.broadcast("backup.updated", { instanceId: i.id, backupId: row.backupId });
  let lastPush = 0;
  try {
    const res = await agentGateway.request(i.nodeId, "backup.create", {
      uuid: i.uuid,
      backupId: row.backupId,
      ignore,
      database,
    }, {
      timeoutMs: BACKUP_TIMEOUT_MS,
      onStream: async (chunk) => {
        row.progressBytes = chunk.bytes;
        if (Date.now() - lastPush >= 2000) {
          lastPush = Date.now();
          await row.save();
          uiGateway.broadcast("backup.updated", { instanceId: i.id, backupId: row.backupId });
        }
      },
    });
    row.status = "completed";
    row.size = res.size;
    row.sha256 = res.sha256;
    row.files = res.files;
    row.progressBytes = res.size;
    row.completedAt = new Date();
    blog.info("backup completed", { id: row.id, size: res.size, files: res.files });
  } catch (err) {
    row.status = "failed";
    row.error = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
    row.completedAt = new Date();
  }
  await row.save();
  uiGateway.broadcast("backup.updated", { instanceId: i.id, backupId: row.backupId });
}

export async function restore(
  c: Context<AppEnv>,
  i: Instance,
  backupId: string,
  wipe: boolean,
): Promise<void> {
  assertOnline(i);
  const b = await get(i.id, backupId);
  if (b.status !== "completed") throw conflict("Only a completed backup can be restored");
  if (RUNNING.has(i.status)) throw conflict("Stop the instance before restoring a backup");
  const database = databaseFor(i);
  await audit.record({
    actorUserId: currentUser(c).id,
    action: "backup.restore",
    targetType: "instance",
    targetId: i.id,
    details: { backupId, name: b.name, wipe },
  });
  const res = await agentGateway.request(i.nodeId, "backup.restore", {
    uuid: i.uuid,
    backupId,
    wipe,
    database,
  }, { timeoutMs: BACKUP_TIMEOUT_MS });
  blog.info("backup restored", { id: b.id, files: res.files });
  uiGateway.broadcast("instance.updated", { instanceId: i.id });
}

export async function prepareDownload(c: Context<AppEnv>, i: Instance, backupId: string) {
  assertOnline(i);
  const b = await get(i.id, backupId);
  if (b.status !== "completed") throw conflict("The backup is not complete");
  const filename = `${i.name.replace(/[^\w.-]+/g, "_")}-${stamp(b.createdAt)}.tar.gz`;
  const ticket = issueTicket({
    userId: currentUser(c).id,
    instanceId: i.id,
    nodeId: i.nodeId,
    filename,
    size: b.size,
    archive: true,
    kind: { type: "backup", uuid: i.uuid, backupId },
  });
  return { url: `/api/v1/files/downloads/${ticket}`, filename, size: b.size };
}

export async function remove(c: Context<AppEnv>, i: Instance, backupId: string): Promise<void> {
  const b = await get(i.id, backupId);
  if (b.status === "completed" || b.status === "failed") {
    if (agentGateway.isConnected(i.nodeId)) {
      try {
        await agentGateway.request(i.nodeId, "backup.delete", { uuid: i.uuid, backupId });
      } catch (err) {
        if (!(err instanceof AgentRpcError && err.rpc.code === RPC_ERROR_CODES.notFound)) throw err;
      }
    } else if (b.status === "completed") {
      throw conflict("The node is not connected; the archive cannot be removed right now");
    }
  } else throw conflict("The backup is still running");
  await b.destroy();
  await audit.record({
    actorUserId: currentUser(c).id,
    action: "backup.delete",
    targetType: "instance",
    targetId: i.id,
    details: { backupId, name: b.name },
  });
  uiGateway.broadcast("backup.updated", { instanceId: i.id, backupId });
}
