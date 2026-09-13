import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import {
  codeHash,
  generateCode,
  maskEmail,
  normalizeCode,
} from "../src/modules/auth/two-factor.ts";

Deno.test("codes are six zero-padded digits", () => {
  for (let i = 0; i < 500; i++) assertMatch(generateCode(), /^\d{6}$/);
  assertMatch(generateCode(8), /^\d{8}$/);
});

Deno.test("codes are not constant", () => {
  const seen = new Set(Array.from({ length: 50 }, () => generateCode()));
  assert(seen.size > 40);
});

Deno.test("normalizeCode strips separators users type", () => {
  assertEquals(normalizeCode("123 456"), "123456");
  assertEquals(normalizeCode("123-456"), "123456");
  assertEquals(normalizeCode(" 123456\n"), "123456");
});

Deno.test("code hash is bound to the challenge id", async () => {
  const a = await codeHash("chal-a", "123456");
  const b = await codeHash("chal-b", "123456");
  const c = await codeHash("chal-a", "123457");
  assertNotEquals(a, b);
  assertNotEquals(a, c);
  assertEquals(a, await codeHash("chal-a", "123456"));
  assertEquals(a.length, 64);
});

Deno.test("maskEmail hides most of the local part", () => {
  assertEquals(maskEmail("lucas@example.com"), "lu***@example.com");
  assertEquals(maskEmail("a@example.com"), "a***@example.com");
  assertEquals(maskEmail("nonsense"), "***");
});
