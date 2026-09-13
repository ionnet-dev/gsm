export interface AgentReleaseDto {
  id: number;
  version: string;
  arch: string;
  sha256: string;
  size: number;
  notes: string | null;
  isLatest: boolean;
  createdAt: string;
  /** nodes running exactly this version */
  nodeCount: number;
}

export interface AgentReleaseSummary {
  latest: Record<string, string | null>; // arch -> version
  outdatedNodes: number;
  totalNodes: number;
}
