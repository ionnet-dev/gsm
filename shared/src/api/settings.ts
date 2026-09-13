import { z } from "zod";

export const SmtpSettings = z.object({
  host: z.string().default(""),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  user: z.string().default(""),
  password: z.string().default(""),
  from: z.string().default(""),
});
export type SmtpSettings = z.infer<typeof SmtpSettings>;

export const GeneralSettings = z.object({
  siteName: z.string().min(1).max(80).default("Ionnet GSM"),
  /** Without a heartbeat a node is marked offline after this long. */
  offlineAfterSeconds: z.number().int().min(30).max(86_400).default(100),
  /** Prefix for template images that name a bare image: `gsm-java:21` → `<registry>/gsm-java:21`. */
  imageRegistry: z.string().max(200).default("ghcr.io/ionnet-dev"),
  /** Console lines the server keeps in memory per instance for newly opened consoles. */
  consoleHistoryLines: z.number().int().min(100).max(10_000).default(1000),
});
export type GeneralSettings = z.infer<typeof GeneralSettings>;

/** Days to keep history (0 = forever). */
export const HistoryRetentionSettings = z.object({
  auditDays: z.number().int().min(0).max(3650).default(0),
  backupsPerInstance: z.number().int().min(0).max(1000).default(0),
});
export type HistoryRetentionSettings = z.infer<typeof HistoryRetentionSettings>;
