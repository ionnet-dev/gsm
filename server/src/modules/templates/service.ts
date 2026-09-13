import type { TemplateDefinition, TemplateDetailDto, TemplateDto } from "@gsm/shared";
import { TEMPLATE_SLUG_RE } from "@gsm/shared";
import { Instance, Template } from "../../db/models.ts";
import { sequelize } from "../../db/sequelize.ts";
import { badRequest, conflict, notFound } from "../../lib/errors.ts";
import { uiGateway } from "../../ws/ui-gateway.ts";

const withInstanceCount = {
  attributes: {
    include: [[
      sequelize.literal(
        "(SELECT COUNT(*) FROM instances i WHERE i.template_id = `Template`.`id`)",
      ),
      "instanceCount",
    ]] as [ReturnType<typeof sequelize.literal>, string][],
  },
};

export function templateDto(t: Template): TemplateDto {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    game: t.game,
    description: t.description,
    icon: t.icon,
    tags: t.tags,
    builtin: t.builtin,
    revision: t.revision,
    instanceCount: Number(t.get("instanceCount") ?? 0),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function templateDetailDto(t: Template): TemplateDetailDto {
  return { ...templateDto(t), definition: t.definition };
}

export async function list(): Promise<TemplateDto[]> {
  const rows = await Template.findAll({
    ...withInstanceCount,
    order: [["builtin", "DESC"], ["game", "ASC"], ["name", "ASC"]],
  });
  return rows.map(templateDto);
}

export async function get(id: number): Promise<Template> {
  const t = await Template.findByPk(id, withInstanceCount);
  if (!t) throw notFound("Template");
  return t;
}

async function assertSlugFree(slug: string, selfId?: number) {
  const existing = await Template.findOne({ where: { slug } });
  if (existing && existing.id !== selfId) {
    throw conflict(`A template with the slug "${slug}" already exists`);
  }
}

export async function create(def: TemplateDefinition, createdBy: number | null): Promise<Template> {
  await assertSlugFree(def.slug);
  const t = Template.build({
    slug: def.slug,
    name: def.name,
    game: def.game,
    definition: def,
    createdBy,
  });
  t.applyDefinition(def);
  await t.save();
  uiGateway.broadcast("template.updated", { templateId: t.id });
  return await get(t.id);
}

export async function update(id: number, def: TemplateDefinition): Promise<Template> {
  const t = await get(id);
  if (t.builtin) throw conflict("Built-in templates cannot be edited; copy it instead");
  await assertSlugFree(def.slug, id);
  t.applyDefinition(def);
  t.revision += 1;
  await t.save();
  uiGateway.broadcast("template.updated", { templateId: id });
  return await get(id);
}

export async function copy(
  id: number,
  input: { slug: string; name: string },
  createdBy: number | null,
): Promise<Template> {
  const src = await get(id);
  if (!TEMPLATE_SLUG_RE.test(input.slug)) throw badRequest("Invalid slug");
  const def: TemplateDefinition = { ...src.definition, slug: input.slug, name: input.name };
  return await create(def, createdBy);
}

export async function remove(id: number): Promise<void> {
  const t = await get(id);
  if (t.builtin) throw conflict("Built-in templates cannot be deleted");
  const used = await Instance.count({ where: { templateId: id } });
  if (used) throw conflict(`${used} instance(s) use this template; delete them first`);
  await t.destroy();
  uiGateway.broadcast("template.updated", { templateId: id });
}
