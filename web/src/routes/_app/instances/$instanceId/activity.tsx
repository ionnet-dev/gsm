import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { useState } from "react";
import { useInstanceActivity } from "@/api/instances";
import { EmptyState } from "@/components/data/empty-state";
import { Pagination } from "@/components/data/pagination";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

const parent = getRouteApi("/_app/instances/$instanceId");

export const Route = createFileRoute("/_app/instances/$instanceId/activity")({
  component: ActivityTab,
});

function ActivityTab() {
  const instanceId = Number(parent.useParams().instanceId);
  const [page, setPage] = useState(1);
  const { data } = useInstanceActivity(instanceId, page);
  return (
    <div className="grid gap-3">
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="p-0">
                  <EmptyState title="No activity yet" className="border-0" />
                </TableCell>
              </TableRow>
            )}
            {data?.items.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDateTime(e.createdAt)}
                </TableCell>
                <TableCell className="text-xs">
                  {e.actor?.name ?? <span className="text-muted-foreground">system</span>}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono">{e.action}</Badge>
                </TableCell>
                <TableCell className="max-w-md truncate font-mono text-[11px] text-muted-foreground">
                  {e.details ? JSON.stringify(e.details) : ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {data && (
        <Pagination
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          onChange={setPage}
        />
      )}
    </div>
  );
}
