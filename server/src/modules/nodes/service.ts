/**
 * Nodes: enrollment, agent authentication, presence and the node-level facts the agent reports.
 * Instances on a node live in modules/instances; this module only counts them.
 */
import { Op, type WhereOptions } from "sequelize";
import type {
  AgentConfigureParams,
  Hello,
  Metrics,
  NodeDetailDto,
  NodeDto,
  NodeStatus,
  NodeSummary,
} from "@gsm/shared";
import { PROTOCOL_VERSION } from "@gsm/shared";
import type { z } from "zod";
import { EnrollmentToken, Instance, InstancePort, Node } from "../../db/models.ts";
import { sequelize } from "../../db/sequelize.ts";
import { badRequest, conflict, notFound, unauthorized } from "../../lib/errors.ts";
import { events } from "../../lib/events.ts";
import { randomId, sha256Hex, timingSafeEqual } from "../../lib/ids.ts";
import { log } from "../../lib/logger.ts";
import { uiGateway } from "../../ws/ui-gateway.ts";
import { agentGateway } from "../../ws/agent-gateway.ts";
import * as audit from "../audit/service.ts";
import { getRegistryAuth } from "../settings/service.ts";
import type {
  CreateEnrollmentTokenBody,
  EnrollBody,
  ListNodesQuery,
  UpdateNodeBody,
} from "./schemas.ts";

const nlog = log.child("nodes");
const ENROLL_PREFIX = "gsm_enr_";

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

interface Counts {
  instances: number;
  running: number;
  allocatedMemoryMb: number;
}

async function countsFor(ids: number[]): Promise<Map<number, Counts>> {
  const out = new Map<number, Counts>();
  if (!ids.length) return out;
  const rows = await Instance.findAll({
    attributes: ["nodeId", "status", "limits"],
    where: { nodeId: { [Op.in]: ids } },
  });
  for (const r of rows) {
    const c = out.get(r.nodeId) ?? { instances: 0, running: 0, allocatedMemoryMb: 0 };
    c.instances++;
    if (r.status === "running" || r.status === "starting") c.running++;
    c.allocatedMemoryMb += r.limits?.memoryMb ?? 0;
    out.set(r.nodeId, c);
  }
  return out;
}

export function nodeDto(n: Node, counts?: Counts): NodeDto {
  return {
    id: n.id,
    name: n.name,
    hostname: n.hostname,
    status: n.status,
    agentVersion: n.agentVersion,
    os: { id: n.osId, name: n.osName, version: n.osVersion, prettyName: n.osPrettyName },
    arch: n.arch,
    cpu: { model: n.cpuModel, cores: n.cpuCores, threads: n.cpuThreads },
    memoryTotal: n.memoryTotal,
    docker: n.docker,
    publicAddress: publicAddressOf(n),
    bindAddress: n.bindAddress,
    portRangeStart: n.portRangeStart,
    portRangeEnd: n.portRangeEnd,
    dataDir: n.dataDir,
    lastMetrics: n.lastMetrics,
    lastSeenAt: n.lastSeenAt?.toISOString() ?? null,
    enrolledAt: n.enrolledAt.toISOString(),
    notes: n.notes,
    instanceCount: counts?.instances ?? 0,
    runningCount: counts?.running ?? 0,
    allocatedMemoryMb: counts?.allocatedMemoryMb ?? 0,
  };
}

/** The address players use: the configured one, else the agent's connecting address, else "". */
export function publicAddressOf(n: Node): string {
  if (n.publicAddress) return n.publicAddress;
  const remote = agentGateway.remoteAddress(n.id);
  if (remote) return remote.startsWith("::ffff:") ? remote.slice(7) : remote;
  const inv = n.inventory?.addresses.find((a) => !a.includes(":")) ?? n.inventory?.addresses[0];
  return inv ?? n.hostname;
}

