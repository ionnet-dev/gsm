/**
 * Port allocation on a node's pool. Pure functions here; the service wraps them in a transaction
 * with the node's `instance_ports` rows.
 */
import type { TemplatePort } from "@gsm/shared";
import { badRequest, conflict } from "../../lib/errors.ts";

export interface Allocation {
  name: string;
  label: string;
  protocol: TemplatePort["protocol"];
  port: number;
  primary: boolean;
}

/**
 * Give every template port a host port: the operator's choice when given, else the template's
 * default when free and inside the pool, else the next free port of the pool. `used` holds the
 * ports other instances on the node already own; the ports allocated here are added to it.
 */
export function allocatePorts(
  ports: TemplatePort[],
  choices: Record<string, number>,
  used: Set<number>,
  range: { start: number; end: number },
): Allocation[] {
  const taken = new Set(used);
  const out: Allocation[] = [];
  for (const [name, port] of Object.entries(choices)) {
    if (!ports.some((p) => p.name === name)) throw badRequest(`Unknown port "${name}"`);
    if (taken.has(port)) throw conflict(`Port ${port} is already in use on this node`);
    taken.add(port);
  }
  let cursor = range.start;
  const nextFree = () => {
    while (cursor <= range.end && taken.has(cursor)) cursor++;
    if (cursor > range.end) {
      throw conflict(`The node's port range ${range.start}-${range.end} has no free ports left`);
    }
    return cursor++;
  };
  for (const p of ports) {
    let port = choices[p.name];
    if (port === undefined) {
      const wanted = p.default;
      if (
        !used.has(wanted) && !out.some((o) => o.port === wanted) && wanted >= range.start &&
        wanted <= range.end
      ) {
        port = wanted;
      } else port = nextFree();
      taken.add(port);
    }
    out.push({ name: p.name, label: p.label, protocol: p.protocol, port, primary: p.primary });
  }
  return out;
}
