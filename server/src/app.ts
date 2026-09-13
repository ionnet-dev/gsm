import { Hono } from "hono";
import { logger as honoLogger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { serveStatic } from "hono/deno";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { config, isDev } from "./config.ts";
import { HttpError } from "./lib/errors.ts";
import { log } from "./lib/logger.ts";
import type { Session } from "./modules/auth/models.ts";
import type { User } from "./modules/users/models.ts";
import type { InstanceScope } from "./modules/instances/access.ts";
import { csrfGuard, sessionMiddleware } from "./modules/auth/middleware.ts";
import { authRoutes } from "./modules/auth/routes.ts";
import { userRoutes } from "./modules/users/routes.ts";
import { auditRoutes } from "./modules/audit/routes.ts";
import { healthRoutes } from "./modules/health/routes.ts";
import { settingsRoutes } from "./modules/settings/routes.ts";
import { downloadRoutes, releaseRoutes } from "./modules/releases/routes.ts";
import { agentRoutes, enrollmentRoutes, nodeRoutes } from "./modules/nodes/routes.ts";
import { templateRoutes } from "./modules/templates/routes.ts";
import { instanceRoutes } from "./modules/instances/routes.ts";
import { agentTransferRoutes, fileRoutes } from "./modules/files/routes.ts";
import { wsRoutes } from "./ws/routes.ts";

const httpLog = log.child("http");

export type AppEnv = {
  Variables: {
    user?: User;
    session?: Session;
    /** true when authenticated by a personal API token rather than a cookie session */
    apiToken?: boolean;
    /** Memoized per request by `modules/instances/access.ts`; `null` = unrestricted (admin). */
    instanceScope?: InstanceScope;
  };
};

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(secureHeaders({
    crossOriginEmbedderPolicy: false,
    // The web app is fully bundled and same-origin; inline styles are used by components/charts.
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  }));
  if (isDev) app.use(honoLogger((line) => httpLog.debug(line)));

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(
        { error: { code: err.code, message: err.message, details: err.details } },
        err.status as 400,
      );
    }
    if (err instanceof z.ZodError) {
      return c.json({
        error: { code: "validation_error", message: "Invalid request", details: err.issues },
      }, 400);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: { code: "http_error", message: err.message } }, err.status);
    }
    httpLog.error("unhandled error", { err, path: c.req.path });
    return c.json({ error: { code: "internal", message: "Internal server error" } }, 500);
  });

  // ---- API ----
  const api = new Hono<AppEnv>();
  api.use("*", sessionMiddleware);
  api.use("*", csrfGuard(["/api/v1/agents/"]));
  api.route("/health", healthRoutes);
  api.route("/auth", authRoutes);
  api.route("/users", userRoutes);
  api.route("/audit", auditRoutes);
  api.route("/settings", settingsRoutes);
  api.route("/agent-releases", releaseRoutes);
  api.route("/agents/transfers", agentTransferRoutes);
  api.route("/agents", agentRoutes);
  api.route("/nodes", nodeRoutes);
  api.route("/enrollment-tokens", enrollmentRoutes);
  api.route("/templates", templateRoutes);
  api.route("/instances", instanceRoutes);
  api.route("/files", fileRoutes);
  app.route("/api/v1", api);
  app.all(
    "/api/*",
    (c) => c.json({ error: { code: "not_found", message: "Route not found" } }, 404),
  );

  // ---- WebSockets ----
  app.route("/ws", wsRoutes);
  app.all(
    "/ws/*",
    (c) => c.json({ error: { code: "not_found", message: "Route not found" } }, 404),
  );

  // ---- Agent downloads + install script ----
  app.route("/downloads", downloadRoutes);
  app.get(
    "/downloads/gsm-agent.service",
    serveStatic({ root: "../agent/packaging", path: "gsm-agent.service" }),
  );
  app.use("/downloads/*", serveStatic({ root: config.DATA_DIR }));
  app.get("/install.sh", serveStatic({ root: "../scripts", path: "install-agent.sh" }));

  // ---- Web app (production) with SPA fallback ----
  app.use("/*", serveStatic({ root: config.WEB_DIST }));
  app.get("/*", serveStatic({ root: config.WEB_DIST, path: "index.html" }));

  return app;
}
