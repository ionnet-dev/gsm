import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { roleAllows } from "@gsm/shared";
import { useInstance } from "@/api/instances";
import { EmptyState } from "@/components/data/empty-state";
import { FileManager } from "@/components/files/file-manager";
import { SftpBar } from "@/components/files/sftp-panel";

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
  const canEdit = roleAllows(instance.myRole, "files");
  return (
    <div className="grid gap-3">
      {canEdit && <SftpBar instanceId={instanceId} />}
      <FileManager instanceId={instanceId} canEdit={canEdit} />
    </div>
  );
}
