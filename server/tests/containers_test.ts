import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  containerPathProblem,
  DatabaseDumpBody,
  databaseEnabled,
  hostPathProblem,
  TemplateDefinition,
  UpdateInstanceBody,
} from "@gsm/shared";
import { buildSpec, newAgentFeature, volumeBackupIgnore } from "../src/modules/instances/spec.ts";
import { checkMounts } from "../src/modules/instances/mounts.ts";
import { normalizeDefinition } from "../src/modules/templates/normalize.ts";

/** A template for a prebuilt image: its own entrypoint and user, volumes, a database. */
const raw = {
  schemaVersion: 1,
  slug: "prebuilt",
  name: "Prebuilt",
  game: "Test",
  image: "ghcr.io/example/game:latest",
  install: { script: "echo 'The server ships in the image.'" },
  startup: "exec /opt/game/start.sh",
  variables: [{ name: "WITH_DB", label: "Database", type: "boolean", default: "true" }],
  ports: [{ name: "game", label: "Game", protocol: "udp", default: 27015, primary: true }],
  env: { DB_HOST: "{{GSM_DB_HOST}}", GAME_PORT: "{{GSM_PORT_GAME}}", KEEP: "{{NOT_A_VARIABLE}}" },
  volumes: [
    { name: "data", label: "Data", path: "/opt/game/data" },
    { name: "cache", label: "Cache", path: "/opt/game/cache", backup: false },
    { name: "maps", label: "Maps", path: "/opt/game/maps", seed: true },
  ],
  container: { entrypoint: [], user: { uid: 1000, gid: 1000 }, pull: "always" },
  database: { name: "game", enabledBy: "WITH_DB" },
};
const prebuilt = TemplateDefinition.parse(raw);
const instance = {
  uuid: "2a1b0c9d-8e7f-4a6b-9c5d-4e3f2a1b0c9d",
  name: "Prebuilt one",
  image: prebuilt.image,
  variables: { WITH_DB: "true" },
  limits: { memoryMb: 0, cpuCores: 0, diskMb: 0 },
  restartOnCrash: true,
  startupOverride: null,
};
const ports = [{ name: "game", protocol: "udp" as const, port: 30020 }];
const node = { bindAddress: "0.0.0.0" };

const refused = (patch: Record<string, unknown>) =>
  assert(!TemplateDefinition.safeParse({ ...raw, ...patch }).success, JSON.stringify(patch));

Deno.test("template container options, volumes and database fill in their defaults", () => {
  assertEquals(prebuilt.container.seccompUnconfined, false);
  assertEquals(prebuilt.volumes.map((v) => [v.name, v.seed, v.backup]), [
    ["data", false, true],
    ["cache", false, false],
    ["maps", true, true],
  ]);
  assertEquals(prebuilt.database, {
    engine: "mariadb",
    image: "mariadb:11.4",
    name: "game",
    memoryMb: 1024,
    enabledBy: "WITH_DB",
  });
  // Older templates have none of it.
  const plain = TemplateDefinition.parse({
    ...raw,
    env: undefined,
    volumes: undefined,
    container: undefined,
    database: undefined,
  });
  assertEquals(plain.container, {
    entrypoint: null,
    user: null,
    pull: "missing",
    seccompUnconfined: false,
  });
  assertEquals([plain.volumes, plain.env, plain.database], [[], {}, null]);
});

Deno.test("templates with unsafe volumes, env or database settings are refused", () => {
  refused({ volumes: [{ name: "x", label: "X", path: "/data/x" }] });
  refused({ volumes: [{ name: "x", label: "X", path: "relative" }] });
  refused({ volumes: [{ name: "x", label: "X", path: "/etc" }] });
  refused({ volumes: [{ name: "x", label: "X", path: "/proc/1" }] });
  refused({ volumes: [{ name: "Bad", label: "X", path: "/opt/x" }] });
  refused({
    volumes: [{ name: "a", label: "A", path: "/opt/x" }, { name: "a", label: "B", path: "/opt/y" }],
  });
  refused({
    volumes: [{ name: "a", label: "A", path: "/opt/x" }, { name: "b", label: "B", path: "/opt/x" }],
  });
  refused({ env: { GSM_PORT_GAME: "1" } });
  refused({ database: { name: "game", enabledBy: "MISSING" } });
  refused({ container: { user: { uid: 0, gid: 0 } } });
});

Deno.test("container and host paths", () => {
  for (const ok of ["/opt/game/data", "/home/steam/gmodserver/garrysmod/maps", "/srv/a-b_c.d"]) {
    assertEquals(containerPathProblem(ok), null, ok);
  }
  for (
    const bad of [
      "/",
      "/etc",
      "/usr",
      "/data",
      "/data/x",
      "/gsm",
      "/dev/shm",
      "/a/../b",
      "/a/",
      "/a:b",
      "a",
    ]
  ) {
    assert(containerPathProblem(bad), bad);
  }
  assertEquals(hostPathProblem("/srv/gsm/gamemodes"), null);
  for (const bad of ["/", "srv", "/srv/../etc", "/srv/a,b"]) assert(hostPathProblem(bad), bad);
});

