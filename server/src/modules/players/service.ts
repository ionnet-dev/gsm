/**
 * Players on instances. Who is online is read from console lines as they arrive (the template's
 * join, leave and list-answer patterns, see parse.ts) and kept in `instance_players`, which also
 * serves as the recent-players list. The game's own lists (operators, bans, …) are read from the
 * instance's files when asked for and cached briefly. Actions are console commands built from the
 * template.
 *
 * Console lines of one instance are handled strictly in order (a queue per instance), so a join and
 * a leave in quick succession cannot swap.
 */
import { Op } from "sequelize";
import type {
  ConsoleLine,
  InstancePlayersDto,
  InstanceStatus,
  PlayerActionBody,
  PlayerDto,
  PlayerListDto,
  TemplateDefinition,
  TemplatePlayerList,
  TemplatePlayers,
} from "@gsm/shared";
import { RECENT_PLAYER_DAYS, RPC_ERROR_CODES } from "@gsm/shared";
import type { z } from "zod";
import { Instance, InstancePlayer, Template } from "../../db/models.ts";
import { sequelize } from "../../db/sequelize.ts";
import { badRequest, conflict, notFound } from "../../lib/errors.ts";
import { log } from "../../lib/logger.ts";
import { agentGateway, AgentRpcError } from "../../ws/agent-gateway.ts";
import { uiGateway } from "../../ws/ui-gateway.ts";
import {
  buildActionCommand,
  compileMatcher,
  nameValidator,
  parseListFile,
  type PlayerEvent,
  type PlayerMatcher,
  type SeenPlayer,
} from "./parse.ts";

const plog = log.child("players");

/** Template edits reach the console matcher within this long. */
const MATCHER_TTL_MS = 60_000;
/** List files are read at most this often, unless a console line or an action says they changed. */
const LISTS_TTL_MS = 30_000;
const LIST_FILE_MAX_BYTES = 2 << 20;
const LIST_READ_TIMEOUT_MS = 15_000;
const RECENT_LIMIT = 100;
const COMMAND_TIMEOUT_MS = 10_000;
/** How long an id from an `identify` line waits for its join line. */
const PENDING_ID_MS = 5 * 60_000;
/** Offline players not seen for this long are forgotten by housekeeping. */
export const PLAYER_RETENTION_DAYS = 90;

/** The template's players section; definitions saved before it existed have none. */
export function playersOf(def: TemplateDefinition): TemplatePlayers | null {
  return (def as Partial<TemplateDefinition>).players ?? null;
}

function playerDto(r: InstancePlayer): PlayerDto {
  return {
    name: r.name,
    id: r.playerId,
    online: r.online,
    joinedAt: r.joinedAt?.toISOString() ?? null,
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  };
}

function loadWithTemplate(instanceId: number) {
  return Instance.findByPk(instanceId, { include: [{ model: Template, as: "template" }] });
}

// ---------------------------------------------------------------------------
// Online counts (for instance DTOs) and the UI event
// ---------------------------------------------------------------------------

const onlineCounts = new Map<number, number>();

export function onlineCount(instanceId: number): number {
  return onlineCounts.get(instanceId) ?? 0;
}

export async function loadOnlineCounts(): Promise<void> {
  const rows = (await InstancePlayer.findAll({
    attributes: [["instance_id", "instanceId"], [sequelize.fn("COUNT", sequelize.col("id")), "n"]],
    where: { online: true },
    group: ["instance_id"],
    raw: true,
  })) as unknown as { instanceId: number; n: number }[];
  onlineCounts.clear();
  for (const r of rows) onlineCounts.set(Number(r.instanceId), Number(r.n));
}

const emitTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** Recount and tell browsers, at most every `delayMs` per instance. */
function scheduleEmit(instanceId: number, delayMs = 250) {
  if (emitTimers.has(instanceId)) return;
  emitTimers.set(
    instanceId,
    setTimeout(() => {
      emitTimers.delete(instanceId);
      InstancePlayer.count({ where: { instanceId, online: true } })
        .then((online) => {
          onlineCounts.set(instanceId, online);
          uiGateway.broadcast("instance.players", { instanceId, online });
        })
        .catch((err) => plog.warn("counting players failed", { instanceId, err: String(err) }));
    }, delayMs),
  );
}

// ---------------------------------------------------------------------------
// Console tracking
// ---------------------------------------------------------------------------

