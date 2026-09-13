/**
 * SFTP: per-instance passwords, SSH keys and the server's side of every sign-in. Agents serve
 * SFTP themselves and ask here with `sftp.auth`; access is checked live (`files` permission).
 * Whenever someone's access changes, their open sessions are re-checked on every node and the
 * ones no longer allowed are closed.
 */
import { Op } from "sequelize";
import type {
  InstanceSftpDto,
  SftpAuthParams,
  SftpAuthResult,
  SftpSession,
  SftpSessionEvent,
  SshKeyDto,
} from "@gsm/shared";
import { roleAllows } from "@gsm/shared";
import { Instance, Node, SftpPassword, SshKey, User } from "../../db/models.ts";
import { sequelize } from "../../db/sequelize.ts";
import { badRequest, conflict, notFound } from "../../lib/errors.ts";
import { events } from "../../lib/events.ts";
import { log } from "../../lib/logger.ts";
import { createRateLimiter } from "../../lib/rate-limit.ts";
import { agentGateway } from "../../ws/agent-gateway.ts";
import * as audit from "../audit/service.ts";
import { hashPassword, verifyPassword } from "../auth/service.ts";
import { roleOn } from "../instances/access.ts";
import { publicAddressOf } from "../nodes/service.ts";
import {
  canonicalKey,
  fingerprint,
  generatePassword,
  parsePublicKey,
  parseSftpUsername,
  sftpNameBase,
  shortId,
} from "./keys.ts";

const slog = log.child("sftp");

/** Failed password sign-ins per client address and per username (keys cannot be guessed). */
const failuresByAddress = createRateLimiter({ windowMs: 10 * 60_000, max: 20 });
const failuresByName = createRateLimiter({ windowMs: 10 * 60_000, max: 20 });

// ---------------------------------------------------------------------------
// Names and DTOs
// ---------------------------------------------------------------------------

