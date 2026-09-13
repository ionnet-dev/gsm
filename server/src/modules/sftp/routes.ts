/**
 * SFTP details and the requester's password per instance (`files` permission), mounted under
 * /instances/:id/sftp, and the requester's SSH keys under /ssh-keys.
 */
import { Hono } from "hono";
import { AddSshKeyBody } from "@gsm/shared";
import type { AppEnv } from "../../app.ts";
import { forbidden } from "../../lib/errors.ts";
import { idParam, parseBody } from "../../lib/http.ts";
import { auditFrom } from "../audit/service.ts";
import { currentUser, requireAuth } from "../auth/middleware.ts";
import { assertInstancePermission } from "../instances/access.ts";
import * as sftp from "./service.ts";

type Ctx = Parameters<typeof auditFrom>[0];

/** Credentials are made from a browser session, like API tokens. */
function assertBrowser(c: Ctx) {
  if (c.get("apiToken")) throw forbidden("Not available with an API token; use a browser session");
}

// ---- /api/v1/instances/:id/sftp ----

export const instanceSftpRoutes = new Hono<AppEnv>();

instanceSftpRoutes.get("/", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "files");
  return c.json({ sftp: await sftp.instanceSftp(id, currentUser(c)) });
});

/** Make (or replace) the requester's SFTP password; the plaintext is returned once. */
instanceSftpRoutes.post("/password", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "files");
  assertBrowser(c);
  const password = await sftp.resetPassword(id, currentUser(c).id);
  await auditFrom(c, "instance.sftp_password", { type: "instance", id });
  return c.json({ password, sftp: await sftp.instanceSftp(id, currentUser(c)) });
});

instanceSftpRoutes.delete("/password", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "files");
  await sftp.removePassword(id, currentUser(c).id);
  await auditFrom(c, "instance.sftp_password_remove", { type: "instance", id });
  return c.json({ sftp: await sftp.instanceSftp(id, currentUser(c)) });
});

// ---- /api/v1/ssh-keys ----

export const sshKeyRoutes = new Hono<AppEnv>();
sshKeyRoutes.use("*", requireAuth);

sshKeyRoutes.get("/", async (c) => c.json({ items: await sftp.listKeys(currentUser(c).id) }));

sshKeyRoutes.post("/", async (c) => {
  assertBrowser(c);
  const body = await parseBody(c, AddSshKeyBody);
  const user = currentUser(c);
  const key = await sftp.addKey(user.id, body.name, body.publicKey);
  await auditFrom(c, "user.ssh_key_add", { type: "user", id: user.id }, {
    name: key.name,
    fingerprint: key.fingerprint,
  });
  return c.json({ key }, 201);
});

sshKeyRoutes.delete("/:id", async (c) => {
  const user = currentUser(c);
  const key = await sftp.removeKey(user.id, idParam(c));
  await auditFrom(c, "user.ssh_key_remove", { type: "user", id: user.id }, {
    name: key.name,
    fingerprint: key.fingerprint,
  });
  return c.json({ ok: true });
});
