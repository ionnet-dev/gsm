/**
 * Host mounts: node directories an admin mounts into an instance's container. They must sit under
 * a directory the node's agent allows (`host_mounts` in its config, reported in the inventory);
 * the agent checks again, symlinks resolved, before every start.
 */
import type { HostMount } from "@gsm/shared";
import { badRequest } from "../../lib/errors.ts";
import type { Node } from "../nodes/models.ts";

const within = (path: string, root: string) => {
  const r = root.replace(/\/+$/, "");
  return path === r || path.startsWith(`${r}/`);
};

/** `volumePaths` are where the template's volumes go; a mount cannot take one of them. */
export function checkMounts(
  node: Pick<Node, "name" | "inventory">,
  mounts: HostMount[],
  volumePaths: string[] = [],
): HostMount[] {
  if (!mounts.length) return [];
  // Inventories stored before the field existed have none: nothing is allowed then.
  const roots = node.inventory?.hostMountRoots ?? [];
  if (!roots.length) {
    throw badRequest(
      `${node.name} allows no host mounts; list the directories instances may mount under host_mounts in its agent's config.yaml`,
    );
  }
  const problems: Record<string, string> = {};
  mounts.forEach((m, i) => {
    if (volumePaths.includes(m.containerPath)) {
      problems[`mounts.${i}.containerPath`] = "A template volume is mounted there";
    }
    if (!roots.some((r) => within(m.hostPath, r))) {
      problems[`mounts.${i}.hostPath`] = `Not under a directory ${node.name} allows (${
        roots.join(", ")
      })`;
    }
  });
  if (Object.keys(problems).length) throw badRequest("Some mounts are not allowed", problems);
  return mounts;
}
