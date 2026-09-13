/**
 * Server <-> agent method and event payloads.
 * Method names are namespaced "<area>.<verb>". Streams are tied to the request id.
 * Every schema here has a hand-mirrored Go struct in agent/internal/protocol/types.go.
 */
import { z } from "zod";
import { instanceEvents, instanceMethods } from "./instances.ts";
import { fileMethods } from "./files.ts";
import { backupMethods } from "./backups.ts";
import { imageMethods } from "./images.ts";

// ---- inventory & presence -------------------------------------------------

export const DiskInfo = z.object({
  device: z.string(),
  mountpoint: z.string(),
  fstype: z.string(),
  totalBytes: z.number().int().nonnegative(),
});
export type DiskInfo = z.infer<typeof DiskInfo>;

/** What the agent found out about the container runtime on the node. */
export const DockerInfo = z.object({
  available: z.boolean(),
  /** Why it is unavailable (socket missing, permission denied); "" when it works. */
  error: z.string(),
  version: z.string(),
  apiVersion: z.string(),
  storageDriver: z.string(),
  rootDir: z.string(),
});
export type DockerInfo = z.infer<typeof DockerInfo>;

export const Inventory = z.object({
  hostname: z.string(),
  /** Contents of /etc/machine-id; stable across reinstalls of the agent, not of the OS. */
  machineId: z.string(),
  os: z.object({ id: z.string(), name: z.string(), version: z.string(), prettyName: z.string() }),
  kernel: z.string(),
  arch: z.string(),
  cpu: z.object({ model: z.string(), cores: z.number().int(), threads: z.number().int() }),
  memoryTotalBytes: z.number().int().nonnegative(),
  disks: z.array(DiskInfo),
  /** Non-loopback IPv4/IPv6 addresses, for the node's default public address. */
  addresses: z.array(z.string()),
  bootTime: z.string().datetime(),
  docker: DockerInfo,
  /** Where instance data lives on the node (the agent's data_dir). */
  dataDir: z.string(),
});
export type Inventory = z.infer<typeof Inventory>;

export const Hello = z.object({
  protocolVersion: z.number().int(),
  agentVersion: z.string(),
  inventory: Inventory,
});
export type Hello = z.infer<typeof Hello>;

/** Node-level metrics, every 30 s; doubles as the heartbeat. */
export const Metrics = z.object({
  at: z.string().datetime(),
  cpuPct: z.number().min(0).max(100),
  memUsedBytes: z.number().int().nonnegative(),
  memTotalBytes: z.number().int().nonnegative(),
  swapUsedBytes: z.number().int().nonnegative(),
  swapTotalBytes: z.number().int().nonnegative(),
  load: z.tuple([z.number(), z.number(), z.number()]),
  disks: z.array(
    z.object({
      mountpoint: z.string(),
      usedBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
    }),
  ),
  net: z.object({
    rxBytesPerSec: z.number().nonnegative(),
    txBytesPerSec: z.number().nonnegative(),
  }),
  uptimeSeconds: z.number().int().nonnegative(),
  /** Bytes used under the data directory (instances, backups); measured every few minutes. */
  dataUsedBytes: z.number().int().nonnegative(),
});
export type Metrics = z.infer<typeof Metrics>;

export const PingResult = z.object({ at: z.string().datetime(), agentVersion: z.string() });

/** Server-side settings the agent needs; sent after hello and on change. */
export const AgentConfigureParams = z.object({
  /** Credentials for pulling from a private registry; null clears them. */
  registryAuth: z
    .object({ server: z.string(), username: z.string(), password: z.string() })
    .nullable()
    .optional(),
});
export type AgentConfigureParams = z.infer<typeof AgentConfigureParams>;

export const AgentUpdateParams = z.object({
  version: z.string(),
  /** Relative download path on the server, e.g. /downloads/gsm-agent/1.2.0/x86_64. */
  path: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Method table: server -> agent. Params/result/stream schemas per method. */
export const agentMethods = {
  "agent.ping": { params: z.object({}), result: PingResult },
  "agent.configure": { params: AgentConfigureParams, result: z.object({}) },
  /**
   * Download `<server>/<path>`, verify, replace the binary and exit so systemd restarts the agent.
   */
  "agent.update": {
    params: AgentUpdateParams,
    result: z.object({ replaced: z.boolean(), message: z.string() }),
  },
  "sys.inventory": { params: z.object({}), result: Inventory },
  ...instanceMethods,
  ...fileMethods,
  ...backupMethods,
  ...imageMethods,
} as const;
export type AgentMethod = keyof typeof agentMethods;
export type AgentParams<M extends AgentMethod> = z.input<(typeof agentMethods)[M]["params"]>;
export type AgentResult<M extends AgentMethod> = z.infer<(typeof agentMethods)[M]["result"]>;

/** Event table: agent -> server. */
export const agentEvents = {
  hello: Hello,
  metrics: Metrics,
  "agent.log": z.object({ level: z.enum(["debug", "info", "warn", "error"]), message: z.string() }),
  ...instanceEvents,
} as const;
export type AgentEvent = keyof typeof agentEvents;
export type AgentEventData<E extends AgentEvent> = z.infer<(typeof agentEvents)[E]>;
