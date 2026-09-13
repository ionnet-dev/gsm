/** POST /instances/:id/firewall: an owner opens or closes the instance's ports in the firewall. */
import { Hono } from "hono";
import { SetInstanceFirewallBody } from "@gsm/shared";
import type { AppEnv } from "../../app.ts";
import { idParam, parseBody } from "../../lib/http.ts";
import { auditFrom } from "../audit/service.ts";
import { assertInstancePermission } from "../instances/access.ts";
import * as firewall from "./service.ts";

export const instanceFirewallRoutes = new Hono<AppEnv>();

instanceFirewallRoutes.post("/", async (c) => {
  const id = idParam(c);
  await assertInstancePermission(c, id, "firewall");
  const { open } = await parseBody(c, SetInstanceFirewallBody);
  const rules = await firewall.setInstanceFirewall(id, open);
  await auditFrom(
    c,
    open ? "instance.firewall_open" : "instance.firewall_close",
    { type: "instance", id },
    { rules: rules.map((r) => `${r.port}/${r.protocol} ${r.state}`) },
  );
  return c.json({ rules });
});
