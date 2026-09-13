import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.createTable("instances", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    uuid: { type: DataTypes.CHAR(36), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    node_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: { model: "nodes", key: "id" },
      onDelete: "RESTRICT",
    },
    template_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: { model: "templates", key: "id" },
      onDelete: "RESTRICT",
    },
    status: {
      type: DataTypes.ENUM(
        "installing",
        "install_failed",
        "stopped",
        "starting",
        "running",
        "stopping",
        "crashed",
        "unknown",
      ),
      allowNull: false,
      defaultValue: "unknown",
    },
    error: { type: DataTypes.STRING(1000), allowNull: true },
    image: { type: DataTypes.STRING(300), allowNull: false },
    variables: { type: DataTypes.JSON, allowNull: false },
    limits: { type: DataTypes.JSON, allowNull: false },
    restart_on_crash: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    auto_start: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    startup_override: { type: DataTypes.TEXT, allowNull: true },
    installed_at: { type: DataTypes.DATE(3), allowNull: true },
    last_started_at: { type: DataTypes.DATE(3), allowNull: true },
    last_stats: { type: DataTypes.JSON, allowNull: true },
    container_id: { type: DataTypes.STRING(80), allowNull: true },
    created_by: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    updated_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("instances", ["node_id"]);
  await qi.addIndex("instances", ["template_id"]);
  await qi.addIndex("instances", ["status"]);
  await qi.addIndex("instances", ["name"]);

  await qi.createTable("instance_ports", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    instance_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: { model: "instances", key: "id" },
      onDelete: "CASCADE",
    },
    node_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: { model: "nodes", key: "id" },
      onDelete: "CASCADE",
    },
    name: { type: DataTypes.STRING(32), allowNull: false },
    label: { type: DataTypes.STRING(80), allowNull: false },
    protocol: { type: DataTypes.ENUM("tcp", "udp", "both"), allowNull: false },
    port: { type: DataTypes.INTEGER, allowNull: false },
    primary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  });
  await qi.addIndex("instance_ports", ["node_id", "port"], { unique: true });
  await qi.addIndex("instance_ports", ["instance_id", "name"], { unique: true });

  await qi.createTable("instance_users", {
    instance_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      primaryKey: true,
      references: { model: "instances", key: "id" },
      onDelete: "CASCADE",
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      primaryKey: true,
      references: { model: "users", key: "id" },
      onDelete: "CASCADE",
    },
    role: { type: DataTypes.ENUM("owner", "operator", "viewer"), allowNull: false },
    granted_by: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("instance_users", ["user_id"]);
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.dropTable("instance_users");
  await qi.dropTable("instance_ports");
  await qi.dropTable("instances");
}
