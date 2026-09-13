/**
 * Built-in templates ship as templates/*.json. On start each one is upserted by slug with
 * `builtin = true`; a changed definition bumps the row's revision. Instances keep referring to the
 * row, so their template id never changes across upgrades.
 */
import { TemplateDefinition } from "@gsm/shared";
import { config } from "../../config.ts";
import { Template } from "../../db/models.ts";
import { log } from "../../lib/logger.ts";

const slog = log.child("templates:seed");

export async function seedBuiltinTemplates(dir = config.TEMPLATES_DIR): Promise<number> {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)].filter((e) => e.isFile && e.name.endsWith(".json"));
  } catch (err) {
    slog.warn("templates directory unreadable", { dir, err: String(err) });
    return 0;
  }
  let changed = 0;
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    let def: TemplateDefinition;
    try {
      def = TemplateDefinition.parse(JSON.parse(await Deno.readTextFile(`${dir}/${entry.name}`)));
    } catch (err) {
      slog.error("built-in template is invalid; skipped", { file: entry.name, err: String(err) });
      continue;
    }
    const existing = await Template.findOne({ where: { slug: def.slug } });
    if (!existing) {
      const t = Template.build({
        slug: def.slug,
        name: def.name,
        game: def.game,
        definition: def,
        builtin: true,
        createdBy: null,
      });
      t.applyDefinition(def);
      await t.save();
      slog.info("built-in template added", { slug: def.slug });
      changed++;
      continue;
    }
    if (!existing.builtin) {
      slog.warn("a custom template uses a built-in slug; the built-in is not seeded", {
        slug: def.slug,
      });
      continue;
    }
    if (JSON.stringify(existing.definition) === JSON.stringify(def)) continue;
    existing.applyDefinition(def);
    existing.revision += 1;
    await existing.save();
    slog.info("built-in template updated", { slug: def.slug, revision: existing.revision });
    changed++;
  }
  return changed;
}
