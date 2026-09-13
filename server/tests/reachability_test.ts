import dgram from "node:dgram";
import { assert, assertEquals } from "@std/assert";
import { classify, tcpCheck, udpSend } from "../src/modules/reachability/net.ts";

Deno.test("tcpCheck tells open from refused and reads the first line", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const serving = (async () => {
    for await (const conn of listener) {
      await conn.write(new TextEncoder().encode("SSH-2.0-GSM\r\nmore\r\n"));
      conn.close();
    }
  })().catch(() => {});

  assertEquals(await tcpCheck("127.0.0.1", port), { status: "open", detail: null });
  const greeting = await tcpCheck("127.0.0.1", port, { readLine: true });
  assertEquals(greeting.line, "SSH-2.0-GSM");

  listener.close();
  await serving;
  const refused = await tcpCheck("127.0.0.1", port);
  assertEquals(refused.status, "closed");
  assert(refused.detail?.startsWith("Connection refused"));
});

Deno.test("classify explains connect errors", () => {
  assertEquals(classify(new Deno.errors.TimedOut()).status, "timeout");
  assertEquals(classify(new Deno.errors.ConnectionRefused()).status, "closed");
  const dns = classify(
    new Error("failed to lookup address information: Name or service not known"),
  );
  assertEquals(dns.status, "error");
  assert(dns.detail?.startsWith("The address does not resolve"));
});

Deno.test("udpSend delivers the token as datagrams", async () => {
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
  const got = new Promise<string>((resolve) =>
    socket.once("message", (msg) => resolve(msg.toString()))
  );
  await udpSend("127.0.0.1", socket.address().port, "GSM-PROBE token", 1);
  assertEquals(await got, "GSM-PROBE token");
  await new Promise<void>((resolve) => socket.close(() => resolve()));
});
