import { assertEquals, assertThrows } from "@std/assert";
import {
  decodeEnvelope,
  encodeEnvelope,
  type Envelope,
  Hello,
  InstanceSpec,
  PROTOCOL_VERSION,
  TemplateDefinition,
} from "../src/mod.ts";

Deno.test("envelope round-trips every variant", () => {
  const variants: Envelope[] = [
    { t: "req", id: "1", method: "agent.ping", params: {} },
    { t: "res", id: "1", ok: true, result: { at: new Date().toISOString(), agentVersion: "x" } },
    { t: "res", id: "1", ok: false, error: { code: "timeout", message: "late" } },
    { t: "stream", id: "1", seq: 0, chunk: { lines: [] } },
    { t: "stream", id: "1", seq: 1, chunk: null, done: true },
    { t: "event", event: "metrics", data: { cpuPct: 1 } },
  ];
  for (const v of variants) assertEquals(decodeEnvelope(encodeEnvelope(v)), v);
});

Deno.test("malformed envelopes are rejected", () => {
  assertThrows(() => decodeEnvelope(JSON.stringify({ t: "nope" })));
  assertThrows(() => decodeEnvelope(JSON.stringify({ t: "req", id: "", method: "x" })));
});

Deno.test("the hello fixture parses", () => {
  const hello = JSON.parse(
    Deno.readTextFileSync(new URL("../fixtures/hello.json", import.meta.url)),
  );
  assertEquals(Hello.parse(hello).protocolVersion, PROTOCOL_VERSION);
});

Deno.test("the instance spec fixture parses", () => {
  const spec = JSON.parse(
    Deno.readTextFileSync(new URL("../fixtures/instance-spec.json", import.meta.url)),
  );
  assertEquals(InstanceSpec.parse(spec).uuid, spec.uuid);
});

Deno.test("built-in templates parse", () => {
  const dir = new URL("../../templates/", import.meta.url);
  let count = 0;
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.name.endsWith(".json")) continue;
    const def = TemplateDefinition.parse(
      JSON.parse(Deno.readTextFileSync(new URL(entry.name, dir))),
    );
    assertEquals(def.slug, entry.name.replace(/\.json$/, ""));
    count++;
  }
  assertEquals(count > 0, true);
});
