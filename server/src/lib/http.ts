import type { Context } from "hono";
import { getConnInfo } from "hono/deno";
import { z } from "zod";
import { badRequest } from "./errors.ts";
import { config } from "../config.ts";

/**
 * The client address from an X-Forwarded-For header. Proxies append the peer they saw, so the
 * *last* entry is the one our trusted proxy wrote; everything before it is client-supplied and
 * must not be used for rate limiting or audit.
 */
export function ipFromForwardedFor(xff: string | undefined, trustProxy: boolean): string | null {
  if (!trustProxy || !xff) return null;
  const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
  const last = parts.at(-1);
  return last ? last.slice(0, 45) : null;
}

/** Best-effort client IP: the trusted proxy's X-Forwarded-For hop, else the socket peer. */
export function clientIp(c: Context): string | null {
  const forwarded = ipFromForwardedFor(c.req.header("x-forwarded-for"), config.TRUST_PROXY);
  if (forwarded) return forwarded;
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

/** Parse and validate a JSON body; malformed JSON becomes a 400 instead of a 500. */
export async function parseBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  return schema.parse(raw);
}

export function parseQuery<T extends z.ZodTypeAny>(c: Context, schema: T): z.infer<T> {
  return schema.parse(c.req.query());
}

export function idParam(c: Context, name = "id"): number {
  const n = Number(c.req.param(name));
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`Invalid ${name}`);
  return n;
}