const matchers = new Map<number, { at: number; matcher: PlayerMatcher | null }>();

async function matcherFor(instanceId: number): Promise<PlayerMatcher | null> {
  const hit = matchers.get(instanceId);
  if (hit && Date.now() - hit.at < MATCHER_TTL_MS) return hit.matcher;
  const i = await loadWithTemplate(instanceId);
  const config = i?.template ? playersOf(i.template.definition) : null;
  let matcher: PlayerMatcher | null = null;
  if (config) {
    try {
      matcher = compileMatcher(config);
    } catch (err) {
      plog.warn("the template's player patterns do not compile", { instanceId, err: String(err) });
    }
  }
  matchers.set(instanceId, { at: Date.now(), matcher });
  return matcher;
}

const queues = new Map<number, Promise<void>>();

function enqueue(instanceId: number, job: () => Promise<void>) {
  const next = (queues.get(instanceId) ?? Promise.resolve())
    .then(job)
    .catch((err) => plog.warn("player update failed", { instanceId, err: String(err) }));
  queues.set(instanceId, next);
  next.finally(() => {
    if (queues.get(instanceId) === next) queues.delete(instanceId);
  });
}

/** Ids named by `identify` lines, waiting for the join: "<instanceId>:<name>" → id. */
const pendingIds = new Map<string, { id: string; at: number }>();
const pendingKey = (instanceId: number, name: string) => `${instanceId}:${name.toLowerCase()}`;

function rememberId(instanceId: number, name: string, id: string) {
  if (pendingIds.size > 1000) {
    for (const [k, v] of pendingIds) if (Date.now() - v.at > PENDING_ID_MS) pendingIds.delete(k);
  }
  pendingIds.set(pendingKey(instanceId, name), { id, at: Date.now() });
}

function takePendingId(instanceId: number, name: string): string | null {
  const key = pendingKey(instanceId, name);
  const p = pendingIds.get(key);
  pendingIds.delete(key);
  return p && Date.now() - p.at < PENDING_ID_MS ? p.id : null;
}

async function markJoined(instanceId: number, p: SeenPlayer) {
  const now = new Date();
  const row = await InstancePlayer.findOne({ where: { instanceId, name: p.name } });
  if (!row) {
    await InstancePlayer.create({
      instanceId,
      name: p.name,
      playerId: p.id,
      online: true,
      joinedAt: now,
      firstSeenAt: now,
      lastSeenAt: now,
    });
    return;
  }
  row.name = p.name;
  if (p.id) row.playerId = p.id;
  row.online = true;
  row.joinedAt = now;
  row.lastSeenAt = now;
  await row.save();
}

async function markLeft(instanceId: number, name: string) {
  const now = new Date();
  const row = await InstancePlayer.findOne({ where: { instanceId, name } });
  if (!row) {
    // We missed the join (the panel was down), but they did play.
    await InstancePlayer.create({ instanceId, name, firstSeenAt: now, lastSeenAt: now });
    return;
  }
  row.online = false;
  row.joinedAt = null;
  row.lastSeenAt = now;
  await row.save();
}

/** A list answer is the whole truth: exactly these players are online. */
async function setOnline(instanceId: number, players: SeenPlayer[]) {
  const now = new Date();
  const names = players.map((p) => p.name);
  const rows = await InstancePlayer.findAll({
    where: {
      instanceId,
      [Op.or]: [{ online: true }, ...(names.length ? [{ name: { [Op.in]: names } }] : [])],
    },
  });
  const byName = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  for (const p of players) {
    const row = byName.get(p.name.toLowerCase());
    if (!row) {
      await InstancePlayer.create({
        instanceId,
        name: p.name,
        playerId: p.id,
        online: true,
        joinedAt: now,
        firstSeenAt: now,
        lastSeenAt: now,
      });
      continue;
    }
    if (!row.online) {
      row.online = true;
      row.joinedAt = now;
    }
    row.name = p.name;
    if (p.id) row.playerId = p.id;
    row.lastSeenAt = now;
    await row.save();
  }
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  for (const row of rows) {
    if (!row.online || wanted.has(row.name.toLowerCase())) continue;
    row.online = false;
    row.joinedAt = null;
    row.lastSeenAt = now;
    await row.save();
  }
}

async function markAllOffline(instanceId: number) {
  const [changed] = await InstancePlayer.update(
    { online: false, joinedAt: null, lastSeenAt: new Date() },
    { where: { instanceId, online: true } },
  );
  if (changed) scheduleEmit(instanceId);
}

