import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type NonAttribute,
} from "sequelize";
import type { TemplateDefinition } from "@gsm/shared";
import { sequelize } from "../../db/sequelize.ts";
import { ID } from "../../lib/model.ts";

/**
 * A game template. Built-ins are seeded from templates/*.json on start (and refreshed when the
 * file changes: `revision` goes up); custom ones are created in the UI. The searchable columns
 * are copies of what is in `definition`.
 */
export class Template extends Model<InferAttributes<Template>, InferCreationAttributes<Template>> {
  declare id: CreationOptional<number>;
  declare slug: string;
  declare name: string;
  declare game: string;
  declare description: CreationOptional<string>;
  declare icon: CreationOptional<string>;
  declare tags: CreationOptional<string[]>;
  declare builtin: CreationOptional<boolean>;
  declare revision: CreationOptional<number>;
  declare definition: TemplateDefinition;
  declare createdBy: ForeignKey<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare instanceCount?: NonAttribute<number>;

  applyDefinition(def: TemplateDefinition) {
    this.slug = def.slug;
    this.name = def.name;
    this.game = def.game;
    this.description = def.description;
    this.icon = def.icon;
    this.tags = def.tags;
    this.definition = def;
  }
}
Template.init(
  {
    id: ID,
    slug: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    game: { type: DataTypes.STRING(80), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    icon: { type: DataTypes.STRING(8), allowNull: false, defaultValue: "🎮" },
    tags: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
    builtin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    definition: { type: DataTypes.JSON, allowNull: false },
    createdBy: { type: DataTypes.BIGINT, allowNull: true },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, tableName: "templates" },
);
