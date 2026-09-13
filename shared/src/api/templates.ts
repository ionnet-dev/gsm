/**
 * A template describes how to install and run one kind of game server: the image, the install
 * script, the startup command, the variables the operator fills in, the ports, and the config
 * files kept in step with those variables. Built-in templates ship with the server
 * (templates/*.json); custom ones are made in the UI. The schema is what both store.
 */
import { z } from "zod";
import {
  CONFIG_FILE_FORMATS,
  PLAYER_ACTION_ICONS,
  PLAYER_FIELD_TYPES,
  PLAYER_LIST_FORMATS,
  PORT_PROTOCOLS,
  STOP_SIGNALS,
  VARIABLE_TYPES,
} from "../enums.ts";

export const VARIABLE_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const TEMPLATE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Version sources the server can list and resolve. `minecraft:vanilla` lists Mojang's manifest;
 * `minecraft:forge` and `minecraft:neoforge` list loader versions for a parent game version.
 */
export const VERSION_SOURCES = [
  "minecraft:vanilla",
  "minecraft:forge",
  "minecraft:neoforge",
] as const;
export type VersionSource = (typeof VERSION_SOURCES)[number];

/**
 * Install resolvers turn variables into download URLs for the install script's environment:
 * `minecraft-vanilla` gives SERVER_JAR_URL for MC_VERSION; `minecraft-forge` and
 * `minecraft-neoforge` give INSTALLER_URL for MC_VERSION + LOADER_VERSION.
 */
export const INSTALL_RESOLVERS = [
  "minecraft-vanilla",
  "minecraft-forge",
  "minecraft-neoforge",
] as const;
export type InstallResolver = (typeof INSTALL_RESOLVERS)[number];

export const TemplateVariable = z.object({
  name: z.string().regex(VARIABLE_NAME_RE),
  label: z.string().min(1).max(80),
  description: z.string().max(500).default(""),
  type: z.enum(VARIABLE_TYPES),
  default: z.string().max(4000).default(""),
  required: z.boolean().default(false),
  /** For `select`. */
  options: z.array(z.object({ value: z.string().max(200), label: z.string().max(80) })).default([]),
  /** For `number`. */
  min: z.number().nullable().default(null),
  max: z.number().nullable().default(null),
  /** For `version`: which list to offer, and the variable holding the parent version, if any. */
  versionSource: z.enum(VERSION_SOURCES).nullable().default(null),
  dependsOn: z.string().regex(VARIABLE_NAME_RE).nullable().default(null),
  /** Instance owners and operators may change it (admins always can). */
  editable: z.boolean().default(true),
  /** Shown to instance users at all. */
  viewable: z.boolean().default(true),
  /** Free-text regular expression the value must match. */
  pattern: z.string().max(200).nullable().default(null),
});
export type TemplateVariable = z.infer<typeof TemplateVariable>;

export const TemplatePort = z.object({
  /** Also the suffix of the env var: `game` → GSM_PORT_GAME. */
  name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: z.string().min(1).max(80),
  protocol: z.enum(PORT_PROTOCOLS),
  /** Preferred port; the node pool gives the next free one when it is taken. */
  default: z.number().int().min(1).max(65535),
  /** True for the port players connect to (shown as the instance's address). */
  primary: z.boolean().default(false),
});
export type TemplatePort = z.infer<typeof TemplatePort>;

export const TemplateConfigFile = z.object({
  path: z.string().min(1).max(512),
  format: z.enum(CONFIG_FILE_FORMATS),
  /** Key → value with `{{VAR}}` placeholders. Nested keys use dots for json/yaml. */
  values: z.record(z.string().min(1).max(200), z.string().max(2000)),
});
export type TemplateConfigFile = z.infer<typeof TemplateConfigFile>;

