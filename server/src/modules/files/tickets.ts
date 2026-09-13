/**
 * One-time download tickets: a POST checks what is asked for and reserves a URL bound to the
 * requesting user; the browser's download manager then GETs it. Files and backups share this.
 */
import { randomId } from "../../lib/ids.ts";

const TICKET_MS = 60_000;

export interface Ticket {
  userId: number;
  instanceId: number;
  nodeId: number;
  filename: string;
  size: number | null;
  archive: boolean;
  kind: { type: "files"; uuid: string; paths: string[] } | {
    type: "backup";
    uuid: string;
    backupId: string;
  };
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();

export function issueTicket(t: Omit<Ticket, "expiresAt">): string {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expiresAt < now) tickets.delete(k);
  const id = randomId(24);
  tickets.set(id, { ...t, expiresAt: now + TICKET_MS });
  return id;
}

/** Take a ticket (it works once) if it belongs to the user and has not expired. */
export function claimTicket(id: string, userId: number): Ticket | null {
  const t = tickets.get(id);
  if (!t || t.expiresAt < Date.now() || t.userId !== userId) return null;
  tickets.delete(id);
  return t;
}

export function contentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
