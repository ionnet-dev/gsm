/**
 * Instances: rows, port reservations, and the operations that drive the agent (install, start,
 * stop, console). The agent gets a complete spec every time (spec.ts); the server owns the
 * `installing`, `install_failed` and `unknown` statuses, the agent every other one (agent-events.ts).
 */
import { Op, type Order, type WhereOptions } from "sequelize";
import type {
  CreateInstanceBody,
  InstanceAccessDto,
  InstanceDetailDto,
  InstanceDto,
  InstanceReachability,
  InstanceRole,
  InstanceStatus,
  InstanceSummary,
  ListInstancesQuery,
  PowerAction,
  TemplateDefinition,
  UpdateInstanceBody,
} from "@gsm/shared";
import { INSTANCE_STATUSES, POWER_ALLOWED, RPC_ERROR_CODES, validateVariable } from "@gsm/shared";
import type { z } from "zod";
import {
  Instance,
  InstancePort,
  InstanceUser,
  Node,
  NodeUser,
  Template,
  User,
} from "../../db/models.ts";
import { sequelize } from "../../db/sequelize.ts";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors.ts";
import { events } from "../../lib/events.ts";
import { log } from "../../lib/logger.ts";
import { agentGateway, AgentRpcError } from "../../ws/agent-gateway.ts";
import { uiGateway } from "../../ws/ui-gateway.ts";
import * as audit from "../audit/service.ts";
import { nodeOwnerIds } from "../nodes/access.ts";
import { publicAddressOf } from "../nodes/service.ts";
import * as players from "../players/service.ts";
import { getGeneral } from "../settings/service.ts";
import { resolveInstall } from "../templates/versions.ts";
import type { InstanceScope } from "./access.ts";
import { applyState, forgetUuid, pushConsole } from "./agent-events.ts";
import { consoleHistory } from "./console.ts";
import { allocatePorts } from "./ports.ts";
import { buildInstall, buildSpec } from "./spec.ts";

const ilog = log.child("instances");

const POWER_TIMEOUT_MS = 5 * 60_000;
const COMMAND_TIMEOUT_MS = 10_000;

const includeAll = [
  { model: Node, as: "node" },
  { model: Template, as: "template" },
  { model: InstancePort, as: "ports" },
  { model: User, as: "creator", attributes: ["id", "name"] },
];

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

function portsDto(i: Instance) {
  return (i.ports ?? [])
    .slice()
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.port - b.port)
    .map((p) => ({
      name: p.name,
      label: p.label,
      protocol: p.protocol,
      port: p.port,
      primary: p.primary,
    }));
}

/** The stored reachability check, limited to the ports the instance has now. */
function reachabilityDto(i: Instance): InstanceReachability | null {
  const r = i.reachability;
  if (!r) return null;
  const current = new Set(
    (i.ports ?? []).flatMap((p) =>
      (p.protocol === "both" ? ["tcp", "udp"] : [p.protocol]).map((proto) =>
        `${p.name}/${p.port}/${proto}`
      )
    ),
  );
  const ports = r.ports.filter((p) => current.has(`${p.name}/${p.port}/${p.protocol}`));
  return ports.length ? { ...r, ports } : null;
}

export function instanceDto(i: Instance, myRole: InstanceRole): InstanceDto {
  const node = i.node!;
  const t = i.template!;
  const address = publicAddressOf(node);
  const primary = (i.ports ?? []).find((p) => p.primary) ?? (i.ports ?? [])[0];
  return {
    id: i.id,
    uuid: i.uuid,
    name: i.name,
    description: i.description,
    status: i.status,
    error: i.error,
    node: { id: node.id, name: node.name, status: node.status, publicAddress: address },
    template: { id: t.id, slug: t.slug, name: t.name, game: t.game, icon: t.icon },
    image: i.image,
    ports: portsDto(i),
    limits: i.limits,
    restartOnCrash: i.restartOnCrash,
    autoStart: i.autoStart,
    installedAt: i.installedAt?.toISOString() ?? null,
    lastStartedAt: i.lastStartedAt?.toISOString() ?? null,
    lastStats: i.lastStats,
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
    myRole,
    address: primary ? `${address}:${primary.port}` : null,
    players: players.playersOf(t.definition) ? { online: players.onlineCount(i.id) } : null,
    reachability: reachabilityDto(i),
  };
}

