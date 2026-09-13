import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { roleAllows } from "@gsm/shared";
import { useInstance } from "@/api/instances";
import { EmptyState } from "@/components/data/empty-state";
import { FileManager } from "@/components/files/file-manager";

const parent = getRouteApi("/_app/instances/$instanceId");

export const Route = createFileRoute("/_app/instances/$instanceId/files")({
  component: FilesTab,
});

function FilesTab() {
  const instanceId = Number(parent.useParams().instanceId);
  const { data: instance } = useInstance(instanceId);
  if (!instance) return null;
  if (instance.node.status === "offline") {
    return <EmptyState title="Node offline" description="Files are read live from the node." />;
  }
  return <FileManager instanceId={instanceId} canEdit={roleAllows(instance.myRole, "files")} />;
}
