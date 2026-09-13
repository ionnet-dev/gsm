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
  compileMatcher(load("7-days-to-die").players!);
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

// ---- 7 Days to Die --------------------------------------------------------------------------

const sdtd = load("7-days-to-die").players!;
const STEAM = "Steam_76561198000000001";
const at = (text: string) => `2026-09-13T21:30:00 123.456 INF ${text}`;
const client = (name: string, id = STEAM) =>
  `EntityID=171, PltfmId='${id}', CrossId='EOS_0002604bc42244e099c1bf05145fb71f', OwnerID='${id}', PlayerName='${name}', ClientNumber='1'`;

Deno.test("7 Days to Die: joins and leaves come from the spawn and disconnect lines", () => {
  const m7 = compileMatcher(sdtd);
  assertEquals(
    m7.match(
      at(
        `PlayerSpawnedInWorld (reason: JoinMultiplayer, position: -1234, 61, 567): ${
          client("Alloc Fan")
        }`,
      ),
    ),
    { type: "join", name: "Alloc Fan", id: STEAM },
  );
  assertEquals(
    m7.match(
      at(
        `PlayerSpawnedInWorld (reason: EnterMultiplayer, position: (1.0, 2.0, 3.0)): ${
          client("Bob")
        }`,
      ),
    ),
    { type: "join", name: "Bob", id: STEAM },
  );
  assertEquals(m7.match(at(`Player disconnected: ${client("Alloc Fan")}`)), {
    type: "leave",
    name: "Alloc Fan",
  });
  for (
    const line of [
      // A respawn after dying or teleporting is not a join.
      at(`PlayerSpawnedInWorld (reason: Died, position: 1, 2, 3): ${client("Bob")}`),
      // Chat, announcements and the game's own summary lines are not either.
      at(
        `Chat (from '${STEAM}', entity id '171', to 'Global'): 'Bob': PlayerSpawnedInWorld (reason: JoinMultiplayer, position: 0): ${
          client("Fake")
        }`,
      ),
      at("GMSG: Player 'Bob' joined the game"),
      at("Player Bob disconnected after 12.3 minutes"),
      `PlayerSpawnedInWorld (reason: JoinMultiplayer, position: 0): ${client("NoPrefix")}`,
    ]
  ) {
    assertEquals(m7.match(line), null, line);
  }
});

Deno.test("7 Days to Die: the lp answer spans a line per player", () => {
  let now = 1_000_000;
  const m7 = compileMatcher(sdtd, () => now);
  const lp = (n: number, name: string, id: string) =>
    `  ${n}. id=${
      171 + n
    }, ${name}, pos=(-1234.5, 61.1, 567.8), remote=True, pltfmid=${id}, crossid=EOS_0002, ip=1.2.3.4, ping=30`;
  assertEquals(m7.match(lp(0, "Alloc Fan", STEAM)), null);
  assertEquals(m7.match(lp(1, "Bob, the builder", "EOS_0002abc")), null);
  assertEquals(m7.match("Total of 2 in the game"), {
    type: "list",
    players: [{ name: "Alloc Fan", id: STEAM }, { name: "Bob, the builder", id: "EOS_0002abc" }],
  });
  assertEquals(m7.match("Total of 0 in the game"), { type: "list", players: [] });
  // `le` ends with the same line: a count that disagrees with the player lines is ignored.
  assertEquals(m7.match("Total of 5 in the game"), null);
  // Lines from an answer long gone do not leak into the next one.
  m7.match(lp(0, "Stale", STEAM));
  now += 60_000;
  assertEquals(m7.match("Total of 0 in the game"), { type: "list", players: [] });
});

// The layout of the file the game wrote, with its commented-out examples.
const SERVERADMIN = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  This file holds the settings for who is banned, whitelisted, admins and server command permissions.
-->
<adminTools>
  <!-- Name in any entries is optional for display purposes only -->
  <users>
    <!-- <user platform="Steam" userid="76561198021925107" name="Hint on who this user is" permission_level="0" /> -->
    <!-- <group steamID="103582791434672565" name="Steam Universe" permission_level_default="1000" permission_level_mod="0" /> -->
    <user platform="Steam" userid="76561198000000001" name="Probe &amp; Admin" permission_level="0" />
    <user platform="EOS" userid="0002604bc42244e099c1bf05145fb71f" permission_level="100" />
  </users>
  <whitelist>
    <!-- <user platform="" userid="" name="" /> -->
  </whitelist>
  <blacklist>
    <blacklisted platform="Steam" userid="76561198000000003" name="Probe Griefer" unbandate="2026-09-13 21:10:38" reason="testing the panel" />
  </blacklist>
  <apitokens>
    <token name="gsmpanel" secret="s3cretT0ken" permission_level="0" />
  </apitokens>
</adminTools>
`;

Deno.test("7 Days to Die: admins, whitelist and bans come from serveradmin.xml", () => {
  const list = (id: string) => sdtd.lists.find((l) => l.id === id)!;
  assertEquals(parseListFile(list("admins"), SERVERADMIN), [
    {
      name: "Probe & Admin",
      id: "Steam_76561198000000001",
      values: { permission_level: "0" },
    },
    // No display name: the id stands in.
    {
      name: "EOS_0002604bc42244e099c1bf05145fb71f",
      id: "EOS_0002604bc42244e099c1bf05145fb71f",
      values: { permission_level: "100" },
    },
  ]);
  assertEquals(parseListFile(list("whitelist"), SERVERADMIN), []);
  assertEquals(parseListFile(list("banned"), SERVERADMIN), [{
    name: "Probe Griefer",
    id: "Steam_76561198000000003",
    values: { reason: "testing the panel", unbandate: "2026-09-13 21:10:38" },
  }]);
  assertEquals(parseListFile(list("banned"), ""), []);
});

Deno.test("7 Days to Die: actions quote names and drop empty optional values", () => {
  const valid = nameValidator(sdtd.namePattern);
  const action = (id: string) => sdtd.actions.find((a) => a.id === id)!;
  const bob: SeenPlayer = { name: "Bob the Builder", id: STEAM };
  assertEquals(buildActionCommand(action("kick"), bob, {}, valid), {
    ok: true,
    command: `kick "${STEAM}"`,
  });
  assertEquals(buildActionCommand(action("kick"), bob, { REASON: 'say "please" nicely' }, valid), {
    ok: true,
    command: `kick "${STEAM}" "say 'please' nicely"`,
  });
  assertEquals(buildActionCommand(action("ban"), bob, { UNIT: "weeks" }, valid), {
    ok: true,
    command: `ban add "${STEAM}" 7 weeks "Banned by an admin" "Bob the Builder"`,
  });
  assertEquals(
    buildActionCommand(action("give"), bob, { ITEM: "gunPistol", COUNT: "1", QUALITY: "6" }, valid),
    {
      ok: true,
      command: `give "Bob the Builder" gunPistol 1 6`,
    },
  );
  // Names with a double quote could end the quoted argument early; they are refused.
  assertEquals(valid('Bob "x'), false);
  assertEquals(valid("Bob, the builder"), true);
});
