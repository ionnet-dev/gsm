/**
 * A template describes how to install and run one kind of game server: the image, the install
 * script, the startup command, the variables the operator fills in, the ports, and the config
 * files kept in step with those variables. Built-in templates ship with the server
 * (templates/*.json); custom ones are made in the UI. The schema is what both store.
 */
import { z } from "zod";
import {
  CONFIG_FILE_FORMATS,
  CONSOLE_TRANSPORTS,
  DATABASE_ENGINES,
  IMAGE_PULL_POLICIES,
  PLAYER_ACTION_ICONS,
  PLAYER_FIELD_TYPES,
  PLAYER_LIST_FORMATS,
  PORT_PROTOCOLS,
  STOP_SIGNALS,
  VARIABLE_TYPES,
} from "../enums.ts";

export const VARIABLE_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const TEMPLATE_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** A template volume's name, also its folder in the instance's files: volumes/<name>. */
export const VOLUME_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** Environment variable names a template may set. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** A database (and its user) name. */
export const DATABASE_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

/** Directories a volume or mount may not sit in: the kernel's, the instance files', the agent's. */
const RESERVED_CONTAINER_TREES = ["/proc", "/sys", "/dev", "/data", "/gsm"];
/** Directories a volume or mount may not replace outright; the image cannot work without them. */
const RESERVED_CONTAINER_DIRS = [
  "/",
  "/bin",
  "/boot",
  "/etc",
  "/lib",
  "/lib32",
  "/lib64",
  "/run",
  "/sbin",
  "/usr",
  "/var",
];

/** Clean absolute path: no empty, `.` or `..` segments, no trailing slash, no `:` or `,`. */
function absolutePathProblem(path: string): string | null {
  if (!path.startsWith("/")) return "Must be an absolute path";
  if (path !== "/" && path.endsWith("/")) return "Must not end with a slash";
  if (!/^\/[A-Za-z0-9._@+\-/]*$/.test(path)) {
    return "Letters, digits, / and . _ - @ + only";
  }
  if (path.split("/").slice(1).some((s) => s === "." || s === ".." || (s === "" && path !== "/"))) {
    return "Must not contain empty, . or .. parts";
  }
  return null;
}

/** Why `path` cannot be a mount point inside an instance's container, or null when it can. */
export function containerPathProblem(path: string): string | null {
  const problem = absolutePathProblem(path);
  if (problem) return problem;
  if (RESERVED_CONTAINER_DIRS.includes(path)) return `${path} cannot be replaced`;
  const tree = RESERVED_CONTAINER_TREES.find((r) => path === r || path.startsWith(r + "/"));
  if (tree) return `${tree} is reserved`;
  return null;
}

/** Why `path` cannot be mounted from a node, or null when it can (the node's agent has the last word). */
export function hostPathProblem(path: string): string | null {
  const problem = absolutePathProblem(path);
  if (problem) return problem;
  if (path === "/") return "Cannot mount the whole node";
  return null;
}

const ContainerPath = z.string().min(2).max(300).superRefine((p, ctx) => {
  const problem = containerPathProblem(p);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

/**
 * Version sources the server can list and resolve. `minecraft:vanilla` lists Mojang's manifest;
 * `minecraft:forge` and `minecraft:neoforge` list loader versions for a parent game version.
 * `steam:<app id>` lists the app's public Steam branches (for SteamCMD's `-beta`), from
 * api.steamcmd.net, with `public` and `latest_experimental` when that cannot be reached.
 */
export const VERSION_SOURCES = [
  "minecraft:vanilla",
  "minecraft:forge",
  "minecraft:neoforge",
  "steam:294420",
  "steam:4020",
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
  /** For `select`: the options are suggestions and any other value is accepted too. */
  allowCustom: z.boolean().default(false),
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
  /** Heading the variable is shown under ("World", "Rules"); variables without one come first. */
  group: z.string().max(40).default(""),
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
  /**
   * The name of an earlier port this one always comes right after (its number plus one), for
   * games that use a run of ports from one setting, like 7 Days to Die's game port and the two
   * after it. Such ports are never picked on their own.
   */
  follows: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).nullable().default(null),
});
export type TemplatePort = z.infer<typeof TemplatePort>;