async function apply(instanceId: number, found: PlayerEvent[]) {
  let changed = false;
  for (const e of found) {
    switch (e.type) {
      case "identify":
        rememberId(instanceId, e.name, e.id);
        await InstancePlayer.update({ playerId: e.id }, { where: { instanceId, name: e.name } });
        break;
      case "join":
        await markJoined(instanceId, {
          name: e.name,
          id: e.id ?? takePendingId(instanceId, e.name),
        });
        changed = true;
        break;
      case "leave":
        await markLeft(instanceId, e.name);
        changed = true;
        break;
      case "list":
        await setOnline(instanceId, e.players);
        changed = true;
        break;
      case "refresh":
        lists.delete(instanceId);
        changed = true;
        break;
    }
  }
  if (changed) scheduleEmit(instanceId);
}

/** Lines of an instance's game console (not install output), in the order they arrived. */
export function onConsole(instanceId: number, lines: ConsoleLine[]): void {
  enqueue(instanceId, async () => {
    const matcher = await matcherFor(instanceId);
    if (!matcher) return;
    const found: PlayerEvent[] = [];
    for (const l of lines) {
      const e = matcher.match(l.text);
      if (e) found.push(e);
    }
    if (found.length) await apply(instanceId, found);
  });
}

/** Statuses in which nobody can be connected to the game. */
const NOBODY_ONLINE = new Set<InstanceStatus>([
  "stopped",
  "crashed",
  "starting",
  "installing",
  "install_failed",
]);

/** An instance's status changed. */
export function onStatus(instanceId: number, status: InstanceStatus): void {
  if (NOBODY_ONLINE.has(status)) enqueue(instanceId, () => markAllOffline(instanceId));
}

