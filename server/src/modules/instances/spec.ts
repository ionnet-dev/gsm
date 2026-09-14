/**
 * Builds what the agent needs for an instance: the container spec and the install spec. Nothing
 * here touches the database; the service loads the rows and hands them over.
 */
import { createHmac } from "node:crypto";
import type {
  DatabaseSpec,
  InstallSpec,
  InstanceSpec,
  PortBinding,
  TemplateDefinition,
} from "@gsm/shared";
import {
  DATABASE_HOST,
  DATABASE_PORT,
  databaseEnabled,
  heapForMemory,
  substitute,
} from "@gsm/shared";
import { config } from "../../config.ts";
import type { Instance, InstancePort } from "./models.ts";
import type { Node } from "../nodes/models.ts";

/** The uid:gid instance containers run as (the `gsm` user in the base image). */
export const CONTAINER_USER = { uid: 1500, gid: 1500 } as const;

/** The first agent that understands volumes, host mounts, databases and the container options. */
export const CONTAINER_OPTIONS_AGENT = "0.6.0";

/** `gsm-java:21` → `<registry>/gsm-java:21`; refs that already name a path or host are kept. */
export function qualifyImage(ref: string, registry: string): string {
  const firstColon = ref.indexOf(":");
  const head = firstColon === -1 ? ref : ref.slice(0, firstColon);
  if (head.includes("/") || !registry) return ref;
  return `${registry.replace(/\/+$/, "")}/${ref}`;
}

/** A secret for one instance and purpose, derived from SESSION_SECRET so it is never stored. */
function instanceSecret(uuid: string, purpose: string, length: number): string {
  return createHmac("sha256", config.SESSION_SECRET)
    .update(`${purpose}:${uuid}`)
    .digest("base64url")
    .slice(0, length);
}

/** The secret a template gives the game's network console (GSM_CONSOLE_PASSWORD). */
export function consolePassword(uuid: string): string {
  return instanceSecret(uuid, "console-password", 24);
}

/** The game's database password (GSM_DB_PASSWORD) and the database server's root password. */
export function databasePasswords(uuid: string): { password: string; rootPassword: string } {
  return {
    password: instanceSecret(uuid, "db-password", 32),
    rootPassword: instanceSecret(uuid, "db-root-password", 32),
  };
}

type EnvTemplate = Pick<TemplateDefinition, "env" | "database" | "variables">;

/**
 * The environment: the instance's variables, the platform's GSM_* facts, then the template's own
 * `env` with placeholders filled (it may not replace GSM_* names).
 */
export function buildEnv(
  instance: Pick<Instance, "uuid" | "name" | "variables" | "limits">,
  ports: Pick<InstancePort, "name" | "port">[],
  def?: EnvTemplate,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(instance.variables)) env[k] = v;
  env.GSM_INSTANCE_UUID = instance.uuid;
  env.GSM_INSTANCE_NAME = instance.name;
  env.GSM_MEMORY_MB = String(instance.limits.memoryMb);
  env.GSM_HEAP_MB = String(heapForMemory(instance.limits.memoryMb));
  env.GSM_BIND = "0.0.0.0";
  env.GSM_CONSOLE_PASSWORD = consolePassword(instance.uuid);
  for (const p of ports) env[`GSM_PORT_${p.name.toUpperCase()}`] = String(p.port);
  if (def?.database) {
    // Defined (empty) while the database is off, so {{GSM_DB_*}} in the template never leaks.
    const on = databaseEnabled(def, instance.variables);
    env.GSM_DB_HOST = on ? DATABASE_HOST : "";
    env.GSM_DB_PORT = on ? String(DATABASE_PORT) : "";
    env.GSM_DB_NAME = on ? def.database.name : "";
    env.GSM_DB_USER = on ? def.database.name : "";
    env.GSM_DB_PASSWORD = on ? databasePasswords(instance.uuid).password : "";
  }
  const facts = { ...env };
  for (const [k, v] of Object.entries(def?.env ?? {})) {
    if (!k.startsWith("GSM_")) env[k] = substitute(v, facts);
  }
  return env;
}

