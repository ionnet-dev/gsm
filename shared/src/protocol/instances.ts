/**
 * Instances on a node: one Docker container each, its data bind-mounted from the node's data
 * directory. The server sends a complete `InstanceSpec` with every start so the agent never has
 * to remember anything about an instance beyond its container and files.
 */
import { z } from "zod";
import { CONFIG_FILE_FORMATS, CONSOLE_STREAMS, STOP_SIGNALS } from "../enums.ts";

export const InstanceUuid = z.string().uuid();

/** A published port: `host` on the node, `container` inside (usually the same number). */
export const PortBinding = z.object({
  name: z.string().min(1).max(32),
  protocol: z.enum(["tcp", "udp"]),
  host: z.number().int().min(1).max(65535),
  container: z.number().int().min(1).max(65535),
});
export type PortBinding = z.infer<typeof PortBinding>;

export const ResourceLimits = z.object({
  /** 0 = unlimited. The container's memory (and memory+swap) limit. */
  memoryMb: z.number().int().min(0),
  /** 0 = unlimited. Fractions allowed (1.5 = one and a half cores). */
  cpuCores: z.number().min(0),
  /** 0 = unlimited. Advisory: measured and shown, not enforced by the runtime. */
  diskMb: z.number().int().min(0),
});
export type ResourceLimits = z.infer<typeof ResourceLimits>;

/**
 * A config file the agent keeps in step with the instance's variables before every start:
 * `values` are written into the file (created when missing), other keys are left alone. Values
 * are already substituted by the server.
 */
export const ConfigFileSpec = z.object({
  path: z.string().min(1).max(512),
  format: z.enum(CONFIG_FILE_FORMATS),
  values: z.record(z.string(), z.string()),
});
export type ConfigFileSpec = z.infer<typeof ConfigFileSpec>;

/** Everything the agent needs to run the instance's container. */
export const InstanceSpec = z.object({
  uuid: InstanceUuid,
  name: z.string().min(1).max(120),
  image: z.string().min(1).max(300),
  /** The command run inside the container (via the image's entrypoint), variables substituted. */
  startup: z.string().min(1).max(4000),
  /** Environment for the container: the instance's variables plus GSM_* facts. */
  env: z.record(z.string(), z.string()),
  ports: z.array(PortBinding).max(64),
  /** The node address the ports are published on ("0.0.0.0" for every interface). */
  bindAddress: z.string().min(1).max(64),
  limits: ResourceLimits,
  stop: z.object({
    /** Typed into the console to stop gracefully; null sends the signal straight away. */
    command: z.string().max(200).nullable(),
    signal: z.enum(STOP_SIGNALS),
    /** How long to wait for a graceful stop before SIGKILL. */
    timeoutSeconds: z.number().int().min(1).max(600),
  }),
  console: z.object({
    /** A regular expression a console line matches once the server is ready for players. */
    readyPattern: z.string().max(500).nullable(),
  }),
  files: z.array(ConfigFileSpec).max(32),
  /** Start the container again when it exits with a non-zero code the operator did not ask for. */
  restartOnCrash: z.boolean(),
  /** The uid:gid the container runs as and the data directory is owned by. */
  user: z.object({ uid: z.number().int(), gid: z.number().int() }),
});
export type InstanceSpec = z.infer<typeof InstanceSpec>;

/** What the install run needs beyond the spec: a one-off container that fills the data dir. */
export const InstallSpec = z.object({
  /** Image to run the script in; the runtime image when null. */
  image: z.string().max(300).nullable(),
  /** POSIX shell script; runs as the instance user in /data with `env` and the spec's env. */
  script: z.string().min(1).max(64_000),
  /** Extra environment (resolved download URLs and the like). */
  env: z.record(z.string(), z.string()),
  timeoutSeconds: z.number().int().min(60).max(4 * 3600),
});
export type InstallSpec = z.infer<typeof InstallSpec>;

/** The states the agent reports; the server adds `installing`/`install_failed` around installs. */
export const AGENT_INSTANCE_STATES = [
  "stopped",
  "starting",
  "running",
  "stopping",
  "crashed",
  "installing",
] as const;

