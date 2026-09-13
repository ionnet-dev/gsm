import { config, isDev } from "../config.ts";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

export type LogFields = Record<string, unknown>;

export class Logger {
  constructor(private readonly scope: string, private readonly base: LogFields = {}) {}

  child(scope: string, fields: LogFields = {}): Logger {
    return new Logger(`${this.scope}:${scope}`, { ...this.base, ...fields });
  }

  debug(msg: string, fields?: LogFields) {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields) {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields) {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields) {
    this.log("error", msg, fields);
  }

  private log(level: Level, msg: string, fields?: LogFields) {
    if (ORDER[level] < ORDER[config.LOG_LEVEL]) return;
    const all = { ...this.base, ...fields };
    if (all.err instanceof Error) {
      all.err = { name: all.err.name, message: all.err.message, stack: all.err.stack };
    }
    if (isDev) {
      const extra = Object.keys(all).length ? " " + JSON.stringify(all) : "";
      const ts = new Date().toISOString().slice(11, 23);
      console.log(
        `${COLORS[level]}${ts} ${level.padEnd(5)}${RESET} [${this.scope}] ${msg}${extra}`,
      );
    } else {
      console.log(
        JSON.stringify({ ts: new Date().toISOString(), level, scope: this.scope, msg, ...all }),
      );
    }
  }
}

export const log = new Logger("gsm");
