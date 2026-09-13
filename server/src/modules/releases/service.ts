/** Agent binaries hosted by the server for the install script and self-update. */
import { Op } from "sequelize";
import type { AgentReleaseDto, AgentReleaseSummary } from "@gsm/shared";
import { AGENT_BUILD_KEYS, agentBuildKey, compareVersions, isOutdatedVersion } from "@gsm/shared";
import { AgentRelease, Node } from "../../db/models.ts";
import { config } from "../../config.ts";
import { badRequest, conflict, notFound } from "../../lib/errors.ts";
import { log } from "../../lib/logger.ts";
import { agentGateway } from "../../ws/agent-gateway.ts";
import { uiGateway } from "../../ws/ui-gateway.ts";

const rlog = log.child("releases");
export const ARCHES = AGENT_BUILD_KEYS;
const isBuildKey = (k: string) => (ARCHES as readonly string[]).includes(k);
const VERSION_RE = /^v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.\-]+)?$/;

export function releasesDir() {
  return `${config.DATA_DIR}/downloads/gsm-agent`;
}

/** Relative download path served by /downloads. */
export function downloadPath(version: string, arch: string) {
  return `/downloads/gsm-agent/${version}/${arch}`;
}

async function dto(r: AgentRelease): Promise<AgentReleaseDto> {
  return {
    id: r.id,
    version: r.version,
    arch: r.arch,
    sha256: r.sha256,
    size: r.size,
    notes: r.notes,
    isLatest: r.isLatest,
    createdAt: r.createdAt.toISOString(),
    nodeCount: await Node.count({ where: { agentVersion: r.version, arch: r.arch } }),
  };
}

export async function list(): Promise<AgentReleaseDto[]> {
  const rows = await AgentRelease.findAll({ order: [["createdAt", "DESC"]] });
  return await Promise.all(rows.map(dto));
}

export async function latestByArch(): Promise<Record<string, AgentRelease | null>> {
  const out: Record<string, AgentRelease | null> = {};
  for (const arch of ARCHES) {
    out[arch] = await AgentRelease.findOne({ where: { arch, isLatest: true } });
  }
  return out;
}

