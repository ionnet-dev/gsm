import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.addColumn("instances", "reachability", { type: DataTypes.JSON, allowNull: true });
  await qi.addColumn("nodes", "sftp_reachability", { type: DataTypes.JSON, allowNull: true });
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.removeColumn("nodes", "sftp_reachability");
  await qi.removeColumn("instances", "reachability");
}
