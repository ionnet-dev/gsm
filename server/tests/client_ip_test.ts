import { assertEquals } from "@std/assert";
import { ipFromForwardedFor } from "../src/lib/http.ts";

Deno.test("X-Forwarded-For: only the proxy-appended last hop is used", () => {
  assertEquals(ipFromForwardedFor("1.2.3.4", true), "1.2.3.4");
  // A client sending its own header gets it prepended by the proxy; the spoofed part is ignored.
  assertEquals(ipFromForwardedFor("9.9.9.9, 1.2.3.4", true), "1.2.3.4");
  assertEquals(ipFromForwardedFor("9.9.9.9,8.8.8.8 , 1.2.3.4 ", true), "1.2.3.4");
  assertEquals(ipFromForwardedFor("", true), null);
  assertEquals(ipFromForwardedFor(undefined, true), null);
});

Deno.test("X-Forwarded-For is ignored entirely when the proxy is not trusted", () => {
  assertEquals(ipFromForwardedFor("1.2.3.4", false), null);
});

Deno.test("X-Forwarded-For values are length-capped", () => {
  assertEquals(ipFromForwardedFor("x".repeat(100), true)?.length, 45);
});
