import {
  type CreationOptional,
  DataTypes,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type NonAttribute,
} from "sequelize";
import type { Role, TwoFactorMethod } from "@gsm/shared";
import { ROLES } from "@gsm/shared";
import { sequelize } from "../../db/sequelize.ts";
import { ID } from "../../lib/model.ts";

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<number>;
  declare email: string;
  declare name: string;
  declare passwordHash: string;
  declare role: Role;
  declare disabled: CreationOptional<boolean>;
  /** Email one-time codes at sign-in. */
  declare twoFactorEmail: CreationOptional<boolean>;
  /** Authenticator seed sealed with lib/secret-box.ts; active only once `totpEnabledAt` is set. */
  declare totpSecret: CreationOptional<string | null>;
  declare totpEnabledAt: CreationOptional<Date | null>;
  /** Last accepted TOTP time step; codes for it or earlier steps are refused (no replays). */
  declare totpLastStep: CreationOptional<number | null>;
  declare lastLoginAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  /** Set by the user list query (a subquery), not a column. */
  declare instanceCount?: NonAttribute<number>;

  /** Second factors that are on, in the order a login challenge offers them. */
  get twoFactorMethods(): NonAttribute<TwoFactorMethod[]> {
    const methods: TwoFactorMethod[] = [];
    if (this.totpEnabledAt) methods.push("totp");
    if (this.twoFactorEmail) methods.push("email");
    return methods;
  }

  get hasTwoFactor(): NonAttribute<boolean> {
    return this.twoFactorMethods.length > 0;
  }

  get isAdmin(): NonAttribute<boolean> {
    return this.role === "admin";
  }

  toPublic() {
    const count = this.get("instanceCount") as number | string | undefined;
    return {
      id: this.id,
      email: this.email,
      name: this.name,
      role: this.role,
      disabled: this.disabled,
      twoFactorEnabled: this.hasTwoFactor,
      twoFactorMethods: this.twoFactorMethods,
      lastLoginAt: this.lastLoginAt?.toISOString() ?? null,
      createdAt: this.createdAt.toISOString(),
      ...(count !== undefined ? { instanceCount: Number(count) } : {}),
    };
  }
}
export type PublicUser = ReturnType<User["toPublic"]>;

User.init(
  {
    id: ID,
    email: { type: DataTypes.STRING(255), allowNull: false, unique: true },
    name: { type: DataTypes.STRING(120), allowNull: false },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false },
    role: { type: DataTypes.ENUM(...ROLES), allowNull: false, defaultValue: "user" },
    disabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    twoFactorEmail: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    totpSecret: { type: DataTypes.STRING(128), allowNull: true },
    totpEnabledAt: { type: DataTypes.DATE(3), allowNull: true },
    totpLastStep: { type: DataTypes.BIGINT, allowNull: true },
    lastLoginAt: { type: DataTypes.DATE(3), allowNull: true },
    createdAt: DataTypes.DATE(3),
    updatedAt: DataTypes.DATE(3),
  },
  { sequelize, tableName: "users" },
);
