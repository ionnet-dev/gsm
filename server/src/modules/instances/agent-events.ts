/** Agent → server events about instances, folded into rows and pushed to browsers. */
import type { ConsoleLine, ConsoleStream, InstanceState, InstanceStats } from "@gsm/shared";
import { Instance } from "../../db/models.ts";
import { events } from "../../lib/events.ts";
import { log } from "../../lib/logger.ts";
import { uiGateway } from "../../ws/ui-gateway.ts";
import { getGeneral } from "../settings/service.ts";
import { consoleHistory } from "./console.ts";

const elog = log.child("instances:events");

/** uuid → instance id, so console and stats events don't hit the database. */
const idByUuid = new Map<string, number>();

export async function instanceIdFor(nodeId: number, uuid: string): Promise<number | null> {
  const cached = idByUuid.get(uuid);
  if (cached !== undefined) return cached;
  const row = await Instance.findOne({ where: { uuid, nodeId }, attributes: ["id"] });
  if (!row) return null;
  idByUuid.set(uuid, row.id);
  return row.id;
}

export function forgetUuid(uuid: string) {
  idByUuid.delete(uuid);
}

/** Apply a state the node reported to the row and tell browsers. */
export async function applyState(instance: Instance, state: InstanceState): Promise<void> {
  const before = instance.status;
  // The server owns installing / install_failed: a container state must not overwrite them while
  // an install runs (the agent reports "installing" itself in that window anyway).
  if (instance.status === "installing" && state.state !== "installing") {
    if (state.state === "stopped" && !state.installed) return;
  }
  instance.status = state.state;
  instance.error = state.error;
  instance.containerId = state.containerId;
  if (
    (state.state === "starting" || state.state === "running") && before !== "running" &&
    before !== "starting"
  ) {
    instance.lastStartedAt = state.startedAt ? new Date(state.startedAt) : new Date();
  }
  if (state.installed && !instance.installedAt) instance.installedAt = new Date();
  if (instance.changed()) await instance.save();
  if (before !== instance.status || state.error) {
    uiGateway.broadcast("instance.status", {
      instanceId: instance.id,
      status: instance.status,
      error: instance.error,
    });
  }
}

export async function onState(nodeId: number, state: InstanceState): Promise<void> {
  const instance = await Instance.findOne({ where: { uuid: state.uuid, nodeId } });
  if (!instance) {
    elog.debug("state for unknown instance", { nodeId, uuid: state.uuid });
    return;
  }
  idByUuid.set(state.uuid, instance.id);
  await applyState(instance, state);
  events.emit("instance.state", { nodeId, state });
}

let capacityLoaded = 0;

export async function pushConsole(
  instanceId: number,
  stream: ConsoleStream,
  lines: ConsoleLine[],
): Promise<void> {
  if (Date.now() - capacityLoaded > 60_000) {
    capacityLoaded = Date.now();
    consoleHistory.setCapacity((await getGeneral()).consoleHistoryLines);
  }
  consoleHistory.append(instanceId, stream, lines);
  uiGateway.broadcast("instance.console", { instanceId, stream, lines });
}

export async function onConsole(
  nodeId: number,
  data: { uuid: string; stream: ConsoleStream; lines: ConsoleLine[] },
): Promise<void> {
  const id = await instanceIdFor(nodeId, data.uuid);
  if (id === null) return;
  await pushConsole(id, data.stream, data.lines);
}

const lastStatsWrite = new Map<number, number>();

export async function onStats(nodeId: number, stats: InstanceStats[]): Promise<void> {
  for (const s of stats) {
    const id = await instanceIdFor(nodeId, s.uuid);
    if (id === null) continue;
    uiGateway.broadcast("instance.stats", { instanceId: id, stats: s });
    const last = lastStatsWrite.get(id) ?? 0;
    if (Date.now() - last >= 10_000) {
      lastStatsWrite.set(id, Date.now());
      await Instance.update({ lastStats: s }, { where: { id } });
    }
  }
}
