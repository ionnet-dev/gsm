/**
 * Players on an instance, mounted under /instances/:id/players. Anyone who can see the instance
 * sees who is online and who played recently; the game's lists and the actions need the `players`
 * permission.
 */
import { Hono } from "hono";
import { PlayerActionBody, roleAllows } from "@gsm/shared";
import type { AppEnv } from "../../app.ts";
import { idParam, parseBody } from "../../lib/http.ts";
import { auditFrom } from "../audit/service.ts";
import { assertInstancePermission } from "../instances/access.ts";
import * as players from "./service.ts";

export const instancePlayerRoutes = new Hono<AppEnv>();

instancePlayerRoutes.get("/", async (c) => {
  const id = idParam(c);
  const role = await assertInstancePermission(c, id, "view");
  return c.json(await players.overview(id, roleAllows(role, "players")));
});

instancePlayerRoutes.post("/refresh", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "players");
  await players.refresh(id);
  return c.json({ ok: true });
});

instancePlayerRoutes.post("/actions", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "players");
  const body = await parseBody(c, PlayerActionBody);
  const { command } = await players.runAction(id, body);
  await auditFrom(c, "instance.player_action", { type: "instance", id }, {
    action: body.action,
    player: body.player,
    command,
  });
  return c.json({ ok: true, command });
});