export const InstanceState = z.object({
  uuid: InstanceUuid,
  state: z.enum(AGENT_INSTANCE_STATES),
  /** The container id, when one exists. */
  containerId: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  /** From the last exit, until the next start. */
  exitCode: z.number().int().nullable(),
  /** The install marker is present: the data directory holds a server. */
  installed: z.boolean(),
  /** Set when the last operation on the instance failed (image missing, port taken, ...). */
  error: z.string().nullable(),
});
export type InstanceState = z.infer<typeof InstanceState>;

export const InstanceStats = z.object({
  uuid: InstanceUuid,
  at: z.string().datetime(),
  cpuPct: z.number().min(0),
  memUsedBytes: z.number().int().nonnegative(),
  /** 0 when unlimited. */
  memLimitBytes: z.number().int().nonnegative(),
  netRxBytes: z.number().int().nonnegative(),
  netTxBytes: z.number().int().nonnegative(),
  /** Bytes used by the instance's data directory; refreshed every few minutes, 0 until then. */
  diskUsedBytes: z.number().int().nonnegative(),
  /** Seconds since the container started. */
  uptimeSeconds: z.number().int().nonnegative(),
});
export type InstanceStats = z.infer<typeof InstanceStats>;

export const ConsoleLine = z.object({
  /** ms since the epoch, as the agent saw the line. */
  at: z.number().int(),
  text: z.string().max(16_384),
});
export type ConsoleLine = z.infer<typeof ConsoleLine>;

export const InstallOutputChunk = z.object({ lines: z.array(ConsoleLine).max(500) });

export const instanceMethods = {
  /** Every instance the agent knows on this node (containers labelled with an instance uuid). */
  "inst.list": { params: z.object({}), result: z.object({ instances: z.array(InstanceState) }) },
  "inst.status": { params: z.object({ uuid: InstanceUuid }), result: InstanceState },
  /**
   * Create the data directory and run the install script in a one-off container, streaming its
   * output. Refused while the instance's container is running.
   */
  "inst.install": {
    params: z.object({ spec: InstanceSpec, install: InstallSpec }),
    result: z.object({ exitCode: z.number().int(), durationMs: z.number().int() }),
    stream: InstallOutputChunk,
  },
  /** (Re)create the container from the spec and start it. */
  "inst.start": { params: z.object({ spec: InstanceSpec }), result: InstanceState },
  /**
   * Stop gracefully (stop command, then signal, then kill after the timeout) and wait for the
   * exit. `force` skips straight to SIGKILL.
   */
  "inst.stop": {
    params: z.object({ uuid: InstanceUuid, force: z.boolean() }),
    result: InstanceState,
  },
  "inst.restart": { params: z.object({ spec: InstanceSpec }), result: InstanceState },
  /** Write to the game's stdin (a newline is appended). */
  "inst.command": {
    params: z.object({ uuid: InstanceUuid, command: z.string().min(1).max(4000) }),
    result: z.object({}),
  },
  /** The last `lines` console lines from the node's log file. */
  "inst.consoleTail": {
    params: z.object({
      uuid: InstanceUuid,
      stream: z.enum(CONSOLE_STREAMS),
      lines: z.number().int().min(1).max(5000),
    }),
    result: z.object({ lines: z.array(ConsoleLine) }),
  },
  /** Remove the container and, with `deleteFiles`, the data directory, logs and backups. */
  "inst.remove": {
    params: z.object({ uuid: InstanceUuid, deleteFiles: z.boolean() }),
    result: z.object({}),
  },
  /** Ask for a fresh stats sample right away (the loop sends one every 10 s anyway). */
  "inst.stats": {
    params: z.object({ uuids: z.array(InstanceUuid).max(500) }),
    result: z.object({ stats: z.array(InstanceStats) }),
  },
} as const;

export const instanceEvents = {
  /** A state change (start, ready, exit, crash) on the node. */
  "inst.status": InstanceState,
  /** Console output, batched about every 100 ms. */
  "inst.console": z.object({
    uuid: InstanceUuid,
    stream: z.enum(CONSOLE_STREAMS),
    lines: z.array(ConsoleLine).max(500),
  }),
  /** Every 10 s for running instances. */
  "inst.stats": z.object({ stats: z.array(InstanceStats).max(500) }),
} as const;
