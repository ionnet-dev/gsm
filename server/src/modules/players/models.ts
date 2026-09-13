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

/**
 * A player seen on an instance. One row per (instance, name); names compare case-insensitively
 * like the column's collation. `online` follows the console; offline rows are the recent list.
 */
export class InstancePlayer
  extends Model<InferAttributes<InstancePlayer>, InferCreationAttributes<InstancePlayer>> {
  declare id: CreationOptional<number>;
  declare instanceId: ForeignKey<number>;
  declare name: string;
  /** The game's id (a UUID for Minecraft), once a console line named it. */
  declare playerId: CreationOptional<string | null>;
  declare online: CreationOptional<boolean>;
  /** When the current session started; null while offline. */
  declare joinedAt: CreationOptional<Date | null>;
  declare firstSeenAt: CreationOptional<Date>;
  declare lastSeenAt: CreationOptional<Date>;
}
InstancePlayer.init(
  {
    id: ID,
    instanceId: { type: DataTypes.BIGINT, allowNull: false },
    name: { type: DataTypes.STRING(64), allowNull: false },
    playerId: { type: DataTypes.STRING(64), allowNull: true },
    online: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    joinedAt: { type: DataTypes.DATE(3), allowNull: true },
    firstSeenAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    lastSeenAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: "instance_players", timestamps: false },
);
