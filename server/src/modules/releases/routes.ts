import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import { badRequest } from "../../lib/errors.ts";
import { idParam } from "../../lib/http.ts";
import { auditFrom } from "../audit/service.ts";
import { currentUser, requireRole } from "../auth/middleware.ts";
import * as releases from "./service.ts";

export const releaseRoutes = new Hono<AppEnv>();
releaseRoutes.use("*", requireRole("admin"));

releaseRoutes.get(
  "/",
  async (c) => c.json({ items: await releases.list(), summary: await releases.summary() }),
);

releaseRoutes.post("/", async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) throw badRequest("Expected multipart form data");
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("Missing file");
  const rel = await releases.upload(
    {
      version: String(form.get("version") ?? ""),
      arch: String(form.get("arch") ?? "x86_64"),
      notes: String(form.get("notes") ?? "").trim() || null,
      file,
      makeLatest: String(form.get("makeLatest") ?? "true") === "true",
    },
    currentUser(c).id,
  );
  await auditFrom(c, "agent_release.upload", { type: "agent_release", id: rel.id }, {
    version: rel.version,
    arch: rel.arch,
  });
  return c.json({ release: rel }, 201);
});

releaseRoutes.post("/:id/latest", async (c) => {
  const id = idParam(c);
  const rel = await releases.setLatest(id);
  await auditFrom(c, "agent_release.set_latest", { type: "agent_release", id }, {
    version: rel.version,
    arch: rel.arch,
  });
  return c.json({ release: rel });
});

releaseRoutes.delete("/:id", async (c) => {
  const id = idParam(c);
  await releases.remove(id);
  await auditFrom(c, "agent_release.delete", { type: "agent_release", id });
  return c.json({ ok: true });
});

releaseRoutes.post("/rollout", async (c) => {
  const res = await releases.rollout();
  await auditFrom(c, "agent_release.rollout", undefined, res);
  return c.json(res);
});

/** Binary downloads used by the install script and self-update (no auth: the binary is public). */
export const downloadRoutes = new Hono<AppEnv>();
downloadRoutes.get("/gsm-agent/:version/:arch", async (c) => {
  const arch = c.req.param("arch").replace(/\.sha256$/, "");
  const wantSha = c.req.param("arch").endsWith(".sha256");
  const file = await releases.resolveFile(c.req.param("version"), arch);
  if (!file) return c.json({ error: { code: "not_found", message: "No such release" } }, 404);
  if (wantSha) return c.text(file.sha + "\n");
  try {
    const f = await Deno.open(file.path, { read: true });
    const stat = await f.stat();
    return new Response(f.readable, {
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(stat.size),
        "x-checksum-sha256": file.sha,
        "cache-control": "no-cache",
      },
    });
  } catch {
    return c.json({ error: { code: "not_found", message: "Release file missing on disk" } }, 404);
  }
});
