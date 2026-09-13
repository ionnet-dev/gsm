/**
 * Files inside an instance's data directory, proxied live to the node (fs.*). Nothing is stored:
 * reads, edits and transfers go straight through, and each one is audit-logged on the instance.
 * Uploads and downloads stream through the relay in `transfers.ts`, never the control socket.
 */
import type { Context } from "hono";
import { baseName, type FileTransferResult, RPC_ERROR_CODES } from "@gsm/shared";
import type { AppEnv } from "../../app.ts";
import { badRequest, conflict, HttpError, notFound } from "../../lib/errors.ts";
import { randomId } from "../../lib/ids.ts";
import { log } from "../../lib/logger.ts";
import { agentGateway, AgentRpcError } from "../../ws/agent-gateway.ts";
import { auditFrom } from "../audit/service.ts";
import { currentUser } from "../auth/middleware.ts";
import type { Instance } from "../instances/models.ts";
import { getFilesSettings } from "../settings/service.ts";
import { type Arrival, Tally, TransferError, transfers } from "./transfers.ts";
import { claimTicket, contentDisposition, issueTicket, type Ticket } from "./tickets.ts";

const flog = log.child("files");
type Ctx = Context<AppEnv>;

const OP_TIMEOUT_MS = 60_000;
const TREE_TIMEOUT_MS = 10 * 60_000;
const TRANSFER_TIMEOUT_MS = 12 * 3_600_000;

const target = (i: Instance) => ({ type: "instance", id: i.id });
const errText = (err: unknown) => err instanceof Error ? err.message : String(err);

export const tooLarge = (limit: number) =>
  new HttpError(
    413,
    "too_large",
    `Larger than the ${formatBytes(limit)} limit (Settings → General)`,
  );

