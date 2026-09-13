import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type NonAttribute,
} from "sequelize";
import type {
  BackupStatus,
  InstanceRole,
  InstanceStats,
  InstanceStatus,
  PortProtocol,
  ResourceLimits,
} from "@gsm/shared";
import { BACKUP_STATUSES, INSTANCE_ROLES, INSTANCE_STATUSES, PORT_PROTOCOLS } from "@gsm/shared";
import { sequelize } from "../../db/sequelize.ts";
import { ID } from "../../lib/model.ts";
import type { Node } from "../nodes/models.ts";
import type { Template } from "../templates/models.ts";
import type { User } from "../users/models.ts";

export class Instance extends Model<InferAttributes<Instance>, InferCreationAttributes<Instance>> {
  declare id: CreationOptional<number>;
  declare uuid: string;
  declare name: string;
  declare description: string | null;
  declare nodeId: ForeignKey<number>;
  declare templateId: ForeignKey<number>;
  declare status: CreationOptional<InstanceStatus>;
  declare error: CreationOptional<string | null>;
  declare image: string;
  /** Variable name → value, as entered (defaults filled in at creation). */
  declare variables: Record<string, string>;
  declare limits: ResourceLimits;
  declare restartOnCrash: CreationOptional<boolean>;
  declare autoStart: CreationOptional<boolean>;
  declare startupOverride: CreationOptional<string | null>;
  declare installedAt: CreationOptional<Date | null>;
  declare lastStartedAt: CreationOptional<Date | null>;
  declare lastStats: CreationOptional<InstanceStats | null>;
  declare containerId: CreationOptional<string | null>;
  declare createdBy: ForeignKey<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare node?: NonAttribute<Node>;
  declare template?: NonAttribute<Template>;
  declare ports?: NonAttribute<InstancePort[]>;
  declare creator?: NonAttribute<User | null>;
}
Instance.init(
  {
    id: ID,
    uuid: { type: DataTypes.CHAR(36), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    nodeId: { type: DataTypes.BIGINT, allowNull: false },
    templateId: { type: DataTypes.BIGINT, allowNull: false },
    status: {
      type: DataTypes.ENUM(...INSTANCE_STATUSES),
      allowNull: false,
      defaultValue: "unknown",
    },
    error: { type: DataTypes.STRING(1000), allowNull: true },
    image: { type: DataTypes.STRING(300), allowNull: false },
    variables: { type: DataTypes.JSON, allowNull: false },
    limits: { type: DataTypes.JSON, allowNull: false },
    restartOnCrash: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    autoStart: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    startupOverride: { type: DataTypes.TEXT, allowNull: true },
    installedAt: { type: DataTypes.DATE(3), allowNull: true },
    lastStartedAt: { type: DataTypes.DATE(3), allowNull: true },
    lastStats: { type: DataTypes.JSON, allowNull: true },
    containerId: { type: DataTypes.STRING(80), allowNull: true },
    createdBy: { type: DataTypes.BIGINT, allowNull: true },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, tableName: "instances" },
);

/** A host port on a node reserved for an instance. One port number belongs to one instance. */
export class InstancePort
  extends Model<InferAttributes<InstancePort>, InferCreationAttributes<InstancePort>> {
  declare id: CreationOptional<number>;
  declare instanceId: ForeignKey<number>;
  declare nodeId: ForeignKey<number>;
  /** The template port's name. */
  declare name: string;
  declare label: string;
  declare protocol: PortProtocol;
  declare port: number;
  declare primary: CreationOptional<boolean>;
}
InstancePort.init(
  {
    id: ID,
    instanceId: { type: DataTypes.BIGINT, allowNull: false },
    nodeId: { type: DataTypes.BIGINT, allowNull: false },
    name: { type: DataTypes.STRING(32), allowNull: false },
    label: { type: DataTypes.STRING(80), allowNull: false },
    protocol: { type: DataTypes.ENUM(...PORT_PROTOCOLS), allowNull: false },
    port: { type: DataTypes.INTEGER, allowNull: false },
    primary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { sequelize, tableName: "instance_ports", timestamps: false },
);

/** Per-instance access for non-admin users. */
export class InstanceUser
  extends Model<InferAttributes<InstanceUser>, InferCreationAttributes<InstanceUser>> {
  declare instanceId: number;
  declare userId: number;
  declare role: InstanceRole;
  declare grantedBy: ForeignKey<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare user?: NonAttribute<User>;
}
InstanceUser.init(
  {
    instanceId: { type: DataTypes.BIGINT, primaryKey: true },
    userId: { type: DataTypes.BIGINT, primaryKey: true },
    role: { type: DataTypes.ENUM(...INSTANCE_ROLES), allowNull: false },
    grantedBy: { type: DataTypes.BIGINT, allowNull: true },
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, tableName: "instance_users", updatedAt: false },
);

export class Backup extends Model<InferAttributes<Backup>, InferCreationAttributes<Backup>> {
  declare id: CreationOptional<number>;
  /** The file name on the node: <backupId>.tar.gz. */
  declare backupId: string;
  declare instanceId: ForeignKey<number>;
  declare name: string;
  declare status: CreationOptional<BackupStatus>;
  declare size: CreationOptional<number | null>;
  declare sha256: CreationOptional<string | null>;
  declare files: CreationOptional<number | null>;
  declare error: CreationOptional<string | null>;
  declare progressBytes: CreationOptional<number>;
  declare createdBy: ForeignKey<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare completedAt: CreationOptional<Date | null>;
  declare creator?: NonAttribute<User | null>;
}
Backup.init(
  {
    id: ID,
    backupId: { type: DataTypes.CHAR(36), allowNull: false, unique: true },
    instanceId: { type: DataTypes.BIGINT, allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    status: {
      type: DataTypes.ENUM(...BACKUP_STATUSES),
      allowNull: false,
      defaultValue: "pending",
    },
    size: { type: DataTypes.BIGINT, allowNull: true },
    sha256: { type: DataTypes.CHAR(64), allowNull: true },
    files: { type: DataTypes.INTEGER, allowNull: true },
    error: { type: DataTypes.STRING(1000), allowNull: true },
    progressBytes: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    createdBy: { type: DataTypes.BIGINT, allowNull: true },
    createdAt: DataTypes.DATE(3),
    completedAt: { type: DataTypes.DATE(3), allowNull: true },
  },
  { sequelize, tableName: "backups", updatedAt: false },
);
