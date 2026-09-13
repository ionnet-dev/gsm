import { assert, assertEquals } from "@std/assert";
import { createRateLimiter } from "../src/lib/rate-limit.ts";

Deno.test("rate limiter blocks after max within window", () => {
  const rl = createRateLimiter({ windowMs: 60_000, max: 2 });
  assertEquals(rl.check("a").ok, true);
  assertEquals(rl.check("a").ok, true);
  const third = rl.check("a");
  assertEquals(third.ok, false);
  assertEquals(third.retryAfterSeconds > 0, true);
  assertEquals(rl.check("b").ok, true);
  rl.reset("a");
  assertEquals(rl.check("a").ok, true);
});

Deno.test("retryAfter reports a key at its limit without counting a hit", () => {
  const rl = createRateLimiter({ windowMs: 60_000, max: 2 });
  rl.check("a");
  assertEquals(rl.retryAfter("a"), 0);
  rl.check("a");
  assert(rl.retryAfter("a") > 0);
  assert(rl.retryAfter("a") > 0); // peeking does not count
  assertEquals(rl.check("a").ok, false);
  assertEquals(rl.retryAfter("b"), 0);
  rl.reset("a");
  assertEquals(rl.retryAfter("a"), 0);
});
