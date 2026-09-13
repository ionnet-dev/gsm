export const NODE_STATUSES = ["online", "offline"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * Site-wide roles. `admin` manages nodes, templates, users and every instance; `user` only sees
 * the instances they were given access to (see INSTANCE_ROLES) and the nodes an admin made them
 * owner of (with every instance on them).
 */
export const ROLES = ["admin", "user"] as const;
export type Role = (typeof ROLES)[number];

/**
 * What a user may do on one instance: `owner` everything including deleting it and sharing it,
 * `operator` run it (console, files, backups, settings), `viewer` watch it.
 */
export const INSTANCE_ROLES = ["owner", "operator", "viewer"] as const;
export type InstanceRole = (typeof INSTANCE_ROLES)[number];

/**
 * Where an instance is. `installing` and `install_failed` are set by the server around the install
 * run; the rest follow the container on the node. `crashed` is an exit the operator did not ask
 * for. `unknown` means the node has not reported on it yet (offline node).
 */
export const INSTANCE_STATUSES = [
  "installing",
  "install_failed",
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
  "unknown",
] as const;
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

export const BACKUP_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

/**
 * How a template variable is entered: free text, a number (with optional bounds), on/off, one of
 * a list, or a game version picked from a version source (see VersionSource).
 */
export const VARIABLE_TYPES = ["text", "number", "boolean", "select", "version"] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const PORT_PROTOCOLS = ["tcp", "udp", "both"] as const;
export type PortProtocol = (typeof PORT_PROTOCOLS)[number];

export const STOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGKILL"] as const;
export type StopSignal = (typeof STOP_SIGNALS)[number];

/**
 * Config files a template keeps in step with its variables before every start. `xml-properties`
 * is a file of `<property name="…" value="…"/>` elements, such as 7 Days to Die's serverconfig.xml.
 */
export const CONFIG_FILE_FORMATS = ["properties", "json", "ini", "yaml", "xml-properties"] as const;
export type ConfigFileFormat = (typeof CONFIG_FILE_FORMATS)[number];

/** Second sign-in factors a user can turn on. */
export const TWO_FACTOR_METHODS = ["totp", "email"] as const;
export type TwoFactorMethod = (typeof TWO_FACTOR_METHODS)[number];

/** What completes a login challenge: an enabled method, or a one-time recovery code. */
export const SECOND_FACTORS = ["totp", "email", "recovery"] as const;
export type SecondFactor = (typeof SECOND_FACTORS)[number];

/**
 * How console commands reach a game that does not read its stdin: a telnet session or Source RCON
 * on a port inside the container, which the agent dials over the Docker network.
 */
export const CONSOLE_TRANSPORTS = ["telnet", "rcon"] as const;
export type ConsoleTransportKind = (typeof CONSOLE_TRANSPORTS)[number];

/** Which console a line belongs to: the game's own, or an install run's. */
export const CONSOLE_STREAMS = ["console", "install"] as const;
export type ConsoleStream = (typeof CONSOLE_STREAMS)[number];

/**
 * How a template's player list file is read: a JSON array of objects, one name per line, or the
 * elements of one kind in an XML file (their attributes play the part of JSON keys).
 */
export const PLAYER_LIST_FORMATS = ["json", "lines", "xml"] as const;
export type PlayerListFormat = (typeof PLAYER_LIST_FORMATS)[number];

/** Inputs a player action can ask for; `player` picks another player who is online. */
export const PLAYER_FIELD_TYPES = ["text", "number", "select", "player"] as const;
export type PlayerFieldType = (typeof PLAYER_FIELD_TYPES)[number];

/** Icons the web app draws next to a player action. */
export const PLAYER_ACTION_ICONS = [
  "command",
  "message",
  "gamemode",
  "teleport",
  "give",
  "clear",
  "kill",
  "kick",
  "ban",
  "unban",
  "op",
  "deop",
  "whitelist",
  "unwhitelist",
] as const;
export type PlayerActionIcon = (typeof PLAYER_ACTION_ICONS)[number];
