/**
 * The agent builds the server can host, keyed the way release files are named. Linux only for
 * now; the key is the `uname -m` architecture.
 */
export const AGENT_BUILDS = [
  { key: "x86_64", label: "Linux x86_64" },
  { key: "aarch64", label: "Linux aarch64" },
] as const;
export type AgentBuildKey = (typeof AGENT_BUILDS)[number]["key"];
export const AGENT_BUILD_KEYS = AGENT_BUILDS.map((b) => b.key) as AgentBuildKey[];

/** The build key for a node, from the architecture its agent reported. */
export function agentBuildKey(arch: string | null | undefined): string {
  return arch ?? "";
}

export function agentBuildLabel(key: string): string {
  return AGENT_BUILDS.find((b) => b.key === key)?.label ?? key;
}
