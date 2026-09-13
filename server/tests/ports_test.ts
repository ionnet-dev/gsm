import { assertEquals, assertThrows } from "@std/assert";
import { allocatePorts } from "../src/modules/instances/ports.ts";
import { HttpError } from "../src/lib/errors.ts";

const range = { start: 30000, end: 30005 };
const game = {
  name: "game",
  label: "Game",
  protocol: "tcp" as const,
  default: 25565,
  primary: true,
};
const query = {
  name: "query",
  label: "Query",
  protocol: "udp" as const,
  default: 25565,
  primary: false,
};

Deno.test("allocatePorts prefers the default when it is in the pool and free", () => {
  const inPool = { ...game, default: 30002 };
  const out = allocatePorts([inPool], {}, new Set(), range);
  assertEquals(out.map((p) => p.port), [30002]);
});

Deno.test("allocatePorts falls back to the next free port of the pool", () => {
  const out = allocatePorts([game, query], {}, new Set([30000]), range);
  assertEquals(out.map((p) => p.port), [30001, 30002]);
  assertEquals(out[0].primary, true);
});

Deno.test("allocatePorts honours choices and refuses collisions", () => {
  const out = allocatePorts([game, query], { game: 40000 }, new Set(), range);
  assertEquals(out.map((p) => p.port), [40000, 30000]);
  assertThrows(() => allocatePorts([game], { game: 30000 }, new Set([30000]), range), HttpError);
  assertThrows(() => allocatePorts([game], { nope: 1 }, new Set(), range), HttpError);
});

Deno.test("allocatePorts fails when the pool is exhausted", () => {
  const used = new Set([30000, 30001, 30002, 30003, 30004, 30005]);
  assertThrows(() => allocatePorts([game], {}, used, range), HttpError, "no free ports");
});
