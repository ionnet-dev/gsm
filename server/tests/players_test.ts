import { assert, assertEquals, assertThrows } from "@std/assert";
import { TemplateDefinition } from "@gsm/shared";
import {
  buildActionCommand,
  compileMatcher,
  nameValidator,
  parseListFile,
  type SeenPlayer,
} from "../src/modules/players/parse.ts";

const load = (slug: string) =>
  TemplateDefinition.parse(
    JSON.parse(Deno.readTextFileSync(new URL(`../../templates/${slug}.json`, import.meta.url))),
  );

const vanilla = load("minecraft-vanilla");
const players = vanilla.players!;
const m = compileMatcher(players);
const STEVE = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
const ALEX = "ec561538-f3fd-461d-aff5-086b22154bce";

Deno.test("the built-in Minecraft templates track players; the generic one does not", () => {
  for (const slug of ["minecraft-vanilla", "minecraft-forge", "minecraft-neoforge"]) {
    const def = load(slug);
    assert(def.players, slug);
    compileMatcher(def.players);
  }
  assertEquals(load("custom-generic").players, null);
});

Deno.test("Minecraft join, leave and id lines, vanilla and Forge layouts", () => {
  assertEquals(
    m.match(`[12:00:01] [User Authenticator #1/INFO]: UUID of player Steve is ${STEVE}`),
    { type: "identify", name: "Steve", id: STEVE },
  );
  assertEquals(
    m.match(
      "[12:00:02] [Server thread/INFO]: Steve[/172.17.0.1:51234] logged in with entity id 157 at (-3.5, 64.0, 12.5)",
    ),
    { type: "join", name: "Steve", id: null },
  );
  assertEquals(
    m.match(
      "[12:00:02] [Server thread/INFO] [minecraft/PlayerList]: Alex[/10.0.0.2:40000] logged in with entity id 9 at (0.5, 70.0, 0.5)",
    ),
    { type: "join", name: "Alex", id: null },
  );
  assertEquals(
    m.match(
      "[12:00:02] [Server thread/INFO]: Steve[<ip address withheld>] logged in with entity id 3 at (0, 64, 0)",
    ),
    { type: "join", name: "Steve", id: null },
  );
  assertEquals(
    m.match(
      "\x1b[32m[12:00:02] [Server thread/INFO] [minecraft/PlayerList]: Bob[/1.2.3.4:5] logged in with entity id 1 at (0, 0, 0)\x1b[m",
    ),
    { type: "join", name: "Bob", id: null },
  );
  assertEquals(
    m.match("[12:05:00] [Server thread/INFO]: Steve lost connection: Disconnected"),
    { type: "leave", name: "Steve" },
  );
  assertEquals(
    m.match(
      "[12:05:00] [Server thread/INFO] [minecraft/ServerGamePacketListenerImpl]: Alex lost connection: Timed out",
    ),
    { type: "leave", name: "Alex" },
  );
});

Deno.test("lines captured from a NeoForge 1.21.1 server", () => {
  const id = "d29fb97d-1904-442f-a40f-1fef40bfefb5";
  assertEquals(
    m.match(
      `[13:22:36] [User Authenticator #1/INFO] [minecraft/ServerLoginPacketListenerImpl]: UUID of player Lucasion09 is ${id}`,
    ),
    { type: "identify", name: "Lucasion09", id },
  );
  assertEquals(
    m.match(
      "[13:22:38] [Server thread/INFO] [minecraft/PlayerList]: Lucasion09[/192.168.0.110:44428] logged in with entity id 16 at (-6.5, 65.0, -148.5)",
    ),
    { type: "join", name: "Lucasion09", id: null },
  );
  assertEquals(
    m.match(
      "[13:22:38] [Server thread/INFO] [minecraft/MinecraftServer]: Lucasion09 joined the game",
    ),
    null,
  );
  assertEquals(
    m.match(
      "[13:23:11] [Server thread/INFO] [minecraft/ServerGamePacketListenerImpl]: Lucasion09 lost connection: Disconnected",
    ),
    { type: "leave", name: "Lucasion09" },
  );
});

Deno.test("list answers captured from NeoForge 1.21.1 and vanilla 26.2 servers", () => {
  assertEquals(
    m.match(
      "[15:24:08] [Server thread/INFO] [minecraft/MinecraftServer]: There are 0 of a max of 20 players online: ",
    ),
    { type: "list", players: [] },
  );
  assertEquals(
    m.match("[15:24:08] [Server thread/INFO]: There are 0 of a max of 20 players online:"),
    { type: "list", players: [] },
  );
});

Deno.test("chat, announcements and refused logins are not taken for players", () => {
  for (
    const line of [
      "[12:00:03] [Server thread/INFO]: <Steve> Bob[/1.2.3.4:5] logged in with entity id 1 at (0, 0, 0)",
      "[12:00:03] [Server thread/INFO]: [Not Secure] <Steve> x]: Bob lost connection: bye",
      "[12:00:03] [Server thread/INFO]: [Server] Bob lost connection: bye",
      "[12:00:03] [Server thread/INFO]: Steve (/1.2.3.4:5678) lost connection: You are not white-listed on this server!",
      "[12:00:03] [Server thread/INFO]: com.mojang.authlib.GameProfile@1a2b3c (/1.2.3.4:5678) lost connection: Disconnected",
      "[12:00:04] [Server thread/INFO]: Steve joined the game",
      "[12:00:05] [Server thread/INFO]: <Steve> There are 5 of a max of 20 players online: Notch",
    ]
  ) {
    assertEquals(m.match(line), null, line);
  }
});

