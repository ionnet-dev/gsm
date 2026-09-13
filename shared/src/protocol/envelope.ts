import { z } from "zod";

/** Bump when a change is not backwards compatible for agents. */
export const PROTOCOL_VERSION = 1;

export const RpcError = z.object({
  code: z.string(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcError>;

export const ReqEnvelope = z.object({
  t: z.literal("req"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown(),
});
export const ResOkEnvelope = z.object({
  t: z.literal("res"),
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.unknown(),
});
export const ResErrEnvelope = z.object({
  t: z.literal("res"),
  id: z.string().min(1),
  ok: z.literal(false),
  error: RpcError,
});
/** A chunk belonging to an in-flight request; the last chunk carries done=true. */
export const StreamEnvelope = z.object({
  t: z.literal("stream"),
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  chunk: z.unknown(),
  done: z.boolean().optional(),
});
export const EventEnvelope = z.object({
  t: z.literal("event"),
  event: z.string().min(1),
  data: z.unknown(),
});

export const Envelope = z.union([
  ReqEnvelope,
  ResOkEnvelope,
  ResErrEnvelope,
  StreamEnvelope,
  EventEnvelope,
]);

export type ReqEnvelope = z.infer<typeof ReqEnvelope>;
export type ResOkEnvelope = z.infer<typeof ResOkEnvelope>;
export type ResErrEnvelope = z.infer<typeof ResErrEnvelope>;
export type ResEnvelope = ResOkEnvelope | ResErrEnvelope;
export type StreamEnvelope = z.infer<typeof StreamEnvelope>;
export type EventEnvelope = z.infer<typeof EventEnvelope>;
export type Envelope = z.infer<typeof Envelope>;

/** Well-known error codes shared by server and agent. */
export const RPC_ERROR_CODES = {
  unknownMethod: "unknown_method",
  invalidParams: "invalid_params",
  timeout: "timeout",
  cancelled: "cancelled",
  unauthorized: "unauthorized",
  unavailable: "unavailable",
  internal: "internal",
  notFound: "not_found",
} as const;

export function encodeEnvelope(env: Envelope): string {
  return JSON.stringify(env);
}

export function decodeEnvelope(raw: string): Envelope {
  return Envelope.parse(JSON.parse(raw));
}
