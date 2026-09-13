import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.createTable("backups", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    backup_id: { type: DataTypes.CHAR(36), allowNull: false, unique: true },
    instance_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: { model: "instances", key: "id" },
      onDelete: "CASCADE",
    },
    name: { type: DataTypes.STRING(120), allowNull: false },
    status: {
      type: DataTypes.ENUM("pending", "running", "completed", "failed"),
      allowNull: false,
      defaultValue: "pending",
    },
    size: { type: DataTypes.BIGINT, allowNull: true },
    sha256: { type: DataTypes.CHAR(64), allowNull: true },
    files: { type: DataTypes.INTEGER, allowNull: true },
    error: { type: DataTypes.STRING(1000), allowNull: true },
    progress_bytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    created_by: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    completed_at: { type: DataTypes.DATE(3), allowNull: true },
  });
  await qi.addIndex("backups", ["instance_id", "created_at"]);
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.dropTable("backups");
}
