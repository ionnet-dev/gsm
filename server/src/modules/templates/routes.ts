import { Hono } from "hono";
import { z } from "zod";
import { TEMPLATE_SLUG_RE, TemplateDefinition, VERSION_SOURCES } from "@gsm/shared";
import type { AppEnv } from "../../app.ts";
import { idParam, parseBody, parseQuery } from "../../lib/http.ts";
import { auditFrom } from "../audit/service.ts";
import { currentUser, requireAuth, requireRole } from "../auth/middleware.ts";
import * as templates from "./service.ts";
import { listVersions } from "./versions.ts";

export const templateRoutes = new Hono<AppEnv>();
templateRoutes.use("*", requireAuth);

const DefinitionBody = z.object({ definition: TemplateDefinition });
const CopyBody = z.object({
  slug: z.string().regex(TEMPLATE_SLUG_RE),
  name: z.string().min(1).max(120),
});
const VersionsQuery = z.object({
  source: z.enum(VERSION_SOURCES),
  parent: z.string().max(64).optional(),
});

templateRoutes.get("/", async (c) => c.json({ items: await templates.list() }));

templateRoutes.get("/versions", async (c) => {
  const q = parseQuery(c, VersionsQuery);
  return c.json({ versions: await listVersions(q.source, q.parent || undefined) });
});

templateRoutes.get("/:id", async (c) => {
  const t = await templates.get(idParam(c));
  return c.json({ template: templates.templateDetailDto(t) });
});

templateRoutes.get("/:id/export", async (c) => {
  const t = await templates.get(idParam(c));
  return c.body(JSON.stringify(t.definition, null, 2), 200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${t.slug}.json"`,
  });
});

templateRoutes.use("*", requireRole("admin"));

async function createFrom(c: Parameters<typeof auditFrom>[0]) {
  const { definition } = await parseBody(c, DefinitionBody);
  const t = await templates.create(definition, currentUser(c).id);
  await auditFrom(c, "template.create", { type: "template", id: t.id }, { slug: t.slug });
  return c.json({ template: templates.templateDetailDto(t) }, 201);
}

templateRoutes.post("/", createFrom);
templateRoutes.post("/import", createFrom);

templateRoutes.put("/:id", async (c) => {
  const id = idParam(c);
  const { definition } = await parseBody(c, DefinitionBody);
  const t = await templates.update(id, definition);
  await auditFrom(c, "template.update", { type: "template", id }, { slug: t.slug });
  return c.json({ template: templates.templateDetailDto(t) });
});

templateRoutes.post("/:id/copy", async (c) => {
  const id = idParam(c);
  const body = await parseBody(c, CopyBody);
  const t = await templates.copy(id, body, currentUser(c).id);
  await auditFrom(c, "template.copy", { type: "template", id: t.id }, { from: id, slug: t.slug });
  return c.json({ template: templates.templateDetailDto(t) }, 201);
});

templateRoutes.delete("/:id", async (c) => {
  const id = idParam(c);
  await templates.remove(id);
  await auditFrom(c, "template.delete", { type: "template", id });
  return c.json({ ok: true });
});
