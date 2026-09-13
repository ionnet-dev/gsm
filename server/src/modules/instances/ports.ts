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
 * default when free and inside the pool, else the next free port of the pool. A port that
 * `follows` another is that port plus one, so a port and its followers are placed as one block
 * and only the first of them can be chosen. `used` holds the ports other instances on the node
 * already own.
 */
export function allocatePorts(
  ports: TemplatePort[],
  choices: Record<string, number>,
  used: Set<number>,
  range: { start: number; end: number },
): Allocation[] {
  const byName = new Map(ports.map((p) => [p.name, p]));
  const headOf = (p: TemplatePort): { head: TemplatePort; offset: number } => {
    let head = p;
    let offset = 0;
    while (head.follows && byName.has(head.follows) && offset < ports.length) {
      head = byName.get(head.follows)!;
      offset++;
    }
    return { head, offset };
  };
  // Every port's block: the head's name → its size (the head plus its followers).
  const size = new Map<string, number>();
  for (const p of ports) {
    const { head, offset } = headOf(p);
    size.set(head.name, Math.max(size.get(head.name) ?? 1, offset + 1));
  }
  for (const name of Object.keys(choices)) {
    if (!byName.has(name)) throw badRequest(`Unknown port "${name}"`);
  }

  const taken = new Set(used);
  const blockFree = (start: number, n: number) => {
    for (let x = start; x < start + n; x++) if (x < 1 || x > 65535 || taken.has(x)) return false;
    return true;
  };
  const take = (start: number, n: number) => {
    for (let x = start; x < start + n; x++) taken.add(x);
  };
  const first = new Map<string, number>();
  for (const [name, n] of size) {
    const port = choices[name];
    if (port === undefined) continue;
    if (!blockFree(port, n)) {
      const busy = Array.from({ length: n }, (_, k) => port + k).find((x) => taken.has(x));
      throw busy === undefined
        ? badRequest(`Port ${port} needs ${n} ports in a row`)
        : conflict(`Port ${busy} is already in use on this node`);
    }
    take(port, n);
    first.set(name, port);
  }
  let cursor = range.start;
  for (const [name, n] of size) {
    if (first.has(name)) continue;
    const wanted = byName.get(name)!.default;
    let port = wanted;
    if (!(wanted >= range.start && wanted + n - 1 <= range.end && blockFree(wanted, n))) {
      while (cursor + n - 1 <= range.end && !blockFree(cursor, n)) cursor++;
      if (cursor + n - 1 > range.end) {
        throw conflict(
          n > 1
            ? `The node's port range ${range.start}-${range.end} has no ${n} free ports in a row`
            : `The node's port range ${range.start}-${range.end} has no free ports left`,
        );
      }
      port = cursor;
    }
    take(port, n);
    first.set(name, port);
  }

  return ports.map((p) => {
    const { head, offset } = headOf(p);
    const port = first.get(head.name)! + offset;
    const chosen = choices[p.name];
    if (offset > 0 && chosen !== undefined && chosen !== port) {
      throw badRequest(`Port "${p.name}" is always ${head.name} + ${offset} (${port})`);
    }
    return { name: p.name, label: p.label, protocol: p.protocol, port, primary: p.primary };
  });
}
