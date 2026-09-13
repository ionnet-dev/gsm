import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useInstance } from "@/api/instances";
import { InstanceConsole } from "@/components/instances/console";

const parent = getRouteApi("/_app/instances/$instanceId");

export const Route = createFileRoute("/_app/instances/$instanceId/")({
  component: ConsoleTab,
});

function ConsoleTab() {
  const instanceId = Number(parent.useParams().instanceId);
  const { data: instance } = useInstance(instanceId);
  if (!instance) return null;
  return <InstanceConsole instance={instance} />;
}
