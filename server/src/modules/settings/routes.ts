import { Hono } from "hono";
import { z } from "zod";
import { FilesSettings } from "@gsm/shared";
import type { AppEnv } from "../../app.ts";
import { parseBody } from "../../lib/http.ts";
import { sendTestEmail } from "../../lib/mailer.ts";
import { auditFrom } from "../audit/service.ts";
import { requireRole } from "../auth/middleware.ts";
import { reconfigureAgents } from "../nodes/service.ts";
import {
  GeneralSchema,
  getFilesSettings,
  getGeneral,
  getHistoryRetention,
  getRegistryAuth,
  getSmtp,
  HistoryRetentionSchema,
  setSetting,
  SmtpSchema,
} from "./service.ts";

export const settingsRoutes = new Hono<AppEnv>();
settingsRoutes.use("*", requireRole("admin"));

const MASK = "••••••••";

settingsRoutes.get("/", async (c) => {
  const [general, history, smtp, files, registry] = await Promise.all([
    getGeneral(),
    getHistoryRetention(),
    getSmtp(),
    getFilesSettings(),
    getRegistryAuth(),
  ]);
  return c.json({
    general,
    history,
    files,
    smtp: { ...smtp, password: smtp.password ? MASK : "" },
    registry: registry
      ? { server: registry.server, username: registry.username, password: MASK }
      : { server: "", username: "", password: "" },
  });
});

settingsRoutes.put("/general", async (c) => {
  const body = await parseBody(c, GeneralSchema);
  await setSetting("general", body);
  await auditFrom(c, "settings.update", { type: "settings" }, { section: "general" });
  return c.json({ general: body });
});

settingsRoutes.put("/history", async (c) => {
  const body = await parseBody(c, HistoryRetentionSchema);
  await setSetting("history_retention", body);
  await auditFrom(c, "settings.update", { type: "settings" }, { section: "history", ...body });
  return c.json({ history: body });
});

settingsRoutes.put("/files", async (c) => {
  const body = await parseBody(c, FilesSettings);
  await setSetting("files", body);
  await auditFrom(c, "settings.update", { type: "settings" }, { section: "files", ...body });
  return c.json({ files: body });
});

settingsRoutes.put("/smtp", async (c) => {
  const body = await parseBody(c, SmtpSchema);
  const current = await getSmtp();
  if (body.password === MASK) body.password = current.password; // unchanged placeholder
  await setSetting("smtp", body);
  await auditFrom(c, "settings.update", { type: "settings" }, { section: "smtp", host: body.host });
  return c.json({ smtp: { ...body, password: body.password ? MASK : "" } });
});

settingsRoutes.post("/smtp/test", async (c) => {
  const { to } = await parseBody(c, z.object({ to: z.string().email() }));
  await sendTestEmail(to);
  return c.json({ ok: true });
});

const RegistryBody = z.object({
  server: z.string().max(200).default(""),
  username: z.string().max(200).default(""),
  password: z.string().max(500).default(""),
});

/** Credentials agents use to pull private images; empty server clears them. */
settingsRoutes.put("/registry", async (c) => {
  const body = await parseBody(c, RegistryBody);
  const current = await getRegistryAuth();
  if (body.password === MASK && current) body.password = current.password;
  const value = body.server && body.username ? body : null;
  await setSetting("registry_auth", value);
  await auditFrom(c, "settings.update", { type: "settings" }, {
    section: "registry",
    server: body.server,
  });
  await reconfigureAgents();
  return c.json({
    registry: value
      ? { server: value.server, username: value.username, password: MASK }
      : { server: "", username: "", password: "" },
  });
});
