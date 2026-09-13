/**
 * Migration runner. Migrations are listed explicitly in ../../migrations/index.ts
 * (umzug's glob loader relies on Node require(), which Deno does not provide).
 *
 * CLI:  deno task migrate [up|down|pending|executed|create <name>]
 */
import { SequelizeStorage, Umzug } from "umzug";
import type { QueryInterface } from "sequelize";
import { sequelize } from "./sequelize.ts";
import { migrations } from "../../migrations/index.ts";
import { log } from "../lib/logger.ts";

export interface Migration {
  name: string;
  up: (qi: QueryInterface) => Promise<void>;
  down: (qi: QueryInterface) => Promise<void>;
}

const migrateLog = log.child("migrate");

export const umzug = new Umzug<QueryInterface>({
  migrations: migrations.map((m) => ({
    name: m.name,
    up: ({ context }) => m.up(context),
    down: ({ context }) => m.down(context),
  })),
  context: sequelize.getQueryInterface(),
  storage: new SequelizeStorage({ sequelize, tableName: "schema_migrations" }),
  logger: {
    info: (msg) => migrateLog.info(String(msg.event ?? "info"), msg),
    warn: (msg) => migrateLog.warn(String(msg.event ?? "warn"), msg),
    error: (msg) => migrateLog.error(String(msg.event ?? "error"), msg),
    debug: () => {},
  },
});

export async function runPendingMigrations(): Promise<string[]> {
  const pending = await umzug.pending();
  if (pending.length === 0) {
    migrateLog.info("schema up to date");
    return [];
  }
  const done = await umzug.up();
  return done.map((m) => m.name);
}

if (import.meta.main) {
  const [cmd = "up", arg] = Deno.args;
  switch (cmd) {
    case "up":
      await umzug.up();
      break;
    case "down":
      await umzug.down();
      break;
    case "pending":
      console.log((await umzug.pending()).map((m) => m.name).join("\n") || "(none)");
      break;
    case "executed":
      console.log((await umzug.executed()).map((m) => m.name).join("\n") || "(none)");
      break;
    case "create": {
      if (!arg) throw new Error("usage: migrate create <name>");
      const existing = migrations.length;
      const file = `${String(existing + 1).padStart(4, "0")}-${arg}.ts`;
      const body =
        `import type { QueryInterface } from "sequelize";\nimport { DataTypes } from "sequelize";\n\nexport async function up(qi: QueryInterface): Promise<void> {\n  // TODO\n}\n\nexport async function down(qi: QueryInterface): Promise<void> {\n  // TODO\n}\n`;
      await Deno.writeTextFile(new URL(`../../migrations/${file}`, import.meta.url), body);
      console.log(`created migrations/${file} — add it to migrations/index.ts`);
      break;
    }
    default:
      throw new Error(`unknown command: ${cmd}`);
  }
  await sequelize.close();
}
