/**
 * Builds what the agent needs for an instance: the container spec and the install spec. Nothing
 * here touches the database; the service loads the rows and hands them over.
 */
import type { InstallSpec, InstanceSpec, PortBinding, TemplateDefinition } from "@gsm/shared";
import { heapForMemory, substitute } from "@gsm/shared";
import type { Instance, InstancePort } from "./models.ts";
import type { Node } from "../nodes/models.ts";

/** The uid:gid instance containers run as (the `gsm` user in the base image). */
export const CONTAINER_USER = { uid: 1500, gid: 1500 } as const;

/** `gsm-java:21` → `<registry>/gsm-java:21`; refs that already name a path or host are kept. */
export function qualifyImage(ref: string, registry: string): string {
  const firstColon = ref.indexOf(":");
  const head = firstColon === -1 ? ref : ref.slice(0, firstColon);
  if (head.includes("/") || !registry) return ref;
  return `${registry.replace(/\/+$/, "")}/${ref}`;
}

/** The environment: the instance's variables plus the platform's GSM_* facts. */
export function buildEnv(
  instance: Pick<Instance, "uuid" | "name" | "variables" | "limits">,
  ports: Pick<InstancePort, "name" | "port">[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(instance.variables)) env[k] = v;
  env.GSM_INSTANCE_UUID = instance.uuid;
  env.GSM_INSTANCE_NAME = instance.name;
  env.GSM_MEMORY_MB = String(instance.limits.memoryMb);
  env.GSM_HEAP_MB = String(heapForMemory(instance.limits.memoryMb));
  env.GSM_BIND = "0.0.0.0";
  for (const p of ports) env[`GSM_PORT_${p.name.toUpperCase()}`] = String(p.port);
  return env;
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
  instance: Pick<
    Instance,
    "uuid" | "name" | "image" | "variables" | "limits" | "restartOnCrash" | "startupOverride"
  >,
  def: TemplateDefinition,
  node: Pick<Node, "bindAddress">,
  ports: Pick<InstancePort, "name" | "protocol" | "port">[],
  registry: string,
): InstanceSpec {
  const env = buildEnv(instance, ports);
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
    console: def.console,
    files: def.files.map((f) => ({
      path: f.path,
      format: f.format,
      values: Object.fromEntries(
        Object.entries(f.values).map(([k, v]) => [k, substitute(v, env)]),
      ),
    })),
    restartOnCrash: instance.restartOnCrash,
    user: { ...CONTAINER_USER },
  };
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
