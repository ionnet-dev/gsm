import type { z } from "zod";
import {
  DEFAULT_FILES_SETTINGS,
  FilesSettings,
  GeneralSettings,
  HistoryRetentionSettings,
  SmtpSettings,
} from "@gsm/shared";
import { Setting } from "../../db/models.ts";

const cache = new Map<string, { value: unknown; at: number }>();
const CACHE_MS = 15_000;

export async function getSetting<T>(key: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value as T;
  const row = await Setting.findByPk(key);
  const parsed = row ? schema.safeParse(row.value) : null;
  const value = parsed?.success ? parsed.data : fallback;
  cache.set(key, { value, at: Date.now() });
  return value;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await Setting.upsert({ key, value });
  cache.set(key, { value, at: Date.now() });
}

export const GeneralSchema = GeneralSettings;
export const DEFAULT_GENERAL = GeneralSettings.parse({});
export const getGeneral = () => getSetting("general", GeneralSchema, DEFAULT_GENERAL);

export const SmtpSchema = SmtpSettings;
export const DEFAULT_SMTP = SmtpSettings.parse({});
export const getSmtp = () => getSetting("smtp", SmtpSchema, DEFAULT_SMTP);

export const HistoryRetentionSchema = HistoryRetentionSettings;
export const DEFAULT_HISTORY_RETENTION = HistoryRetentionSettings.parse({});
export const getHistoryRetention = () =>
  getSetting("history_retention", HistoryRetentionSchema, DEFAULT_HISTORY_RETENTION);

/** Size limits for the file manager. */
export const getFilesSettings = () => getSetting("files", FilesSettings, DEFAULT_FILES_SETTINGS);

/**
 * Registry credentials for private images, kept as a setting (plain text: they must be sent to
 * the registry as they are). null when none are set.
 */
export interface RegistryAuth {
  server: string;
  username: string;
  password: string;
}
export const getRegistryAuth = async (): Promise<RegistryAuth | null> => {
  const row = await Setting.findByPk("registry_auth");
  const v = row?.value as RegistryAuth | null | undefined;
  return v && v.server && v.username ? v : null;
};
