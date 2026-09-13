/**
 * The pure half of player tracking: reading console lines, list answers and list files with a
 * template's `players` section, and turning an action into a console command. Nothing here touches
 * the database or an agent, so it is tested on its own.
 */
import type {
  PlayerListEntryDto,
  TemplatePlayerAction,
  TemplatePlayerActionField,
  TemplatePlayerList,
  TemplatePlayers,
} from "@gsm/shared";

export interface SeenPlayer {
  name: string;
  id: string | null;
}

/** What one console line says about players. */
export type PlayerEvent =
  | { type: "join"; name: string; id: string | null }
  | { type: "leave"; name: string }
  | { type: "identify"; name: string; id: string }
  | { type: "list"; players: SeenPlayer[] }
  | { type: "refresh" };

export interface PlayerMatcher {
  match(line: string): PlayerEvent | null;
  validName(name: string): boolean;
}

// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// deno-lint-ignore no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;
const FIELD_MAX_LENGTH = 200;

export function nameValidator(pattern: string): (name: string | undefined) => name is string {
  const re = new RegExp(pattern);
  return (name): name is string => !!name && re.test(name);
}

/** Compile a template's patterns once; throws when one of them does not compile. */
export function compileMatcher(p: TemplatePlayers): PlayerMatcher {
  const re = (s: string | null) => (s ? new RegExp(s) : null);
  const join = re(p.console.join);
  const leave = re(p.console.leave);
  const identify = re(p.console.identify);
  const refresh = re(p.console.refresh);
  const answer = p.list ? new RegExp(p.list.pattern) : null;
  const entry = re(p.list?.entry ?? null);
  const separator = p.list?.separator ?? ",";
  const validName = nameValidator(p.namePattern);

  return {
    validName,
    match(raw) {
      const line = raw.replace(ANSI, "");
      const groups = (r: RegExp | null) => r?.exec(line)?.groups;
      let g = groups(join);
      if (g && validName(g.name)) return { type: "join", name: g.name, id: g.id || null };
      g = groups(leave);
      if (g && validName(g.name)) return { type: "leave", name: g.name };
      g = groups(identify);
      if (g && validName(g.name) && g.id) return { type: "identify", name: g.name, id: g.id };
      g = groups(answer);
      if (g && g.names !== undefined) {
        return { type: "list", players: parseListAnswer(g.names, separator, entry, validName) };
      }
      if (refresh?.test(line)) return { type: "refresh" };
      return null;
    },
  };
}

/** Split the `names` part of a list answer into players; entries that don't parse are dropped. */
export function parseListAnswer(
  names: string,
  separator: string,
  entry: RegExp | null,
  validName: (name: string | undefined) => name is string,
): SeenPlayer[] {
  const out: SeenPlayer[] = [];
  const seen = new Set<string>();
  for (const part of names.split(separator)) {
    const text = part.trim();
    if (!text) continue;
    let player: SeenPlayer = { name: text, id: null };
    if (entry) {
      const g = entry.exec(text)?.groups;
      if (!g) continue;
      player = { name: g.name, id: g.id || null };
    }
    const key = player.name?.toLowerCase();
    if (!validName(player.name) || seen.has(key)) continue;
    seen.add(key);
    out.push(player);
  }
  return out;
}

const scalar = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "";

/** Read a list file's content; throws on JSON that is not an array. */
export function parseListFile(list: TemplatePlayerList, content: string): PlayerListEntryDto[] {
  if (list.format === "lines") {
    return content.split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter(Boolean)
      .map((name) => ({ name, id: null, values: {} }));
  }
  const data: unknown = content.trim() === "" ? [] : JSON.parse(content);
  if (!Array.isArray(data)) throw new Error("expected a JSON array");
  const out: PlayerListEntryDto[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = scalar(obj[list.nameKey]);
    if (!name) continue;
    const values: Record<string, string> = {};
    for (const c of list.columns) {
      const v = scalar(obj[c.key]);
      if (v !== "") values[c.key] = v;
    }
    out.push({ name, id: list.idKey ? scalar(obj[list.idKey]) || null : null, values });
  }
  return out;
}

/** Check one field value (already trimmed); returns the problem or null. */
export function checkField(
  f: TemplatePlayerActionField,
  value: string,
  validName: (name: string | undefined) => name is string,
): string | null {
  if (value === "") return f.required ? "Required" : null;
  if (CONTROL.test(value)) return "Must be a single line of text";
  if (value.length > FIELD_MAX_LENGTH) return `At most ${FIELD_MAX_LENGTH} characters`;
  switch (f.type) {
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) return "Must be a number";
      if (f.min !== null && n < f.min) return `Must be at least ${f.min}`;
      if (f.max !== null && n > f.max) return `Must be at most ${f.max}`;
      break;
    }
    case "select":
      if (!f.options.some((o) => o.value === value)) return "Not one of the options";
      break;
    case "player":
      if (!validName(value)) return "Not a valid player name";
      break;
  }
  return null;
}

export type BuiltCommand =
  | { ok: true; command: string }
  | { ok: false; problems: Record<string, string> };

/**
 * Fill an action's command for a player. Every value is checked first: names against the
 * template's name pattern (which keeps out selectors such as `@a`), fields against their type, and
 * nothing may hold a line break (it would start a second command). An empty optional field takes
 * the space before it along, so `kick {{PLAYER}} {{REASON}}` becomes `kick Steve`.
 */
export function buildActionCommand(
  action: TemplatePlayerAction,
  player: SeenPlayer,
  input: Record<string, string>,
  validName: (name: string | undefined) => name is string,
): BuiltCommand {
  const problems: Record<string, string> = {};
  if (!validName(player.name)) problems.PLAYER = "Not a valid player name";
  const declared = new Set(action.fields.map((f) => f.name));
  for (const name of Object.keys(input)) {
    if (!declared.has(name)) problems[name] = "Unknown field";
  }
  const values: Record<string, string> = {
    PLAYER: player.name,
    PLAYER_ID: player.id ?? player.name,
  };
  for (const f of action.fields) {
    const value = (input[f.name] ?? f.default).trim();
    const problem = checkField(f, value, validName);
    if (problem) problems[f.name] = problem;
    values[f.name] = value;
  }
  if (Object.keys(problems).length) return { ok: false, problems };
  const command = action.command.replace(
    /( ?)\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g,
    (m, space: string, name: string) =>
      name in values ? (values[name] === "" ? "" : space + values[name]) : m,
  ).trim();
  return { ok: true, command };
}
