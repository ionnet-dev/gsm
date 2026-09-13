/**
 * The instance file manager (`files` permission), mounted under /instances/:id/files, plus the
 * top-level /files routes (limits, one-time downloads) and the agent's side of transfers under
 * /api/v1/agents/transfers (node token, no CSRF header).
 */
import { Hono } from "hono";
import {
  ChmodBody,
  CompressBody,
  ExtractBody,
  ListQuery,
  MkdirBody,
  PathQuery,
  PathsBody,
  RenameBody,
  UploadQuery,
  WriteBody,
} from "@gsm/shared";
import type { AppEnv } from "../../app.ts";
import { badRequest, HttpError, unauthorized } from "../../lib/errors.ts";
import { idParam, parseBody, parseQuery } from "../../lib/http.ts";
import { requireAuth } from "../auth/middleware.ts";
import { assertInstancePermission } from "../instances/access.ts";
import * as instances from "../instances/service.ts";
import * as nodes from "../nodes/service.ts";
import * as files from "./service.ts";
import { TransferError, transfers } from "./transfers.ts";

function contentLength(c: { req: { header: (n: string) => string | undefined } }): number {
  const n = Number(c.req.header("content-length"));
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new HttpError(411, "length_required", "The upload needs a Content-Length");
  }
  return n;
}

async function instanceFor(c: Parameters<typeof idParam>[0]) {
  const id = idParam(c);
  await assertInstancePermission(c, id, "files");
  return await instances.get(id);
}

// ---- /api/v1/instances/:id/files ----

export const instanceFileRoutes = new Hono<AppEnv>();

instanceFileRoutes.get("/", async (c) => {
  const i = await instanceFor(c);
  const q = parseQuery(c, ListQuery);
  return c.json(await files.list(i, q.path));
});
instanceFileRoutes.get("/stat", async (c) => {
  const i = await instanceFor(c);
  const q = parseQuery(c, PathQuery);
  return c.json(await files.stat(i, q.path));
});
instanceFileRoutes.get("/content", async (c) => {
  const i = await instanceFor(c);
  const q = parseQuery(c, PathQuery);
  return c.json(await files.read(c, i, q.path));
});
instanceFileRoutes.put("/content", async (c) => {
  const i = await instanceFor(c);
  return c.json(await files.write(c, i, await parseBody(c, WriteBody)));
});
instanceFileRoutes.post("/mkdir", async (c) => {
  const i = await instanceFor(c);
  const b = await parseBody(c, MkdirBody);
  return c.json(await files.mkdir(c, i, b.path), 201);
});
instanceFileRoutes.post("/rename", async (c) => {
  const i = await instanceFor(c);
  const b = await parseBody(c, RenameBody);
  return c.json(await files.rename(c, i, b.from, b.to));
});
instanceFileRoutes.post("/delete", async (c) => {
  const i = await instanceFor(c);
  const b = await parseBody(c, PathsBody);
  return c.json(await files.remove(c, i, b.paths));
});
instanceFileRoutes.post("/chmod", async (c) => {
  const i = await instanceFor(c);
  return c.json(await files.chmod(c, i, await parseBody(c, ChmodBody)));
});
instanceFileRoutes.post("/extract", async (c) => {
  const i = await instanceFor(c);
  const b = await parseBody(c, ExtractBody);
  return c.json(await files.extract(c, i, b.path, b.dest));
});
instanceFileRoutes.post("/compress", async (c) => {
  const i = await instanceFor(c);
  const b = await parseBody(c, CompressBody);
  return c.json(await files.compress(c, i, b.paths, b.dest), 201);
});
/** Raw body, streamed to the node as it arrives; options in the query string. */
instanceFileRoutes.put("/upload", async (c) => {
  const i = await instanceFor(c);
  const q = parseQuery(c, UploadQuery);
  const size = contentLength(c);
  return c.json(await files.upload(c, i, q, c.req.raw.body, size), 201);
});
instanceFileRoutes.post("/download", async (c) => {
  const i = await instanceFor(c);
  const b = await parseBody(c, PathsBody);
  return c.json(await files.prepareDownload(c, i, b.paths));
});

// ---- /api/v1/files ----

export const fileRoutes = new Hono<AppEnv>();
fileRoutes.use("*", requireAuth);
fileRoutes.get("/limits", async (c) => c.json(await files.limits()));
/** The one-time URL from POST …/download; bound to the user who asked for it. */
fileRoutes.get("/downloads/:ticket", (c) => files.download(c, c.req.param("ticket")));

// ---- the agent's side: /api/v1/agents/transfers/:token ----

export const agentTransferRoutes = new Hono<AppEnv>();

async function agentNodeId(c: { req: { header: (n: string) => string | undefined } }) {
  const auth = c.req.header("authorization");
  const node = await nodes.authenticateAgent(
    auth?.startsWith("Bearer ") ? auth.slice(7) : undefined,
  );
  if (!node) throw unauthorized("Invalid agent token");
  return node.id;
}

function transferError(err: unknown): never {
  if (err instanceof TransferError) throw badRequest(err.message);
  throw err;
}

agentTransferRoutes.get("/:token", async (c) => {
  const nodeId = await agentNodeId(c);
  try {
    const { stream, size } = transfers.serve(c.req.param("token"), nodeId);
    return new Response(stream, {
      headers: { "content-type": "application/octet-stream", "content-length": String(size) },
    });
  } catch (err) {
    transferError(err);
  }
});
agentTransferRoutes.get("/:token/digest", async (c) => {
  const nodeId = await agentNodeId(c);
  try {
    return c.json({ sha256: await transfers.digest(c.req.param("token"), nodeId) });
  } catch (err) {
    transferError(err);
  }
});
agentTransferRoutes.post("/:token", async (c) => {
  const nodeId = await agentNodeId(c);
  const body = c.req.raw.body;
  if (!body) throw badRequest("No body");
  const len = c.req.header("content-length");
  let answer;
  try {
    answer = await transfers.receive(c.req.param("token"), nodeId, body, len ? Number(len) : null);
  } catch (err) {
    transferError(err);
  }
  if ("error" in answer) throw badRequest(answer.error);
  return c.json(answer);
});
