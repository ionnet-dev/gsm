import { assertEquals } from "@std/assert";
import { roleAtLeast } from "../src/modules/auth/middleware.ts";

Deno.test("role hierarchy", () => {
  assertEquals(roleAtLeast("admin", "user"), true);
  assertEquals(roleAtLeast("user", "admin"), false);
  assertEquals(roleAtLeast("user", "user"), true);
});
