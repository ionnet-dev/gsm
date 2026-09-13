import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { resetLink, tokenHash } from "../src/modules/auth/password-reset.ts";
import { sha256Hex } from "../src/lib/ids.ts";

Deno.test("reset link carries the token in the fragment, not the query", () => {
  assertEquals(
    resetLink("abc_-123", "https://gsm.example.com"),
    "https://gsm.example.com/reset-password#abc_-123",
  );
  assertEquals(
    resetLink("abc", "https://gsm.example.com/"),
    "https://gsm.example.com/reset-password#abc",
  );
  const url = new URL(resetLink("abc", "https://gsm.example.com"));
  assertEquals(url.search, "");
  assertEquals(url.hash, "#abc");
});

Deno.test("reset token hash is stable, hex, and specific to the token", async () => {
  const a = await tokenHash("token-a");
  assertMatch(a, /^[0-9a-f]{64}$/);
  assertEquals(a, await tokenHash("token-a"));
  assertNotEquals(a, await tokenHash("token-b"));
  // Domain-separated, so it never equals a plain SHA-256 stored elsewhere.
  assert(a !== await sha256Hex("token-a"));
});
