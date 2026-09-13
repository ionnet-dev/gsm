import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import { tooManyRequests } from "../../lib/errors.ts";
import { clientIp, idParam, parseBody, parseQuery } from "../../lib/http.ts";
import { createRateLimiter } from "../../lib/rate-limit.ts";
import { z } from "zod";
import { agentGateway } from "../../ws/agent-gateway.ts";
import { uiGateway } from "../../ws/ui-gateway.ts";
import { log } from "../../lib/logger.ts";
import { auditFrom } from "../audit/service.ts";
import { currentUser, requireAuth, requireRole } from "../auth/middleware.ts";
import { assertNodeAccess, nodeScope } from "./access.ts";
import {
  CreateEnrollmentTokenBody,
  EnrollBody,
  GrantNodeAccessBody,
  ListNodesQuery,
  UpdateNodeBody,
} from "./schemas.ts";
import * as nodes from "./service.ts";

// ---- agent-facing (no session, no CSRF) ----
export const agentRoutes = new Hono<AppEnv>();
const enrollLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 30 });

agentRoutes.post("/enroll", async (c) => {
  const ip = clientIp(c) ?? "unknown";
  const limit = enrollLimiter.check(ip);
  if (!limit.ok) throw tooManyRequests("Too many enrollment attempts");
  const body = await parseBody(c, EnrollBody);
  return c.json(await nodes.enroll(body, ip), 201);
});

// ---- nodes: admins manage every node, users the nodes an admin made them owner of ----
export const nodeRoutes = new Hono<AppEnv>();
nodeRoutes.use("*", requireAuth);

nodeRoutes.get(
  "/",
  async (c) => c.json(await nodes.list(parseQuery(c, ListNodesQuery), await nodeScope(c))),
);
nodeRoutes.get("/all", async (c) => c.json({ items: await nodes.all(await nodeScope(c)) }));
nodeRoutes.get("/summary", async (c) => c.json(await nodes.summary(await nodeScope(c))));

nodeRoutes.get("/:id", async (c) => {
  const id = idParam(c);
  await assertNodeAccess(c, id);
  const n = await nodes.get(id);
  return c.json({ node: await nodes.nodeDetailDto(n), connected: agentGateway.isConnected(n.id) });
});

nodeRoutes.patch("/:id", async (c) => {
  const id = idParam(c);
  await assertNodeAccess(c, id);
  const body = await parseBody(c, UpdateNodeBody);
  const n = await nodes.update(id, body);
  await auditFrom(c, "node.update", { type: "node", id }, body);
  return c.json({ node: await nodes.nodeDetailDto(n) });
});

nodeRoutes.delete("/:id", requireRole("admin"), async (c) => {
  const id = idParam(c);
  const n = await nodes.get(id);
  await nodes.remove(id);
  agentGateway.disconnect(id, "node deleted");
  await auditFrom(c, "node.delete", { type: "node", id }, { name: n.name });
  return c.json({ ok: true });
});

nodeRoutes.post("/:id/ping", async (c) => {
  const id = idParam(c);
  await assertNodeAccess(c, id);
  const started = performance.now();
  const result = await agentGateway.request(id, "agent.ping", {});
  return c.json({ ...result, rttMs: Math.round(performance.now() - started) });
});

nodeRoutes.post("/:id/refresh", async (c) => {
  const id = idParam(c);
  await assertNodeAccess(c, id);
  const inventory = await agentGateway.request(id, "sys.inventory", {});
  const n = await nodes.get(id);
  n.applyInventory(inventory);
  await n.save();
  return c.json({ node: await nodes.nodeDetailDto(n) });
});

// ---- images on a node ----
const ilog = log.child("images");

nodeRoutes.get("/:id/images", async (c) => {
  const id = idParam(c);
  await assertNodeAccess(c, id);
  return c.json(await agentGateway.request(id, "image.list", {}));
});

/** Pull in the background; progress and the outcome arrive as `image.pull` events. */
nodeRoutes.post("/:id/images/pull", async (c) => {
  const id = idParam(c);
  await assertNodeAccess(c, id);
  const { ref } = await parseBody(c, z.object({ ref: z.string().min(1).max(300) }));
  if (!agentGateway.isConnected(id)) {
    return c.json({ error: { code: "unavailable", message: "The node is not connected" } }, 409);
  }
  await auditFrom(c, "node.image_pull", { type: "node", id }, { ref });
  let last = 0;
  agentGateway.request(id, "image.pull", { ref }, {
    timeoutMs: 60 * 60_000,
    onStream: (progress) => {
      const now = Date.now();
      if (now - last < 500) return;
      last = now;
      uiGateway.broadcast("image.pull", { nodeId: id, ref, done: false, error: null, progress });
    },
  }).then(() => {
    uiGateway.broadcast("image.pull", { nodeId: id, ref, done: true, error: null, progress: null });
  }).catch((err) => {
    ilog.warn("image pull failed", { nodeId: id, ref, err: String(err) });
    uiGateway.broadcast("image.pull", {
      nodeId: id,
      ref,
      done: true,
      error: err instanceof Error ? err.message : String(err),
      progress: null,
    });
  });
  return c.json({ ok: true }, 202);
});

nodeRoutes.delete("/:id/images", async (c) => {
  const id = idParam(c);
  await assertNodeAccess(c, id);
  const ref = c.req.query("ref");
  if (!ref) return c.json({ error: { code: "bad_request", message: "ref is required" } }, 400);
  await agentGateway.request(id, "image.remove", { ref }, { timeoutMs: 120_000 });
  await auditFrom(c, "node.image_remove", { type: "node", id }, { ref });
  return c.json({ ok: true });
});

// ---- owners: anyone who manages the node sees them, only admins change them ----
nodeRoutes.get("/:id/access", async (c) => {
  const id = idParam(c);
  await assertNodeAccess(c, id);
  return c.json({ items: await nodes.listAccess(id) });
});

nodeRoutes.put("/:id/access", requireRole("admin"), async (c) => {
  const id = idParam(c);
  const body = await parseBody(c, GrantNodeAccessBody);
  const items = await nodes.grant(id, body.userId, currentUser(c).id);
  await auditFrom(c, "node.access_grant", { type: "node", id }, body);
  return c.json({ items });
});

nodeRoutes.delete("/:id/access/:userId", requireRole("admin"), async (c) => {
  const id = idParam(c);
  const userId = idParam(c, "userId");
  const items = await nodes.revoke(id, userId);
  await auditFrom(c, "node.access_revoke", { type: "node", id }, { userId });
  return c.json({ items });
});

// ---- enrollment tokens (admin) ----
export const enrollmentRoutes = new Hono<AppEnv>();
enrollmentRoutes.use("*", requireRole("admin"));
enrollmentRoutes.get("/", async (c) => c.json({ items: await nodes.listEnrollmentTokens() }));
enrollmentRoutes.post("/", async (c) => {
  const body = await parseBody(c, CreateEnrollmentTokenBody);
  const { token, plaintext } = await nodes.createEnrollmentToken(body, currentUser(c).id);
  await auditFrom(c, "enrollment_token.create", { type: "enrollment_token", id: token.id }, {
    name: token.name,
  });
  return c.json({ token, plaintext }, 201);
});
enrollmentRoutes.post("/:id/revoke", async (c) => {
  const id = idParam(c);
  await nodes.revokeEnrollmentToken(id);
  await auditFrom(c, "enrollment_token.revoke", { type: "enrollment_token", id });
  return c.json({ ok: true });
});
