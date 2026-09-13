/**
 * Single reconnecting WebSocket to /ws/ui. Server events invalidate TanStack Query caches;
 * high-frequency streams (console lines, stats, node metrics) are additionally fanned out to
 * subscribers. Console output only arrives for instances a subscriber asked for.
 */
import type { QueryClient } from "@tanstack/react-query";
import type {
  InstanceDetailDto,
  NodeDetailDto,
  NodeDto,
  Page,
  UiEvent,
  UiEventData,
} from "@gsm/shared";
import { backupKeys } from "@/api/backups";
import { instanceKeys, patchInstanceCaches } from "@/api/instances";
import { nodeKeys } from "@/api/nodes";
import { templateKeys } from "@/api/templates";

type Listener<E extends UiEvent> = (data: UiEventData<E>) => void;

class UiSocket {
  private ws: WebSocket | null = null;
  private qc: QueryClient | null = null;
  private listeners = new Map<string, Set<Listener<UiEvent>>>();
  /** Console subscribers per instance; the server is told when the first arrives and the last leaves. */
  private consoles = new Map<number, number>();
  private retry = 1000;
  private stopped = false;
  private statusListeners = new Set<(connected: boolean) => void>();
  connected = false;

  start(qc: QueryClient) {
    this.qc = qc;
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.setConnected(false);
  }

  on<E extends UiEvent>(event: E, listener: Listener<E>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as Listener<UiEvent>);
    this.listeners.set(event, set);
    return () => set.delete(listener as Listener<UiEvent>);
  }

  onStatus(listener: (connected: boolean) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.connected);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * Follow an instance's console. The listener gets every `instance.console` batch for it; the
   * subscription is (re)sent on every reconnect. Returns an unsubscribe function.
   */
  subscribeConsole(
    instanceId: number,
    listener: (data: UiEventData<"instance.console">) => void,
  ): () => void {
    const count = this.consoles.get(instanceId) ?? 0;
    this.consoles.set(instanceId, count + 1);
    if (count === 0) this.send({ t: "sub", instanceId });
    const off = this.on("instance.console", (d) => {
      if (d.instanceId === instanceId) listener(d);
    });
    return () => {
      off();
      const n = (this.consoles.get(instanceId) ?? 1) - 1;
      if (n <= 0) {
        this.consoles.delete(instanceId);
        this.send({ t: "unsub", instanceId });
      } else this.consoles.set(instanceId, n);
    };
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private setConnected(v: boolean) {
    if (this.connected === v) return;
    this.connected = v;
    for (const l of this.statusListeners) l(v);
  }

  private connect() {
    if (this.stopped) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws/ui`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) {
        ws.close();
        return;
      }
      this.retry = 1000;
      this.setConnected(true);
      // Subscriptions do not survive the socket; the server forgot them.
      for (const id of this.consoles.keys()) this.send({ t: "sub", instanceId: id });
      // We may have missed events while disconnected.
      this.qc?.invalidateQueries();
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(String(evt.data)) as { t: string; event: UiEvent; data: unknown };
        if (msg.t === "event") this.dispatch(msg.event, msg.data);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = (evt) => {
      // A superseded socket (StrictMode double-mount, explicit stop/start) must not reconnect.
      if (this.ws !== ws) return;
      this.setConnected(false);
      this.ws = null;
      if (this.stopped || evt.code === 4001) return;
      // 4002: the server changed what this user may see; reconnect right away.
      setTimeout(() => this.connect(), evt.code === 4002 ? 0 : this.retry);
      this.retry = Math.min(this.retry * 2, 15_000);
    };
    ws.onerror = () => ws.close();
  }

  private dispatch(event: UiEvent, data: unknown) {
    const qc = this.qc;
    if (qc) {
      switch (event) {
        case "node.status":
          qc.invalidateQueries({ queryKey: nodeKeys.all });
          qc.invalidateQueries({ queryKey: instanceKeys.all });
          break;
        case "node.updated":
          qc.invalidateQueries({ queryKey: nodeKeys.all });
          break;
        case "node.metrics": {
          const d = data as UiEventData<"node.metrics">;
          // Patch caches in place; a metrics tick is not worth a refetch.
          qc.setQueriesData<Page<NodeDto>>({ queryKey: ["nodes", "list"] }, (page) =>
            page
              ? {
                ...page,
                items: page.items.map((n) =>
                  n.id === d.nodeId ? { ...n, lastMetrics: d.metrics, lastSeenAt: d.metrics.at } : n
                ),
              }
              : page);
          qc.setQueryData<{ items: NodeDto[] }>(nodeKeys.every, (old) =>
            old
              ? {
                items: old.items.map((n) =>
                  n.id === d.nodeId ? { ...n, lastMetrics: d.metrics, lastSeenAt: d.metrics.at } : n
                ),
              }
              : old);
          qc.setQueryData<{ node: NodeDetailDto; connected: boolean }>(
            nodeKeys.detail(d.nodeId),
            (old) =>
              old
                ? {
                  ...old,
                  node: { ...old.node, lastMetrics: d.metrics, lastSeenAt: d.metrics.at },
                }
                : old,
          );
          break;
        }
        case "instance.updated": {
          const d = data as UiEventData<"instance.updated">;
          qc.invalidateQueries({ queryKey: instanceKeys.all });
          qc.invalidateQueries({ queryKey: instanceKeys.access(d.instanceId) });
          break;
        }
        case "instance.status": {
          const d = data as UiEventData<"instance.status">;
          patchInstanceCaches(
            qc,
            d.instanceId,
            (i) => ({ ...i, status: d.status, error: d.error }),
          );
          qc.invalidateQueries({ queryKey: instanceKeys.summary });
          qc.invalidateQueries({ queryKey: nodeKeys.all });
          break;
        }
        case "instance.stats": {
          const d = data as UiEventData<"instance.stats">;
          patchInstanceCaches(qc, d.instanceId, (i) => ({ ...i, lastStats: d.stats }));
          break;
        }
        case "instance.console":
          break; // streamed to subscribers only
        case "backup.updated": {
          const d = data as UiEventData<"backup.updated">;
          qc.invalidateQueries({ queryKey: backupKeys.list(d.instanceId) });
          break;
        }
        case "template.updated":
          qc.invalidateQueries({ queryKey: templateKeys.all });
          break;
        case "image.pull": {
          const d = data as UiEventData<"image.pull">;
          if (d.done) qc.invalidateQueries({ queryKey: nodeKeys.images(d.nodeId) });
          break;
        }
      }
    }
    for (const l of this.listeners.get(event) ?? []) l(data as UiEventData<UiEvent>);
  }
}

export const uiSocket = new UiSocket();

/** Convenience for components: patch an instance detail in the cache. */
export type { InstanceDetailDto };
