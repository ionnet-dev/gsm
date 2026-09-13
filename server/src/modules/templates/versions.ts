/**
 * Version sources (lists for `version` variables) and install resolvers (download URLs for the
 * install script's environment). Upstream lists are cached for 10 minutes; a failure to reach an
 * upstream is a 502 with the upstream named.
 */
import type { InstallResolver, VersionOption, VersionSource } from "@gsm/shared";
import { HttpError } from "../../lib/errors.ts";
import { log } from "../../lib/logger.ts";

const vlog = log.child("versions");
const CACHE_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

const MOJANG_MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const FORGE_PROMOTIONS =
  "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const FORGE_MAVEN = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
const STEAMCMD_API = "https://api.steamcmd.net/v1/info";

const upstream = (what: string, err: unknown) =>
  new HttpError(
    502,
    "upstream_unavailable",
    `Could not reach ${what}: ${err instanceof Error ? err.message : String(err)}`,
  );

const cache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await load();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** For tests: forget everything. */
export function clearVersionCache() {
  cache.clear();
}

async function fetchText(url: string, what: string): Promise<string> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    vlog.warn("upstream fetch failed", { url, err: String(err) });
    throw upstream(what, err);
  }
}

async function fetchJson<T>(url: string, what: string): Promise<T> {
  const text = await fetchText(url, what);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw upstream(what, err);
  }
}

// ---- Mojang ----------------------------------------------------------------

interface MojangManifest {
  latest: { release: string; snapshot: string };
  versions: { id: string; type: string; url: string; releaseTime: string }[];
}

const mojangManifest = () =>
  cached("mojang", () => fetchJson<MojangManifest>(MOJANG_MANIFEST, "Mojang's version manifest"));

async function vanillaVersions(): Promise<VersionOption[]> {
  const m = await mojangManifest();
  return m.versions.map((v) => ({
    id: v.id,
    label: v.id + (v.id === m.latest.release ? " (latest release)" : ""),
    kind: v.type,
    releasedAt: v.releaseTime,
  }));
}

async function resolveVanilla(vars: Record<string, string>): Promise<Record<string, string>> {
  const version = vars.MC_VERSION;
  if (!version) throw new HttpError(400, "bad_request", "MC_VERSION is required");
  const m = await mojangManifest();
  const entry = m.versions.find((v) => v.id === version);
  if (!entry) throw new HttpError(400, "bad_request", `Unknown Minecraft version ${version}`);
  const detail = await cached(
    `mojang:${version}`,
    () =>
      fetchJson<{ downloads?: { server?: { url: string; sha1: string } } }>(
        entry.url,
        `Mojang's metadata for ${version}`,
      ),
  );
  const server = detail.downloads?.server;
  if (!server) {
    throw new HttpError(400, "bad_request", `Minecraft ${version} has no server download`);
  }
  return { SERVER_JAR_URL: server.url, SERVER_JAR_SHA1: server.sha1 };
}

// ---- Forge -----------------------------------------------------------------

/** `<version>` entries of a Maven metadata file. */
export function parseMavenVersions(xml: string): string[] {
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1].trim());
}

interface ForgePromotions {
  promos: Record<string, string>;
}

/** Forge versions for one Minecraft version, newest first, recommended/latest flagged. */
export function forgeOptions(
  allVersions: string[],
  promos: Record<string, string>,
  mc: string,
): VersionOption[] {
  const prefix = `${mc}-`;
  const recommended = promos[`${mc}-recommended`];
  const latest = promos[`${mc}-latest`];
  const loaders = allVersions
    .filter((v) => v.startsWith(prefix))
    .map((v) => v.slice(prefix.length))
    .reverse();
  return loaders.map((v) => {
    const kind = v === recommended ? "recommended" : v === latest ? "latest" : "release";
    const tag = kind === "release" ? "" : ` (${kind})`;
    return { id: v, label: v + tag, kind, releasedAt: null };
  });
}

async function forgeVersions(mc: string | undefined): Promise<VersionOption[]> {
  if (!mc) throw new HttpError(400, "bad_request", "Pick a Minecraft version first");
  const [xml, promos] = await Promise.all([
    cached("forge:maven", () => fetchText(`${FORGE_MAVEN}/maven-metadata.xml`, "the Forge Maven")),
    cached(
      "forge:promos",
      () => fetchJson<ForgePromotions>(FORGE_PROMOTIONS, "the Forge promotions list"),
    ),
  ]);
  return forgeOptions(parseMavenVersions(xml), promos.promos ?? {}, mc);
}

function resolveForge(vars: Record<string, string>): Record<string, string> {
  const mc = vars.MC_VERSION, loader = vars.LOADER_VERSION;
  if (!mc || !loader) {
    throw new HttpError(400, "bad_request", "MC_VERSION and LOADER_VERSION are required");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(mc) || !/^[A-Za-z0-9._-]+$/.test(loader)) {
    throw new HttpError(400, "bad_request", "Invalid version");
  }
  const v = `${mc}-${loader}`;
  return { INSTALLER_URL: `${FORGE_MAVEN}/${v}/forge-${v}-installer.jar` };
}

// ---- NeoForge --------------------------------------------------------------

