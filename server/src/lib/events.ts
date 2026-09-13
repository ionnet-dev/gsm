/** Typed in-process event bus so modules can react to each other without importing each other. */
import type { InstanceState, NodeStatus } from "@gsm/shared";

export interface GsmEvents {
  /** Every accepted agent hello, including reconnects of a node that never showed offline. */
  "agent.hello": { nodeId: number };
  "node.online": { nodeId: number };
  "node.offline": { nodeId: number };
  "node.status": { nodeId: number; status: NodeStatus };
  "node.deleted": { nodeId: number };
  /** The agent reported a state for one of its instances (from inst.status or inst.list). */
  "instance.state": { nodeId: number; state: InstanceState };
  "instance.deleted": { instanceId: number; nodeId: number };
  /** An instance reached `running`; its ports answer now. */
  "instance.running": { instanceId: number };
  /** An install finished or an instance's ports changed, while it is stopped. */
  "instance.ports_changed": { instanceId: number };
  /** An owner opened or closed an instance's ports in the node's firewall. */
  "instance.firewall": { instanceId: number };
  /** A node answered agent.configure; `listening` is its SFTP state. */
  "node.sftp": { nodeId: number; listening: boolean };
  /** A user's instance or node access changed (grant, revoke, role, instance created/deleted). */
  "access.changed": { userIds: number[] };
}

type Listener<K extends keyof GsmEvents> = (payload: GsmEvents[K]) => void | Promise<void>;

class EventBus {
  private listeners = new Map<keyof GsmEvents, Set<Listener<keyof GsmEvents>>>();

  on<K extends keyof GsmEvents>(event: K, listener: Listener<K>): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as Listener<keyof GsmEvents>);
    this.listeners.set(event, set);
    return () => set.delete(listener as Listener<keyof GsmEvents>);
  }

  emit<K extends keyof GsmEvents>(event: K, payload: GsmEvents[K]): void {
    for (const l of this.listeners.get(event) ?? []) {
      Promise.resolve()
        .then(() => (l as Listener<K>)(payload))
        .catch((err) => console.error(`event listener for ${event} failed`, err));
    }
  }
}

export const events = new EventBus();
