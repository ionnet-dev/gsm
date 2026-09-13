/**
 * Lightweight semver-style comparison for agent versions ("1.2.3", "v1.2.3", "1.2.3-rc.1").
 * Anything that does not parse (e.g. "dev") is incomparable: `compareVersions` returns null.
 */
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?(?:\+[0-9A-Za-z.\-]+)?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseVersion(v: string | null | undefined): ParsedVersion | null {
  if (!v) return null;
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

function cmpIdent(a: string, b: string): number {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na && nb) return Number(a) - Number(b);
  if (na) return -1; // numeric identifiers sort before alphanumeric ones
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Negative when a < b, positive when a > b, 0 when equal; null when either does not parse. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (const k of ["major", "minor", "patch"] as const) {
    if (pa[k] !== pb[k]) return pa[k] - pb[k];
  }
  // A pre-release sorts before the release it precedes (1.0.0-rc.1 < 1.0.0).
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) return 0;
  if (pa.prerelease.length === 0) return 1;
  if (pb.prerelease.length === 0) return -1;
  const n = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i], y = pb.prerelease[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const c = cmpIdent(x, y);
    if (c !== 0) return c;
  }
  return 0;
}

/** True when `agentVersion` parses and is strictly older than `latest`. */
export function isOutdatedVersion(
  agentVersion: string | null | undefined,
  latest: string | null | undefined,
): boolean {
  const c = compareVersions(agentVersion, latest);
  return c !== null && c < 0;
}
