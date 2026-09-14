/**
 * Template definitions are stored as they were saved. A newer schema adds fields with defaults
 * (volumes, container options, a database, ...), so a definition saved before them is read through
 * the schema, which fills them in: no code meets an older shape. One that no longer passes (a rule
 * was tightened) is kept as stored, with the newer fields' defaults, rather than breaking every
 * instance made from it.
 */
import { TemplateDefinition } from "@gsm/shared";
import { log } from "../../lib/logger.ts";

const tlog = log.child("templates");
const seen = new WeakMap<object, TemplateDefinition>();

export function normalizeDefinition(raw: unknown): TemplateDefinition {
  if (!raw || typeof raw !== "object") return raw as TemplateDefinition;
  const hit = seen.get(raw);
  if (hit) return hit;
  const parsed = TemplateDefinition.safeParse(raw);
  let def: TemplateDefinition;
  if (parsed.success) {
    def = parsed.data;
  } else {
    const slug = (raw as { slug?: unknown }).slug;
    tlog.warn("stored template no longer passes the schema; using it as stored", {
      slug,
      issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
    });
    const old = raw as Partial<TemplateDefinition>;
    def = {
      ...(raw as TemplateDefinition),
      env: old.env ?? {},
      volumes: old.volumes ?? [],
      container: old.container ??
        { entrypoint: null, user: null, pull: "missing", seccompUnconfined: false },
      database: old.database ?? null,
    };
  }
  seen.set(raw, def);
  return def;
}
