import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Download } from "lucide-react";
import { useAuditLog } from "@/api/users";
import { Pagination } from "@/components/data/pagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";

export const Route = createFileRoute("/_app/settings/audit")({
  component: AuditPage,
});

function AuditPage() {
  const [page, setPage] = useState(1);
  const { data } = useAuditLog({ page, pageSize: 50 });
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button size="sm" variant="outline" asChild>
          <a href="/api/v1/audit/export?format=csv" download>
            <Download /> Export CSV
          </a>
        </Button>
        <Button size="sm" variant="outline" asChild>
          <a href="/api/v1/audit/export?format=jsonl" download>
            <Download /> Export JSON lines
          </a>
        </Button>
      </div>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>When</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Details</TableHead>
              <TableHead>IP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.items.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDateTime(e.createdAt)}
                </TableCell>
                <TableCell className="text-xs">
                  {e.actor?.name ?? <span className="text-muted-foreground">system</span>}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono">
                    {e.action}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {e.targetType ? `${e.targetType}#${e.targetId ?? ""}` : "—"}
                </TableCell>
                <TableCell className="max-w-md truncate font-mono text-[11px] text-muted-foreground">
                  {e.details ? JSON.stringify(e.details) : ""}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {e.ip ?? "—"}
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
