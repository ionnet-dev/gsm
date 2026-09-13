/**
 * Players on an instance: who is online, who played recently, the game's own lists (operators,
 * bans, …) and the actions the template offers. See `TemplatePlayers` for how a template declares
 * them.
 */
import { z } from "zod";
import { type TemplatePlayerAction, VARIABLE_NAME_RE } from "./templates.ts";

export interface PlayerDto {
  name: string;
  /** The game's id for the player (a UUID for Minecraft), once the console has named it. */
  id: string | null;
  online: boolean;
  /** When the current session started; null while offline. */
  joinedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface PlayerListEntryDto {
  name: string;
  id: string | null;
  /** The list's columns, by key. */
  values: Record<string, string>;
}

export interface PlayerListDto {
  id: string;
  label: string;
  badge: string;
  columns: { key: string; label: string }[];
  entries: PlayerListEntryDto[];
  /** Why the file could not be read; `entries` is empty then. A missing file is an empty list. */
  error: string | null;
}

export interface InstancePlayersDto {
  /** The template declares players at all. */
  supported: boolean;
  /** The template has a command that asks the game who is online. */
  canRefresh: boolean;
  online: PlayerDto[];
  /** Offline players seen in the last RECENT_PLAYER_DAYS days, most recent first. */
  recent: PlayerDto[];
  /** Lists and actions are only sent to roles with the `players` permission. */
  lists: PlayerListDto[];
  actions: TemplatePlayerAction[];
  /** Names typed by hand must match it. */
  namePattern: string;
}

/** How far back the recent list goes. */
export const RECENT_PLAYER_DAYS = 30;

export const PlayerActionBody = z.object({
  /** The action's id in the template. */
  action: z.string().min(1).max(32),
  player: z.string().trim().min(1).max(64),
  /** Field name → value; missing fields take their defaults. */
  fields: z.record(z.string().regex(VARIABLE_NAME_RE), z.string().max(500)).default({}),
});
export type PlayerActionBody = z.input<typeof PlayerActionBody>;
