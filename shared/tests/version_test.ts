import { assertEquals } from "@std/assert";
import { compareVersions, isOutdatedVersion, parseVersion } from "../src/version.ts";

Deno.test("parseVersion accepts semver with optional v and suffixes", () => {
  assertEquals(parseVersion("1.2.3")?.patch, 3);
  assertEquals(parseVersion("v0.6.0")?.minor, 6);
  assertEquals(parseVersion("1.0.0-rc.1")?.prerelease, ["rc", "1"]);
  assertEquals(parseVersion("1.0.0+build.5")?.prerelease, []);
  assertEquals(parseVersion("dev"), null);
  assertEquals(parseVersion(""), null);
  assertEquals(parseVersion(null), null);
});

Deno.test("compareVersions orders numerically and by pre-release", () => {
  assertEquals(Math.sign(compareVersions("1.2.3", "1.10.0")!), -1);
  assertEquals(Math.sign(compareVersions("2.0.0", "1.99.99")!), 1);
  assertEquals(compareVersions("1.0.0", "v1.0.0"), 0);
  assertEquals(Math.sign(compareVersions("1.0.0-rc.1", "1.0.0")!), -1);
  assertEquals(Math.sign(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")!), -1);
  assertEquals(Math.sign(compareVersions("1.0.0-beta", "1.0.0-alpha")!), 1);
  assertEquals(compareVersions("dev", "1.0.0"), null);
});

Deno.test("isOutdatedVersion is strict and ignores unparseable versions", () => {
  assertEquals(isOutdatedVersion("0.5.0", "0.6.0"), true);
  assertEquals(isOutdatedVersion("0.6.0", "0.6.0"), false);
  assertEquals(isOutdatedVersion("0.7.0-dev", "0.6.0"), false); // newer than latest is fine
  assertEquals(isOutdatedVersion("dev", "0.6.0"), false);
  assertEquals(isOutdatedVersion(null, "0.6.0"), false);
  assertEquals(isOutdatedVersion("0.5.0", null), false);
});
