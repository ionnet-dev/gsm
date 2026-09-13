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

export class AuditEntry
  extends Model<InferAttributes<AuditEntry>, InferCreationAttributes<AuditEntry>> {
  declare id: CreationOptional<number>;
  declare actorUserId: ForeignKey<number | null>;
  declare action: string;
  declare targetType: string | null;
  declare targetId: number | null;
  declare details: Record<string, unknown> | null;
  declare ip: string | null;
  declare createdAt: CreationOptional<Date>;
  declare actor?: NonAttribute<User | null>;
}

AuditEntry.init(
  {
    id: ID,
    actorUserId: { type: DataTypes.BIGINT, allowNull: true },
    action: { type: DataTypes.STRING(64), allowNull: false },
    targetType: { type: DataTypes.STRING(32), allowNull: true },
    targetId: { type: DataTypes.BIGINT, allowNull: true },
    details: { type: DataTypes.JSON, allowNull: true },
    ip: { type: DataTypes.STRING(45), allowNull: true },
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, tableName: "audit_log", updatedAt: false },
);
