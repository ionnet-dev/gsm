import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

const timestamps = {
  created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
};

export async function up(qi: QueryInterface): Promise<void> {
  await qi.createTable("enrollment_tokens", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    token_prefix: { type: DataTypes.STRING(12), allowNull: false },
    max_uses: { type: DataTypes.INTEGER, allowNull: true },
    uses: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    expires_at: { type: DataTypes.DATE(3), allowNull: true },
    revoked_at: { type: DataTypes.DATE(3), allowNull: true },
    created_by: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: { model: "users", key: "id" },
      onDelete: "SET NULL",
    },
    ...timestamps,
  });

  await qi.createTable("nodes", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    hostname: { type: DataTypes.STRING(255), allowNull: false },
    machine_id: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    status: {
      type: DataTypes.ENUM("online", "offline"),
      allowNull: false,
      defaultValue: "offline",
    },
    agent_secret_hash: { type: DataTypes.CHAR(64), allowNull: false },
    agent_version: { type: DataTypes.STRING(32), allowNull: true },
    protocol_version: { type: DataTypes.INTEGER, allowNull: true },
    os_id: { type: DataTypes.STRING(40), allowNull: true },
    os_name: { type: DataTypes.STRING(80), allowNull: true },
    os_version: { type: DataTypes.STRING(40), allowNull: true },
    os_pretty_name: { type: DataTypes.STRING(120), allowNull: true },
    kernel: { type: DataTypes.STRING(80), allowNull: true },
    arch: { type: DataTypes.STRING(16), allowNull: true },
    cpu_model: { type: DataTypes.STRING(120), allowNull: true },
    cpu_cores: { type: DataTypes.INTEGER, allowNull: true },
    cpu_threads: { type: DataTypes.INTEGER, allowNull: true },
    memory_total: { type: DataTypes.BIGINT, allowNull: true },
    docker: { type: DataTypes.JSON, allowNull: true },
    data_dir: { type: DataTypes.STRING(300), allowNull: true },
    inventory: { type: DataTypes.JSON, allowNull: true },
    last_metrics: { type: DataTypes.JSON, allowNull: true },
    last_seen_at: { type: DataTypes.DATE(3), allowNull: true },
    enrolled_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    enrollment_token_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: { model: "enrollment_tokens", key: "id" },
      onDelete: "SET NULL",
    },
    notes: { type: DataTypes.TEXT, allowNull: true },
    public_address: { type: DataTypes.STRING(253), allowNull: true },
    bind_address: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "0.0.0.0" },
    port_range_start: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30000 },
    port_range_end: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30999 },
    ...timestamps,
  });
  await qi.addIndex("nodes", ["status"]);
  await qi.addIndex("nodes", ["name"]);
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.dropTable("nodes");
  await qi.dropTable("enrollment_tokens");
}