export const TemplateConfigFile = z.object({
  path: z.string().min(1).max(512),
  format: z.enum(CONFIG_FILE_FORMATS),
  /** Key → value with `{{VAR}}` placeholders. Nested keys use dots for json/yaml. */
  values: z.record(z.string().min(1).max(200), z.string().max(2000)),
});
export type TemplateConfigFile = z.infer<typeof TemplateConfigFile>;

/**
 * A directory of the instance mounted somewhere other than /data, for images that keep their
 * server outside /data (a prebuilt image with the game in it). It is kept in the instance's files
 * as volumes/<name>, so the file manager, SFTP and backups see it, and it outlives the container,
 * image updates and reinstalls like everything else there.
 */
export const TemplateVolume = z.object({
  name: z.string().regex(VOLUME_NAME_RE),
  label: z.string().min(1).max(80),
  description: z.string().max(300).default(""),
  /** Where it appears inside the container: an absolute path outside /data. */
  path: ContainerPath,
  /**
   * Fill it with what the image has at `path` when the folder does not exist yet (stock maps,
   * default configs). Deleting the folder fills it again on the next start.
   */
  seed: z.boolean().default(false),
  /** Include it in backups; off for caches and downloads that come back by themselves. */
  backup: z.boolean().default(true),
});
export type TemplateVolume = z.infer<typeof TemplateVolume>;

/**
 * How the container runs, for images not built on the platform's base image. The defaults suit the
 * base image: its entrypoint, the gsm user (1500), Docker's seccomp filter, pull when missing.
 */
export const TemplateContainer = z.object({
  /**
   * Replaces the image's entrypoint; `sh -c "<startup>"` follows it. An empty list runs the
   * startup command with no entrypoint (Docker's init is PID 1 then). Null keeps the image's.
   */
  entrypoint: z.array(z.string().min(1).max(500)).max(16).nullable().default(null),
  /** Run as this uid:gid, and own the instance's files as it, for images built around a user. */
  user: z.object({
    uid: z.number().int().min(1).max(2_147_483_647),
    gid: z.number().int().min(1).max(2_147_483_647),
  }).nullable().default(null),
  /** `always` pulls before every start and install (images under a moving tag such as latest). */
  pull: z.enum(IMAGE_PULL_POLICIES).default("missing"),
  /**
   * Turn Docker's seccomp filter off for the container. Some Docker hosts refuse a socket call that
   * 32-bit Source servers make. Only built-in templates and admins may set it.
   */
  seccompUnconfined: z.boolean().default(false),
});
export type TemplateContainer = z.infer<typeof TemplateContainer>;

/**
 * A database server beside the instance: its own container, on a network only the two share, with
 * its files outside the instance's. The game reaches it at GSM_DB_HOST:GSM_DB_PORT as GSM_DB_USER
 * with GSM_DB_PASSWORD; the password is derived per instance and never stored. Backups carry a
 * dump of it.
 */
