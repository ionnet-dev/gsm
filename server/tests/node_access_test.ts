import { assertEquals } from "@std/assert";
import type { InstanceRole } from "@gsm/shared";
import { roleIn } from "../src/modules/instances/access.ts";
import { visibleTo } from "../src/ws/ui-gateway.ts";

const consoles = new Set<number>();
const admin = { admin: true, scope: null, nodes: null, consoles };
/** Owns node 1 (and so instance 10 on it as owner) and was given instance 20 as a viewer. */
const nodeOwner = {
  admin: false,
  scope: new Map<number, InstanceRole>([[10, "owner"], [20, "viewer"]]),
  nodes: new Set([1]),
  consoles,
};
const plainUser = {
  admin: false,
  scope: new Map<number, InstanceRole>([[20, "operator"]]),
  nodes: new Set<number>(),
  consoles,
};

Deno.test("node events reach admins and the node's owners only", () => {
  for (const event of ["node.metrics", "node.status", "node.updated", "image.pull"] as const) {
    assertEquals(visibleTo(admin, event, { nodeId: 1 }), true);
    assertEquals(visibleTo(nodeOwner, event, { nodeId: 1 }), true);
    assertEquals(visibleTo(nodeOwner, event, { nodeId: 2 }), false);
    assertEquals(visibleTo(plainUser, event, { nodeId: 1 }), false);
  }
});

Deno.test("instance events follow the instance scope, not the node", () => {
  const onNode1 = { instanceId: 10, nodeId: 1 };
  assertEquals(visibleTo(nodeOwner, "instance.status", onNode1), true);
  assertEquals(visibleTo(plainUser, "instance.status", onNode1), false);
  assertEquals(visibleTo(plainUser, "instance.status", { instanceId: 20 }), true);
  assertEquals(visibleTo(nodeOwner, "instance.console", { instanceId: 10 }), false);
});

Deno.test("template events are for admins", () => {
  assertEquals(visibleTo(admin, "template.updated", {}), true);
  assertEquals(visibleTo(nodeOwner, "template.updated", {}), false);
});

Deno.test("roleIn reads the role from the scope", () => {
  assertEquals(roleIn(null, 99), "owner");
  assertEquals(roleIn(nodeOwner.scope, 10), "owner");
  assertEquals(roleIn(nodeOwner.scope, 20), "viewer");
  assertEquals(roleIn(plainUser.scope, 10), null);
});
