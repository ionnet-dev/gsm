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
  DockerInfo,
  FirewallRule,
  Inventory,
  Metrics,
  NodeStatus,
  SftpReachability,
} from "@gsm/shared";
import { DEFAULT_PORT_RANGE, DEFAULT_SFTP_PORT, NODE_STATUSES } from "@gsm/shared";
import { sequelize } from "../../db/sequelize.ts";
import { ID } from "../../lib/model.ts";
import type { User } from "../users/models.ts";

export class EnrollmentToken extends Model<
  InferAttributes<EnrollmentToken>,
  InferCreationAttributes<EnrollmentToken>
> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare tokenHash: string;
  declare tokenPrefix: string;
  declare maxUses: number | null;
  declare uses: CreationOptional<number>;
  declare expiresAt: Date | null;
  declare revokedAt: Date | null;
  declare createdBy: ForeignKey<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  isUsable(now = new Date()): boolean {
    if (this.revokedAt) return false;
    if (this.expiresAt && this.expiresAt < now) return false;
    if (this.maxUses !== null && this.uses >= this.maxUses) return false;
    return true;
  }
}
EnrollmentToken.init(
  {
    id: ID,
    name: { type: DataTypes.STRING(120), allowNull: false },
    tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    tokenPrefix: { type: DataTypes.STRING(12), allowNull: false },
    maxUses: { type: DataTypes.INTEGER, allowNull: true },
    uses: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    expiresAt: { type: DataTypes.DATE(3), allowNull: true },
    revokedAt: { type: DataTypes.DATE(3), allowNull: true },
    createdBy: { type: DataTypes.BIGINT, allowNull: true },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, tableName: "enrollment_tokens" },
);

