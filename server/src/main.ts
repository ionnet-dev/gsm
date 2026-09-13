import { config } from "./config.ts";
import { log } from "./lib/logger.ts";
import { connectDatabase } from "./db/sequelize.ts";
import { runPendingMigrations } from "./db/migrate.ts";
import "./db/models.ts";
import { createApp } from "./app.ts";
import { startOfflineDetector } from "./jobs/offline-detector.ts";
import { startHousekeeping } from "./jobs/housekeeping.ts";
import { seedFromDisk } from "./modules/releases/service.ts";
import { seedBuiltinTemplates } from "./modules/templates/seed.ts";
import { startInstanceSupervisor } from "./modules/instances/supervisor.ts";
import { loadOnlineCounts } from "./modules/players/service.ts";

// Last-resort net: log instead of exiting, which would drop every agent and UI socket at once.
globalThis.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  log.error("unhandled rejection", { err: e.reason });
});

await connectDatabase();
if (config.AUTO_MIGRATE) {
  const applied = await runPendingMigrations();
  if (applied.length) log.info("migrations applied", { applied });
}
await Deno.mkdir(`${config.DATA_DIR}/downloads`, { recursive: true });
await seedFromDisk().catch((err) => log.warn("release seeding failed", { err }));
await seedBuiltinTemplates().catch((err) => log.warn("template seeding failed", { err }));

const app = createApp();
await loadOnlineCounts();
const stopDetector = startOfflineDetector();
const stopHousekeeping = startHousekeeping();
const stopSupervisor = startInstanceSupervisor();

const server = Deno.serve(
  {
    port: config.PORT,
    onListen: ({ hostname, port }) =>
      log.info(`listening on http://${hostname}:${port}`, { env: config.DENO_ENV }),
  },
  app.fetch,
);

const shutdown = async () => {
  log.info("shutting down");
  stopDetector();
  stopHousekeeping();
  stopSupervisor();
  await server.shutdown();
  Deno.exit(0);
};
Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
