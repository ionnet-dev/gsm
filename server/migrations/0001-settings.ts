import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.createTable("settings", {
    key: { type: DataTypes.STRING(128), primaryKey: true },
    value: { type: DataTypes.JSON, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  });
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.dropTable("settings");
}
