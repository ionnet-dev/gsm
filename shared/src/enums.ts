export const NODE_STATUSES = ["online", "offline"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * Site-wide roles. `admin` manages nodes, templates, users and every instance; `user` only sees
 * the instances they were given access to (see INSTANCE_ROLES).
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

/** Config files a template keeps in step with its variables before every start. */
export const CONFIG_FILE_FORMATS = ["properties", "json", "ini", "yaml"] as const;
export type ConfigFileFormat = (typeof CONFIG_FILE_FORMATS)[number];

/** Second sign-in factors a user can turn on. */
export const TWO_FACTOR_METHODS = ["totp", "email"] as const;
export type TwoFactorMethod = (typeof TWO_FACTOR_METHODS)[number];

/** What completes a login challenge: an enabled method, or a one-time recovery code. */
export const SECOND_FACTORS = ["totp", "email", "recovery"] as const;
export type SecondFactor = (typeof SECOND_FACTORS)[number];

/** Which console a line belongs to: the game's own, or an install run's. */
export const CONSOLE_STREAMS = ["console", "install"] as const;
export type ConsoleStream = (typeof CONSOLE_STREAMS)[number];
