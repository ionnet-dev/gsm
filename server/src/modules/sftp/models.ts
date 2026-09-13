import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
} from "sequelize";
import { sequelize } from "../../db/sequelize.ts";
import { ID } from "../../lib/model.ts";

/** A user's SFTP password for one instance; only its hash is kept. */
export class SftpPassword
  extends Model<InferAttributes<SftpPassword>, InferCreationAttributes<SftpPassword>> {
  declare instanceId: number;
  declare userId: number;
  declare passwordHash: string;
  declare createdAt: CreationOptional<Date>;
  declare lastUsedAt: CreationOptional<Date | null>;
}
SftpPassword.init(
  {
    instanceId: { type: DataTypes.BIGINT, primaryKey: true },
    userId: { type: DataTypes.BIGINT, primaryKey: true },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false },
    createdAt: DataTypes.DATE(3),
    lastUsedAt: { type: DataTypes.DATE(3), allowNull: true },
  },
  { sequelize, tableName: "sftp_passwords", updatedAt: false },
);

/** A user's SSH public key; it signs them in to every instance they may manage files on. */
export class SshKey extends Model<InferAttributes<SshKey>, InferCreationAttributes<SshKey>> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<number>;
  declare name: string;
  /** "type base64", without the comment. */
  declare publicKey: string;
  declare fingerprint: string;
  declare createdAt: CreationOptional<Date>;
  declare lastUsedAt: CreationOptional<Date | null>;
}
SshKey.init(
  {
    id: ID,
    userId: { type: DataTypes.BIGINT, allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    publicKey: { type: DataTypes.TEXT, allowNull: false },
    fingerprint: { type: DataTypes.STRING(100), allowNull: false },
    createdAt: DataTypes.DATE(3),
    lastUsedAt: { type: DataTypes.DATE(3), allowNull: true },
  },
  { sequelize, tableName: "ssh_keys", updatedAt: false },
);