export const TemplateDatabase = z.object({
  engine: z.enum(DATABASE_ENGINES).default("mariadb"),
  image: z.string().min(1).max(300).default("mariadb:11.4"),
  /** The database's name, and its user's. */
  name: z.string().regex(DATABASE_NAME_RE).default("gsm"),
  /** The database container's memory limit; 0 = unlimited. */
  memoryMb: z.number().int().min(0).max(1024 * 1024).default(1024),
  /** A boolean variable that turns the database on per instance; always on when null. */
  enabledBy: z.string().regex(VARIABLE_NAME_RE).nullable().default(null),
});
export type TemplateDatabase = z.infer<typeof TemplateDatabase>;

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
  /**
   * `json`: an array of objects; `lines`: one name per line, `#` starts a comment; `xml`: the
   * `element` entries of an XML file, whose attributes are read like JSON keys.
   */
  format: z.enum(PLAYER_LIST_FORMATS),
  /** For `xml`: the entries' element under its parent, as `parent/child` (`whitelist/user`). */
  element: z.string().regex(/^[A-Za-z_][\w.-]*\/[A-Za-z_][\w.-]*$/).nullable().default(null),
  /** For `json` and `xml`: the keys holding each entry's name and id. */
  nameKey: z.string().min(1).max(60).default("name"),
  idKey: z.string().min(1).max(60).nullable().default(null),
  /** Builds the id from several keys instead, like `{{platform}}_{{userid}}`; wins over `idKey`. */
  idFormat: z.string().max(120).nullable().default(null),
  /** For `json` and `xml`: more keys of each entry to show as columns. */
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
    /**
     * Matches the answer; group `names` holds the entries. With `line`, matches the line that
     * ends a multi-line answer instead, and needs no group.
     */
    pattern: regexString(),
    separator: z.string().min(1).max(10).default(","),
    /** Matches one entry: groups `name` and, optionally, `id`. Without it an entry is a name. */
    entry: regexString(["name"]).nullable().default(null),
    /**
     * For answers with a line per player: matches each such line (groups `name` and, optionally,
     * `id`). The lines seen before the one matching `pattern` make up the answer.
     */
    line: regexString(["name"]).nullable().default(null),
  }).nullable().default(null),
  lists: z.array(TemplatePlayerList).max(8).default([]),
  actions: z.array(TemplatePlayerAction).max(40).default([]),
}).superRefine((p, ctx) => {
  if (p.list && !p.list.line && !p.list.pattern.includes("(?<names>")) {
    ctx.addIssue({
      code: "custom",
      path: ["list", "pattern"],
      message: "Needs the named group names, unless `line` reads a multi-line answer",
    });
  }
  p.lists.forEach((l, i) => {
    if (l.format === "xml" && !l.element) {
      ctx.addIssue({
        code: "custom",
        path: ["lists", i, "element"],
        message: "An xml list names its element, like whitelist/user",
      });
    }
  });
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
    /**
     * For games that do not read commands on stdin: telnet or Source RCON on `port` inside the
     * container (not a template port; it is never published), or `fifo`, a named pipe at `path`
     * inside the container that the image's start script reads its console from. `password` may
     * use placeholders, such as {{GSM_CONSOLE_PASSWORD}}; answers matching `ignore` are not shown
     * (lines the game printed on stdout already).
     */
    transport: z.object({
      kind: z.enum(CONSOLE_TRANSPORTS),
      port: z.number().int().min(1).max(65535).nullable().default(null),
      path: z.string().max(300).nullable().default(null),
      password: z.string().max(200).default(""),
      ignore: z.string().max(500).nullable().default(null),
    }).superRefine((t, ctx) => {
      if (t.kind !== "fifo") {
        if (t.port === null) {
          ctx.addIssue({ code: "custom", path: ["port"], message: "Needs the console's port" });
        }
        return;
      }
      const problem = t.path === null ? "Needs the pipe's path" : absolutePathProblem(t.path);
      if (problem) ctx.addIssue({ code: "custom", path: ["path"], message: problem });
    }).nullable().default(null),
  }).default({ readyPattern: null, transport: null }),
  variables: z.array(TemplateVariable).max(64).default([]),
  ports: z.array(TemplatePort).max(32).default([]),
  files: z.array(TemplateConfigFile).max(32).default([]),
  /**
   * More environment for the container, with `{{VAR}}` placeholders: `"DB_HOST":
   * "{{GSM_DB_HOST}}"` for an image that reads its own names. GSM_* names are the platform's.
   */
  env: z.record(z.string().regex(ENV_NAME_RE), z.string().max(2000)).default({}),
  volumes: z.array(TemplateVolume).max(16).default([]),
  container: TemplateContainer.default({
    entrypoint: null,
    user: null,
    pull: "missing",
    seccompUnconfined: false,
  }),
  database: TemplateDatabase.nullable().default(null),
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
}).superRefine((d, ctx) => {
  const names = new Set<string>();
  d.ports.forEach((p, i) => {
    if (names.has(p.name)) {
      ctx.addIssue({ code: "custom", path: ["ports", i, "name"], message: "Duplicate port name" });
    }
    if (p.follows !== null && !names.has(p.follows)) {
      ctx.addIssue({
        code: "custom",
        path: ["ports", i, "follows"],
        message: "Must name a port listed before this one",
      });
    }
    if (p.follows !== null && d.ports.some((o, j) => j < i && o.follows === p.follows)) {
      ctx.addIssue({
        code: "custom",
        path: ["ports", i, "follows"],
        message: `Only one port can follow ${p.follows}`,
      });
    }
    if (p.follows !== null && p.primary) {
      ctx.addIssue({
        code: "custom",
        path: ["ports", i, "primary"],
        message: "A port that follows another cannot be the primary one",
      });
    }
    names.add(p.name);
  });
  const volumeNames = new Set<string>();
  const volumePaths = new Set<string>();
  d.volumes.forEach((v, i) => {
    if (volumeNames.has(v.name)) {
      ctx.addIssue({ code: "custom", path: ["volumes", i, "name"], message: "Duplicate volume" });
    }
    if (volumePaths.has(v.path)) {
      ctx.addIssue({
        code: "custom",
        path: ["volumes", i, "path"],
        message: "Another volume is mounted there",
      });
    }
    volumeNames.add(v.name);
    volumePaths.add(v.path);
  });
  for (const key of Object.keys(d.env)) {
    if (key.startsWith("GSM_")) {
      ctx.addIssue({
        code: "custom",
        path: ["env", key],
        message: "GSM_* variables are set by the platform",
      });
    }
  }
  const enabledBy = d.database?.enabledBy;
  if (enabledBy && !d.variables.some((v) => v.name === enabledBy && v.type === "boolean")) {
    ctx.addIssue({
      code: "custom",
      path: ["database", "enabledBy"],
      message: "Must name a boolean variable of this template",
    });
  }
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
  {
    name: "GSM_CONSOLE_PASSWORD",
    description:
      "A random secret for the game's network console (telnet or RCON), fixed per instance",
  },
  {
    name: "GSM_DB_HOST",
    description:
      "With a database: its host name inside the instance (db); empty while it is turned off",
  },
  { name: "GSM_DB_PORT", description: "With a database: its port (3306)" },
  { name: "GSM_DB_NAME", description: "With a database: the database's name" },
  { name: "GSM_DB_USER", description: "With a database: the user the game signs in as" },
  {
    name: "GSM_DB_PASSWORD",
    description: "With a database: that user's password, derived per instance",
  },
] as const;

/** Whether an instance with these variables has the template's database turned on. */
export function databaseEnabled(
  def: Pick<TemplateDefinition, "database" | "variables">,
  vars: Record<string, string>,
): boolean {
  if (!def.database) return false;
  const by = def.database.enabledBy;
  return by === null || (vars[by] ?? def.variables.find((v) => v.name === by)?.default) === "true";
}

/** The port a port's run starts at (itself unless it `follows` one) and how far after it it is. */
export function portRun(
  ports: Pick<TemplatePort, "name" | "follows">[],
  name: string,
): { head: string; offset: number } {
  let head = name;
  let offset = 0;
  for (;;) {
    const follows = ports.find((p) => p.name === head)?.follows;
    if (!follows || offset >= ports.length) return { head, offset };
    head = follows;
    offset++;
  }
}

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
      if (!v.allowCustom && !v.options.some((o) => o.value === value)) {
        return "Not one of the options";
      }
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
