import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

export async function up(qi: QueryInterface): Promise<void> {
  await qi.addColumn("users", "sftp_name", {
    type: DataTypes.STRING(40),
    allowNull: true,
    unique: true,
  });
  await qi.addColumn("nodes", "sftp_port", {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 2022,
  });
  await qi.addColumn("nodes", "sftp_host_key", { type: DataTypes.STRING(100), allowNull: true });
  await qi.addColumn("nodes", "sftp_error", { type: DataTypes.STRING(500), allowNull: true });

  await qi.createTable("sftp_passwords", {
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
    password_hash: { type: DataTypes.STRING(255), allowNull: false },
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    last_used_at: { type: DataTypes.DATE(3), allowNull: true },
  });
  await qi.addIndex("sftp_passwords", ["user_id"]);

  await qi.createTable("ssh_keys", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: { model: "users", key: "id" },
      onDelete: "CASCADE",
    },
    name: { type: DataTypes.STRING(120), allowNull: false },
    public_key: { type: DataTypes.TEXT, allowNull: false },
    fingerprint: { type: DataTypes.STRING(100), allowNull: false },
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    last_used_at: { type: DataTypes.DATE(3), allowNull: true },
  });
  await qi.addIndex("ssh_keys", ["user_id", "fingerprint"], { unique: true });
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.dropTable("ssh_keys");
  await qi.dropTable("sftp_passwords");
  await qi.removeColumn("nodes", "sftp_error");
  await qi.removeColumn("nodes", "sftp_host_key");
  await qi.removeColumn("nodes", "sftp_port");
  await qi.removeColumn("users", "sftp_name");
}
