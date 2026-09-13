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
/** Lines of a multi-line list answer further apart than this belong to different answers. */
const LIST_LINE_GAP_MS = 15_000;
const LIST_MAX_ENTRIES = 1000;

export function nameValidator(pattern: string): (name: string | undefined) => name is string {
  const re = new RegExp(pattern);
  return (name): name is string => !!name && re.test(name);
}

/**
 * Compile a template's patterns once; throws when one of them does not compile. A matcher keeps
 * the lines of a multi-line list answer until its last line, so use one per instance.
 */
export function compileMatcher(p: TemplatePlayers, now: () => number = Date.now): PlayerMatcher {
  const re = (s: string | null) => (s ? new RegExp(s) : null);
  const join = re(p.console.join);
  const leave = re(p.console.leave);
  const identify = re(p.console.identify);
  const refresh = re(p.console.refresh);
  const answer = p.list ? new RegExp(p.list.pattern) : null;
  const entry = re(p.list?.entry ?? null);
  const listLine = re(p.list?.line ?? null);
  const separator = p.list?.separator ?? ",";
  const validName = nameValidator(p.namePattern);
  let pending: { at: number; players: SeenPlayer[] } | null = null;

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
      g = groups(listLine);
      if (g) {
        if (!pending || now() - pending.at > LIST_LINE_GAP_MS) pending = { at: now(), players: [] };
        pending.at = now();
        const key = g.name?.toLowerCase();
        if (
          validName(g.name) && pending.players.length < LIST_MAX_ENTRIES &&
          !pending.players.some((x) => x.name.toLowerCase() === key)
        ) {
          pending.players.push({ name: g.name, id: g.id || null });
        }
        return null;
      }
      g = groups(answer);
      if (g && listLine) {
        const fresh = pending && now() - pending.at <= LIST_LINE_GAP_MS ? pending.players : [];
        pending = null;
        // Another command's summary can look alike; a count that disagrees gives it away.
        if (g.count !== undefined && Number(g.count) !== fresh.length) return null;
        return { type: "list", players: fresh };
      }
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
  if (list.format === "xml") return listEntries(list, xmlElements(content, list.element ?? ""));
  const data: unknown = content.trim() === "" ? [] : JSON.parse(content);
  if (!Array.isArray(data)) throw new Error("expected a JSON array");
  return listEntries(list, data);
}

function listEntries(list: TemplatePlayerList, items: unknown[]): PlayerListEntryDto[] {
  const out: PlayerListEntryDto[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = entryId(list, obj);
    // Games that key their lists by id may leave the name out; the id stands in for it then.
    const name = scalar(obj[list.nameKey]) || id;
    if (!name) continue;
    const values: Record<string, string> = {};
    for (const c of list.columns) {
      const v = scalar(obj[c.key]);
      if (v !== "") values[c.key] = v;
    }
    out.push({ name, id, values });
  }
  return out;
}

/** `idFormat` fills `{{key}}` from the entry (null when one is missing), else `idKey`. */
function entryId(list: TemplatePlayerList, obj: Record<string, unknown>): string | null {
  if (list.idFormat) {
    let missing = false;
    const id = list.idFormat.replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, (_, key: string) => {
      const v = scalar(obj[key]);
      if (!v) missing = true;
      return v;
    });
    return missing || !id ? null : id;
  }
  return list.idKey ? scalar(obj[list.idKey]) || null : null;
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const decodeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] !== "#") return XML_ENTITIES[e.toLowerCase()] ?? m;
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The attributes of each `child` element inside the first `parent` element, as objects. Enough
 * XML for the files games write (7 Days to Die's serveradmin.xml): comments are skipped, child
 * content is not read. A missing parent is an empty list.
 */
export function xmlElements(content: string, element: string): Record<string, string>[] {
  const [parent, child] = element.split("/");
  if (!parent || !child) throw new Error(`bad element "${element}"`);
  const text = content.replace(/<!--[\s\S]*?-->/g, "");
  const section = new RegExp(
    `<${escapeRe(parent)}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${escapeRe(parent)}\\s*>)`,
  )
    .exec(text);
  if (!section?.[1]) return [];
  const out: Record<string, string>[] = [];
  for (const m of section[1].matchAll(new RegExp(`<${escapeRe(child)}((?:\\s[^>]*?)?)/?>`, "g"))) {
    const attrs: Record<string, string> = {};
    for (const a of m[1].matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[a[1]] = decodeXml(a[2] ?? a[3] ?? "");
    }
    out.push(attrs);
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
 * the space before it along, so `kick {{PLAYER}} {{REASON}}` becomes `kick Steve`. A placeholder
 * in double quotes (`"{{PLAYER}}"`) keeps a value with spaces in one argument: double quotes in the
 * value turn into single ones so it cannot end early, and an empty value drops the quotes too.
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
    /( ?)(?:"\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}"|\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\})/g,
    (m, space: string, quoted: string | undefined, bare: string | undefined) => {
      const name = quoted ?? bare!;
      if (!(name in values)) return m;
      const value = values[name];
      if (value === "") return "";
      return quoted ? `${space}"${value.replaceAll('"', "'")}"` : space + value;
    },
  ).trim();
  return { ok: true, command };
}