/** Type the template's list command; the answer is read from the console like any other line. */
async function askWhoIsOnline(instanceId: number): Promise<boolean> {
  const i = await loadWithTemplate(instanceId);
  const list = i?.template ? playersOf(i.template.definition)?.list : null;
  if (!i || !list || i.status !== "running" || !agentGateway.isConnected(i.nodeId)) return false;
  await agentGateway.request(i.nodeId, "inst.command", { uuid: i.uuid, command: list.command }, {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  return true;
}

/**
 * After a node reconnects, console lines sent while it was away are lost: ask each of its running
 * instances who is online.
 */
export async function resync(instanceIds: number[]): Promise<void> {
  for (const id of instanceIds) {
    try {
      await askWhoIsOnline(id);
    } catch (err) {
      plog.debug("asking who is online failed", { instanceId: id, err: String(err) });
    }
  }
}

/** Drop what is kept in memory for a deleted instance (its rows go with the instance). */
export function forget(instanceId: number): void {
  matchers.delete(instanceId);
  lists.delete(instanceId);
  onlineCounts.delete(instanceId);
}

// ---------------------------------------------------------------------------
// Lists (read from the instance's files)
// ---------------------------------------------------------------------------

const lists = new Map<number, { at: number; promise: Promise<PlayerListDto[]> }>();

const isMissing = (err: unknown) =>
  err instanceof AgentRpcError &&
  (err.rpc.code === RPC_ERROR_CODES.notFound || /no such file|not exist/i.test(err.rpc.message));

async function readList(i: Instance, list: TemplatePlayerList): Promise<PlayerListDto> {
  const base = { id: list.id, label: list.label, badge: list.badge, columns: list.columns };
  if (!agentGateway.isConnected(i.nodeId)) {
    return { ...base, entries: [], error: "The node is not connected" };
  }
  try {
    const res = await agentGateway.request(i.nodeId, "fs.read", {
      uuid: i.uuid,
      path: list.path,
      maxBytes: LIST_FILE_MAX_BYTES,
    }, { timeoutMs: LIST_READ_TIMEOUT_MS });
    if (res.tooLarge) return { ...base, entries: [], error: `${list.path} is too large to read` };
    if (res.content === null) {
      return { ...base, entries: [], error: `${list.path} is not a text file` };
    }
    return { ...base, entries: parseListFile(list, res.content), error: null };
  } catch (err) {
    // The game writes its lists on first start; until then there is nobody on them.
    if (isMissing(err)) return { ...base, entries: [], error: null };
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, entries: [], error: `${list.path}: ${msg}` };
  }
}

function listsFor(i: Instance, config: TemplatePlayers): Promise<PlayerListDto[]> {
  if (!config.lists.length) return Promise.resolve([]);
  const hit = lists.get(i.id);
  if (hit && Date.now() - hit.at < LISTS_TTL_MS) return hit.promise;
  const promise = Promise.all(config.lists.map((l) => readList(i, l)));
  const entry = { at: Date.now(), promise };
  lists.set(i.id, entry);
  // A failed read is not worth serving for the whole TTL.
  promise.then((r) => {
    if (r.some((l) => l.error) && lists.get(i.id) === entry) lists.delete(i.id);
  });
  return promise;
}

// ---------------------------------------------------------------------------
// Reads and actions for the REST routes
// ---------------------------------------------------------------------------

/** Who is online and who played recently; lists and actions only when `manage`. */
export async function overview(instanceId: number, manage: boolean): Promise<InstancePlayersDto> {
  const i = await loadWithTemplate(instanceId);
  if (!i) throw notFound("Instance");
  const config = playersOf(i.template!.definition);
  if (!config) {
    return {
      supported: false,
      canRefresh: false,
      online: [],
      recent: [],
      lists: [],
      actions: [],
      namePattern: "",
    };
  }
  const since = new Date(Date.now() - RECENT_PLAYER_DAYS * 86_400_000);
  const [online, recent, playerLists] = await Promise.all([
    InstancePlayer.findAll({ where: { instanceId, online: true }, order: [["name", "ASC"]] }),
    InstancePlayer.findAll({
      where: { instanceId, online: false, lastSeenAt: { [Op.gte]: since } },
      order: [["lastSeenAt", "DESC"]],
      limit: RECENT_LIMIT,
    }),
    manage ? listsFor(i, config) : Promise.resolve([]),
  ]);
  return {
    supported: true,
    canRefresh: config.list !== null,
    online: online.map(playerDto),
    recent: recent.map(playerDto),
    lists: playerLists,
    actions: manage ? config.actions : [],
    namePattern: config.namePattern,
  };
}

/** Read the lists again and, while the game runs, ask it who is online. */
export async function refresh(instanceId: number): Promise<void> {
  matchers.delete(instanceId);
  lists.delete(instanceId);
  await askWhoIsOnline(instanceId);
  scheduleEmit(instanceId);
}

/** Run one of the template's player actions; returns the command that was typed. */
export async function runAction(
  instanceId: number,
  body: z.infer<typeof PlayerActionBody>,
): Promise<{ command: string }> {
  const i = await loadWithTemplate(instanceId);
  if (!i) throw notFound("Instance");
  const config = playersOf(i.template!.definition);
  const action = config?.actions.find((a) => a.id === body.action);
  if (!config || !action) throw badRequest("The template has no such player action");
  if (i.status !== "running" && i.status !== "starting") {
    throw conflict("The instance is not running");
  }
  if (!agentGateway.isConnected(i.nodeId)) throw conflict("The node is offline");
  const known = await InstancePlayer.findOne({ where: { instanceId, name: body.player } });
  // Someone only on a list (added while offline, never seen) still has the id the game keeps.
  let id = known?.playerId ?? null;
  if (!id) {
    const name = body.player.toLowerCase();
    const entries = (await listsFor(i, config)).flatMap((l) => l.entries);
    id = entries.find((e) => e.id && e.name.toLowerCase() === name)?.id ?? null;
  }
  const built = buildActionCommand(
    action,
    { name: body.player, id },
    body.fields,
    nameValidator(config.namePattern),
  );
  if (!built.ok) throw badRequest("Some values are invalid", built.problems);
  await agentGateway.request(i.nodeId, "inst.command", { uuid: i.uuid, command: built.command }, {
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  // Most actions change a list; read the lists again once the game has written its files.
  lists.delete(instanceId);
  setTimeout(() => {
    lists.delete(instanceId);
    scheduleEmit(instanceId);
  }, 1500);
  return { command: built.command };
}

/** Forget offline players nobody has seen for PLAYER_RETENTION_DAYS. */
export async function purgeOldPlayers(): Promise<number> {
  return await InstancePlayer.destroy({
    where: {
      online: false,
      lastSeenAt: { [Op.lt]: new Date(Date.now() - PLAYER_RETENTION_DAYS * 86_400_000) },
    },
  });
}
