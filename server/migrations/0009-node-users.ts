import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.createTable("node_users", {
    node_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      primaryKey: true,
      references: { model: "nodes", key: "id" },
      onDelete: "CASCADE",
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      primaryKey: true,
      references: { model: "users", key: "id" },
      onDelete: "CASCADE",
    },
    granted_by: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("node_users", ["user_id"]);
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.dropTable("node_users");
}
