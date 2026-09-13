import { assertEquals } from "@std/assert";
import {
  forgeOptions,
  neoforgeOptions,
  neoforgePrefix,
  parseMavenVersions,
} from "../src/modules/templates/versions.ts";

const FORGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>net.minecraftforge</groupId>
  <artifactId>forge</artifactId>
  <versioning>
    <versions>
      <version>1.12.2-14.23.5.2859</version>
      <version>1.20.1-47.2.0</version>
      <version>1.20.1-47.3.0</version>
      <version>1.20.1-47.3.12</version>
      <version>1.21.1-52.0.1</version>
    </versions>
  </versioning>
</metadata>`;

const NEO_XML = `<metadata><versioning><versions>
<version>20.2.86</version>
<version>21.1.70</version>
<version>21.1.72</version>
<version>21.1.73-beta</version>
<version>21.0.167</version>
</versions></versioning></metadata>`;

Deno.test("parseMavenVersions reads every version element", () => {
  assertEquals(parseMavenVersions(FORGE_XML).length, 5);
  assertEquals(parseMavenVersions(NEO_XML)[0], "20.2.86");
});

Deno.test("forgeOptions filters by game version, newest first, and flags promotions", () => {
  const out = forgeOptions(
    parseMavenVersions(FORGE_XML),
    { "1.20.1-recommended": "47.3.0", "1.20.1-latest": "47.3.12" },
    "1.20.1",
  );
  assertEquals(out.map((o) => o.id), ["47.3.12", "47.3.0", "47.2.0"]);
  assertEquals(out.map((o) => o.kind), ["latest", "recommended", "release"]);
  assertEquals(forgeOptions(parseMavenVersions(FORGE_XML), {}, "1.19"), []);
});

Deno.test("neoforgePrefix maps Minecraft versions to NeoForge prefixes", () => {
  assertEquals(neoforgePrefix("1.21.1"), "21.1");
  assertEquals(neoforgePrefix("1.21"), "21.0");
  assertEquals(neoforgePrefix("1.20.2"), "20.2");
  assertEquals(neoforgePrefix("24w14a"), null);
});

Deno.test("neoforgeOptions filters by the prefix, newest first", () => {
  const out = neoforgeOptions(parseMavenVersions(NEO_XML), "1.21.1");
  assertEquals(out.map((o) => o.id), ["21.1.73-beta", "21.1.72", "21.1.70"]);
  assertEquals(out[0].kind, "beta");
  assertEquals(neoforgeOptions(parseMavenVersions(NEO_XML), "1.21").map((o) => o.id), ["21.0.167"]);
});
