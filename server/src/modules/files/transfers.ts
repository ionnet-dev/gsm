/**
 * The byte relay between browsers and agents (fs.upload / fs.download / backup.download). A
 * transfer is a one-time token for one node, handed to the agent in the request:
 *
 * - outgoing (to the node): the agent GETs the token and gets `source` streamed as it arrives (a
 *   browser upload's body), then GETs `…/digest` for the SHA-256 the server counted, and only
 *   renames the file into place if it matches;
 * - incoming (from the node): the agent POSTs the bytes; whoever called `expect()` reads them,
 *   and the agent's POST is answered with the SHA-256 once they have all been read.
 *
 * Nothing is buffered beyond what the streams hold, so a transfer can be any size. Tokens live in
 * memory: an unclaimed one expires after a minute, and a stalled stream fails after two.
 */
import { createHash } from "node:crypto";
import { randomId } from "../../lib/ids.ts";
import { log } from "../../lib/logger.ts";

const tlog = log.child("files:transfers");

const CLAIM_MS = 60_000;
export const STALL_MS = 120_000;

export class TransferError extends Error {}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

interface Outgoing {
  kind: "out";
  nodeId: number;
  source: ReadableStream<Uint8Array>;
  size: number;
  claimed: boolean;
  digest: Deferred<string>;
  timer: ReturnType<typeof setTimeout>;
}

/** What `expect()` gets when the agent starts posting. */
export interface Arrival {
  body: ReadableStream<Uint8Array>;
  /** From Content-Length; null for a chunked body (archives). */
  length: number | null;
  /** Answer the agent's POST: the SHA-256 of everything read, or why the transfer failed. */
  complete: (result: { sha256: string } | { error: string }) => void;
}

interface Incoming {
  kind: "in";
  nodeId: number;
  claimed: boolean;
  arrival: Deferred<Arrival>;
  timer: ReturnType<typeof setTimeout>;
}

type Transfer = Outgoing | Incoming;

/** Counts and hashes bytes as they pass. */
export class Tally {
  private hash = createHash("sha256");
  bytes = 0;
  add(chunk: Uint8Array) {
    this.hash.update(chunk);
    this.bytes += chunk.byteLength;
  }
  hex(): string {
    return this.hash.digest("hex");
  }
}

class Transfers {
  private items = new Map<string, Transfer>();

  private add(t: Transfer): string {
    const token = randomId(24);
    this.items.set(token, t);
    return token;
  }

  private expire(token: string) {
    const t = this.items.get(token);
    if (!t || t.claimed) return;
    this.items.delete(token);
    if (t.kind === "out") {
      t.digest.reject(new TransferError("The node never fetched the file"));
      t.source.cancel("expired").catch(() => {});
    } else t.arrival.reject(new TransferError("The node never sent the file"));
  }

  /** Offer `size` bytes of `source` to the node. */
  offer(nodeId: number, source: ReadableStream<Uint8Array>, size: number) {
    const t: Outgoing = {
      kind: "out",
      nodeId,
      source,
      size,
      claimed: false,
      digest: deferred(),
      timer: 0 as unknown as ReturnType<typeof setTimeout>,
    };
    const token = this.add(t);
    t.timer = setTimeout(() => this.expire(token), CLAIM_MS);
    return {
      token,
      digest: t.digest.promise,
      cancel: (reason = "cancelled") => {
        clearTimeout(t.timer);
        this.items.delete(token);
        t.digest.reject(new TransferError(reason));
        t.source.cancel(reason).catch(() => {});
      },
    };
  }

  /** Wait for the node to post the bytes for the returned token. */
  expect(nodeId: number) {
    const t: Incoming = {
      kind: "in",
      nodeId,
      claimed: false,
      arrival: deferred(),
      timer: 0 as unknown as ReturnType<typeof setTimeout>,
    };
    const token = this.add(t);
    t.timer = setTimeout(() => this.expire(token), CLAIM_MS);
    return {
      token,
      arrival: t.arrival.promise,
      cancel: (reason = "cancelled") => {
        clearTimeout(t.timer);
        if (!t.claimed) this.items.delete(token);
        t.arrival.reject(new TransferError(reason));
      },
    };
  }

  /** The agent's GET: stream an outgoing transfer's bytes, failing it if the source stalls. */
  serve(token: string, nodeId: number): { stream: ReadableStream<Uint8Array>; size: number } {
    const t = this.items.get(token);
    if (!t || t.kind !== "out" || t.nodeId !== nodeId || t.claimed) {
      throw new TransferError("Unknown transfer");
    }
    t.claimed = true;
    clearTimeout(t.timer);
    const reader = t.source.getReader();
    const tally = new Tally();
    const drop = () => setTimeout(() => this.items.delete(token), CLAIM_MS);
    const fail = (message: string) => {
      tlog.debug("transfer failed", { nodeId, bytes: tally.bytes, size: t.size, message });
      this.items.delete(token);
      t.digest.reject(new TransferError(message));
    };
    let complete = false;
    const finish = (ctrl: ReadableStreamDefaultController<Uint8Array>) => {
      complete = true;
      t.digest.resolve(tally.hex());
      drop();
      ctrl.close();
      reader.cancel().catch(() => {});
    };
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        if (t.size === 0) finish(ctrl);
      },
      async pull(ctrl) {
        let stall: ReturnType<typeof setTimeout> | undefined;
        try {
          const timeout = new Promise<never>((_, rej) => {
            stall = setTimeout(() => rej(new TransferError("The upload stalled")), STALL_MS);
          });
          const { value, done } = await Promise.race([reader.read(), timeout]);
          if (done) {
            throw new TransferError(`The upload ended after ${tally.bytes} of ${t.size} bytes`);
          }
          tally.add(value);
          if (tally.bytes > t.size) throw new TransferError("The upload is larger than announced");
          ctrl.enqueue(value);
          if (tally.bytes === t.size) finish(ctrl);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          fail(message);
          reader.cancel(message).catch(() => {});
          ctrl.error(err);
        } finally {
          clearTimeout(stall);
        }
      },
      cancel(reason) {
        if (complete) return;
        fail("The node stopped reading");
        reader.cancel(reason).catch(() => {});
      },
    });
    return { stream, size: t.size };
  }

  /** The agent's GET …/digest after reading everything. */
  async digest(token: string, nodeId: number): Promise<string> {
    const t = this.items.get(token);
    if (!t || t.kind !== "out" || t.nodeId !== nodeId || !t.claimed) {
      throw new TransferError("Unknown transfer");
    }
    try {
      return await t.digest.promise;
    } finally {
      this.items.delete(token);
    }
  }

  /** The agent's POST: hand its body to whoever is waiting, and answer once it has been read. */
  receive(
    token: string,
    nodeId: number,
    body: ReadableStream<Uint8Array>,
    length: number | null,
  ): Promise<{ sha256: string } | { error: string }> {
    const t = this.items.get(token);
    if (!t || t.kind !== "in" || t.nodeId !== nodeId || t.claimed) {
      throw new TransferError("Unknown transfer");
    }
    t.claimed = true;
    clearTimeout(t.timer);
    this.items.delete(token);
    const answer = deferred<{ sha256: string } | { error: string }>();
    t.arrival.resolve({ body, length, complete: answer.resolve });
    return answer.promise;
  }

  get size() {
    return this.items.size;
  }
}

export const transfers = new Transfers();
