import { assertEquals } from "@std/assert";
import { POWER_ALLOWED, roleAllows, TemplateDefinition, validateVariable } from "@gsm/shared";
import { mergeVariables } from "../src/modules/instances/service.ts";

Deno.test("roleAllows follows the permission table", () => {
  assertEquals(roleAllows("viewer", "console"), true);
  assertEquals(roleAllows("viewer", "command"), false);
  assertEquals(roleAllows("operator", "files"), true);
  assertEquals(roleAllows("operator", "access"), false);
  assertEquals(roleAllows("owner", "delete"), true);
  assertEquals(roleAllows(null, "view"), false);
});

Deno.test("power actions are limited by status", () => {
  assertEquals(POWER_ALLOWED.start.includes("running"), false);
  assertEquals(POWER_ALLOWED.stop.includes("running"), true);
});

const def = TemplateDefinition.parse({
  schemaVersion: 1,
  slug: "test-template",
  name: "T",
  game: "G",
  image: "gsm-base",
  install: { script: "true" },
  startup: "run",
  variables: [
    { name: "PUBLIC", label: "Public", type: "number", default: "5", min: 1, max: 10 },
    { name: "SECRET", label: "Secret", type: "text", default: "x", editable: false },
    { name: "NEEDED", label: "Needed", type: "text", required: true },
  ],
});

Deno.test("mergeVariables fills defaults, validates and enforces editability", () => {
  const out = mergeVariables(def, null, { NEEDED: "y" }, "owner");
  assertEquals(out, { PUBLIC: "5", SECRET: "x", NEEDED: "y" });
  let threw = "";
  try {
    mergeVariables(def, out, { PUBLIC: "50" }, "operator");
  } catch (e) {
    threw = (e as { details?: Record<string, string> }).details?.PUBLIC ?? "";
  }
  assertEquals(threw, "Must be at most 10");
  let forbidden = false;
  try {
    mergeVariables(def, out, { SECRET: "changed" }, "operator");
  } catch (e) {
    forbidden = (e as { status?: number }).status === 403;
  }
  assertEquals(forbidden, true);
  assertEquals(mergeVariables(def, out, { SECRET: "changed" }, "owner").SECRET, "changed");
  assertEquals(validateVariable(def.variables[2], ""), "Required");
});
