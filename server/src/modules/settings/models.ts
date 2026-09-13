import { DataTypes, type InferAttributes, type InferCreationAttributes, Model } from "sequelize";
import { sequelize } from "../../db/sequelize.ts";

export class Setting extends Model<InferAttributes<Setting>, InferCreationAttributes<Setting>> {
  declare key: string;
  declare value: unknown;
}

Setting.init(
  {
    key: { type: DataTypes.STRING(128), primaryKey: true },
    value: { type: DataTypes.JSON, allowNull: false },
  },
  { sequelize, tableName: "settings", createdAt: false, updatedAt: "updated_at" },
);
