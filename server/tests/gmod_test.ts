import { assert, assertEquals } from "@std/assert";
import { TemplateDefinition } from "@gsm/shared";
import { buildActionCommand, compileMatcher, nameValidator } from "../src/modules/players/parse.ts";
import { buildSpec, newAgentFeature } from "../src/modules/instances/spec.ts";

const gmod = TemplateDefinition.parse(
  JSON.parse(Deno.readTextFileSync(new URL("../../templates/garrys-mod.json", import.meta.url))),
);
const defaults = Object.fromEntries(gmod.variables.map((v) => [v.name, v.default]));
const instance = {
  uuid: "5d2c3b4a-1e0f-4a9b-8c7d-6e5f4a3b2c1d",
  name: "Sandbox",
  image: gmod.image,
  variables: defaults,
  limits: { memoryMb: 4096, cpuCores: 0, diskMb: 0 },
  restartOnCrash: true,
  startupOverride: null,
};
const ports = [{ name: "game", protocol: "udp" as const, port: 30015 }];
const node = { bindAddress: "0.0.0.0" };

Deno.test("Garry's Mod: srcds runs under script on the instance's port", () => {
  const spec = buildSpec(instance, gmod, node, ports, "");
  // script gives srcds a terminal: without one it holds its output back in big blocks.
  assert(spec.startup.includes(`exec script -qfec "$BIN $* $EXTRA_ARGS" /dev/null`));
  assert(spec.startup.includes(`-port "$GSM_PORT_GAME"`));
  assertEquals(spec.env.GSM_PORT_GAME, "30015");
  assertEquals(spec.ports, [{ name: "game", protocol: "udp", host: 30015, container: 30015 }]);
  assertEquals(spec.stop.command, "quit");
  assertEquals(spec.user, { uid: 1500, gid: 1500 });
  assertEquals(spec.database, null);
  assertEquals(newAgentFeature(spec), "Source .cfg config files");
  const ready = new RegExp(spec.console.readyPattern!);
  assert(ready.test("VAC secure mode is activated."));
  assert(ready.test("Could not establish connection to Steam servers."));
});

Deno.test("Garry's Mod: server.cfg and the database file follow the variables", () => {
  const off = buildSpec(
    { ...instance, variables: { ...defaults, HOSTNAME: "Build & fight", SERVER_PASSWORD: "s3" } },
    gmod,
    node,
    ports,
    "",
  );
  const cfg = off.files.find((f) => f.path === "server/garrysmod/cfg/server.cfg")!;
  assertEquals(cfg.format, "source-cfg");
  assertEquals(cfg.values.hostname, "Build & fight");
  assertEquals(cfg.values.sv_password, "s3");
  // Join and leave lines only come with logging on.
  assertEquals(cfg.values.log, "on");
  assertEquals(cfg.values.sv_logecho, "1");
  const dbFile = () => off.files.find((f) => f.path === "server/garrysmod/data/gsm/database.json")!;
  assertEquals(dbFile().values.host, "");
  assertEquals(off.env.GSM_DB_PASSWORD, "");

  const on = buildSpec(
    { ...instance, variables: { ...defaults, DATABASE: "true" } },
    gmod,
    node,
    ports,
    "",
  );
  assertEquals(on.database?.image, "mariadb:11.4");
  assertEquals(on.database?.name, "gmod");
  assertEquals(on.database?.user, "gmod");
  assertEquals(on.database!.password.length, 32);
  assert(on.database!.password !== on.database!.rootPassword);
  assertEquals(on.env.GSM_DB_HOST, "db");
  assertEquals(on.env.GSM_DB_PORT, "3306");
  assertEquals(on.env.GSM_DB_PASSWORD, on.database!.password);
  const values = on.files.find((f) => f.path.endsWith("database.json"))!.values;
  assertEquals(values, {
    host: "db",
    port: "3306",
    database: "gmod",
    user: "gmod",
    password: on.database!.password,
  });
  assertEquals(newAgentFeature(on), "A database");
});

Deno.test("Garry's Mod: players come from the log lines and the status answer", () => {
  const m = compileMatcher(gmod.players!);
  assertEquals(
    m.match(`L 09/14/2026 - 09:37:36: "Lucas<2><STEAM_0:1:1234><>" entered the game`),
    { type: "join", name: "Lucas", id: "STEAM_0:1:1234" },
  );
  assertEquals(
    m.match(
      `L 09/14/2026 - 09:40:02: "Lucas<2><STEAM_0:1:1234><>" disconnected (reason "Disconnect by user.")`,
    ),
    { type: "leave", name: "Lucas" },
  );
  // Bots are not players, and chat always ends in a quote so it cannot pass for a join.
  assertEquals(m.match(`L 09/14/2026 - 09:37:36: "Bot01<3><BOT><>" entered the game`), null);
  assertEquals(
    m.match(
      `L 09/14/2026 - 09:38:00: "Lucas<2><STEAM_0:1:1234><>" say "x<5><STEAM_0:0:9><>" entered the game"`,
    ),
    null,
  );
  // The list command is `status;echo ---- end of status`: rows first, then the marker.
  for (
    const line of [
      "hostname: My Garry's Mod server",
      "players : 1 humans, 1 bots (16 max)",
      "# userid name                uniqueid            connected ping loss state  adr",
      `#      2 "Lucas"             STEAM_0:1:1234      00:41       45    0 active 10.0.0.5:27005`,
      `#      3 "Bot01"             BOT                                     active`,
    ]
  ) {
    assertEquals(m.match(line), null);
  }
  assertEquals(m.match("---- end of status "), {
    type: "list",
    players: [{ name: "Lucas", id: "STEAM_0:1:1234" }],
  });
});

Deno.test("Garry's Mod: kick and ban go by the quoted SteamID", () => {
  const m = { validName: nameValidator(gmod.players!.namePattern) };
  const actions = Object.fromEntries(gmod.players!.actions.map((a) => [a.id, a]));
  const lucas = { name: "Lucas", id: "STEAM_0:1:1234" };
  assertEquals(buildActionCommand(actions.kick, lucas, { REASON: "be nice" }, m.validName), {
    ok: true,
    command: `kickid "STEAM_0:1:1234" "be nice"`,
  });
  assertEquals(buildActionCommand(actions.kick, lucas, {}, m.validName), {
    ok: true,
    command: `kickid "STEAM_0:1:1234"`,
  });
  assertEquals(buildActionCommand(actions.ban, lucas, { MINUTES: "60" }, m.validName), {
    ok: true,
    command: `banid 60 "STEAM_0:1:1234" kick; writeid`,
  });
  assertEquals(buildActionCommand(actions.unban, lucas, {}, m.validName), {
    ok: true,
    command: `removeid "STEAM_0:1:1234"; writeid`,
  });
});
