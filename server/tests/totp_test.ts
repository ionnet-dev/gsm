import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { hotp, matchStep, otpauthUrl, stepAt, toBase32 } from "../src/modules/auth/totp.ts";
import {
  generateRecoveryCode,
  guessFactor,
  normalizeRecoveryCode,
  recoveryCodeHash,
} from "../src/modules/auth/two-factor.ts";
import { open, seal } from "../src/lib/secret-box.ts";

const rfcSecret = new TextEncoder().encode("12345678901234567890");

Deno.test("HOTP matches the RFC 4226 test vectors", async () => {
  const expected = [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ];
  for (let i = 0; i < expected.length; i++) assertEquals(await hotp(rfcSecret, i), expected[i]);
});

Deno.test("TOTP matches the RFC 6238 SHA-1 test vectors", async () => {
  const cases: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [t, code] of cases) assertEquals(await hotp(rfcSecret, stepAt(t * 1000), 8), code);
});

Deno.test("TOTP accepts one step of clock drift either side, no more", async () => {
  const now = 1_700_000_000_000;
  const step = stepAt(now);
  assertEquals(await matchStep(rfcSecret, await hotp(rfcSecret, step), now), step);
  assertEquals(await matchStep(rfcSecret, await hotp(rfcSecret, step - 1), now), step - 1);
  assertEquals(await matchStep(rfcSecret, await hotp(rfcSecret, step + 1), now), step + 1);
  assertEquals(await matchStep(rfcSecret, await hotp(rfcSecret, step - 2), now), null);
  assertEquals(await matchStep(rfcSecret, await hotp(rfcSecret, step + 2), now), null);
  assertEquals(await matchStep(rfcSecret, "12345", now), null);
  assertEquals(await matchStep(rfcSecret, "12345a", now), null);
});

Deno.test("otpauth URL is what authenticator apps expect", () => {
  assertEquals(toBase32(rfcSecret), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assertEquals(
    otpauthUrl("JBSWY3DPEHPK3PXP", "lucas@example.com", "Ionnet GSM"),
    "otpauth://totp/Ionnet%20GSM:lucas%40example.com?secret=JBSWY3DPEHPK3PXP" +
      "&issuer=Ionnet%20GSM&algorithm=SHA1&digits=6&period=30",
  );
});

Deno.test("recovery codes: format, uniqueness, normalizing and per-user hashing", async () => {
  const codes = Array.from({ length: 300 }, generateRecoveryCode);
  for (const c of codes) {
    assertMatch(c, /^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
  }
  assertEquals(new Set(codes).size, codes.length);
  assertEquals(normalizeRecoveryCode(" ABCD-efgh jkmn "), "abcdefghjkmn");
  assertEquals(
    await recoveryCodeHash(1, "abcd-efgh-jkmn"),
    await recoveryCodeHash(1, "ABCDEFGHJKMN"),
  );
  assertNotEquals(
    await recoveryCodeHash(1, "abcd-efgh-jkmn"),
    await recoveryCodeHash(2, "abcd-efgh-jkmn"),
  );
});

Deno.test("without an explicit method, the code's shape picks the factor", () => {
  assertEquals(guessFactor(["totp", "email"], "123 456"), "totp");
  assertEquals(guessFactor(["email"], "123456"), "email");
  assertEquals(guessFactor(["totp"], "abcd-efgh-jkmn"), "recovery");
});

Deno.test("secret box round-trips and refuses tampering or another context", async () => {
  const secret = crypto.getRandomValues(new Uint8Array(20));
  const sealed = await seal(secret, "totp:1");
  assertMatch(sealed, /^v1:/);
  assertNotEquals(sealed, await seal(secret, "totp:1")); // fresh IV every time
  assertEquals(await open(sealed, "totp:1"), secret);
  assertEquals(await open(sealed, "totp:2"), null);
  const flipped = sealed.slice(0, -2) + (sealed.at(-2) === "A" ? "B" : "A") + sealed.at(-1);
  assertEquals(await open(flipped, "totp:1"), null);
  assertEquals(await open("garbage", "totp:1"), null);
});
