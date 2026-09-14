import { z } from "zod";
import {
  INSTANCE_ROLES,
  INSTANCE_STATUSES,
  type InstanceRole,
  type InstanceStatus,
} from "../enums.ts";
import type { InstanceStats, ResourceLimits } from "../protocol/instances.ts";
import { Pagination } from "./common.ts";
import type { InstanceReachability } from "./reachability.ts";
import type { InstanceFirewallDto } from "./firewall.ts";
import { containerPathProblem, hostPathProblem, VARIABLE_NAME_RE } from "./templates.ts";
import type { DatabaseEngine } from "../enums.ts";

export const VariableValues = z.record(z.string().regex(VARIABLE_NAME_RE), z.string().max(4000));

const pathChecked = (max: number, problem: (p: string) => string | null) =>
  z.string().min(2).max(max).superRefine((p, ctx) => {
    const why = problem(p);
    if (why) ctx.addIssue({ code: "custom", message: why });
  });

/**
 * A directory on the node mounted into the instance's container. Only admins set them, and the
 * node's agent refuses paths outside the roots its config allows.
 */
export const HostMount = z.object({
  hostPath: pathChecked(500, hostPathProblem),
  containerPath: pathChecked(300, containerPathProblem),
  readOnly: z.boolean().default(false),
});
export type HostMount = z.infer<typeof HostMount>;

const HostMounts = z.array(HostMount).max(16).superRefine((list, ctx) => {
  const seen = new Set<string>();
  list.forEach((m, i) => {
    if (seen.has(m.containerPath)) {
      ctx.addIssue({
        code: "custom",
        path: [i, "containerPath"],
        message: "Another mount uses that path",
      });
    }
    seen.add(m.containerPath);
  });
});

/** A template volume as an instance has it: `folder` is where it is in the instance's files. */
export interface InstanceVolumeDto {
  name: string;
  label: string;
  description: string;
  /** Inside the container. */
  path: string;
  /** In the instance's files: volumes/<name>. */
  folder: string;
  backup: boolean;
}

/** How the game reaches the instance's database; the password is shown to `settings` roles. */
export interface InstanceDatabaseDto {
  engine: DatabaseEngine;
  image: string;
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
}

export const DatabaseDumpBody = z.object({
  /** Where in the instance's files; `database-dumps/<name>-<time>.sql.gz` when null. */
  path: z.string().min(1).max(512).regex(
    /\.sql\.gz$/,
    "The dump is gzipped: end the name in .sql.gz",
  )
    .nullable().default(null),
});
export const DatabaseImportBody = z.object({
  /** A .sql or .sql.gz file in the instance's files. */
  path: z.string().min(1).max(512),
});

export interface InstancePortDto {
  name: string;
  label: string;
  protocol: "tcp" | "udp" | "both";
  port: number;
  primary: boolean;
}

export interface InstanceDto {
  id: number;
  uuid: string;
  name: string;
  description: string | null;
  status: InstanceStatus;
  /** Why the last operation failed, if it did. */
  error: string | null;
  node: { id: number; name: string; status: "online" | "offline"; publicAddress: string };
  template: { id: number; slug: string; name: string; game: string; icon: string };
  image: string;
  ports: InstancePortDto[];
  limits: ResourceLimits;
  restartOnCrash: boolean;
  /** Start when the node's agent comes up. */
  autoStart: boolean;
  installedAt: string | null;
  lastStartedAt: string | null;
  lastStats: InstanceStats | null;
  createdAt: string;
  updatedAt: string;
  /** The requester's role on it; "owner" for admins and the node's owners. */
  myRole: InstanceRole;
  /** `<publicAddress>:<primary port>` for players. */
  address: string | null;
  /** Players online now; null when the template does not track players. */
  players: { online: number } | null;
  /** The last reachability check of its ports (current ports only); null before the first. */
  reachability: InstanceReachability | null;
  firewall: InstanceFirewallDto;
  /** The database server beside it, when its template has one and it is turned on. */
  database: { engine: DatabaseEngine; image: string; name: string } | null;
}

export interface InstanceDetailDto extends InstanceDto {
  /** Only the variables the requester may see. */
  variables: Record<string, string>;
  /** The startup command, when overridden per instance. */
  startupOverride: string | null;
  createdBy: { id: number; name: string } | null;
  /** The template's volumes: instance folders mounted elsewhere in the container. */
  volumes: InstanceVolumeDto[];
  /** Node directories mounted into the container (set by admins). */
  mounts: HostMount[];
}

