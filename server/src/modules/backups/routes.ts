/** Backups (`backups` permission), mounted under /instances/:id/backups. */
import { Hono } from "hono";
import { z } from "zod";
import { BackupId, CreateBackupBody, RestoreBackupBody } from "@gsm/shared";
import type { AppEnv } from "../../app.ts";
import { idParam, parseBody } from "../../lib/http.ts";
import { assertInstancePermission } from "../instances/access.ts";
import * as instances from "../instances/service.ts";
import * as backups from "./service.ts";

export const instanceBackupRoutes = new Hono<AppEnv>();

async function instanceFor(c: Parameters<typeof idParam>[0]) {
  const id = idParam(c);
  await assertInstancePermission(c, id, "backups");
  return await instances.get(id);
}

const backupId = (c: Parameters<typeof idParam>[0]) => BackupId.parse(c.req.param("backupId"));

instanceBackupRoutes.get("/", async (c) => {
  const i = await instanceFor(c);
  return c.json({ items: await backups.list(i.id) });
});

instanceBackupRoutes.post("/", async (c) => {
  const i = await instanceFor(c);
  const body = await parseBody(c, CreateBackupBody);
  return c.json({ backup: await backups.create(c, i, body) }, 202);
});

instanceBackupRoutes.post("/:backupId/restore", async (c) => {
  const i = await instanceFor(c);
  const body = await parseBody(c, RestoreBackupBody);
  await backups.restore(c, i, backupId(c), body.wipe);
  return c.json({ ok: true }, 202);
});

instanceBackupRoutes.post("/:backupId/download", async (c) => {
  const i = await instanceFor(c);
  return c.json(await backups.prepareDownload(c, i, backupId(c)));
});

instanceBackupRoutes.delete("/:backupId", async (c) => {
  const i = await instanceFor(c);
  await backups.remove(c, i, backupId(c));
  return c.json({ ok: true });
});

export const _schemas = { z };
