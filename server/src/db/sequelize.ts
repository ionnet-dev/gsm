import { Sequelize } from "sequelize";
import mysql2 from "mysql2";
import { config } from "../config.ts";
import { log } from "../lib/logger.ts";

const dbLog = log.child("db");

export const sequelize = new Sequelize(config.DB_NAME, config.DB_USER, config.DB_PASSWORD, {
  host: config.DB_HOST,
  port: config.DB_PORT,
  dialect: "mysql",
  dialectModule: mysql2, // explicit: Sequelize's dynamic require() does not resolve under Deno
  logging: config.LOG_SQL ? (sql) => dbLog.debug(sql) : false,
  define: { underscored: true, timestamps: true, createdAt: "created_at", updatedAt: "updated_at" },
  pool: { max: 10, min: 0, idle: 10_000 },
  dialectOptions: { supportBigNumbers: true, bigNumberStrings: false },
  timezone: "+00:00",
});

export async function connectDatabase(): Promise<void> {
  await sequelize.authenticate();
  dbLog.info("connected", { host: config.DB_HOST, database: config.DB_NAME });
}