export interface InstanceAccessDto {
  userId: number;
  name: string;
  email: string;
  role: InstanceRole;
  grantedAt: string;
  /** `node`: the user owns the instance's node, which makes them owner here; changed on the node. */
  via: "instance" | "node";
}

export interface InstanceSummary {
  total: number;
  byStatus: Record<InstanceStatus, number>;
}

export const ListInstancesQuery = Pagination.extend({
  nodeId: z.coerce.number().int().optional(),
  templateId: z.coerce.number().int().optional(),
  status: z.enum(INSTANCE_STATUSES).optional(),
  q: z.string().max(120).optional(),
  sort: z.enum(["name", "status", "createdAt", "node"]).default("name"),
  dir: z.enum(["asc", "desc"]).default("asc"),
});

const Limits = z.object({
  memoryMb: z.number().int().min(0).max(1024 * 1024),
  cpuCores: z.number().min(0).max(1024),
  diskMb: z.number().int().min(0).max(1024 * 1024 * 10),
});

/** Ports chosen by hand: template port name → host port. Missing ones are auto-assigned. */
const PortChoices = z.record(
  z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  z.number().int().min(1).max(65535),
);

export const CreateInstanceBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().default(null),
  nodeId: z.number().int().positive(),
  templateId: z.number().int().positive(),
  /** One of the template's images; the template default when null. */
  image: z.string().max(300).nullable().default(null),
  variables: VariableValues.default({}),
  ports: PortChoices.default({}),
  limits: Limits.nullable().default(null),
  restartOnCrash: z.boolean().nullable().default(null),
  autoStart: z.boolean().default(false),
  /** Run the install straight away (default) or leave the instance uninstalled. */
  install: z.boolean().default(true),
  /** Also make this user an owner of the instance (the node's owners already are). */
  ownerUserId: z.number().int().positive().nullable().default(null),
});
export type CreateInstanceBody = z.input<typeof CreateInstanceBody>;

export const UpdateInstanceBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  image: z.string().min(1).max(300).optional(),
  variables: VariableValues.optional(),
  ports: PortChoices.optional(),
  limits: Limits.optional(),
  restartOnCrash: z.boolean().optional(),
  autoStart: z.boolean().optional(),
  startupOverride: z.string().max(4000).nullable().optional(),
  /** Admins only. Replaces the list; the instance must be stopped. */
  mounts: HostMounts.optional(),
});
export type UpdateInstanceBody = z.input<typeof UpdateInstanceBody>;

export const POWER_ACTIONS = ["start", "stop", "restart", "kill"] as const;
export type PowerAction = (typeof POWER_ACTIONS)[number];

export const PowerBody = z.object({ action: z.enum(POWER_ACTIONS) });
export const CommandBody = z.object({ command: z.string().min(1).max(4000) });

export const GrantAccessBody = z.object({
  userId: z.number().int().positive(),
  role: z.enum(INSTANCE_ROLES),
});

/** Which instance roles may do what; admins may do everything, node owners are `owner`. */
export const INSTANCE_PERMISSIONS = {
  view: ["owner", "operator", "viewer"],
  console: ["owner", "operator", "viewer"],
  command: ["owner", "operator"],
  power: ["owner", "operator"],
  files: ["owner", "operator"],
  backups: ["owner", "operator"],
  settings: ["owner", "operator"],
  /** Player actions (kick, ban, …) and the game's player lists. */
  players: ["owner", "operator"],
  access: ["owner"],
  delete: ["owner"],
  reinstall: ["owner"],
  /** Open the instance's ports in the node's firewall (when the node allows it). */
  firewall: ["owner"],
} as const satisfies Record<string, readonly InstanceRole[]>;
export type InstancePermission = keyof typeof INSTANCE_PERMISSIONS;

export function roleAllows(role: InstanceRole | null, permission: InstancePermission): boolean {
  return role !== null &&
    (INSTANCE_PERMISSIONS[permission] as readonly InstanceRole[]).includes(role);
}

/** Statuses from which each power action makes sense. */
export const POWER_ALLOWED: Record<PowerAction, readonly InstanceStatus[]> = {
  start: ["stopped", "crashed", "unknown"],
  stop: ["running", "starting", "crashed", "unknown"],
  restart: ["running", "starting", "stopped", "crashed"],
  kill: ["running", "starting", "stopping", "crashed", "unknown"],
};
