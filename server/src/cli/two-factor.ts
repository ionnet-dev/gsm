/**
 * Break-glass recovery when a user has lost every second factor (phone gone, SMTP broken, no
 * recovery codes left): turns all of them off for one user and signs them out everywhere.
 *
 *   deno task 2fa:reset user@example.com
 */
import { connectDatabase } from "../db/sequelize.ts";
import { User } from "../db/models.ts";
import { adminReset } from "../modules/auth/two-factor.ts";
import * as audit from "../modules/audit/service.ts";

const [email] = Deno.args;
if (!email) {
  console.error("usage: deno task 2fa:reset <email>");
  Deno.exit(2);
}
await connectDatabase();
const user = await User.findOne({ where: { email: email.toLowerCase() } });
if (!user) {
  console.error(`no user with email ${email}`);
  Deno.exit(1);
}
if (!user.hasTwoFactor) {
  console.log(`${user.email}: two-factor authentication is not enabled; nothing to do`);
  Deno.exit(0);
}
await adminReset(user);
await audit.record({
  actorUserId: null,
  action: "auth.2fa_reset",
  targetType: "user",
  targetId: user.id,
  details: { via: "cli" },
});
console.log(
  `${user.email}: two-factor authentication (app, email, recovery codes) disabled, sessions revoked`,
);
Deno.exit(0);