/** The NeoForge version prefix for a Minecraft version: 1.21.1 → "21.1", 1.21 → "21.0". */
export function neoforgePrefix(mc: string): string | null {
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(mc);
  if (!m) return null;
  return `${m[1]}.${m[2] ?? "0"}`;
}

export function neoforgeOptions(allVersions: string[], mc: string): VersionOption[] {
  const prefix = neoforgePrefix(mc);
  if (!prefix) return [];
  const matching = allVersions.filter((v) => v.startsWith(`${prefix}.`)).reverse();
  return matching.map((v, i) => ({
    id: v,
    label: v + (i === 0 ? " (latest)" : "") + (v.includes("beta") ? "" : ""),
    kind: v.includes("beta") ? "beta" : i === 0 ? "latest" : "release",
    releasedAt: null,
  }));
}

async function neoforgeVersions(mc: string | undefined): Promise<VersionOption[]> {
  if (!mc) throw new HttpError(400, "bad_request", "Pick a Minecraft version first");
  const xml = await cached(
    "neoforge:maven",
    () => fetchText(`${NEOFORGE_MAVEN}/maven-metadata.xml`, "the NeoForge Maven"),
  );
  return neoforgeOptions(parseMavenVersions(xml), mc);
}

function resolveNeoforge(vars: Record<string, string>): Record<string, string> {
  const v = vars.LOADER_VERSION;
  if (!v) throw new HttpError(400, "bad_request", "LOADER_VERSION is required");
  if (!/^[A-Za-z0-9._-]+$/.test(v)) throw new HttpError(400, "bad_request", "Invalid version");
  return { INSTALLER_URL: `${NEOFORGE_MAVEN}/${v}/neoforge-${v}-installer.jar` };
}

// ---- Steam ---------------------------------------------------------------------

export interface SteamBranch {
  buildid?: string;
  description?: string;
  pwdrequired?: string | number | boolean;
  timebuildupdated?: string;
  timeupdated?: string;
}

/** Offered when api.steamcmd.net cannot be reached: Steam's two standing branches. */
export const STEAM_FALLBACK_BRANCHES: VersionOption[] = [
  { id: "public", label: "public (stable)", kind: "release", releasedAt: null },
  {
    id: "latest_experimental",
    label: "latest_experimental (unstable)",
    kind: "experimental",
    releasedAt: null,
  },
];

/**
 * An app's branches as versions: `public` first (labelled with the named branch of the same
 * build), then `latest_experimental`, then the rest newest first. Password branches are left out.
 */
export function steamBranchOptions(branches: Record<string, SteamBranch>): VersionOption[] {
  const open = Object.entries(branches).filter(([, b]) =>
    !b.pwdrequired || b.pwdrequired === "0" || b.pwdrequired === 0
  );
  const time = (b: SteamBranch) => Number(b.timebuildupdated ?? b.timeupdated ?? 0);
  const pub = branches.public;
  const twin = pub?.buildid
    ? open.find(([id, b]) => id !== "public" && b.buildid === pub.buildid && b.description)
    : undefined;
  const rank = (id: string) => id === "public" ? 0 : id === "latest_experimental" ? 1 : 2;
  return open
    .sort(([a, x], [b, y]) => rank(a) - rank(b) || time(y) - time(x))
    .map(([id, b]) => ({
      id,
      label: id === "public"
        ? `public (${twin?.[1].description ?? "stable"})`
        : b.description
        ? `${id} (${b.description})`
        : id,
      kind: id === "public" ? "release" : id === "latest_experimental" ? "experimental" : "old",
      releasedAt: time(b) ? new Date(time(b) * 1000).toISOString() : null,
    }));
}

async function steamVersions(appId: string): Promise<VersionOption[]> {
  try {
    return await cached(`steam:${appId}`, async () => {
      const info = await fetchJson<
        { data?: Record<string, { depots?: { branches?: Record<string, SteamBranch> } }> }
      >(`${STEAMCMD_API}/${appId}`, "api.steamcmd.net");
      const branches = info.data?.[appId]?.depots?.branches;
      if (!branches || typeof branches !== "object") {
        throw upstream("api.steamcmd.net", new Error("no branches in the answer"));
      }
      return steamBranchOptions(branches);
    });
  } catch {
    // Installs take the branch name as it is; the two standing branches always exist.
    return STEAM_FALLBACK_BRANCHES;
  }
}

// ---- public API ------------------------------------------------------------

export async function listVersions(
  source: VersionSource,
  parent: string | undefined,
): Promise<VersionOption[]> {
  switch (source) {
    case "minecraft:vanilla":
      return await vanillaVersions();
    case "minecraft:forge":
      return await forgeVersions(parent);
    case "minecraft:neoforge":
      return await neoforgeVersions(parent);
    case "steam:294420":
      return await steamVersions("294420");
  }
}

/** Extra environment for an install run, from the instance's variables. */
export async function resolveInstall(
  resolver: InstallResolver | null,
  vars: Record<string, string>,
): Promise<Record<string, string>> {
  switch (resolver) {
    case null:
      return {};
    case "minecraft-vanilla":
      return await resolveVanilla(vars);
    case "minecraft-forge":
      return resolveForge(vars);
    case "minecraft-neoforge":
      return resolveNeoforge(vars);
  }
}
