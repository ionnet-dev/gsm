import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().default(3000),
  SITE_URL: z.string().url().default("http://localhost:5173"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LOG_SQL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  DB_HOST: z.string().default("127.0.0.1"),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_NAME: z.string().default("gsm"),
  DB_USER: z.string().default("gsm"),
  DB_PASSWORD: z.string().default("gsm"),
  AUTO_MIGRATE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  /**
   * Whether X-Forwarded-For (set by the reverse proxy in front of us) is trusted for the client IP.
   * Only the last hop is used, which the proxy appends and a client cannot forge. Set to "false"
   * when clients hit the server directly, otherwise the header is attacker-controlled.
   */
  TRUST_PROXY: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  WEB_DIST: z.string().default("../web/dist"),
  DATA_DIR: z.string().default("./data"),
  /** Built-in game templates (templates/*.json in the repo), seeded into the database on start. */
  TEMPLATES_DIR: z.string().default("../templates"),
  /** Agent builds baked into the image as <version>/<arch>; imported into DATA_DIR on start. */
  BUNDLED_AGENTS_DIR: z.string().optional(),
  DENO_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = Deno.env.toObject()): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config: Config = loadConfig();
export const isDev = config.DENO_ENV === "development";