Deno.test("buildSpec carries the container options, volumes and the database", () => {
  const spec = buildSpec(instance, prebuilt, node, ports, "ghcr.io/ionnet-dev");
  assertEquals(spec.image, "ghcr.io/example/game:latest");
  assertEquals(spec.user, { uid: 1000, gid: 1000 });
  assertEquals(spec.entrypoint, []);
  assertEquals(spec.pull, "always");
  assertEquals(spec.seccompUnconfined, false);
  assertEquals(spec.volumes, [
    { name: "data", path: "/opt/game/data", seed: false },
    { name: "cache", path: "/opt/game/cache", seed: false },
    { name: "maps", path: "/opt/game/maps", seed: true },
  ]);
  assertEquals(spec.mounts, []);
  assertEquals(spec.env.DB_HOST, "db");
  assertEquals(spec.env.GAME_PORT, "30020");
  assertEquals(spec.env.KEEP, "{{NOT_A_VARIABLE}}");
  assertEquals(spec.database?.name, "game");
  assertEquals(newAgentFeature(spec), "Volumes");
  assertEquals(volumeBackupIgnore(prebuilt), ["volumes/cache/**"]);

  const off = buildSpec(
    { ...instance, variables: { WITH_DB: "false" } },
    prebuilt,
    node,
    ports,
    "",
  );
  assertEquals(off.database, null);
  assertEquals(off.env.DB_HOST, "");
  assertEquals(databaseEnabled(prebuilt, { WITH_DB: "false" }), false);
  assertEquals(databaseEnabled(prebuilt, {}), true);
});

Deno.test("host mounts: only under the node's allowed roots, and they reach the spec", () => {
  const mounts = [{
    hostPath: "/srv/gsm/gamemodes/rp",
    containerPath: "/opt/game/gamemodes/rp",
    readOnly: true,
  }];
  const allowing = { name: "node-1", inventory: { hostMountRoots: ["/srv/gsm"] } } as never;
  const closed = { name: "node-1", inventory: { hostMountRoots: [] } } as never;
  const old = { name: "node-1", inventory: null } as never;
  assertEquals(checkMounts(allowing, mounts), mounts);
  assertEquals(checkMounts(closed, []), []);
  assertThrows(() => checkMounts(closed, mounts));
  assertThrows(() => checkMounts(old, mounts));
  assertThrows(() => checkMounts(allowing, [{ ...mounts[0], hostPath: "/srv/gsmx/a" }]));

  const spec = buildSpec({ ...instance, mounts }, prebuilt, node, ports, "");
  assertEquals(spec.mounts, mounts);
  assertEquals(newAgentFeature({ ...spec, volumes: [] }), "Host mounts");

  assert(UpdateInstanceBody.safeParse({ mounts }).success);
  assert(!UpdateInstanceBody.safeParse({ mounts: [...mounts, mounts[0]] }).success);
  assert(!UpdateInstanceBody.safeParse({ mounts: [{ ...mounts[0], hostPath: "srv" }] }).success);
  assert(
    !UpdateInstanceBody.safeParse({ mounts: [{ ...mounts[0], containerPath: "/data/x" }] }).success,
  );
});

Deno.test("a mount cannot take a volume's path; dumps are gzipped files", () => {
  const allowing = { name: "node-1", inventory: { hostMountRoots: ["/srv/gsm"] } } as never;
  const onVolume = [{ hostPath: "/srv/gsm/x", containerPath: "/opt/game/data", readOnly: false }];
  assertThrows(() => checkMounts(allowing, onVolume, prebuilt.volumes.map((v) => v.path)));
  assertEquals(checkMounts(allowing, onVolume), onVolume);
  assert(DatabaseDumpBody.safeParse({ path: "dumps/a.sql.gz" }).success);
  assert(DatabaseDumpBody.safeParse({}).success);
  assert(!DatabaseDumpBody.safeParse({ path: "dumps/a.sql" }).success);
});

Deno.test("console transports: telnet and rcon need a port, fifo an absolute pipe path", () => {
  const ok = (transport: unknown) =>
    TemplateDefinition.safeParse({ ...raw, console: { transport } }).success;
  assert(ok({ kind: "fifo", path: "/home/steam/console.in" }));
  assert(ok({ kind: "rcon", port: 27015 }));
  assert(!ok({ kind: "fifo" }));
  assert(!ok({ kind: "fifo", path: "console.in" }));
  assert(!ok({ kind: "telnet" }));
  const fifo = TemplateDefinition.parse({
    ...raw,
    console: { transport: { kind: "fifo", path: "/home/steam/console.in" } },
  });
  const spec = buildSpec(instance, fifo, node, ports, "");
  assertEquals(spec.console.transport, {
    kind: "fifo",
    port: 0,
    path: "/home/steam/console.in",
    password: "",
    ignore: null,
  });
});

Deno.test("definitions saved before volumes and container options existed read with defaults", () => {
  const stored = JSON.parse(
    Deno.readTextFileSync(new URL("../../templates/minecraft-vanilla.json", import.meta.url)),
  );
  for (const key of ["env", "volumes", "container", "database"]) delete stored[key];
  const def = normalizeDefinition(stored);
  assertEquals(def.container, {
    entrypoint: null,
    user: null,
    pull: "missing",
    seccompUnconfined: false,
  });
  assertEquals([def.volumes, def.env, def.database], [[], {}, null]);
  assert(normalizeDefinition(stored) === def, "read once per stored object");
  // One the schema refuses now is still usable rather than breaking its instances.
  const kept = normalizeDefinition({ ...stored, icon: "far too long for an icon" });
  assertEquals(kept.slug, "minecraft-vanilla");
  assertEquals(kept.volumes, []);
  assertEquals(kept.container.pull, "missing");
});
