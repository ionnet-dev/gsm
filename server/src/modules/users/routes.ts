import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import { idParam, parseBody } from "../../lib/http.ts";
import { auditFrom } from "../audit/service.ts";
import { currentUser, requireAuth, requireRole } from "../auth/middleware.ts";
import { CreateUserBody, ResetPasswordBody, UpdateUserBody } from "./schemas.ts";
import * as users from "./service.ts";

export const userRoutes = new Hono<AppEnv>();

/** Any signed-in user may look names up, to share an instance with someone. */
userRoutes.get("/directory", requireAuth, async (c) => c.json({ items: await users.directory() }));

userRoutes.use("*", requireRole("admin"));

userRoutes.get("/", async (c) => c.json({ items: await users.list() }));

userRoutes.post("/", async (c) => {
  const body = await parseBody(c, CreateUserBody);
  const user = await users.create(body);
  await auditFrom(c, "user.create", { type: "user", id: user.id }, {
    email: user.email,
    role: user.role,
  });
  return c.json({ user: user.toPublic() }, 201);
});

userRoutes.patch("/:id", async (c) => {
  const id = idParam(c);
  const body = await parseBody(c, UpdateUserBody);
  const user = await users.update(id, body, currentUser(c).id);
  await auditFrom(c, "user.update", { type: "user", id }, body);
  return c.json({ user: user.toPublic() });
});

userRoutes.delete("/:id", async (c) => {
  const id = idParam(c);
  await users.remove(id, currentUser(c).id);
  await auditFrom(c, "user.delete", { type: "user", id });
  return c.json({ ok: true });
});

userRoutes.post("/:id/password", async (c) => {
  const id = idParam(c);
  const body = await parseBody(c, ResetPasswordBody);
  await users.resetPassword(id, body.password);
  await auditFrom(c, "user.password_reset", { type: "user", id });
  return c.json({ ok: true });
});
