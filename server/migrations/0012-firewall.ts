import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.addColumn("nodes", "firewall_managed", {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  });
  await qi.addColumn("nodes", "firewall_backend", { type: DataTypes.STRING(20), allowNull: true });
  await qi.addColumn("nodes", "firewall_error", { type: DataTypes.STRING(500), allowNull: true });
  await qi.addColumn("nodes", "firewall_sftp", { type: DataTypes.JSON, allowNull: true });
  await qi.addColumn("instances", "firewall", { type: DataTypes.JSON, allowNull: true });
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.removeColumn("instances", "firewall");
  await qi.removeColumn("nodes", "firewall_sftp");
  await qi.removeColumn("nodes", "firewall_error");
  await qi.removeColumn("nodes", "firewall_backend");
  await qi.removeColumn("nodes", "firewall_managed");
}