/** Ids of player lists and actions: `ops`, `whitelist-add`. */
export const PLAYER_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** A regular expression (JavaScript syntax) that compiles and declares the named groups. */
function regexString(groups: string[] = []) {
  return z.string().min(1).max(500).refine(
    (p) => {
      try {
        new RegExp(p);
      } catch {
        return false;
      }
      return groups.every((g) => p.includes(`(?<${g}>`));
    },
    groups.length
      ? `Must be a valid regular expression with the named group${groups.length > 1 ? "s" : ""} ${
        groups.join(", ")
      }`
      : "Must be a valid regular expression",
  );
}

/**
 * A list the game keeps in a file inside the instance (operators, bans, a whitelist). The panel
 * reads it to show who is on it and to offer the actions that fit.
 */
export const TemplatePlayerList = z.object({
  id: z.string().regex(PLAYER_KEY_RE),
  /** Tab title: "Operators". */
  label: z.string().min(1).max(60),
  /** Shown next to a player who is on the list: "Operator". */
  badge: z.string().max(30).default(""),
  path: z.string().min(1).max(512),
  /** `json`: an array of objects; `lines`: one name per line, `#` starts a comment. */
  format: z.enum(PLAYER_LIST_FORMATS),
  /** For `json`: the keys holding each entry's name and id. */
  nameKey: z.string().min(1).max(60).default("name"),
  idKey: z.string().min(1).max(60).nullable().default(null),
  /** For `json`: more keys of each entry to show as columns. */
  columns: z.array(z.object({ key: z.string().min(1).max(60), label: z.string().min(1).max(40) }))
    .max(8).default([]),
});
export type TemplatePlayerList = z.infer<typeof TemplatePlayerList>;

/** Something a player action asks for before it runs; its value fills `{{NAME}}`. */
export const TemplatePlayerActionField = z.object({
  name: z.string().regex(VARIABLE_NAME_RE),
  label: z.string().min(1).max(80),
  type: z.enum(PLAYER_FIELD_TYPES).default("text"),
  required: z.boolean().default(false),
  default: z.string().max(200).default(""),
  placeholder: z.string().max(120).default(""),
  /** For `select`. */
  options: z.array(z.object({ value: z.string().max(200), label: z.string().max(80) })).default([]),
  /** For `number`. */
  min: z.number().nullable().default(null),
  max: z.number().nullable().default(null),
});
export type TemplatePlayerActionField = z.infer<typeof TemplatePlayerActionField>;

/**
 * A console command run for one player. `{{PLAYER}}` is the player's name, `{{PLAYER_ID}}` their
 * id (the name when unknown), and each field fills its own placeholder.
 */
export const TemplatePlayerAction = z.object({
  id: z.string().regex(PLAYER_KEY_RE),
  label: z.string().min(1).max(60),
  /** Menu section: "Moderation". */
  group: z.string().max(40).default(""),
  icon: z.enum(PLAYER_ACTION_ICONS).default("command"),
  command: z.string().min(1).max(500).regex(/^[^\n\r\0]+$/, "Must be a single line"),
  fields: z.array(TemplatePlayerActionField).max(8).default([]),
  /** Only offered for players who are online right now. */
  online: z.boolean().default(false),
  /** Only offered when the player is (`is: true`) or is not on one of the lists. */
  when: z.object({ list: z.string().regex(PLAYER_KEY_RE), is: z.boolean() }).nullable().default(
    null,
  ),
  /** Asks for confirmation and is shown in red. */
  danger: z.boolean().default(false),
});
export type TemplatePlayerAction = z.infer<typeof TemplatePlayerAction>;

/**
 * How the panel knows who plays on an instance and what it can do to them. Who is online comes
 * from console lines (and the answer to `list.command`); lists come from files; actions are
 * console commands.
 */