export function formatBytes(n: number): string {
  const units = ["bytes", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function assertConnected(i: Instance) {
  if (!agentGateway.isConnected(i.nodeId)) throw conflict("The node is not connected");
}

export async function limits() {
  return await getFilesSettings();
}

export function list(i: Instance, path: string) {
  return agentGateway.request(i.nodeId, "fs.list", { uuid: i.uuid, path }, {
    timeoutMs: OP_TIMEOUT_MS,
  });
}

export function stat(i: Instance, path: string) {
  return agentGateway.request(i.nodeId, "fs.stat", { uuid: i.uuid, path }, {
    timeoutMs: OP_TIMEOUT_MS,
  });
}

export async function read(c: Ctx, i: Instance, path: string) {
  const { viewMaxBytes } = await getFilesSettings();
  const res = await agentGateway.request(i.nodeId, "fs.read", {
    uuid: i.uuid,
    path,
    maxBytes: viewMaxBytes,
  }, { timeoutMs: OP_TIMEOUT_MS });
  if (res.content !== null) {
    await auditFrom(c, "file.view", target(i), { path: res.path, size: res.size });
  }
  return { ...res, limit: viewMaxBytes };
}

export async function write(
  c: Ctx,
  i: Instance,
  body: { path: string; content: string; expectSha256: string | null; create: boolean },
) {
  const { viewMaxBytes } = await getFilesSettings();
  const bytes = new TextEncoder().encode(body.content).byteLength;
  if (bytes > viewMaxBytes) throw tooLarge(viewMaxBytes);
  try {
    const res = await agentGateway.request(i.nodeId, "fs.write", { uuid: i.uuid, ...body }, {
      timeoutMs: OP_TIMEOUT_MS,
    });
    await auditFrom(c, body.create ? "file.create" : "file.write", target(i), {
      path: res.path,
      size: res.size,
      sha256: res.sha256,
    });
    return res;
  } catch (err) {
    if (err instanceof AgentRpcError && (err.rpc.data as { conflict?: boolean })?.conflict) {
      throw new HttpError(409, "file_changed", err.message);
    }
    throw err;
  }
}

export async function mkdir(c: Ctx, i: Instance, path: string) {
  const res = await agentGateway.request(i.nodeId, "fs.mkdir", { uuid: i.uuid, path }, {
    timeoutMs: OP_TIMEOUT_MS,
  });
  await auditFrom(c, "file.mkdir", target(i), { path: res.path });
  return res;
}

export async function rename(c: Ctx, i: Instance, from: string, to: string) {
  const res = await agentGateway.request(i.nodeId, "fs.rename", { uuid: i.uuid, from, to }, {
    timeoutMs: OP_TIMEOUT_MS,
  });
  await auditFrom(c, "file.rename", target(i), { from, to: res.path });
  return res;
}

export async function remove(c: Ctx, i: Instance, paths: string[]) {
  try {
    const res = await agentGateway.request(i.nodeId, "fs.delete", { uuid: i.uuid, paths }, {
      timeoutMs: TREE_TIMEOUT_MS,
    });
    await auditFrom(c, "file.delete", target(i), { paths, ...res });
    return res;
  } catch (err) {
    await auditFrom(c, "file.delete", target(i), { paths, error: errText(err) });
    throw err;
  }
}

export async function chmod(
  c: Ctx,
  i: Instance,
  body: { paths: string[]; mode: number; recursive: boolean },
) {
  const res = await agentGateway.request(i.nodeId, "fs.chmod", { uuid: i.uuid, ...body }, {
    timeoutMs: body.recursive ? TREE_TIMEOUT_MS : OP_TIMEOUT_MS,
  });
  await auditFrom(c, "file.chmod", target(i), { ...body, mode: body.mode.toString(8), ...res });
  return res;
}

export async function extract(c: Ctx, i: Instance, path: string, dest: string) {
  const res = await agentGateway.request(i.nodeId, "fs.extract", { uuid: i.uuid, path, dest }, {
    timeoutMs: TREE_TIMEOUT_MS,
  });
  await auditFrom(c, "file.extract", target(i), { path, dest, ...res });
  return res;
}

export async function compress(c: Ctx, i: Instance, paths: string[], dest: string) {
  const res = await agentGateway.request(i.nodeId, "fs.compress", { uuid: i.uuid, paths, dest }, {
    timeoutMs: TREE_TIMEOUT_MS,
  });
  await auditFrom(c, "file.compress", target(i), { paths, dest, size: res.size });
  return res;
}

// ---- uploads ----

/**
 * Stream a browser upload straight to the node. The body must have a Content-Length, and is
 * relayed as it arrives; the agent writes it beside the destination and renames it into place
 * only if its SHA-256 matches what the server relayed.
 */
export async function upload(
  c: Ctx,
  i: Instance,
  opts: { path: string; overwrite: boolean },
  body: ReadableStream<Uint8Array> | null,
  size: number,
): Promise<FileTransferResult> {
  assertConnected(i);
  if (!body) throw badRequest("The upload has no body");
  const { transferMaxBytes } = await getFilesSettings();
  if (transferMaxBytes > 0 && size > transferMaxBytes) throw tooLarge(transferMaxBytes);
  const opId = randomId(9);
  const offer = transfers.offer(i.nodeId, body, size);
  const onAbort = () => {
    offer.cancel("The upload was cancelled");
    agentGateway.request(i.nodeId, "fs.cancel", { opId }).catch(() => {});
  };
  c.req.raw.signal.addEventListener("abort", onAbort);
  const details = { path: opts.path, size, overwrite: opts.overwrite };
  try {
    const res = await agentGateway.request(i.nodeId, "fs.upload", {
      opId,
      token: offer.token,
      uuid: i.uuid,
      size,
      ...opts,
    }, { timeoutMs: TRANSFER_TIMEOUT_MS });
    await auditFrom(c, "file.upload", target(i), { ...details, sha256: res.sha256 });
    return res;
  } catch (err) {
    offer.cancel(errText(err));
    const refused = err instanceof AgentRpcError && err.rpc.code === RPC_ERROR_CODES.invalidParams;
    if (!refused) await auditFrom(c, "file.upload", target(i), { ...details, error: errText(err) });
    throw err;
  } finally {
    c.req.raw.signal.removeEventListener("abort", onAbort);
  }
}

// ---- downloads ----

/** Check what is asked for and reserve a one-time download URL for the requester. */
export async function prepareDownload(c: Ctx, i: Instance, paths: string[]) {
  assertConnected(i);
  const { transferMaxBytes } = await getFilesSettings();
  let archive = paths.length > 1;
  let size: number | null = null;
  if (!archive) {
    const { entry } = await stat(i, paths[0]);
    const type = entry.type === "symlink" ? entry.targetType : entry.type;
    if (type === "dir") archive = true;
    else if (type !== "file") throw badRequest(`Not a regular file: ${paths[0]}`);
    else if (entry.type === "file") size = entry.size;
  }
  if (size !== null && transferMaxBytes > 0 && size > transferMaxBytes) {
    throw tooLarge(transferMaxBytes);
  }
  const filename = !archive
    ? baseName(paths[0])
    : paths.length === 1
    ? `${baseName(paths[0]) || i.name}.tar.gz`
    : `${i.name}-files.tar.gz`;
  const ticket = issueTicket({
    userId: currentUser(c).id,
    instanceId: i.id,
    nodeId: i.nodeId,
    filename,
    size,
    archive,
    kind: { type: "files", uuid: i.uuid, paths },
  });
  return { url: `/api/v1/files/downloads/${ticket}`, filename, archive, size };
}

/**
 * Serve a reserved download: ask the agent to post the bytes and pass them to the browser as they
 * come. The last chunk is held back until the agent has confirmed the SHA-256 the server counted,
 * so a corrupted transfer fails in the browser instead of landing as a damaged file.
 */
export async function download(c: Ctx, ticketId: string): Promise<Response> {
  const t = claimTicket(ticketId, currentUser(c).id);
  if (!t) throw notFound("Download");
  if (!agentGateway.isConnected(t.nodeId)) throw conflict("The node is not connected");
  const { transferMaxBytes } = await getFilesSettings();
  const opId = randomId(9);
  const incoming = transfers.expect(t.nodeId);
  const started = Date.now();
  const action = t.kind.type === "files" ? "file.download" : "backup.download";
  const details = t.kind.type === "files"
    ? { paths: t.kind.paths, archive: t.archive }
    : { backupId: t.kind.backupId };
  const audit = (extra: Record<string, unknown>) =>
    auditFrom(c, action, { type: "instance", id: t.instanceId }, {
      ...details,
      ...extra,
      durationSeconds: Math.round((Date.now() - started) / 1000),
    });

  const rpc = requestDownload(t, opId, incoming.token);
  rpc.catch(() => {});

  let arrival: Arrival;
  try {
    arrival = await Promise.race([
      incoming.arrival,
      rpc.then(() => {
        throw new TransferError("The node finished without sending anything");
      }),
    ]);
  } catch (err) {
    incoming.cancel(errText(err));
    await audit({ error: errText(err) });
    throw err instanceof TransferError ? badRequest(err.message) : err;
  }

  const reader = arrival.body.getReader();
  const tally = new Tally();
  let held: Uint8Array | null = null;
  let finished = false;
  const fail = (message: string) => {
    if (finished) return;
    finished = true;
    arrival.complete({ error: message });
    reader.cancel(message).catch(() => {});
    agentGateway.request(t.nodeId, "fs.cancel", { opId }).catch(() => {});
    audit({ error: message, bytes: tally.bytes }).catch(() => {});
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { value, done } = await reader.read();
        if (!done) {
          tally.add(value);
          if (transferMaxBytes > 0 && tally.bytes > transferMaxBytes) {
            throw tooLarge(transferMaxBytes);
          }
          if (held) ctrl.enqueue(held);
          held = value;
          return;
        }
        const sha256 = tally.hex();
        arrival.complete({ sha256 });
        const res = await rpc;
        finished = true;
        if (held) ctrl.enqueue(held);
        ctrl.close();
        await audit({ size: res.size, sha256 });
      } catch (err) {
        fail(errText(err));
        ctrl.error(err);
      }
    },
    cancel() {
      fail("The browser cancelled the download");
    },
  });
  flog.debug("download started", { instanceId: t.instanceId, kind: t.kind.type });
  const headers: Record<string, string> = {
    "content-type": t.archive ? "application/gzip" : "application/octet-stream",
    "content-disposition": contentDisposition(t.filename),
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  };
  if (arrival.length !== null) headers["content-length"] = String(arrival.length);
  return new Response(body, { headers });
}

function requestDownload(t: Ticket, opId: string, token: string) {
  if (t.kind.type === "backup") {
    return agentGateway.request(t.nodeId, "backup.download", {
      opId,
      token,
      uuid: t.kind.uuid,
      backupId: t.kind.backupId,
    }, { timeoutMs: TRANSFER_TIMEOUT_MS });
  }
  return agentGateway.request(t.nodeId, "fs.download", {
    opId,
    token,
    uuid: t.kind.uuid,
    paths: t.kind.paths,
    archive: t.archive,
  }, { timeoutMs: TRANSFER_TIMEOUT_MS });
}