/** The instance's database server, or null when its template has none or it is turned off. */
export function databaseSpec(
  instance: Pick<Instance, "uuid" | "variables">,
  def: Pick<TemplateDefinition, "database" | "variables">,
): DatabaseSpec | null {
  const db = def.database;
  if (!db || !databaseEnabled(def, instance.variables)) return null;
  return {
    engine: db.engine,
    // Database images come from their own registry (Docker Hub), never the platform's.
    image: db.image,
    name: db.name,
    user: db.name,
    ...databasePasswords(instance.uuid),
    memoryMb: db.memoryMb,
  };
}

function portBindings(ports: Pick<InstancePort, "name" | "protocol" | "port">[]): PortBinding[] {
  const out: PortBinding[] = [];
  for (const p of ports) {
    const protocols = p.protocol === "both" ? (["tcp", "udp"] as const) : ([p.protocol] as const);
    for (const protocol of protocols) {
      out.push({ name: p.name, protocol, host: p.port, container: p.port });
    }
  }
  return out;
}

export function buildSpec(
  instance:
    & Pick<
      Instance,
      "uuid" | "name" | "image" | "variables" | "limits" | "restartOnCrash" | "startupOverride"
    >
    & Partial<Pick<Instance, "mounts">>,
  def: TemplateDefinition,
  node: Pick<Node, "bindAddress">,
  ports: Pick<InstancePort, "name" | "protocol" | "port">[],
  registry: string,
): InstanceSpec {
  const env = buildEnv(instance, ports, def);
  const transport = def.console.transport;
  return {
    uuid: instance.uuid,
    name: instance.name,
    image: qualifyImage(instance.image, registry),
    startup: substitute(instance.startupOverride || def.startup, env),
    env,
    ports: portBindings(ports),
    bindAddress: node.bindAddress,
    limits: instance.limits,
    stop: def.stop,
    console: {
      readyPattern: def.console.readyPattern,
      transport: transport
        ? {
          kind: transport.kind,
          port: transport.port ?? 0,
          path: transport.path,
          password: substitute(transport.password, env),
          ignore: transport.ignore,
        }
        : null,
    },
    files: def.files.map((f) => ({
      path: f.path,
      format: f.format,
      values: Object.fromEntries(
        Object.entries(f.values).map(([k, v]) => [k, substitute(v, env)]),
      ),
    })),
    restartOnCrash: instance.restartOnCrash,
    user: def.container.user ? { ...def.container.user } : { ...CONTAINER_USER },
    entrypoint: def.container.entrypoint,
    volumes: def.volumes.map(({ name, path, seed }) => ({ name, path, seed })),
    mounts: (instance.mounts ?? []).map(({ hostPath, containerPath, readOnly }) => ({
      hostPath,
      containerPath,
      readOnly,
    })),
    pull: def.container.pull,
    seccompUnconfined: def.container.seccompUnconfined,
    database: databaseSpec(instance, def),
  };
}

/**
 * What in the spec an agent older than CONTAINER_OPTIONS_AGENT would ignore or refuse, or null
 * when it asks for nothing new. (Another container user works on every agent.)
 */
export function newAgentFeature(spec: InstanceSpec): string | null {
  if (spec.volumes.length) return "Volumes";
  if (spec.mounts.length) return "Host mounts";
  if (spec.database) return "A database";
  if (spec.entrypoint !== null) return "An entrypoint override";
  if (spec.pull !== "missing") return "Pulling the image on every start";
  if (spec.seccompUnconfined) return "Running without seccomp";
  if (spec.files.some((f) => f.format === "source-cfg")) return "Source .cfg config files";
  if (spec.console.transport?.kind === "fifo") return "A console pipe";
  return null;
}

/** Backup ignore patterns for the template's volumes that stay out of backups. */
export function volumeBackupIgnore(def: Pick<TemplateDefinition, "volumes">): string[] {
  return def.volumes.filter((v) => !v.backup).map((v) => `volumes/${v.name}/**`);
}

export function buildInstall(
  def: TemplateDefinition,
  resolved: Record<string, string>,
  registry: string,
): InstallSpec {
  return {
    image: def.install.image ? qualifyImage(def.install.image, registry) : null,
    script: def.install.script,
    env: resolved,
    timeoutSeconds: def.install.timeoutSeconds,
  };
}