export const TemplatePlayers = z.object({
  /** Valid player names. Every name put into a command is checked against it first. */
  namePattern: regexString().default("^[A-Za-z0-9_]{1,32}$"),
  console: z.object({
    /** A player joined: groups `name` and, optionally, `id`. */
    join: regexString(["name"]).nullable().default(null),
    /** A player left: group `name`. */
    leave: regexString(["name"]).nullable().default(null),
    /** A line naming a player's id, usually just before the join: groups `name` and `id`. */
    identify: regexString(["name", "id"]).nullable().default(null),
    /** Lines after which the lists are read again (a ban, a new operator, …). */
    refresh: regexString().nullable().default(null),
  }).default({ join: null, leave: null, identify: null, refresh: null }),
  /** A command that prints who is online, and how to read its answer. */
  list: z.object({
    command: z.string().min(1).max(200).regex(/^[^\n\r\0]+$/, "Must be a single line"),
    /** Matches the answer; group `names` holds the entries. */
    pattern: regexString(["names"]),
    separator: z.string().min(1).max(10).default(","),
    /** Matches one entry: groups `name` and, optionally, `id`. Without it an entry is a name. */
    entry: regexString(["name"]).nullable().default(null),
  }).nullable().default(null),
  lists: z.array(TemplatePlayerList).max(8).default([]),
  actions: z.array(TemplatePlayerAction).max(40).default([]),
}).superRefine((p, ctx) => {
  const lists = new Set(p.lists.map((l) => l.id));
  if (lists.size !== p.lists.length) {
    ctx.addIssue({ code: "custom", path: ["lists"], message: "List ids must be unique" });
  }
  const ids = new Set<string>();
  p.actions.forEach((a, i) => {
    if (ids.has(a.id)) {
      ctx.addIssue({ code: "custom", path: ["actions", i, "id"], message: "Duplicate action id" });
    }
    ids.add(a.id);
    if (a.when && !lists.has(a.when.list)) {
      ctx.addIssue({
        code: "custom",
        path: ["actions", i, "when", "list"],
        message: `No list called ${a.when.list}`,
      });
    }
    const known = new Set(["PLAYER", "PLAYER_ID", ...a.fields.map((f) => f.name)]);
    a.fields.forEach((f, j) => {
      if (f.name === "PLAYER" || f.name === "PLAYER_ID") {
        ctx.addIssue({
          code: "custom",
          path: ["actions", i, "fields", j, "name"],
          message: `${f.name} is filled in by the panel`,
        });
      }
    });
    for (const m of a.command.matchAll(/\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g)) {
      if (!known.has(m[1])) {
        ctx.addIssue({
          code: "custom",
          path: ["actions", i, "command"],
          message: `{{${m[1]}}} is neither PLAYER, PLAYER_ID nor one of the fields`,
        });
      }
    }
  });
});
export type TemplatePlayers = z.infer<typeof TemplatePlayers>;

export const TemplateDefinition = z.object({
  schemaVersion: z.literal(1),
  slug: z.string().regex(TEMPLATE_SLUG_RE),
  name: z.string().min(1).max(120),
  /** The game, for grouping: "Minecraft: Java Edition". */
  game: z.string().min(1).max(80),
  description: z.string().max(2000).default(""),
  /** An emoji or short glyph shown next to the name. */
  icon: z.string().max(8).default("🎮"),
  tags: z.array(z.string().max(40)).max(20).default([]),
  /** The runtime image; `images` lists the alternatives an operator may pick. */
  image: z.string().min(1).max(300),
  images: z.array(z.object({ label: z.string().max(80), ref: z.string().min(1).max(300) })).default(
    [],
  ),
  install: z.object({
    image: z.string().max(300).nullable().default(null),
    script: z.string().min(1).max(64_000),
    resolver: z.enum(INSTALL_RESOLVERS).nullable().default(null),
    timeoutSeconds: z.number().int().min(60).max(4 * 3600).default(1800),
  }),
  startup: z.string().min(1).max(4000),
  stop: z.object({
    command: z.string().max(200).nullable().default(null),
    signal: z.enum(STOP_SIGNALS).default("SIGTERM"),
    timeoutSeconds: z.number().int().min(1).max(600).default(30),
  }).default({ command: null, signal: "SIGTERM", timeoutSeconds: 30 }),
  console: z.object({
    readyPattern: z.string().max(500).nullable().default(null),
  }).default({ readyPattern: null }),
  variables: z.array(TemplateVariable).max(64).default([]),
  ports: z.array(TemplatePort).max(32).default([]),
  files: z.array(TemplateConfigFile).max(32).default([]),
  /** Defaults for new instances. */
  resources: z.object({
    memoryMb: z.number().int().min(0).default(2048),
    cpuCores: z.number().min(0).default(0),
    diskMb: z.number().int().min(0).default(0),
  }).default({ memoryMb: 2048, cpuCores: 0, diskMb: 0 }),
  restartOnCrash: z.boolean().default(true),
  /** Paths (globs) left out of backups by default. */
  backupIgnore: z.array(z.string().max(200)).max(100).default([]),
  /** Player tracking and actions; null when the game has none the panel understands. */
  players: TemplatePlayers.nullable().default(null),
});
export type TemplateDefinition = z.infer<typeof TemplateDefinition>;
export type TemplateDefinitionInput = z.input<typeof TemplateDefinition>;

