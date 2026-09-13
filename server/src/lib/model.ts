/** Shared Sequelize model helpers. Every model file uses these so definitions stay uniform. */
import { DataTypes, type ModelAttributeColumnOptions } from "sequelize";

export const ID: ModelAttributeColumnOptions = {
  type: DataTypes.BIGINT,
  autoIncrement: true,
  primaryKey: true,
};

export const bigintFk = (allowNull = false): ModelAttributeColumnOptions => ({
  type: DataTypes.BIGINT,
  allowNull,
});

/** Column definition helper for nullable strings. */
export const str = (len: number, allowNull = true): ModelAttributeColumnOptions => ({
  type: DataTypes.STRING(len),
  allowNull,
});
