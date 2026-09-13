import { User } from "../../db/models.ts";
import { sequelize } from "../../db/sequelize.ts";
import { badRequest, conflict, notFound } from "../../lib/errors.ts";
import { events } from "../../lib/events.ts";
import { uiGateway } from "../../ws/ui-gateway.ts";
import { endSessions, hashPassword } from "../auth/service.ts";
import { adminReset } from "../auth/two-factor.ts";
import type { z } from "zod";
import type { CreateUserBody, UpdateUserBody } from "./schemas.ts";

const withCounts = {
  attributes: {
    include: [
      [
        sequelize.literal(
          "(SELECT COUNT(*) FROM instance_users iu WHERE iu.user_id = `User`.`id`)",
        ),
        "instanceCount",
      ],
      [
        sequelize.literal("(SELECT COUNT(*) FROM node_users nu WHERE nu.user_id = `User`.`id`)"),
        "nodeCount",
      ],
    ] as [ReturnType<typeof sequelize.literal>, string][],
  },
};

export async function list() {
  const users = await User.findAll({ ...withCounts, order: [["name", "ASC"]] });
  return users.map((u) => u.toPublic());
}

export async function get(id: number): Promise<User> {
  const user = await User.findByPk(id);
  if (!user) throw notFound("User");
  return user;
}

/** For pickers (sharing an instance): every enabled user, id, name and email only. */
export async function directory() {
  const users = await User.findAll({
    attributes: ["id", "name", "email", "role"],
    where: { disabled: false },
    order: [["name", "ASC"]],
  });
  return users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role }));
}

export async function create(input: z.infer<typeof CreateUserBody>): Promise<User> {
  const email = input.email.toLowerCase();
  if (await User.findOne({ where: { email } })) {
    throw conflict("A user with that email already exists");
  }
  return await User.create({
    email,
    name: input.name,
    passwordHash: await hashPassword(input.password),
    role: input.role,
    lastLoginAt: null,
  });
}

export async function update(
  id: number,
  input: z.infer<typeof UpdateUserBody>,
  actorId: number,
): Promise<User> {
  const user = await get(id);
  const demoting = input.role !== undefined && input.role !== "admin" && user.role === "admin";
  const disabling = input.disabled === true && !user.disabled;
  if ((demoting || disabling) && (await adminCount()) <= 1 && user.role === "admin") {
    throw badRequest("Cannot remove the last administrator");
  }
  if (id === actorId && (demoting || disabling)) {
    throw badRequest("You cannot demote or disable your own account");
  }
  const roleChanged = input.role !== undefined && input.role !== user.role;
  if (input.name !== undefined) user.name = input.name;
  if (input.role !== undefined) user.role = input.role;
  if (input.disabled !== undefined) user.disabled = input.disabled;
  await user.save();
  if (input.disabled) await endSessions(id);
  if (input.twoFactorEnabled === false && user.hasTwoFactor) await adminReset(user);
  // Live sockets carry the scope they connected with; make them reconnect with the new one.
  if (roleChanged) uiGateway.reconnectUser(id);
  if (roleChanged || disabling) events.emit("access.changed", { userIds: [id] });
  return user;
}

export async function remove(id: number, actorId: number): Promise<void> {
  if (id === actorId) throw badRequest("You cannot delete your own account");
  const user = await get(id);
  if (user.role === "admin" && (await adminCount()) <= 1) {
    throw badRequest("Cannot delete the last administrator");
  }
  await user.destroy();
  uiGateway.disconnectUser(id);
  events.emit("access.changed", { userIds: [id] });
}

export async function resetPassword(id: number, password: string): Promise<void> {
  const user = await get(id);
  user.passwordHash = await hashPassword(password);
  await user.save();
  await endSessions(id);
}

function adminCount(): Promise<number> {
  return User.count({ where: { role: "admin", disabled: false } });
}