export async function nodeDetailDto(n: Node): Promise<NodeDetailDto> {
  const counts = (await countsFor([n.id])).get(n.id);
  const ports = await InstancePort.findAll({
    where: { nodeId: n.id },
    order: [["port", "ASC"]],
  });
  return {
    ...nodeDto(n, counts),
    inventory: n.inventory,
    machineId: n.machineId,
    protocolVersion: n.protocolVersion,
    remoteAddress: agentGateway.remoteAddress(n.id),
    portsInUse: ports.flatMap((p) =>
      (p.protocol === "both" ? ["tcp", "udp"] as const : [p.protocol]).map((protocol) => ({
        port: p.port,
        protocol,
        instanceId: p.instanceId,
        name: p.name,
      }))
    ),
  };
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export async function createEnrollmentToken(
  input: z.infer<typeof CreateEnrollmentTokenBody>,
  createdBy: number,
) {
  const plaintext = ENROLL_PREFIX + randomId(24);
  const token = await EnrollmentToken.create({
    name: input.name,
    tokenHash: await sha256Hex(plaintext),
    tokenPrefix: plaintext.slice(0, 12),
    maxUses: input.maxUses,
    expiresAt: input.expiresInHours ? new Date(Date.now() + input.expiresInHours * 3600_000) : null,
    revokedAt: null,
    createdBy,
  });
  return { token: enrollmentTokenDto(token), plaintext };
}

export function enrollmentTokenDto(t: EnrollmentToken) {
  return {
    id: t.id,
    name: t.name,
    tokenPrefix: t.tokenPrefix,
    maxUses: t.maxUses,
    uses: t.uses,
    expiresAt: t.expiresAt?.toISOString() ?? null,
    revokedAt: t.revokedAt?.toISOString() ?? null,
    usable: t.isUsable(),
    createdAt: t.createdAt.toISOString(),
  };
}

export async function listEnrollmentTokens() {
  const tokens = await EnrollmentToken.findAll({ order: [["id", "DESC"]] });
  return tokens.map(enrollmentTokenDto);
}

export async function revokeEnrollmentToken(id: number) {
  const token = await EnrollmentToken.findByPk(id);
  if (!token) throw notFound("Enrollment token");
  token.revokedAt = new Date();
  await token.save();
}

/**
 * Exchange an enrollment token for a per-agent token. If a node with the same /etc/machine-id
 * already exists it is re-attached (secret rotated, inventory refreshed) instead of duplicated.
 */
export async function enroll(input: z.infer<typeof EnrollBody>, ip: string | null) {
  const token = await EnrollmentToken.findOne({
    where: { tokenHash: await sha256Hex(input.token) },
  });
  if (!token || !token.isUsable()) throw unauthorized("Invalid or expired enrollment token");

  const secret = randomId(32);
  const secretHash = await sha256Hex(secret);
  const inv = input.inventory;
  const name = input.name?.trim() || inv.hostname || "node";

  const node = await sequelize.transaction(async (transaction) => {
    let node = await Node.findOne({ where: { machineId: inv.machineId }, transaction });
    let reattached = false;
    if (node) {
      reattached = true;
      node.agentSecretHash = secretHash;
      node.applyInventory(inv);
      node.enrollmentTokenId = token.id;
      node.enrolledAt = new Date();
      await node.save({ transaction });
    } else {
      node = Node.build({
        name,
        hostname: inv.hostname,
        machineId: inv.machineId,
        agentSecretHash: secretHash,
        agentVersion: input.agentVersion,
        protocolVersion: null,
        osId: null,
        osName: null,
        osVersion: null,
        osPrettyName: null,
        kernel: null,
        arch: null,
        cpuModel: null,
        cpuCores: null,
        cpuThreads: null,
        memoryTotal: null,
        docker: null,
        dataDir: null,
        inventory: null,
        lastMetrics: null,
        lastSeenAt: null,
        enrollmentTokenId: token.id,
        notes: null,
      });
      node.applyInventory(inv);
      await node.save({ transaction });
    }
    token.uses += 1;
    await token.save({ transaction });
    await audit.record({
      actorUserId: null,
      action: reattached ? "node.reenroll" : "node.enroll",
      targetType: "node",
      targetId: node.id,
      details: { name: node.name, hostname: inv.hostname, token: token.name },
      ip,
    });
    return node;
  });

  nlog.info("node enrolled", { id: node.id, name: node.name });
  uiGateway.broadcast("node.updated", { nodeId: node.id });
  return { agentToken: `${node.id}.${secret}`, nodeId: node.id, name: node.name };
}

/** Validate a bearer token of the form "<nodeId>.<secret>". */
export async function authenticateAgent(bearer: string | undefined): Promise<Node | null> {
  if (!bearer) return null;
  const dot = bearer.indexOf(".");
  if (dot <= 0) return null;
  const id = Number(bearer.slice(0, dot));
  if (!Number.isInteger(id) || id <= 0) return null;
  const node = await Node.findByPk(id);
  if (!node) return null;
  const hash = await sha256Hex(bearer.slice(dot + 1));
  return timingSafeEqual(hash, node.agentSecretHash) ? node : null;
}

// ---------------------------------------------------------------------------
// Presence (called by the agent gateway)
// ---------------------------------------------------------------------------

export type HelloResult =
  | { ok: true; config: AgentConfigureParams }
  | { ok: false; reason: string };

async function agentConfig(): Promise<AgentConfigureParams> {
  return { registryAuth: await getRegistryAuth() };
}

/** Re-sends agent.configure to connected agents after a setting changed. */
export async function reconfigureAgents(ids = agentGateway.connectedIds()): Promise<void> {
  const cfg = await agentConfig();
  await Promise.all(
    ids.filter((id) => agentGateway.isConnected(id)).map(async (id) => {
      try {
        await agentGateway.request(id, "agent.configure", cfg);
      } catch (err) {
        nlog.warn("agent.configure failed", { id, err: String(err) });
      }
    }),
  );
}

export async function onAgentHello(nodeId: number, hello: Hello): Promise<HelloResult> {
  if (hello.protocolVersion !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason:
        `protocol version ${hello.protocolVersion} not supported (server speaks ${PROTOCOL_VERSION})`,
    };
  }
  const node = await Node.findByPk(nodeId);
  if (!node) return { ok: false, reason: "node no longer exists" };
  node.applyInventory(hello.inventory);
  node.agentVersion = hello.agentVersion;
  node.protocolVersion = hello.protocolVersion;
  node.lastSeenAt = new Date();
  const wasOffline = node.status !== "online";
  node.status = "online";
  await node.save();
  nlog.info("agent online", { id: node.id, name: node.name, agentVersion: hello.agentVersion });
  uiGateway.broadcast("node.status", {
    nodeId,
    status: "online",
    lastSeenAt: node.lastSeenAt.toISOString(),
  });
  uiGateway.broadcast("node.updated", { nodeId });
  if (wasOffline) events.emit("node.online", { nodeId });
  return { ok: true, config: await agentConfig() };
}

