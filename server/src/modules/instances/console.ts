/** In-memory console history per instance and stream, for consoles opened mid-run. */
import type { ConsoleLine, ConsoleStream } from "@gsm/shared";

export class RingBuffer<T> {
  private items: T[] = [];
  private start = 0;

  constructor(public capacity: number) {}

  push(item: T) {
    if (this.items.length < this.capacity) {
      this.items.push(item);
      return;
    }
    this.items[this.start] = item;
    this.start = (this.start + 1) % this.capacity;
  }

  /** Oldest first. */
  toArray(): T[] {
    if (this.items.length < this.capacity) return [...this.items];
    return [...this.items.slice(this.start), ...this.items.slice(0, this.start)];
  }

  get length() {
    return this.items.length;
  }

  clear() {
    this.items = [];
    this.start = 0;
  }
}

class ConsoleHistory {
  private buffers = new Map<string, RingBuffer<ConsoleLine>>();
  private capacity = 1000;

  setCapacity(n: number) {
    this.capacity = n;
  }

  private key(instanceId: number, stream: ConsoleStream) {
    return `${instanceId}:${stream}`;
  }

  append(instanceId: number, stream: ConsoleStream, lines: ConsoleLine[]) {
    const key = this.key(instanceId, stream);
    let buf = this.buffers.get(key);
    if (!buf) {
      buf = new RingBuffer<ConsoleLine>(this.capacity);
      this.buffers.set(key, buf);
    }
    for (const l of lines) buf.push(l);
  }

  tail(instanceId: number, stream: ConsoleStream, lines: number): ConsoleLine[] {
    const all = this.buffers.get(this.key(instanceId, stream))?.toArray() ?? [];
    return all.slice(Math.max(0, all.length - lines));
  }

  clear(instanceId: number, stream?: ConsoleStream) {
    if (stream) this.buffers.delete(this.key(instanceId, stream));
    else {
      this.buffers.delete(this.key(instanceId, "console"));
      this.buffers.delete(this.key(instanceId, "install"));
    }
  }
}

export const consoleHistory = new ConsoleHistory();