Deno.test("a list answer names everyone online", () => {
  assertEquals(
    m.match(
      `[12:10:00] [Server thread/INFO]: There are 2 of a max of 20 players online: Steve (${STEVE}), Alex (${ALEX})`,
    ),
    { type: "list", players: [{ name: "Steve", id: STEVE }, { name: "Alex", id: ALEX }] },
  );
  assertEquals(
    m.match("[12:10:00] [Server thread/INFO]: There are 0 of a max of 20 players online: "),
    { type: "list", players: [] },
  );
  assertEquals(
    m.match("[12:10:00] [Server thread/INFO]: There are 1 of a max 20 players online: Steve"),
    { type: "list", players: [{ name: "Steve", id: null }] },
  );
});

Deno.test("changes to the game's lists ask for a refresh", () => {
  for (
    const line of [
      "[12:11:00] [Server thread/INFO]: Made Steve a server operator",
      "[12:11:00] [Server thread/INFO]: [Alex: Made Steve no longer a server operator]",
      "[12:11:00] [Server thread/INFO]: Banned Steve: Griefing",
      "[12:11:00] [Server thread/INFO]: Unbanned Steve",
      "[12:11:00] [Server thread/INFO]: Added Steve to the whitelist",
    ]
  ) {
    assertEquals(m.match(line), { type: "refresh" }, line);
  }
});

Deno.test("list files: Minecraft JSON and plain lines", () => {
  const ops = players.lists.find((l) => l.id === "ops")!;
  assertEquals(
    parseListFile(
      ops,
      `[{"uuid":"${STEVE}","name":"Steve","level":4,"bypassesPlayerLimit":false},{"level":4}]`,
    ),
    [{ name: "Steve", id: STEVE, values: { level: "4" } }],
  );
  assertEquals(parseListFile(ops, "\n"), []);
  assertThrows(() => parseListFile(ops, "{}"));
  const lines = { ...ops, format: "lines" as const };
  assertEquals(parseListFile(lines, "# admins\nSteve\n\n  Alex # the builder\n"), [
    { name: "Steve", id: null, values: {} },
    { name: "Alex", id: null, values: {} },
  ]);
});

Deno.test("actions fill their command and check every value", () => {
  const valid = nameValidator(players.namePattern);
  const action = (id: string) => players.actions.find((a) => a.id === id)!;
  const steve: SeenPlayer = { name: "Steve", id: STEVE };
  const run = (id: string, fields: Record<string, string> = {}, who = steve) =>
    buildActionCommand(action(id), who, fields, valid);

  assertEquals(run("kick"), { ok: true, command: "kick Steve" });
  assertEquals(run("kick", { REASON: "  Be nice  " }), { ok: true, command: "kick Steve Be nice" });
  assertEquals(run("gamemode", { MODE: "creative" }), {
    ok: true,
    command: "gamemode creative Steve",
  });
  assertEquals(run("give"), { ok: true, command: "give Steve minecraft:diamond 1" });
  assertEquals(run("teleport", { TARGET: "Alex" }), { ok: true, command: "tp Steve Alex" });

  // Selectors, line breaks, unknown options, out-of-range numbers and unknown fields are refused.
  assertEquals(run("op", {}, { name: "@a", id: null }).ok, false);
  assertEquals(run("kick", { REASON: "bye\nop Mallory" }), {
    ok: false,
    problems: { REASON: "Must be a single line of text" },
  });
  assertEquals(run("gamemode", { MODE: "god" }).ok, false);
  assertEquals(run("give", { COUNT: "100000" }).ok, false);
  assertEquals(run("teleport", { TARGET: "@r" }).ok, false);
  assertEquals(run("message").ok, false);
  assertEquals(run("kill", { EXTRA: "1" }).ok, false);
});

Deno.test("the template schema refuses broken player sections", () => {
  const base = { ...vanilla, slug: "players-test" };
  const bad = (p: unknown) => !TemplateDefinition.safeParse({ ...base, players: p }).success;
  const msg = players.actions[0];
  assert(!bad(players));
  assert(bad({ ...players, console: { ...players.console, join: "(unclosed" } }));
  assert(bad({ ...players, console: { ...players.console, join: "no name group" } }));
  assert(bad({ ...players, actions: [{ ...msg, command: "tell {{PLAYER}} {{NOPE}}" }] }));
  assert(bad({ ...players, actions: [{ ...msg, when: { list: "nope", is: true } }] }));
  assert(bad({ ...players, actions: [{ ...msg, command: "say a\nop b" }] }));
  assert(bad({ ...players, actions: [msg, msg] }));
});
