/** POST /instances/:id/reachability: check an instance's ports and its node's SFTP now. */
import { Hono } from "hono";
import type { AppEnv } from "../../app.ts";
import { idParam } from "../../lib/http.ts";
import { assertInstancePermission } from "../instances/access.ts";
import * as reachability from "./service.ts";

export const instanceReachabilityRoutes = new Hono<AppEnv>();

instanceReachabilityRoutes.post("/", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "settings");
  reachability.assertManualAllowed(`instance:${id}`);
  return c.json(await reachability.checkInstanceAndSftp(id));
});
