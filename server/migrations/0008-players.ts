import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.createTable("instance_players", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    instance_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: { model: "instances", key: "id" },
      onDelete: "CASCADE",
    },
    name: { type: DataTypes.STRING(64), allowNull: false },
    player_id: { type: DataTypes.STRING(64), allowNull: true },
    online: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    joined_at: { type: DataTypes.DATE(3), allowNull: true },
    first_seen_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    last_seen_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("instance_players", ["instance_id", "name"], { unique: true });
  await qi.addIndex("instance_players", ["instance_id", "online"]);
  await qi.addIndex("instance_players", ["instance_id", "last_seen_at"]);
  await qi.addIndex("instance_players", ["last_seen_at"]);
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.dropTable("instance_players");
}
