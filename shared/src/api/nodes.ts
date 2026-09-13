import { z } from "zod";
import type { NodeStatus } from "../enums.ts";
import type { DockerInfo, Inventory, Metrics } from "../protocol/agent.ts";
import { Pagination } from "./common.ts";

/** The default port pool for a new node. */
export const DEFAULT_PORT_RANGE = { start: 30000, end: 30999 } as const;

export interface NodeDto {
  id: number;
  name: string;
  hostname: string;
  status: NodeStatus;
  agentVersion: string | null;
  os: { id: string | null; name: string | null; version: string | null; prettyName: string | null };
  arch: string | null;
  cpu: { model: string | null; cores: number | null; threads: number | null };
  memoryTotal: number | null;
  docker: DockerInfo | null;
  /** Address players connect to; defaults to the address the agent connected from. */
  publicAddress: string;
  bindAddress: string;
  portRangeStart: number;
  portRangeEnd: number;
  dataDir: string | null;
  lastMetrics: Metrics | null;
  lastSeenAt: string | null;
  enrolledAt: string;
  notes: string | null;
  instanceCount: number;
  runningCount: number;
  /** Memory limits of every instance on the node added up (0-limit instances count nothing). */
  allocatedMemoryMb: number;
}

export interface NodeDetailDto extends NodeDto {
  inventory: Inventory | null;
  machineId: string;
  protocolVersion: number | null;
  /** The address the agent connects from, while connected. */
  remoteAddress: string | null;
  portsInUse: { port: number; protocol: "tcp" | "udp"; instanceId: number; name: string }[];
}

export interface NodeSummary {
  total: number;
  online: number;
  offline: number;
}

export interface EnrollmentTokenDto {
  id: number;
  name: string;
  tokenPrefix: string;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  revokedAt: string | null;
  usable: boolean;
  createdAt: string;
}

export const CreateEnrollmentTokenBody = z.object({
  name: z.string().min(1).max(120),
  maxUses: z.number().int().positive().nullable().default(null),
  expiresInHours: z.number().positive().max(24 * 365).nullable().default(24 * 7),
});
export type CreateEnrollmentTokenBody = z.input<typeof CreateEnrollmentTokenBody>;

export const ListNodesQuery = Pagination.extend({
  status: z.enum(["online", "offline"]).optional(),
  q: z.string().max(120).optional(),
});

export const UpdateNodeBody = z.object({
  name: z.string().min(1).max(120).optional(),
  notes: z.string().max(10_000).nullable().optional(),
  /** Empty string resets to the agent's connecting address. */
  publicAddress: z.string().max(253).optional(),
  bindAddress: z.string().min(1).max(64).optional(),
  portRangeStart: z.number().int().min(1024).max(65535).optional(),
  portRangeEnd: z.number().int().min(1024).max(65535).optional(),
});
export type UpdateNodeBody = z.input<typeof UpdateNodeBody>;
