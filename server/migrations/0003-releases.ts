import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.createTable("agent_releases", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    version: { type: DataTypes.STRING(64), allowNull: false },
    arch: { type: DataTypes.STRING(16), allowNull: false },
    sha256: { type: DataTypes.CHAR(64), allowNull: false },
    size: { type: DataTypes.BIGINT, allowNull: false },
    path: { type: DataTypes.STRING(300), allowNull: false },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    is_latest: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    latest_since: { type: DataTypes.DATE(3), allowNull: true },
    created_by: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("agent_releases", ["version", "arch"], { unique: true });
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.dropTable("agent_releases");
}
