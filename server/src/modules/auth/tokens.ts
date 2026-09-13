/** Personal API tokens: `Authorization: Bearer gsm_api_<random>`. They act as the owning user. */
import {
  type CreationOptional,
  DataTypes,
  type ForeignKey,
  type InferAttributes,
  type InferCreationAttributes,
  Model,
  type NonAttribute,
  Op,
} from "sequelize";
import { sequelize } from "../../db/sequelize.ts";
import { ID } from "../../lib/model.ts";
import { randomId, sha256Hex } from "../../lib/ids.ts";
import { badRequest, notFound } from "../../lib/errors.ts";
import type { User } from "../users/models.ts";

export const API_TOKEN_PREFIX = "gsm_api_";

export class ApiToken extends Model<InferAttributes<ApiToken>, InferCreationAttributes<ApiToken>> {
  declare id: CreationOptional<number>;
  declare userId: ForeignKey<number>;
  declare name: string;
  declare tokenHash: string;
  declare tokenPrefix: string;
  declare expiresAt: Date | null;
  declare lastUsedAt: Date | null;
  declare revokedAt: Date | null;
  declare createdAt: CreationOptional<Date>;
  declare user?: NonAttribute<User>;
}
ApiToken.init(
  {
    id: ID,
    userId: { type: DataTypes.BIGINT, allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    tokenHash: { type: DataTypes.CHAR(64), allowNull: false, unique: true },
    tokenPrefix: { type: DataTypes.STRING(16), allowNull: false },
    expiresAt: { type: DataTypes.DATE(3), allowNull: true },
    lastUsedAt: { type: DataTypes.DATE(3), allowNull: true },
    revokedAt: { type: DataTypes.DATE(3), allowNull: true },
    createdAt: DataTypes.DATE(3),
  },
  { sequelize, tableName: "api_tokens", updatedAt: false },
);

export function tokenDto(t: ApiToken) {
  return {
    id: t.id,
    name: t.name,
    tokenPrefix: t.tokenPrefix,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}
export type ApiTokenDto = ReturnType<typeof tokenDto>;

export async function listTokens(userId: number) {
  return (await ApiToken.findAll({ where: { userId }, order: [["id", "DESC"]] })).map(tokenDto);
}

export async function createToken(userId: number, name: string, expiresInDays: number | null) {
  if ((await ApiToken.count({ where: { userId, revokedAt: null } })) >= 20) {
    throw badRequest("Too many active tokens (max 20)");
  }
  const plaintext = API_TOKEN_PREFIX + randomId(32);
  const t = await ApiToken.create({
    userId,
    name,
    tokenHash: await sha256Hex(plaintext),
    tokenPrefix: plaintext.slice(0, 14),
    expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null,
    lastUsedAt: null,
    revokedAt: null,
  });
  return { token: tokenDto(t), plaintext };
}

export async function revokeToken(userId: number, id: number) {
  const t = await ApiToken.findOne({ where: { id, userId } });
  if (!t) throw notFound("Token");
  t.revokedAt = new Date();
  await t.save();
}

/** Resolve a bearer token to its owner; touches last_used_at at most once a minute. */
export async function resolveApiToken(bearer: string): Promise<ApiToken | null> {
  if (!bearer.startsWith(API_TOKEN_PREFIX)) return null;
  const t = await ApiToken.findOne({
    where: {
      tokenHash: await sha256Hex(bearer),
      revokedAt: null,
      [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
    },
  });
  if (!t) return null;
  if (!t.lastUsedAt || Date.now() - t.lastUsedAt.getTime() > 60_000) {
    t.lastUsedAt = new Date();
    t.save().catch(() => {});
  }
  return t;
}
