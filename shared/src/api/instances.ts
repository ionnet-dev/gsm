import { z } from "zod";
import {
  INSTANCE_ROLES,
  INSTANCE_STATUSES,
  type InstanceRole,
  type InstanceStatus,
} from "../enums.ts";
import type { InstanceStats, ResourceLimits } from "../protocol/instances.ts";
import { Pagination } from "./common.ts";
import { VARIABLE_NAME_RE } from "./templates.ts";

export const VariableValues = z.record(z.string().regex(VARIABLE_NAME_RE), z.string().max(4000));

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
  /** The requester's role on it; "owner" for admins. */
  myRole: InstanceRole;
  /** `<publicAddress>:<primary port>` for players. */
  address: string | null;
  /** Players online now; null when the template does not track players. */
  players: { online: number } | null;
}

export interface InstanceDetailDto extends InstanceDto {
  /** Only the variables the requester may see. */
  variables: Record<string, string>;
  /** The startup command, when overridden per instance. */
  startupOverride: string | null;
  createdBy: { id: number; name: string } | null;
}

export interface InstanceAccessDto {
  userId: number;
  name: string;
  email: string;
  role: InstanceRole;
  grantedAt: string;
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
  /** Give the creator the owner role (admins creating for someone else may skip it). */
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

/** Which instance roles may do what; admins may do everything. */
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
