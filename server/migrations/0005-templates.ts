import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.createTable("templates", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    slug: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    game: { type: DataTypes.STRING(80), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false },
    icon: { type: DataTypes.STRING(8), allowNull: false, defaultValue: "🎮" },
    tags: { type: DataTypes.JSON, allowNull: false },
    builtin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    definition: { type: DataTypes.JSON, allowNull: false },
    created_by: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("templates", ["game"]);
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.dropTable("templates");
}
