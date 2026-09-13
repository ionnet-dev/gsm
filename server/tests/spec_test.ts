import { assertEquals } from "@std/assert";
import { TemplateDefinition } from "@gsm/shared";
import { buildEnv, buildInstall, buildSpec, qualifyImage } from "../src/modules/instances/spec.ts";

const def = TemplateDefinition.parse(
  JSON.parse(
    Deno.readTextFileSync(new URL("../../templates/minecraft-vanilla.json", import.meta.url)),
  ),
);

const instance = {
  uuid: "6f1c2a1e-9b7d-4c1a-8a0e-3d2b1c0f9e8d",
  name: "Survival",
  image: "gsm-java:21",
  variables: {
    MC_VERSION: "1.21.1",
    EULA: "true",
    MOTD: "Hi there",
    MAX_PLAYERS: "10",
    JVM_FLAGS: "-XX:+UseG1GC",
  },
  limits: { memoryMb: 4096, cpuCores: 0, diskMb: 0 },
  restartOnCrash: true,
  startupOverride: null,
};
const ports = [{ name: "game", protocol: "tcp" as const, port: 30000 }];

Deno.test("qualifyImage prefixes bare refs only", () => {
  assertEquals(qualifyImage("gsm-java:21", "ghcr.io/ionnet-dev"), "ghcr.io/ionnet-dev/gsm-java:21");
  assertEquals(qualifyImage("ghcr.io/x/y:1", "ghcr.io/ionnet-dev"), "ghcr.io/x/y:1");
  assertEquals(qualifyImage("library/debian", "ghcr.io/ionnet-dev"), "library/debian");
  assertEquals(qualifyImage("gsm-base", ""), "gsm-base");
});

Deno.test("buildEnv adds the platform facts", () => {
  const env = buildEnv(instance, ports);
  assertEquals(env.GSM_PORT_GAME, "30000");
  assertEquals(env.GSM_MEMORY_MB, "4096");
  assertEquals(env.GSM_HEAP_MB, "3482");
  assertEquals(env.GSM_INSTANCE_NAME, "Survival");
  assertEquals(env.MOTD, "Hi there");
});

Deno.test("buildSpec substitutes variables into the startup and config files", () => {
  const spec = buildSpec(instance, def, { bindAddress: "0.0.0.0" }, ports, "ghcr.io/ionnet-dev");
  assertEquals(spec.image, "ghcr.io/ionnet-dev/gsm-java:21");
  assertEquals(spec.startup, "java -Xms256M -Xmx3482M -XX:+UseG1GC -jar server.jar nogui");
  assertEquals(spec.ports, [{ name: "game", protocol: "tcp", host: 30000, container: 30000 }]);
  const props = spec.files.find((f) => f.path === "server.properties")!;
  assertEquals(props.values["server-port"], "30000");
  assertEquals(props.values["motd"], "Hi there");
  assertEquals(props.values["max-players"], "10");
  assertEquals(spec.files.find((f) => f.path === "eula.txt")!.values.eula, "true");
  assertEquals(spec.user, { uid: 1500, gid: 1500 });
  assertEquals(spec.stop.command, "stop");
});

Deno.test("buildSpec expands both-protocol ports and honours the override", () => {
  const spec = buildSpec(
    { ...instance, startupOverride: "echo {{GSM_PORT_GAME}}" },
    def,
    { bindAddress: "10.0.0.1" },
    [{ name: "game", protocol: "both", port: 31000 }],
    "",
  );
  assertEquals(spec.startup, "echo 31000");
  assertEquals(spec.ports.map((p) => p.protocol), ["tcp", "udp"]);
  assertEquals(spec.bindAddress, "10.0.0.1");
});

Deno.test("buildInstall carries the resolved environment", () => {
  const inst = buildInstall(def, { SERVER_JAR_URL: "https://x/server.jar" }, "ghcr.io/ionnet-dev");
  assertEquals(inst.image, null);
  assertEquals(inst.env.SERVER_JAR_URL, "https://x/server.jar");
  assertEquals(inst.timeoutSeconds, 1800);
});