export function instanceDetailDto(i: Instance, myRole: InstanceRole): InstanceDetailDto {
  const def = i.template!.definition;
  const variables: Record<string, string> = {};
  for (const v of def.variables) {
    if (!v.viewable && myRole !== "owner") continue;
    if (v.name in i.variables) variables[v.name] = i.variables[v.name];
  }
  return {
    ...instanceDto(i, myRole),
    variables,
    startupOverride: i.startupOverride,
    createdBy: i.creator ? { id: i.creator.id, name: i.creator.name } : null,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function get(id: number): Promise<Instance> {
  const i = await Instance.findByPk(id, { include: includeAll });
  if (!i) throw notFound("Instance");
  return i;
}

/** The instance ids a user may see (scope), as a where clause fragment. */
function scopeWhere(scope: InstanceScope): WhereOptions<Instance> {
  return scope ? { id: { [Op.in]: [...scope.keys()] } } : {};
}

export async function list(q: z.infer<typeof ListInstancesQuery>, scope: InstanceScope) {
  const where: Record<string | symbol, unknown> = { ...scopeWhere(scope) };
  if (q.nodeId) where.nodeId = q.nodeId;
  if (q.templateId) where.templateId = q.templateId;
  if (q.status) where.status = q.status;
  if (q.q) {
    const like = `%${q.q}%`;
    Object.assign(where, {
      [Op.or]: [{ name: { [Op.like]: like } }, { description: { [Op.like]: like } }],
    });
  }
  const dir = q.dir.toUpperCase() as "ASC" | "DESC";
  const order: Order = q.sort === "node"
    ? [[{ model: Node, as: "node" }, "name", dir], ["name", "ASC"]]
    : [[q.sort, dir], ["id", "ASC"]];
  const { rows, count } = await Instance.findAndCountAll({
    where,
    include: includeAll,
    order,
    limit: q.pageSize,
    offset: (q.page - 1) * q.pageSize,
    distinct: true,
  });
  return { rows, total: count, page: q.page, pageSize: q.pageSize };
}

export async function summary(scope: InstanceScope): Promise<InstanceSummary> {
  const rows = (await Instance.findAll({
    attributes: ["status", [sequelize.fn("COUNT", sequelize.col("id")), "count"]],
    where: scopeWhere(scope),
    group: ["status"],
    raw: true,
  })) as unknown as { status: InstanceStatus; count: number }[];
  const byStatus = Object.fromEntries(INSTANCE_STATUSES.map((s) => [s, 0])) as Record<
    InstanceStatus,
    number
  >;
  let total = 0;
  for (const r of rows) {
    const n = Number(r.count);
    byStatus[r.status] = n;
    total += n;
  }
  return { total, byStatus };
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

/**
 * Merge `input` over `current` (or the template defaults), checking each value against its
 * declaration. Non-owners may only change `editable` variables. Unknown names are refused.
 */
export function mergeVariables(
  def: TemplateDefinition,
  current: Record<string, string> | null,
  input: Record<string, string>,
  role: InstanceRole,
): Record<string, string> {
  const known = new Map(def.variables.map((v) => [v.name, v]));
  for (const name of Object.keys(input)) {
    if (!known.has(name)) throw badRequest(`Unknown variable ${name}`);
  }
  const out: Record<string, string> = {};
  const problems: Record<string, string> = {};
  for (const v of def.variables) {
    const before = current?.[v.name] ?? v.default;
    let value = before;
    if (v.name in input && input[v.name] !== before) {
      if (!v.editable && role !== "owner") {
        throw forbidden(`${v.label} can only be changed by an owner`);
      }
      value = input[v.name];
    }
    const problem = validateVariable(v, value);
    if (problem) problems[v.name] = problem;
    out[v.name] = value;
  }
  if (Object.keys(problems).length) {
    throw badRequest("Some variables are invalid", problems);
  }
  return out;
}

function pickImage(def: TemplateDefinition, image: string | null | undefined, current?: string) {
  if (image === null || image === undefined) return current ?? def.image;
  const allowed = [def.image, ...def.images.map((i) => i.ref)];
  if (!allowed.includes(image)) throw badRequest("That image is not one the template offers");
  return image;
}

// ---------------------------------------------------------------------------
// Create / update / delete
// ---------------------------------------------------------------------------

/** Ports on the node taken by other instances, and the node's SFTP port. */
async function usedPorts(nodeId: number, exceptInstanceId?: number): Promise<Set<number>> {
  const [rows, node] = await Promise.all([
    InstancePort.findAll({
      where: { nodeId, ...(exceptInstanceId ? { instanceId: { [Op.ne]: exceptInstanceId } } : {}) },
      attributes: ["port"],
    }),
    Node.findByPk(nodeId, { attributes: ["id", "sftpPort"] }),
  ]);
  const used = new Set(rows.map((r) => r.port));
  if (node?.sftpPort) used.add(node.sftpPort);
  return used;
}

export async function create(
  input: z.infer<typeof CreateInstanceBody>,
  actor: User,
): Promise<Instance> {
  const node = await Node.findByPk(input.nodeId);
  if (!node) throw badRequest("Unknown node");
  const template = await Template.findByPk(input.templateId);
  if (!template) throw badRequest("Unknown template");
  const def = template.definition;
  const variables = mergeVariables(def, null, input.variables, "owner");
  const image = pickImage(def, input.image);
  const limits = input.limits ?? def.resources;
  const uuid = crypto.randomUUID();

  const instance = await sequelize.transaction(async (transaction) => {
    const used = await usedPorts(node.id);
    const allocation = allocatePorts(def.ports, input.ports, used, {
      start: node.portRangeStart,
      end: node.portRangeEnd,
    });
    const row = await Instance.create({
      uuid,
      name: input.name,
      description: input.description,
      nodeId: node.id,
      templateId: template.id,
      status: "stopped",
      image,
      variables,
      limits,
      restartOnCrash: input.restartOnCrash ?? def.restartOnCrash,
      autoStart: input.autoStart,
      createdBy: actor.id,
    }, { transaction });
    if (allocation.length) {
      await InstancePort.bulkCreate(
        allocation.map((a) => ({ ...a, instanceId: row.id, nodeId: node.id })),
        { transaction },
      );
    }
    const ownerId = input.ownerUserId;
    if (ownerId) {
      if (!(await User.findByPk(ownerId, { transaction }))) throw badRequest("Unknown owner");
      await InstanceUser.create(
        { instanceId: row.id, userId: ownerId, role: "owner", grantedBy: actor.id },
        { transaction },
      );
    }
    return row;
  });

  ilog.info("instance created", { id: instance.id, name: instance.name, node: node.id });
  // The node's owners own the new instance too; their sockets pick it up on reconnect.
  const gained = new Set(await nodeOwnerIds(node.id));
  if (input.ownerUserId) gained.add(input.ownerUserId);
  if (gained.size) {
    events.emit("access.changed", { userIds: [...gained] });
    for (const u of gained) uiGateway.reconnectUser(u);
  }
  uiGateway.broadcast("instance.updated", { instanceId: instance.id });
  if (input.install) {
    install(instance.id, actor.id).catch((err) =>
      ilog.warn("install failed", { id: instance.id, err: String(err) })
    );
  }
  return await get(instance.id);
}

const RUNNING = new Set<InstanceStatus>(["running", "starting", "stopping", "installing"]);

export async function update(
  id: number,
  input: z.infer<typeof UpdateInstanceBody>,
  role: InstanceRole,
): Promise<Instance> {
  const i = await get(id);
  const def = i.template!.definition;
  const structural = input.image !== undefined || input.ports !== undefined ||
    input.limits !== undefined;
  if (structural && RUNNING.has(i.status)) {
    throw conflict("Stop the instance before changing its image, ports or resources");
  }
  if (input.name !== undefined) i.name = input.name;
  if (input.description !== undefined) i.description = input.description;
  if (input.image !== undefined) i.image = pickImage(def, input.image, i.image);
  if (input.variables !== undefined) {
    i.variables = mergeVariables(def, i.variables, input.variables, role);
  }
  if (input.limits !== undefined) i.limits = input.limits;
  if (input.restartOnCrash !== undefined) i.restartOnCrash = input.restartOnCrash;
  if (input.autoStart !== undefined) i.autoStart = input.autoStart;
  const startupOverride = input.startupOverride === undefined
    ? i.startupOverride
    : input.startupOverride?.trim() || null;
  if (startupOverride !== i.startupOverride) {
    if (role !== "owner") throw forbidden("Only an owner may change the startup command");
    i.startupOverride = startupOverride;
  }
  await sequelize.transaction(async (transaction) => {
    await i.save({ transaction });
    if (input.ports !== undefined) {
      const node = i.node!;
      const used = await usedPorts(node.id, i.id);
      // Keep the current port for every template port the caller did not choose.
      const choices = { ...input.ports };
      for (const p of i.ports ?? []) {
        if (!(p.name in choices) && def.ports.some((tp) => tp.name === p.name)) {
          choices[p.name] = p.port;
        }
      }
      const allocation = allocatePorts(def.ports, choices, used, {
        start: node.portRangeStart,
        end: node.portRangeEnd,
      });
      await InstancePort.destroy({ where: { instanceId: i.id }, transaction });
      await InstancePort.bulkCreate(
        allocation.map((a) => ({ ...a, instanceId: i.id, nodeId: node.id })),
        { transaction },
      );
    }
  });
  uiGateway.broadcast("instance.updated", { instanceId: id });
  if (input.ports !== undefined) events.emit("instance.ports_changed", { instanceId: id });
  return await get(id);
}

export async function remove(id: number, keepFiles: boolean, actorId: number): Promise<void> {
  const i = await get(id);
  const node = i.node!;
  if (!agentGateway.isConnected(node.id)) {
    throw conflict(
      `${node.name} is offline; the instance can only be deleted while its node is connected`,
    );
  }
  try {
    await agentGateway.request(node.id, "inst.remove", { uuid: i.uuid, deleteFiles: !keepFiles }, {
      timeoutMs: POWER_TIMEOUT_MS,
    });
  } catch (err) {
    if (!(err instanceof AgentRpcError && err.rpc.code === RPC_ERROR_CODES.notFound)) throw err;
  }
  const userIds =
    (await InstanceUser.findAll({ where: { instanceId: id }, attributes: ["userId"] }))
      .map((r) => r.userId);
  await i.destroy();
  consoleHistory.clear(id);
  players.forget(id);
  forgetUuid(i.uuid);
  ilog.info("instance deleted", { id, name: i.name, by: actorId, keepFiles });
  events.emit("instance.deleted", { instanceId: id, nodeId: node.id });
  if (userIds.length) {
    events.emit("access.changed", { userIds });
    for (const u of userIds) uiGateway.reconnectUser(u);
  }
  uiGateway.broadcast("instance.updated", { instanceId: id });
}

// ---------------------------------------------------------------------------
// Operations on the node
// ---------------------------------------------------------------------------

async function specFor(i: Instance) {
  const { imageRegistry } = await getGeneral();
  return buildSpec(i, i.template!.definition, i.node!, i.ports ?? [], imageRegistry);
}

function assertOnline(i: Instance) {
  if (!agentGateway.isConnected(i.nodeId)) {
    throw conflict(`${i.node?.name ?? "The node"} is offline`);
  }
}

async function setStatus(i: Instance, status: InstanceStatus, error: string | null = null) {
  i.status = status;
  i.error = error;
  await i.save();
  players.onStatus(i.id, status);
  uiGateway.broadcast("instance.status", { instanceId: i.id, status, error });
}

/** Run the template's install script on the node; the output streams as the `install` console. */
export async function install(id: number, actorId: number | null): Promise<void> {
  const i = await get(id);
  assertOnline(i);
  if (RUNNING.has(i.status)) throw conflict("Stop the instance before reinstalling");
  const def = i.template!.definition;
  const { imageRegistry } = await getGeneral();
  let resolved: Record<string, string>;
  try {
    resolved = await resolveInstall(def.install.resolver, i.variables);
  } catch (err) {
    await setStatus(i, "install_failed", err instanceof Error ? err.message : String(err));
    throw err;
  }
  consoleHistory.clear(id, "install");
  await setStatus(i, "installing");
  await audit.record({
    actorUserId: actorId,
    action: "instance.install",
    targetType: "instance",
    targetId: id,
    details: { name: i.name, template: i.template!.slug },
  });
  const spec = await specFor(i);
  const installSpec = buildInstall(def, resolved, imageRegistry);
  try {
    const res = await agentGateway.request(
      i.nodeId,
      "inst.install",
      { spec, install: installSpec },
      {
        timeoutMs: (installSpec.timeoutSeconds + 60) * 1000,
        onStream: (chunk) => pushConsole(id, "install", chunk.lines),
      },
    );
    const fresh = await get(id);
    if (res.exitCode === 0) {
      fresh.installedAt = new Date();
      await setStatus(fresh, "stopped");
      events.emit("instance.ports_changed", { instanceId: id });
      ilog.info("install finished", { id, durationMs: res.durationMs });
    } else {
      await setStatus(
        fresh,
        "install_failed",
        `The install script exited with code ${res.exitCode}`,
      );
    }
  } catch (err) {
    const fresh = await get(id);
    await setStatus(fresh, "install_failed", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export async function power(id: number, action: PowerAction, actorId: number): Promise<Instance> {
  const i = await get(id);
  assertOnline(i);
  if (!POWER_ALLOWED[action].includes(i.status)) {
    throw conflict(`Cannot ${action} an instance that is ${i.status.replace("_", " ")}`);
  }
  if ((action === "start" || action === "restart") && !i.installedAt) {
    throw conflict("The instance is not installed yet");
  }
  await audit.record({
    actorUserId: actorId,
    action: `instance.${action}`,
    targetType: "instance",
    targetId: id,
    details: { name: i.name },
  });
  try {
    let state;
    switch (action) {
      case "start":
        state = await agentGateway.request(i.nodeId, "inst.start", { spec: await specFor(i) }, {
          timeoutMs: POWER_TIMEOUT_MS,
        });
        break;
      case "restart":
        state = await agentGateway.request(i.nodeId, "inst.restart", { spec: await specFor(i) }, {
          timeoutMs: POWER_TIMEOUT_MS,
        });
        break;
      case "stop":
      case "kill":
        state = await agentGateway.request(i.nodeId, "inst.stop", {
          uuid: i.uuid,
          force: action === "kill",
        }, { timeoutMs: POWER_TIMEOUT_MS });
        break;
    }
    const fresh = await get(id);
    await applyState(fresh, state);
    return fresh;
  } catch (err) {
    const fresh = await get(id);
    fresh.error = err instanceof Error ? err.message : String(err);
    await fresh.save();
    uiGateway.broadcast("instance.status", {
      instanceId: id,
      status: fresh.status,
      error: fresh.error,
    });
    throw err;
  }
}

export async function command(id: number, cmd: string, actorId: number): Promise<void> {
  const i = await get(id);
  assertOnline(i);
  if (i.status !== "running" && i.status !== "starting") {
    throw conflict("The instance is not running");
  }
  await agentGateway.request(i.nodeId, "inst.command", { uuid: i.uuid, command: cmd }, {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  await audit.record({
    actorUserId: actorId,
    action: "instance.command",
    targetType: "instance",
    targetId: id,
    details: { command: cmd.slice(0, 500) },
  });
}

/** The last lines of a console: from the node's log when it is connected, else the server's buffer. */
export async function consoleTail(id: number, stream: "console" | "install", lines: number) {
  const i = await get(id);
  if (agentGateway.isConnected(i.nodeId)) {
    try {
      const res = await agentGateway.request(i.nodeId, "inst.consoleTail", {
        uuid: i.uuid,
        stream,
        lines,
      });
      return res.lines;
    } catch (err) {
      ilog.debug("console tail from node failed; using the buffer", { id, err: String(err) });
    }
  }
  return consoleHistory.tail(id, stream, lines);
}

export async function stats(id: number) {
  const i = await get(id);
  return i.lastStats;
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/** The node's owners (owner through the node), then the users the instance was shared with. */
export async function listAccess(id: number): Promise<InstanceAccessDto[]> {
  const i = await Instance.findByPk(id, { attributes: ["id", "nodeId"] });
  if (!i) throw notFound("Instance");
  const withUser = {
    include: [{ model: User, as: "user", attributes: ["id", "name", "email"] }],
    order: [["createdAt", "ASC"]] as Order,
  };
  const [owners, grants] = await Promise.all([
    NodeUser.findAll({ where: { nodeId: i.nodeId }, ...withUser }),
    InstanceUser.findAll({ where: { instanceId: id }, ...withUser }),
  ]);
  return [
    ...owners.map((r) => ({
      userId: r.userId,
      name: r.user?.name ?? "",
      email: r.user?.email ?? "",
      role: "owner" as const,
      grantedAt: r.createdAt.toISOString(),
      via: "node" as const,
    })),
    ...grants.map((r) => ({
      userId: r.userId,
      name: r.user?.name ?? "",
      email: r.user?.email ?? "",
      role: r.role,
      grantedAt: r.createdAt.toISOString(),
      via: "instance" as const,
    })),
  ];
}

export async function grant(id: number, userId: number, role: InstanceRole, actorId: number) {
  await get(id);
  const user = await User.findByPk(userId);
  if (!user) throw badRequest("Unknown user");
  const [row, created] = await InstanceUser.findOrCreate({
    where: { instanceId: id, userId },
    defaults: { instanceId: id, userId, role, grantedBy: actorId },
  });
  if (!created && row.role !== role) {
    row.role = role;
    await row.save();
  }
  events.emit("access.changed", { userIds: [userId] });
  uiGateway.reconnectUser(userId);
  uiGateway.broadcast("instance.updated", { instanceId: id });
  return await listAccess(id);
}

export async function revoke(id: number, userId: number) {
  const removed = await InstanceUser.destroy({ where: { instanceId: id, userId } });
  if (!removed) throw notFound("Access");
  events.emit("access.changed", { userIds: [userId] });
  uiGateway.reconnectUser(userId);
  uiGateway.broadcast("instance.updated", { instanceId: id });
  return await listAccess(id);
}

export function activity(id: number, page: number, pageSize: number) {
  return audit.list({ page, pageSize, targetType: "instance", targetId: id });
}
