/**
 * The panel server's side of a reachability check: connect out to a node's public address the way
 * a player or an SFTP client would.
 */
import dgram from "node:dgram";
import type { ReachabilityStatus } from "@gsm/shared";

export const CONNECT_TIMEOUT_MS = 5_000;

export interface Outcome {
  status: Exclude<ReachabilityStatus, "untested">;
  detail: string | null;
  /** The first line the other side sent, when asked to read one. */
  line?: string;
}

/** A promise that rejects with TimedOut after `ms`, and a way to cancel it. */
function deadline(ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Deno.errors.TimedOut()), ms);
  });
  return { expired, clear: () => clearTimeout(timer) };
}

/** Turn a connect error into a status people can act on. */
export function classify(err: unknown, timeoutMs = CONNECT_TIMEOUT_MS): Outcome {
  if (err instanceof Deno.errors.TimedOut) {
    return {
      status: "timeout",
      detail: `No answer within ${
        timeoutMs / 1000
      } s; a firewall may drop it, or the port is not forwarded`,
    };
  }
  if (err instanceof Deno.errors.ConnectionRefused) {
    return {
      status: "closed",
      detail: "Connection refused: nothing answers on this port, or a firewall rejects it",
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/lookup|resolve|name or service|nodename/i.test(message)) {
    return { status: "error", detail: `The address does not resolve: ${message}` };
  }
  if (/unreachable/i.test(message)) {
    return { status: "error", detail: `No route to the node: ${message}` };
  }
  return { status: "error", detail: message };
}

/**
 * Open a TCP connection to host:port. Optionally write `payload` and/or read the first line the
 * other side sends (an SSH greeting).
 */
export async function tcpCheck(
  host: string,
  port: number,
  opts: { payload?: string; readLine?: boolean; timeoutMs?: number } = {},
): Promise<Outcome> {
  const ms = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const connecting = Deno.connect({ hostname: host, port, transport: "tcp" });
  const connectBy = deadline(ms);
  let conn: Deno.TcpConn;
  try {
    conn = await Promise.race([connecting, connectBy.expired]);
  } catch (err) {
    // A connection that turns up after the deadline is closed straight away.
    connecting.then((c) => c.close()).catch(() => {});
    return classify(err, ms);
  } finally {
    connectBy.clear();
  }
  try {
    if (opts.payload) await conn.write(new TextEncoder().encode(opts.payload));
    if (!opts.readLine) return { status: "open", detail: null };
    const buf = new Uint8Array(256);
    const readBy = deadline(ms);
    const n = await Promise.race([conn.read(buf), readBy.expired]).catch(() => null)
      .finally(readBy.clear);
    const text = n ? new TextDecoder().decode(buf.subarray(0, n)) : "";
    return { status: "open", detail: null, line: text.split(/\r?\n/)[0] };
  } catch (err) {
    return { status: "error", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      conn.close();
    } catch { /* already closed */ }
  }
}

/** Send `payload` to host:port over UDP a few times; UDP has no answer to wait for here. */
export async function udpSend(host: string, port: number, payload: string, times = 3) {
  const socket = dgram.createSocket(host.includes(":") ? "udp6" : "udp4");
  try {
    for (let i = 0; i < times; i++) {
      await new Promise<void>((resolve, reject) =>
        socket.send(payload, port, host, (err) => err ? reject(err) : resolve())
      );
      await new Promise((r) => setTimeout(r, 300));
    }
  } finally {
    socket.close();
  }
}
