/**
 * Server -> browser push events over /ws/ui, and the few control frames a browser sends there
 * (console subscriptions). Everything else goes over REST.
 */
import { z } from "zod";
import { CONSOLE_STREAMS, INSTANCE_STATUSES, NODE_STATUSES } from "../enums.ts";
import { Metrics } from "./agent.ts";
import { ConsoleLine, InstanceStats } from "./instances.ts";
import { PullProgress } from "./images.ts";

export const uiEvents = {
  hello: z.object({ userId: z.number().int() }),
  "node.status": z.object({
    nodeId: z.number().int(),
    status: z.enum(NODE_STATUSES),
    lastSeenAt: z.string().datetime().nullable(),
  }),
  "node.updated": z.object({ nodeId: z.number().int() }),
  "node.metrics": z.object({ nodeId: z.number().int(), metrics: Metrics }),
  /** Anything about the instance row changed (name, settings, access, install state). */
  "instance.updated": z.object({ instanceId: z.number().int() }),
  "instance.status": z.object({
    instanceId: z.number().int(),
    status: z.enum(INSTANCE_STATUSES),
    error: z.string().nullable(),
  }),
  "instance.stats": z.object({ instanceId: z.number().int(), stats: InstanceStats }),
  /** Only sent to browsers that subscribed to the instance's console. */
  "instance.console": z.object({
    instanceId: z.number().int(),
    stream: z.enum(CONSOLE_STREAMS),
    lines: z.array(ConsoleLine),
  }),
  /** Someone joined or left, or a player list changed; `online` is the new count. */
  "instance.players": z.object({ instanceId: z.number().int(), online: z.number().int() }),
  "backup.updated": z.object({ instanceId: z.number().int(), backupId: z.string() }),
  "template.updated": z.object({ templateId: z.number().int() }),
  "image.pull": z.object({
    nodeId: z.number().int(),
    ref: z.string(),
    done: z.boolean(),
    error: z.string().nullable(),
    progress: PullProgress.nullable(),
  }),
  /** The user's access changed; the socket is closed with 4002 and the app reconnects. */
} as const;
export type UiEvent = keyof typeof uiEvents;
export type UiEventData<E extends UiEvent> = z.infer<(typeof uiEvents)[E]>;

/** Browser -> server: follow or stop following an instance's console output. */
export const UiClientMessage = z.discriminatedUnion("t", [
  z.object({ t: z.literal("sub"), instanceId: z.number().int() }),
  z.object({ t: z.literal("unsub"), instanceId: z.number().int() }),
]);
export type UiClientMessage = z.infer<typeof UiClientMessage>;