export interface TemplateDto {
  id: number;
  slug: string;
  name: string;
  game: string;
  description: string;
  icon: string;
  tags: string[];
  /** Ships with the server; edits are refused (copy it instead). */
  builtin: boolean;
  /** Bumped by the server for built-ins when the shipped file changes. */
  revision: number;
  instanceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateDetailDto extends TemplateDto {
  definition: TemplateDefinition;
}

/** One entry of a version list (`GET /templates/versions`). */
export interface VersionOption {
  id: string;
  label: string;
  /** "release", "snapshot", "recommended", "latest", … for filtering. */
  kind: string;
  releasedAt: string | null;
}

/** Variables the platform provides to every instance; templates may reference them. */
export const BUILTIN_VARIABLES = [
  { name: "GSM_INSTANCE_UUID", description: "The instance id" },
  { name: "GSM_INSTANCE_NAME", description: "The instance name" },
  { name: "GSM_MEMORY_MB", description: "The container's memory limit in MiB (0 = unlimited)" },
  {
    name: "GSM_HEAP_MB",
    description: "A safe JVM heap for the memory limit: limit minus overhead (2048 when unlimited)",
  },
  { name: "GSM_PORT_<NAME>", description: "The host port for each template port, upper-cased" },
  { name: "GSM_BIND", description: "Address to listen on inside the container (0.0.0.0)" },
] as const;

/** Substitute `{{NAME}}` placeholders; unknown names are left as they are. */
export function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(
    /\{\{\s*([A-Z][A-Z0-9_]*)\s*\}\}/g,
    (m, name: string) => name in vars ? vars[name] : m,
  );
}

/** The JVM heap to give a container with `memoryMb` of memory (0 = unlimited). */
export function heapForMemory(memoryMb: number): number {
  if (memoryMb <= 0) return 2048;
  if (memoryMb <= 1024) return Math.max(256, Math.floor(memoryMb * 0.75));
  return memoryMb - Math.min(1024, Math.max(384, Math.floor(memoryMb * 0.15)));
}

/** Check one variable value against its declaration; returns the problem or null. */
export function validateVariable(v: TemplateVariable, value: string): string | null {
  if (value === "") return v.required ? "Required" : null;
  switch (v.type) {
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) return "Must be a number";
      if (v.min !== null && n < v.min) return `Must be at least ${v.min}`;
      if (v.max !== null && n > v.max) return `Must be at most ${v.max}`;
      break;
    }
    case "boolean":
      if (value !== "true" && value !== "false") return "Must be true or false";
      break;
    case "select":
      if (!v.options.some((o) => o.value === value)) return "Not one of the options";
      break;
  }
  if (v.pattern) {
    try {
      if (!new RegExp(v.pattern).test(value)) return "Does not match the expected format";
    } catch {
      // A broken pattern in a template must not lock every value out.
    }
  }
  if (/[\0\n\r]/.test(value)) return "Must be a single line";
  return null;
}