/** The user's SFTP name, picked from their email the first time it is needed. */
export async function ensureSftpName(user: User): Promise<string> {
  if (user.sftpName) return user.sftpName;
  const base = sftpNameBase(user.email);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base.slice(0, 34)}-${n}`;
    if (await User.count({ where: { sftpName: candidate } })) continue;
    try {
      await User.update({ sftpName: candidate }, { where: { id: user.id, sftpName: null } });
    } catch {
      continue; // taken in the meantime (unique index)
    }
    const fresh = await User.findByPk(user.id, { attributes: ["id", "sftpName"] });
    if (fresh?.sftpName) return (user.sftpName = fresh.sftpName);
  }
  throw conflict("Could not pick an SFTP name");
}

function passwordCredential(row: SftpPassword): string {
  return `password:${row.createdAt.getTime()}`;
}

export async function instanceSftp(instanceId: number, user: User): Promise<InstanceSftpDto> {
  const i = await Instance.findByPk(instanceId, { include: [{ model: Node, as: "node" }] });
  if (!i) throw notFound("Instance");
  const node = i.node!;
  const [password, sshKeys, name] = await Promise.all([
    SftpPassword.findOne({ where: { instanceId, userId: user.id } }),
    SshKey.count({ where: { userId: user.id } }),
    ensureSftpName(user),
  ]);
  const problem = node.sftpPort === null
    ? "SFTP is turned off on this node"
    : !agentGateway.isConnected(node.id)
    ? "The node is offline"
    : node.sftpError ?? (node.sftpHostKey ? null : "The node has not reported SFTP yet");
  return {
    available: problem === null,
    problem,
    host: publicAddressOf(node),
    port: node.sftpPort,
    username: `${name}.${shortId(i.uuid)}`,
    hostKey: node.sftpHostKey,
    password: password
      ? {
        createdAt: password.createdAt.toISOString(),
        lastUsedAt: password.lastUsedAt?.toISOString() ?? null,
      }
      : null,
    sshKeys,
    reachable: node.sftpReachability?.port === node.sftpPort ? node.sftpReachability : null,
  };
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/** A new SFTP password for the user on the instance; the old one stops working. */
export async function resetPassword(instanceId: number, userId: number): Promise<string> {
  const plaintext = generatePassword();
  const passwordHash = await hashPassword(plaintext);
  await sequelize.transaction(async (transaction) => {
    await SftpPassword.destroy({ where: { instanceId, userId }, transaction });
    await SftpPassword.create({ instanceId, userId, passwordHash }, { transaction });
  });
  await recheckSessions([userId]);
  return plaintext;
}

export async function removePassword(instanceId: number, userId: number): Promise<void> {
  const removed = await SftpPassword.destroy({ where: { instanceId, userId } });
  if (!removed) throw notFound("SFTP password");
  await recheckSessions([userId]);
}

// ---------------------------------------------------------------------------
// SSH keys
// ---------------------------------------------------------------------------

function keyDto(k: SshKey): SshKeyDto {
  return {
    id: k.id,
    name: k.name,
    type: k.publicKey.split(" ")[0],
    fingerprint: k.fingerprint,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  };
}

export async function listKeys(userId: number): Promise<SshKeyDto[]> {
  const rows = await SshKey.findAll({ where: { userId }, order: [["createdAt", "ASC"]] });
  return rows.map(keyDto);
}

export async function addKey(userId: number, name: string, publicKey: string): Promise<SshKeyDto> {
  const parsed = parsePublicKey(publicKey);
  if (typeof parsed === "string") throw badRequest(parsed);
  const fp = await fingerprint(parsed.blob);
  if (await SshKey.count({ where: { userId, fingerprint: fp } })) {
    throw conflict("You added this key already");
  }
  const key = await SshKey.create({
    userId,
    name,
    publicKey: canonicalKey(parsed),
    fingerprint: fp,
  });
  return keyDto(key);
}

export async function removeKey(userId: number, id: number): Promise<SshKeyDto> {
  const key = await SshKey.findOne({ where: { id, userId } });
  if (!key) throw notFound("SSH key");
  await key.destroy();
  await recheckSessions([userId]);
  return keyDto(key);
}

// ---------------------------------------------------------------------------
// Sign-in (agent -> server `sftp.auth`)
// ---------------------------------------------------------------------------

const DENIED: SftpAuthResult = { allowed: false };

/**
 * May this username with this password or key open the instance it names on this node? Every
 * refusal looks the same to the agent; failed passwords count towards the rate limits.
 */
export async function authenticate(nodeId: number, p: SftpAuthParams): Promise<SftpAuthResult> {
  const address = p.remoteAddress || "unknown";
  const nameKey = `${nodeId}:${p.username.toLowerCase()}`;
  if (failuresByAddress.retryAfter(address) > 0 || failuresByName.retryAfter(nameKey) > 0) {
    return DENIED;
  }
  const fail = () => {
    if (p.method === "password") {
      failuresByAddress.check(address);
      failuresByName.check(nameKey);
    }
    return DENIED;
  };
  const parsed = parseSftpUsername(p.username);
  if (!parsed) return fail();
  const user = await User.findOne({ where: { sftpName: parsed.name, disabled: false } });
  if (!user) return fail();
  const matches = await Instance.findAll({
    where: { nodeId, uuid: { [Op.like]: `${parsed.shortId}%` } },
    attributes: ["id", "uuid", "nodeId"],
    limit: 2,
  });
  if (matches.length !== 1) return fail();
  const instance = matches[0];
  if (!roleAllows(await roleOn(user, instance.id), "files")) return fail();

  if (p.method === "password") {
    const row = await SftpPassword.findOne({ where: { instanceId: instance.id, userId: user.id } });
    if (!row || !p.password || !(await verifyPassword(p.password, row.passwordHash))) {
      return fail();
    }
    await SftpPassword.update({ lastUsedAt: new Date() }, {
      where: { instanceId: instance.id, userId: user.id },
    });
    return {
      allowed: true,
      userId: user.id,
      uuid: instance.uuid,
      credential: passwordCredential(row),
    };
  }

  const key = p.publicKey ? parsePublicKey(p.publicKey) : null;
  if (!key || typeof key === "string") return DENIED;
  const row = await SshKey.findOne({
    where: { userId: user.id, fingerprint: await fingerprint(key.blob) },
  });
  if (!row) return DENIED;
  await row.update({ lastUsedAt: new Date() });
  return { allowed: true, userId: user.id, uuid: instance.uuid, credential: `key:${row.id}` };
}

// ---------------------------------------------------------------------------
// Open sessions
// ---------------------------------------------------------------------------

async function sessionAllowed(nodeId: number, s: SftpSession): Promise<boolean> {
  const user = await User.findByPk(s.userId);
  if (!user || user.disabled) return false;
  const instance = await Instance.findOne({
    where: { uuid: s.uuid, nodeId },
    attributes: ["id", "nodeId"],
  });
  if (!instance) return false;
  if (!roleAllows(await roleOn(user, instance.id), "files")) return false;
  if (s.credential.startsWith("key:")) {
    const id = Number(s.credential.slice(4));
    return Number.isInteger(id) && (await SshKey.count({ where: { id, userId: user.id } })) > 0;
  }
  const row = await SftpPassword.findOne({ where: { instanceId: instance.id, userId: user.id } });
  return !!row && passwordCredential(row) === s.credential;
}

/** Close the SFTP sessions of these users that their access no longer allows, on every node. */
export async function recheckSessions(userIds: number[]): Promise<void> {
  if (!userIds.length) return;
  await Promise.all(
    agentGateway.connectedIds().map(async (nodeId) => {
      try {
        const { sessions } = await agentGateway.request(nodeId, "sftp.sessions", { userIds });
        const doomed: string[] = [];
        for (const s of sessions) if (!(await sessionAllowed(nodeId, s))) doomed.push(s.id);
        if (!doomed.length) return;
        await agentGateway.request(nodeId, "sftp.disconnect", { ids: doomed });
        slog.info("closed SFTP sessions after an access change", {
          nodeId,
          sessions: doomed.length,
        });
      } catch (err) {
        // Agents without SFTP answer unknown_method; nothing to close there.
        slog.debug("SFTP session re-check skipped", { nodeId, err: String(err) });
      }
    }),
  );
}

events.on("access.changed", ({ userIds }) => recheckSessions(userIds));

/** Audit sign-ins and what each session did. */
export async function onSession(nodeId: number, e: SftpSessionEvent): Promise<void> {
  const instance = await Instance.findOne({ where: { uuid: e.uuid, nodeId }, attributes: ["id"] });
  await audit.record({
    actorUserId: e.userId,
    action: e.state === "opened" ? "instance.sftp_login" : "instance.sftp_logout",
    targetType: "instance",
    targetId: instance?.id ?? null,
    details: { method: e.method, session: e.id, ...(e.stats ? { stats: e.stats } : {}) },
    ip: e.remoteAddress || null,
  });
}
