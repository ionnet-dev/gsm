import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type NonAttribute,
} from "sequelize";
import { sequelize } from "../../db/sequelize.ts";
import { ID } from "../../lib/model.ts";
import type { User } from "../users/models.ts";

export class Session extends Model<InferAttributes<Session>, InferCreationAttributes<Session>> {
  declare id: string;
  declare userId: ForeignKey<number>;
  declare expiresAt: Date;
  declare ip: string | null;
  declare userAgent: string | null;
  declare lastSeenAt: CreationOptional<Date>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare user?: NonAttribute<User>;
}

Session.init(
  {
    id: { type: DataTypes.STRING(64), primaryKey: true },
    userId: { type: DataTypes.BIGINT, allowNull: false },
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
    ip: { type: DataTypes.STRING(45), allowNull: true },
    userAgent: { type: DataTypes.STRING(512), allowNull: true },
    lastSeenAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, tableName: "sessions" },
);

/**
 * A pending email one-time-code step. `purpose` is "login" (second factor after a correct
 * password; no session exists yet) or "enable" (proving the mailbox works before turning 2FA on).
 * Only a hash of the code is stored; the row is deleted on success or after too many attempts.
 */
export class LoginChallenge
  extends Model<InferAttributes<LoginChallenge>, InferCreationAttributes<LoginChallenge>> {
  declare id: string;
  declare userId: ForeignKey<number>;
  declare purpose: "login" | "enable";
  /** Hash of the latest email code; null until one is sent. */
  declare codeHash: string | null;
  declare attempts: CreationOptional<number>;
  declare sends: CreationOptional<number>;
  declare lastSentAt: Date | null;
  declare expiresAt: Date;
  declare ip: string | null;
  declare userAgent: string | null;
  declare createdAt: CreationOptional<Date>;
  declare user?: NonAttribute<User>;
}

LoginChallenge.init(
  {
    id: { type: DataTypes.STRING(64), primaryKey: true },
    userId: { type: DataTypes.BIGINT, allowNull: false },
    purpose: { type: DataTypes.ENUM("login", "enable"), allowNull: false },
    codeHash: { type: DataTypes.CHAR(64), allowNull: true },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    sends: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    lastSentAt: { type: DataTypes.DATE(3), allowNull: true },
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
    ip: { type: DataTypes.STRING(45), allowNull: true },
    userAgent: { type: DataTypes.STRING(512), allowNull: true },
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, tableName: "login_challenges", updatedAt: false },
);

/** One-time recovery code: SHA-256 of the code (see two-factor.ts); the plaintext is shown once. */
export class RecoveryCode
  extends Model<InferAttributes<RecoveryCode>, InferCreationAttributes<RecoveryCode>> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<number>;
  declare codeHash: string;
  declare usedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
}

RecoveryCode.init(
  {
    id: ID,
    userId: { type: DataTypes.BIGINT, allowNull: false },
    codeHash: { type: DataTypes.CHAR(64), allowNull: false },
    usedAt: { type: DataTypes.DATE(3), allowNull: true },
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, tableName: "recovery_codes", updatedAt: false },
);

/**
 * A pending "forgot password" link (see password-reset.ts). The emailed token is never stored, only
 * its SHA-256. A user has at most one; it is deleted when used or replaced by a newer request.
 */
export class PasswordReset
  extends Model<InferAttributes<PasswordReset>, InferCreationAttributes<PasswordReset>> {
  declare tokenHash: string;
  declare userId: ForeignKey<number>;
  declare expiresAt: Date;
  declare ip: string | null;
  declare userAgent: string | null;
  declare createdAt: CreationOptional<Date>;
  declare user?: NonAttribute<User>;
}

PasswordReset.init(
  {
    tokenHash: { type: DataTypes.CHAR(64), primaryKey: true },
    userId: { type: DataTypes.BIGINT, allowNull: false },
    expiresAt: { type: DataTypes.DATE(3), allowNull: false },
    ip: { type: DataTypes.STRING(45), allowNull: true },
    userAgent: { type: DataTypes.STRING(512), allowNull: true },
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, tableName: "password_resets", updatedAt: false },
);
