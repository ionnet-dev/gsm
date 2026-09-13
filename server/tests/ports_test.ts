import { assertEquals, assertThrows } from "@std/assert";
import { TemplateDefinition, type TemplatePort } from "@gsm/shared";
import { allocatePorts } from "../src/modules/instances/ports.ts";
import { HttpError } from "../src/lib/errors.ts";

const port = (
  p: Partial<TemplatePort> & Pick<TemplatePort, "name" | "default" | "protocol">,
): TemplatePort => ({ label: p.name, primary: false, follows: null, ...p });

const range = { start: 30000, end: 30005 };
const game = {
  name: "game",
  label: "Game",
  protocol: "tcp" as const,
  default: 25565,
  primary: true,
  follows: null,
};
const query = {
  name: "query",
  label: "Query",
  protocol: "udp" as const,
  default: 25565,
  primary: false,
  follows: null,
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

// 7 Days to Die: the game port and the two after it, which the game derives from its setting.
const run = [
  port({ name: "game", default: 26900, protocol: "both", primary: true }),
  port({ name: "game_2", default: 26901, protocol: "udp", follows: "game" }),
  port({ name: "game_3", default: 26902, protocol: "udp", follows: "game_2" }),
];
const numbers = (out: { name: string; port: number }[]) =>
  Object.fromEntries(out.map((a) => [a.name, a.port]));

Deno.test("allocatePorts places a port and its followers as one block", () => {
  const pool = { start: 26900, end: 26999 };
  assertEquals(numbers(allocatePorts(run, {}, new Set(), pool)), {
    game: 26900,
    game_2: 26901,
    game_3: 26902,
  });
  // 26902 is taken, so no block starting at 26900 fits; the next free run of three does.
  assertEquals(numbers(allocatePorts(run, {}, new Set([26902]), pool)), {
    game: 26903,
    game_2: 26904,
    game_3: 26905,
  });
});

Deno.test("allocatePorts moves followers with a chosen head and checks their choices", () => {
  assertEquals(numbers(allocatePorts(run, { game: 30010 }, new Set(), range)), {
    game: 30010,
    game_2: 30011,
    game_3: 30012,
  });
  // A follower's choice is accepted when it agrees with the head, refused otherwise.
  allocatePorts(run, { game: 30010, game_2: 30011 }, new Set(), range);
  assertThrows(
    () => allocatePorts(run, { game: 30010, game_2: 30020 }, new Set(), range),
    HttpError,
  );
  assertThrows(() => allocatePorts(run, { game: 30010 }, new Set([30012]), range), HttpError);
  assertThrows(() => allocatePorts(run, {}, new Set(), { start: 30000, end: 30001 }), HttpError);
});

Deno.test("the template schema checks followers", () => {
  const def = (ports: unknown[]) => ({
    schemaVersion: 1,
    slug: "tt",
    name: "T",
    game: "G",
    image: "i",
    install: { script: "true" },
    startup: "true",
    ports,
  });
  const base = { label: "P", protocol: "udp", default: 1 };
  assertEquals(TemplateDefinition.safeParse(def(run)).success, true);
  // Following a port that comes later, or two ports following the same one, is refused.
  assertEquals(
    TemplateDefinition.safeParse(
      def([{ ...base, name: "b", follows: "a" }, { ...base, name: "a" }]),
    )
      .success,
    false,
  );
  assertEquals(
    TemplateDefinition.safeParse(def([
      { ...base, name: "a" },
      { ...base, name: "b", follows: "a" },
      { ...base, name: "c", follows: "a" },
    ])).success,
    false,
  );
});
