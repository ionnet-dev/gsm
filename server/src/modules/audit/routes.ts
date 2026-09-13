import { Hono } from "hono";
import { z } from "zod";
import { Pagination } from "@gsm/shared";
import type { AppEnv } from "../../app.ts";
import { requireRole } from "../auth/middleware.ts";
import { parseQuery } from "../../lib/http.ts";
import * as audit from "./service.ts";

export const auditRoutes = new Hono<AppEnv>();

const ListQuery = Pagination.extend({
  action: z.string().optional(),
  actorUserId: z.coerce.number().int().optional(),
});

const ExportQuery = z.object({
  format: z.enum(audit.EXPORT_FORMATS).default("csv"),
  action: z.string().optional(),
  actorUserId: z.coerce.number().int().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

auditRoutes.get("/", requireRole("admin"), async (c) => {
  const q = parseQuery(c, ListQuery);
  return c.json(await audit.list(q));
});

/** Streams the whole log, or a filtered slice, as a download. The export itself is audited. */
auditRoutes.get("/export", requireRole("admin"), async (c) => {
  const q = parseQuery(c, ExportQuery);
  await audit.auditFrom(c, "audit.exported", { type: "audit" }, {
    format: q.format,
    action: q.action ?? null,
    from: q.from?.toISOString() ?? null,
    to: q.to?.toISOString() ?? null,
  });
  const stamp = new Date().toISOString().slice(0, 10);
  return c.body(audit.exportStream(q.format, q), 200, {
    "content-type": q.format === "csv"
      ? "text/csv; charset=utf-8"
      : "application/x-ndjson; charset=utf-8",
    "content-disposition": `attachment; filename="gsm-audit-${stamp}.${q.format}"`,
    "cache-control": "no-store",
  });
});