export async function summary(): Promise<AgentReleaseSummary> {
  const latest = await latestByArch();
  const all = await Node.findAll({ attributes: ["id", "arch", "agentVersion"] });
  let outdated = 0;
  for (const n of all) {
    if (isOutdatedVersion(n.agentVersion, latest[agentBuildKey(n.arch)]?.version)) outdated++;
  }
  return {
    latest: Object.fromEntries(Object.entries(latest).map(([a, r]) => [a, r?.version ?? null])),
    outdatedNodes: outdated,
    totalNodes: all.length,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Store an uploaded binary and register it; optionally mark it latest for its arch. */
export async function upload(
  input: { version: string; arch: string; notes: string | null; file: File; makeLatest: boolean },
  createdBy: number,
) {
  const version = input.version.trim().replace(/^v/, "");
  if (!VERSION_RE.test(version)) {
    throw badRequest("Version must look like 1.2.3 (optionally with -suffix)");
  }
  if (!isBuildKey(input.arch)) throw badRequest("Unsupported architecture");
  if (input.file.size < 1_000_000) {
    throw badRequest("That does not look like an agent binary (too small)");
  }
  if (await AgentRelease.findOne({ where: { version, arch: input.arch } })) {
    throw conflict(`Release ${version} for ${input.arch} already exists`);
  }
  const bytes = new Uint8Array(await input.file.arrayBuffer());
  const elf = bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
  if (!elf) throw badRequest("File is not an ELF executable");
  const sha = await sha256Hex(bytes);
  const dir = `${releasesDir()}/${version}`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeFile(`${dir}/${input.arch}`, bytes, { mode: 0o755 });
  await Deno.writeTextFile(`${dir}/${input.arch}.sha256`, sha + "\n");

  const release = await AgentRelease.create({
    version,
    arch: input.arch,
    sha256: sha,
    size: bytes.byteLength,
    path: downloadPath(version, input.arch),
    notes: input.notes,
    isLatest: false,
    createdBy,
  });
  if (input.makeLatest) await setLatest(release.id);
  rlog.info("release uploaded", { version, arch: input.arch, size: bytes.byteLength });
  return await dto(release);
}

export async function setLatest(id: number) {
  const r = await AgentRelease.findByPk(id);
  if (!r) throw notFound("Release");
  await AgentRelease.update(
    { isLatest: false, latestSince: null },
    { where: { arch: r.arch, id: { [Op.ne]: id } } },
  );
  if (!r.isLatest) r.latestSince = new Date();
  r.isLatest = true;
  await r.save();
  uiGateway.broadcast("node.updated", { nodeId: 0 });
  return await dto(r);
}

export async function remove(id: number) {
  const r = await AgentRelease.findByPk(id);
  if (!r) throw notFound("Release");
  if (r.isLatest) throw badRequest("Mark another release as latest before deleting this one");
  await Deno.remove(`${releasesDir()}/${r.version}/${r.arch}`).catch(() => {});
  await Deno.remove(`${releasesDir()}/${r.version}/${r.arch}.sha256`).catch(() => {});
  await Deno.remove(`${releasesDir()}/${r.version}`).catch(() => {}); // only if empty
  await r.destroy();
}

/** Resolve "latest" (or a version) for an arch to a file on disk. */
export async function resolveFile(
  version: string,
  arch: string,
): Promise<{ path: string; sha: string } | null> {
  if (!isBuildKey(arch)) return null;
  const r = version === "latest"
    ? await AgentRelease.findOne({ where: { arch, isLatest: true } })
    : await AgentRelease.findOne({ where: { arch, version: version.replace(/^v/, "") } });
  if (!r) return null;
  return { path: `${releasesDir()}/${r.version}/${r.arch}`, sha: r.sha256 };
}

/**
 * Tell every connected, outdated agent to update to the latest release for its arch. Agents
 * restart into the new binary; instances keep running (they are containers).
 */
export async function rollout(): Promise<{ updated: number[]; failed: number[]; skipped: number }> {
  const latest = await latestByArch();
  const all = await Node.findAll({ attributes: ["id", "name", "arch", "agentVersion"] });
  const due = all.filter((n) => {
    const l = latest[agentBuildKey(n.arch)];
    return l && n.agentVersion !== l.version && agentGateway.isConnected(n.id);
  });
  const updated: number[] = [];
  const failed: number[] = [];
  await Promise.all(due.map(async (n) => {
    const l = latest[agentBuildKey(n.arch)]!;
    try {
      const res = await agentGateway.request(n.id, "agent.update", {
        version: l.version,
        path: l.path,
        sha256: l.sha256,
      }, { timeoutMs: 120_000 });
      if (res.replaced) updated.push(n.id);
      else failed.push(n.id);
      rlog.info("agent.update", { nodeId: n.id, ...res });
    } catch (err) {
      failed.push(n.id);
      rlog.warn("agent.update failed", { nodeId: n.id, err: String(err) });
    }
  }));
  return { updated, failed, skipped: all.length - due.length };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy agent builds baked into the image (BUNDLED_AGENTS_DIR/<version>/<arch>) into DATA_DIR.
 * The image can't ship them in DATA_DIR itself: it is a volume, and an existing volume hides
 * whatever a newer image puts there. A version already on disk is never replaced.
 */
async function importBundled(): Promise<void> {
  const src = config.BUNDLED_AGENTS_DIR;
  if (!src) return;
  let versions: Deno.DirEntry[];
  try {
    versions = [...Deno.readDirSync(src)];
  } catch {
    rlog.warn("bundled agent directory is missing", { dir: src });
    return;
  }
  for (const v of versions) {
    if (!v.isDirectory || !VERSION_RE.test(v.name)) continue;
    for (const arch of ARCHES) {
      const from = `${src}/${v.name}/${arch}`;
      const to = `${releasesDir()}/${v.name}/${arch}`;
      if (!(await exists(from))) continue;
      const sha = await sha256Hex(await Deno.readFile(from));
      if (await exists(to)) {
        if (sha !== await sha256Hex(await Deno.readFile(to))) {
          rlog.warn(
            "the image ships a different build under an existing version; kept the old one",
            {
              version: v.name,
              arch,
              hint: "bump VERSION in the Dockerfile to release it",
            },
          );
        }
        continue;
      }
      await Deno.mkdir(`${releasesDir()}/${v.name}`, { recursive: true });
      await Deno.copyFile(from, to);
      await Deno.chmod(to, 0o755);
      await Deno.writeTextFile(`${to}.sha256`, sha + "\n");
      rlog.info("imported bundled agent build", { version: v.name, arch });
    }
  }
}

/**
 * Register binaries that exist on disk but not in the database (bundled builds imported above, or
 * files placed by `deno task agent:build`). A newly registered build becomes latest for its arch
 * when it is newer than the current latest; a latest chosen earlier by hand stays put.
 */
export async function seedFromDisk(): Promise<number> {
  await importBundled();
  const created: AgentRelease[] = [];
  let versions: Deno.DirEntry[] = [];
  try {
    versions = [...Deno.readDirSync(releasesDir())];
  } catch {
    return 0;
  }
  for (const v of versions) {
    if (!v.isDirectory || !VERSION_RE.test(v.name)) continue;
    for (const arch of ARCHES) {
      const path = `${releasesDir()}/${v.name}/${arch}`;
      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(path);
      } catch {
        continue;
      }
      if (await AgentRelease.findOne({ where: { version: v.name, arch } })) continue;
      const bytes = await Deno.readFile(path);
      const release = await AgentRelease.create({
        version: v.name,
        arch,
        sha256: await sha256Hex(bytes),
        size: stat.size,
        path: downloadPath(v.name, arch),
        notes: "seeded from disk",
        isLatest: false,
        createdBy: null,
      });
      created.push(release);
    }
  }
  for (const arch of ARCHES) {
    const current = await AgentRelease.findOne({ where: { arch, isLatest: true } });
    const candidates = current
      ? created.filter((r) =>
        r.arch === arch && (compareVersions(r.version, current.version) ?? 0) > 0
      )
      : await AgentRelease.findAll({ where: { arch } });
    if (!candidates.length) continue;
    const newest = candidates.sort((a, b) => compareVersions(b.version, a.version) ?? 0)[0];
    await setLatest(newest.id);
    rlog.info("agent release marked latest", { version: newest.version, arch });
  }
  if (created.length) rlog.info("seeded releases from disk", { added: created.length });
  return created.length;
}
