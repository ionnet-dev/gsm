import { Hono } from "hono";
import { z } from "zod";
import {
  CommandBody,
  CreateInstanceBody,
  GrantAccessBody,
  ListInstancesQuery,
  Pagination,
  PowerBody,
  UpdateInstanceBody,
} from "@gsm/shared";
import type { AppEnv } from "../../app.ts";
import { idParam, parseBody, parseQuery } from "../../lib/http.ts";
import { auditFrom } from "../audit/service.ts";
import { currentUser, requireAuth, requireRole } from "../auth/middleware.ts";
import { instanceBackupRoutes } from "../backups/routes.ts";
import { instanceFileRoutes } from "../files/routes.ts";
import { assertInstancePermission, instanceScope, roleOn } from "./access.ts";
import * as instances from "./service.ts";

export const instanceRoutes = new Hono<AppEnv>();
instanceRoutes.use("*", requireAuth);

instanceRoutes.route("/:id/files", instanceFileRoutes);
instanceRoutes.route("/:id/backups", instanceBackupRoutes);

instanceRoutes.get("/", async (c) => {
  const q = parseQuery(c, ListInstancesQuery);
  const user = currentUser(c);
  const page = await instances.list(q, await instanceScope(c));
  const items = await Promise.all(
    page.rows.map(async (i) => instances.instanceDto(i, (await roleOn(user, i.id)) ?? "viewer")),
  );
  return c.json({ items, total: page.total, page: page.page, pageSize: page.pageSize });
});

instanceRoutes.get(
  "/summary",
  async (c) => c.json(await instances.summary(await instanceScope(c))),
);

instanceRoutes.post("/", requireRole("admin"), async (c) => {
  const body = await parseBody(c, CreateInstanceBody);
  const i = await instances.create(body, currentUser(c));
  await auditFrom(c, "instance.create", { type: "instance", id: i.id }, {
    name: i.name,
    nodeId: i.nodeId,
    templateId: i.templateId,
  });
  return c.json({ instance: instances.instanceDetailDto(i, "owner") }, 201);
});

instanceRoutes.get("/:id", async (c) => {
  const id = idParam(c);
  const role = await assertInstancePermission(c, id, "view");
  return c.json({ instance: instances.instanceDetailDto(await instances.get(id), role) });
});

instanceRoutes.patch("/:id", async (c) => {
  const id = idParam(c);
  const role = await assertInstancePermission(c, id, "settings");
  const body = await parseBody(c, UpdateInstanceBody);
  const i = await instances.update(id, body, role);
  const { variables: _v, ...rest } = body;
  await auditFrom(c, "instance.update", { type: "instance", id }, {
    ...rest,
    variables: body.variables ? Object.keys(body.variables) : undefined,
  });
  return c.json({ instance: instances.instanceDetailDto(i, role) });
});

instanceRoutes.delete("/:id", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "delete");
  const keepFiles = ["1", "true"].includes(c.req.query("keepFiles") ?? "");
  const i = await instances.get(id);
  await instances.remove(id, keepFiles, currentUser(c).id);
  await auditFrom(c, "instance.delete", { type: "instance", id }, { name: i.name, keepFiles });
  return c.json({ ok: true });
});

instanceRoutes.post("/:id/power", async (c) => {
  const id = idParam(c);
  const role = await assertInstancePermission(c, id, "power");
  const { action } = await parseBody(c, PowerBody);
  const i = await instances.power(id, action, currentUser(c).id);
  return c.json({ instance: instances.instanceDetailDto(i, role) });
});

instanceRoutes.post("/:id/command", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "command");
  const { command } = await parseBody(c, CommandBody);
  await instances.command(id, command, currentUser(c).id);
  return c.json({ ok: true });
});

instanceRoutes.post("/:id/reinstall", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "reinstall");
  const actorId = currentUser(c).id;
  // Refusals (offline node, running instance) come back straight away; the run itself is background.
  const started = instances.install(id, actorId);
  await Promise.race([started, new Promise((r) => setTimeout(r, 300))]).catch((err) => {
    throw err;
  });
  started.catch(() => {});
  return c.json({ ok: true }, 202);
});

const ConsoleQuery = z.object({
  stream: z.enum(["console", "install"]).default("console"),
  lines: z.coerce.number().int().min(1).max(5000).default(500),
});

instanceRoutes.get("/:id/console", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "console");
  const q = parseQuery(c, ConsoleQuery);
  return c.json({ lines: await instances.consoleTail(id, q.stream, q.lines) });
});

instanceRoutes.get("/:id/stats", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "view");
  return c.json({ stats: await instances.stats(id) });
});

instanceRoutes.get("/:id/access", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "view");
  return c.json({ items: await instances.listAccess(id) });
});

instanceRoutes.put("/:id/access", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "access");
  const body = await parseBody(c, GrantAccessBody);
  const items = await instances.grant(id, body.userId, body.role, currentUser(c).id);
  await auditFrom(c, "instance.access_grant", { type: "instance", id }, body);
  return c.json({ items });
});

instanceRoutes.delete("/:id/access/:userId", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "access");
  const userId = idParam(c, "userId");
  const items = await instances.revoke(id, userId);
  await auditFrom(c, "instance.access_revoke", { type: "instance", id }, { userId });
  return c.json({ items });
});

instanceRoutes.get("/:id/activity", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "view");
  const q = parseQuery(c, Pagination);
  return c.json(await instances.activity(id, q.page, q.pageSize));
});