export async function onAgentMetrics(nodeId: number, metrics: Metrics): Promise<void> {
  await Node.update({ lastMetrics: metrics, lastSeenAt: new Date() }, { where: { id: nodeId } });
  uiGateway.broadcast("node.metrics", { nodeId, metrics });
}

export async function setStatus(nodeId: number, status: NodeStatus): Promise<void> {
  const [changed] = await Node.update({ status }, {
    where: { id: nodeId, status: { [Op.ne]: status } },
  });
  if (!changed) return;
  const n = await Node.findByPk(nodeId, { attributes: ["id", "name", "lastSeenAt"] });
  nlog.info(`node ${status}`, { id: nodeId, name: n?.name });
  uiGateway.broadcast("node.status", {
    nodeId,
    status,
    lastSeenAt: n?.lastSeenAt?.toISOString() ?? null,
  });
  events.emit("node.status", { nodeId, status });
  if (status === "offline") events.emit("node.offline", { nodeId });
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function list(q: z.infer<typeof ListNodesQuery>) {
  const where: WhereOptions<Node> = {};
  if (q.status) where.status = q.status;
  if (q.q) {
    const like = `%${q.q}%`;
    Object.assign(where, {
      [Op.or]: [
        { name: { [Op.like]: like } },
        { hostname: { [Op.like]: like } },
        { osPrettyName: { [Op.like]: like } },
      ],
    });
  }
  const { rows, count } = await Node.findAndCountAll({
    where,
    order: [["name", "ASC"], ["id", "ASC"]],
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
  });
  const counts = await countsFor(rows.map((r) => r.id));
  return {
    items: rows.map((n) => nodeDto(n, counts.get(n.id))),
    total: count,
    page: q.page,
    pageSize: q.pageSize,
  };
}

/** Every node, for pickers. */
export async function all(): Promise<NodeDto[]> {
  const rows = await Node.findAll({ order: [["name", "ASC"]] });
  const counts = await countsFor(rows.map((r) => r.id));
  return rows.map((n) => nodeDto(n, counts.get(n.id)));
}

export async function summary(): Promise<NodeSummary> {
  const rows = (await Node.findAll({
    attributes: ["status", [sequelize.fn("COUNT", sequelize.col("id")), "count"]],
    group: ["status"],
    raw: true,
  })) as unknown as { status: NodeStatus; count: number }[];
  const out: NodeSummary = { total: 0, online: 0, offline: 0 };
  for (const r of rows) {
    const n = Number(r.count);
    out.total += n;
    out[r.status] += n;
  }
  return out;
}

export async function get(id: number): Promise<Node> {
  const n = await Node.findByPk(id);
  if (!n) throw notFound("Node");
  return n;
}

export async function update(id: number, input: z.infer<typeof UpdateNodeBody>): Promise<Node> {
  const n = await get(id);
  if (input.name !== undefined) n.name = input.name;
  if (input.notes !== undefined) n.notes = input.notes;
  if (input.publicAddress !== undefined) n.publicAddress = input.publicAddress.trim() || null;
  if (input.bindAddress !== undefined) n.bindAddress = input.bindAddress.trim();
  const start = input.portRangeStart ?? n.portRangeStart;
  const end = input.portRangeEnd ?? n.portRangeEnd;
  if (end < start) throw badRequest("The port range end must not be below its start");
  if (end - start > 20_000) throw badRequest("A port range covers at most 20000 ports");
  n.portRangeStart = start;
  n.portRangeEnd = end;
  await n.save();
  uiGateway.broadcast("node.updated", { nodeId: id });
  return n;
}

/** A node can only go once nothing runs on it. */
export async function remove(id: number): Promise<void> {
  const n = await get(id);
  const instances = await Instance.count({ where: { nodeId: id } });
  if (instances) {
    throw conflict(`${n.name} still hosts ${instances} instance(s); delete or move them first`);
  }
  await n.destroy();
  events.emit("node.deleted", { nodeId: id });
  uiGateway.broadcast("node.updated", { nodeId: id });
}
