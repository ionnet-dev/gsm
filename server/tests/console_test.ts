import { assertEquals } from "@std/assert";
import { consoleHistory, RingBuffer } from "../src/modules/instances/console.ts";

Deno.test("RingBuffer keeps the newest items in order", () => {
  const b = new RingBuffer<number>(3);
  b.push(1);
  b.push(2);
  assertEquals(b.toArray(), [1, 2]);
  b.push(3);
  b.push(4);
  b.push(5);
  assertEquals(b.toArray(), [3, 4, 5]);
  assertEquals(b.length, 3);
});

Deno.test("consoleHistory tails per instance and stream", () => {
  consoleHistory.setCapacity(4);
  consoleHistory.append(7, "console", [1, 2, 3, 4, 5].map((n) => ({ at: n, text: `l${n}` })));
  consoleHistory.append(7, "install", [{ at: 1, text: "installing" }]);
  assertEquals(consoleHistory.tail(7, "console", 2).map((l) => l.text), ["l4", "l5"]);
  assertEquals(consoleHistory.tail(7, "console", 10).length, 4);
  assertEquals(consoleHistory.tail(7, "install", 10).map((l) => l.text), ["installing"]);
  consoleHistory.clear(7, "install");
  assertEquals(consoleHistory.tail(7, "install", 10), []);
  assertEquals(consoleHistory.tail(7, "console", 10).length, 4);
  consoleHistory.clear(7);
  assertEquals(consoleHistory.tail(7, "console", 10), []);
});