/** A machine running the agent: hosts instances in containers. */
export class Node extends Model<InferAttributes<Node>, InferCreationAttributes<Node>> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare hostname: string;
  declare machineId: string;
  declare status: CreationOptional<NodeStatus>;
  declare agentSecretHash: string;
  declare agentVersion: string | null;
  declare protocolVersion: number | null;
  declare osId: string | null;
  declare osName: string | null;
  declare osVersion: string | null;
  declare osPrettyName: string | null;
  declare kernel: string | null;
  declare arch: string | null;
  declare cpuModel: string | null;
  declare cpuCores: number | null;
  declare cpuThreads: number | null;
  declare memoryTotal: number | null;
  declare docker: DockerInfo | null;
  declare dataDir: string | null;
  declare inventory: Inventory | null;
  declare lastMetrics: Metrics | null;
  declare lastSeenAt: Date | null;
  declare enrolledAt: CreationOptional<Date>;
  declare enrollmentTokenId: ForeignKey<number | null>;
  declare notes: string | null;
  /** Address players connect to; null = the address the agent connects from. */
  declare publicAddress: CreationOptional<string | null>;
  /** Address instance ports are published on. */
  declare bindAddress: CreationOptional<string>;
  declare portRangeStart: CreationOptional<number>;
  declare portRangeEnd: CreationOptional<number>;
  /** The agent's SFTP port; null = off. */
  declare sftpPort: CreationOptional<number | null>;
  /** As the agent last reported from agent.configure. */
  declare sftpHostKey: CreationOptional<string | null>;
  declare sftpError: CreationOptional<string | null>;
  /** The last check of the SFTP port from outside (modules/reachability). */
  declare sftpReachability: CreationOptional<SftpReachability | null>;
  /** The panel may change the node's firewall (modules/firewall). */
  declare firewallManaged: CreationOptional<boolean>;
  /** As the agent last reported from agent.configure. */
  declare firewallBackend: CreationOptional<string | null>;
  declare firewallError: CreationOptional<string | null>;
  declare firewallSftp: CreationOptional<FirewallRule[] | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  /** Set by list queries (subqueries), not columns. */
  declare instanceCount?: NonAttribute<number>;
  declare runningCount?: NonAttribute<number>;

  /** Copy inventory facts into indexed columns so lists can filter/sort without JSON access. */
  applyInventory(inv: Inventory) {
    this.hostname = inv.hostname;
    this.osId = inv.os.id;
    this.osName = inv.os.name;
    this.osVersion = inv.os.version;
    this.osPrettyName = inv.os.prettyName;
    this.kernel = inv.kernel;
    this.arch = inv.arch;
    this.cpuModel = inv.cpu.model;
    this.cpuCores = inv.cpu.cores;
    this.cpuThreads = inv.cpu.threads;
    this.memoryTotal = inv.memoryTotalBytes;
    this.docker = inv.docker;
    this.dataDir = inv.dataDir;
    this.inventory = inv;
  }
}
Node.init(
  {
    id: ID,
    name: { type: DataTypes.STRING(120), allowNull: false },
    hostname: { type: DataTypes.STRING(255), allowNull: false },
    machineId: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    status: {
      type: DataTypes.ENUM(...NODE_STATUSES),
      allowNull: false,
      defaultValue: "offline",
    },
    agentSecretHash: { type: DataTypes.CHAR(64), allowNull: false },
    agentVersion: { type: DataTypes.STRING(32), allowNull: true },
    protocolVersion: { type: DataTypes.INTEGER, allowNull: true },
    osId: { type: DataTypes.STRING(40), allowNull: true },
    osName: { type: DataTypes.STRING(80), allowNull: true },
    osVersion: { type: DataTypes.STRING(40), allowNull: true },
    osPrettyName: { type: DataTypes.STRING(120), allowNull: true },
    kernel: { type: DataTypes.STRING(80), allowNull: true },
    arch: { type: DataTypes.STRING(16), allowNull: true },
    cpuModel: { type: DataTypes.STRING(120), allowNull: true },
    cpuCores: { type: DataTypes.INTEGER, allowNull: true },
    cpuThreads: { type: DataTypes.INTEGER, allowNull: true },
    memoryTotal: { type: DataTypes.BIGINT, allowNull: true },
    docker: { type: DataTypes.JSON, allowNull: true },
    dataDir: { type: DataTypes.STRING(300), allowNull: true },
    inventory: { type: DataTypes.JSON, allowNull: true },
    lastMetrics: { type: DataTypes.JSON, allowNull: true },
    lastSeenAt: { type: DataTypes.DATE(3), allowNull: true },
    enrolledAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    enrollmentTokenId: { type: DataTypes.BIGINT, allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    publicAddress: { type: DataTypes.STRING(253), allowNull: true },
    bindAddress: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "0.0.0.0" },
    portRangeStart: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: DEFAULT_PORT_RANGE.start,
    },
    portRangeEnd: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: DEFAULT_PORT_RANGE.end,
    },
    sftpPort: { type: DataTypes.INTEGER, allowNull: true, defaultValue: DEFAULT_SFTP_PORT },
    sftpHostKey: { type: DataTypes.STRING(100), allowNull: true },
    sftpError: { type: DataTypes.STRING(500), allowNull: true },
    sftpReachability: { type: DataTypes.JSON, allowNull: true },
    firewallManaged: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    firewallBackend: { type: DataTypes.STRING(20), allowNull: true },
    firewallError: { type: DataTypes.STRING(500), allowNull: true },
    firewallSftp: { type: DataTypes.JSON, allowNull: true },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, tableName: "nodes" },
);

/**
 * A user who owns a node outright: they manage it (settings, images, new instances) and are owner
 * of every instance on it. Only admins hand nodes out.
 */
export class NodeUser extends Model<InferAttributes<NodeUser>, InferCreationAttributes<NodeUser>> {
  declare nodeId: number;
  declare userId: number;
  declare grantedBy: ForeignKey<number | null>;
  declare createdAt: CreationOptional<Date>;
  declare user?: NonAttribute<User>;
}
NodeUser.init(
  {
    nodeId: { type: DataTypes.BIGINT, primaryKey: true },
    userId: { type: DataTypes.BIGINT, primaryKey: true },
    grantedBy: { type: DataTypes.BIGINT, allowNull: true },
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, tableName: "node_users", updatedAt: false },
);
