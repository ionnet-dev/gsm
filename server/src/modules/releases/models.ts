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

export class AgentRelease
  extends Model<InferAttributes<AgentRelease>, InferCreationAttributes<AgentRelease>> {
  declare id: CreationOptional<number>;
  declare version: string;
  declare arch: string;
  declare sha256: string;
  declare size: number;
  declare path: string;
  declare notes: string | null;
  declare isLatest: CreationOptional<boolean>;
  declare latestSince: CreationOptional<Date | null>;
  declare createdBy: ForeignKey<number | null>;
  declare createdAt: CreationOptional<Date>;
}
AgentRelease.init(
  {
    id: ID,
    version: { type: DataTypes.STRING(64), allowNull: false },
    arch: { type: DataTypes.STRING(16), allowNull: false },
    sha256: { type: DataTypes.CHAR(64), allowNull: false },
    size: { type: DataTypes.BIGINT, allowNull: false },
    path: { type: DataTypes.STRING(300), allowNull: false },
    notes: { type: DataTypes.STRING(1000), allowNull: true },
    isLatest: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    latestSince: { type: DataTypes.DATE(3), allowNull: true },
    createdBy: { type: DataTypes.BIGINT, allowNull: true },
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, tableName: "agent_releases", updatedAt: false },
);
