import type { QueryInterface } from "sequelize";
import { DataTypes } from "sequelize";

const timestamps = {
  created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  updated_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
};

const userRef = (onDelete: "CASCADE" | "SET NULL", allowNull = false) => ({
  type: DataTypes.BIGINT,
  allowNull,
  references: { model: "users", key: "id" },
  onDelete,
});

/** Users, sessions, second factors, password resets, API tokens and the audit log. */
export async function up(qi: QueryInterface): Promise<void> {
  await qi.createTable("users", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    password_hash: { type: DataTypes.STRING(255), allowNull: false },
    role: { type: DataTypes.ENUM("admin", "user"), allowNull: false, defaultValue: "user" },
    disabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    two_factor_email: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    totp_secret: { type: DataTypes.STRING(128), allowNull: true },
    totp_enabled_at: { type: DataTypes.DATE(3), allowNull: true },
    totp_last_step: { type: DataTypes.BIGINT, allowNull: true },
    last_login_at: { type: DataTypes.DATE(3), allowNull: true },
    ...timestamps,
  });

  await qi.createTable("sessions", {
    id: { type: DataTypes.STRING(64), primaryKey: true },
    user_id: userRef("CASCADE"),
    expires_at: { type: DataTypes.DATE(3), allowNull: false },
    ip: { type: DataTypes.STRING(45), allowNull: true },
    user_agent: { type: DataTypes.STRING(512), allowNull: true },
    last_seen_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    ...timestamps,
  });
  await qi.addIndex("sessions", ["user_id"]);
  await qi.addIndex("sessions", ["expires_at"]);

  await qi.createTable("login_challenges", {
    id: { type: DataTypes.STRING(64), primaryKey: true },
    user_id: userRef("CASCADE"),
    purpose: { type: DataTypes.ENUM("login", "enable"), allowNull: false },
    code_hash: { type: DataTypes.CHAR(64), allowNull: true },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    sends: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    last_sent_at: { type: DataTypes.DATE(3), allowNull: true },
    expires_at: { type: DataTypes.DATE(3), allowNull: false },
    ip: { type: DataTypes.STRING(45), allowNull: true },
    user_agent: { type: DataTypes.STRING(512), allowNull: true },
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("login_challenges", ["user_id"]);
  await qi.addIndex("login_challenges", ["expires_at"]);

  await qi.createTable("recovery_codes", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    user_id: userRef("CASCADE"),
    code_hash: { type: DataTypes.CHAR(64), allowNull: false },
    used_at: { type: DataTypes.DATE(3), allowNull: true },
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("recovery_codes", ["user_id", "code_hash"]);

  await qi.createTable("password_resets", {
    token_hash: { type: DataTypes.CHAR(64), primaryKey: true },
    user_id: userRef("CASCADE"),
    expires_at: { type: DataTypes.DATE(3), allowNull: false },
    ip: { type: DataTypes.STRING(45), allowNull: true },
    user_agent: { type: DataTypes.STRING(512), allowNull: true },
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("password_resets", ["user_id"]);
  await qi.addIndex("password_resets", ["expires_at"]);

  await qi.createTable("api_tokens", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    user_id: userRef("CASCADE"),
    name: { type: DataTypes.STRING(120), allowNull: false },
    token_hash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    token_prefix: { type: DataTypes.STRING(16), allowNull: false },
    expires_at: { type: DataTypes.DATE(3), allowNull: true },
    last_used_at: { type: DataTypes.DATE(3), allowNull: true },
    revoked_at: { type: DataTypes.DATE(3), allowNull: true },
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("api_tokens", ["user_id"]);

  await qi.createTable("audit_log", {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    actor_user_id: userRef("SET NULL", true),
    action: { type: DataTypes.STRING(64), allowNull: false },
    target_type: { type: DataTypes.STRING(32), allowNull: true },
    target_id: { type: DataTypes.BIGINT, allowNull: true },
    details: { type: DataTypes.JSON, allowNull: true },
    ip: { type: DataTypes.STRING(45), allowNull: true },
    created_at: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  });
  await qi.addIndex("audit_log", ["created_at"]);
  await qi.addIndex("audit_log", ["actor_user_id"]);
  await qi.addIndex("audit_log", ["target_type", "target_id"]);
}

export async function down(qi: QueryInterface): Promise<void> {
  await qi.dropTable("audit_log");
  await qi.dropTable("api_tokens");
  await qi.dropTable("password_resets");
  await qi.dropTable("recovery_codes");
  await qi.dropTable("login_challenges");
  await qi.dropTable("sessions");
  await qi.dropTable("users");
}
