import { Hono } from "hono";
import { sequelize } from "../../db/sequelize.ts";
import { umzug } from "../../db/migrate.ts";
import { VERSION } from "../../version.ts";
import type { AppEnv } from "../../app.ts";

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get("/", async (c) => {
  let db: "ok" | "error" = "ok";
  try {
    await sequelize.query("SELECT 1");
  } catch {
    db = "error";
  }
  const status = db === "ok" ? "ok" : "degraded";
  // Version and schema state are only for signed-in users; anonymous probes get the bare status.
  if (!c.get("user")) return c.json({ status, db }, db === "ok" ? 200 : 503);
  const pending = db === "ok" ? (await umzug.pending()).length : null;
  return c.json(
    { status, version: VERSION, db, pendingMigrations: pending },
    db === "ok" ? 200 : 503,
  );
});
