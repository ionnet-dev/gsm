import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Archive, Download, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { BackupDto } from "@gsm/shared";
import { useBackupMutations, useBackups } from "@/api/backups";
import { errorMessage } from "@/api/client";
import { useInstance } from "@/api/instances";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { EmptyState } from "@/components/data/empty-state";
import { Field } from "@/components/data/field";
import { BackupStatusBadge } from "@/components/data/status-badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes, formatDateTime } from "@/lib/format";

const parent = getRouteApi("/_app/instances/$instanceId");

export const Route = createFileRoute("/_app/instances/$instanceId/backups")({
  component: BackupsTab,
});

function BackupsTab() {
  const instanceId = Number(parent.useParams().instanceId);
  const { data: instance } = useInstance(instanceId);
  const { data: backups = [] } = useBackups(instanceId);
  const bm = useBackupMutations(instanceId);
  const err = (e: Error) => toast.error(errorMessage(e));
  const stopped = instance?.status === "stopped" || instance?.status === "crashed";

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          Archives of the whole data directory, kept on the node. Restoring needs a stopped
          instance.
        </div>
        <CreateBackupDialog
          busy={bm.create.isPending}
          onCreate={(b) =>
            bm.create.mutate(b, {
              onSuccess: () => toast.success("Backup started"),
              onError: err,
            })}
        />
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-32" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {backups.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="p-0">
                  <EmptyState
                    icon={Archive}
                    title="No backups"
                    description="Create one before big changes; they are cheap."
                    className="border-0"
                  />
                </TableCell>
              </TableRow>
            )}
            {backups.map((b) => (
              <TableRow key={b.id}>
                <TableCell>
                  <div className="font-medium">{b.name || b.backupId.slice(0, 8)}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">{b.backupId}</div>
                  {b.error && <div className="text-xs text-status-critical">{b.error}</div>}
                </TableCell>
                <TableCell>
                  <BackupStatusBadge status={b.status} />
                  {b.status === "running" && (
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {formatBytes(b.progressBytes)} so far
                    </div>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {b.size !== null ? formatBytes(b.size) : "—"}
                  {b.files !== null && (
                    <span className="text-muted-foreground">· {b.files} files</span>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatDateTime(b.createdAt)}
                  {b.createdBy && <div>by {b.createdBy.name}</div>}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Download"
                      disabled={b.status !== "completed"}
                      onClick={() => bm.download.mutate(b.backupId, { onError: err })}
                    >
                      <Download />
                    </Button>
                    <RestoreDialog
                      backup={b}
                      disabled={b.status !== "completed" || !stopped}
                      busy={bm.restore.isPending}
                      onRestore={(wipe) =>
                        bm.restore.mutate({ backupId: b.backupId, wipe }, {
                          onSuccess: () => toast.success("Restore started"),
                          onError: err,
                        })}
                    />
                    <ConfirmDialog
                      trigger={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Delete"
                          disabled={b.status === "running"}
                        >
                          <Trash2 />
                        </Button>
                      }
                      title={`Delete backup ${b.name || b.backupId.slice(0, 8)}?`}
                      description="The archive is removed from the node. This can't be undone."
                      confirmLabel="Delete"
                      onConfirm={() => bm.remove.mutate(b.backupId, { onError: err })}
                    />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function CreateBackupDialog(
  { busy, onCreate }: { busy: boolean; onCreate: (b: { name: string; ignore: string[] }) => void },
) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [ignore, setIgnore] = useState("");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> Create backup
        </Button>
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Create backup</DialogTitle>
          <DialogDescription>
            A running server keeps running; files that change mid-way may be inconsistent.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Name (optional)" htmlFor="bname">
            <Input
              id="bname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Before the 1.21 update"
              autoFocus
            />
          </Field>
          <Field
            label="Extra paths to leave out"
            htmlFor="bignore"
            hint="One glob per line, on top of the template's defaults (logs, caches)."
          >
            <Textarea
              id="bignore"
              value={ignore}
              onChange={(e) => setIgnore(e.target.value)}
              rows={3}
              className="font-mono"
              placeholder={"logs/**\n*.tmp"}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            disabled={busy}
            onClick={() => {
              onCreate({
                name: name.trim(),
                ignore: ignore.split("\n").map((l) => l.trim()).filter(Boolean),
              });
              setOpen(false);
              setName("");
              setIgnore("");
            }}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RestoreDialog(
  { backup, disabled, busy, onRestore }: {
    backup: BackupDto;
    disabled: boolean;
    busy: boolean;
    onRestore: (wipe: boolean) => void;
  },
) {
  const [open, setOpen] = useState(false);
  const [wipe, setWipe] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Restore"
          title={disabled ? "Stop the instance first" : "Restore"}
          disabled={disabled}
        >
          <RotateCcw />
        </Button>
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Restore {backup.name || backup.backupId.slice(0, 8)}?</DialogTitle>
          <DialogDescription>
            Files in the archive overwrite the ones in the instance. Current files not in the
            archive are kept unless you wipe first.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-xs">
          <Checkbox checked={wipe} onCheckedChange={(v) => setWipe(!!v)} />
          Empty the data directory before restoring
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            variant={wipe ? "destructive" : "default"}
            disabled={busy}
            onClick={() => {
              onRestore(wipe);
              setOpen(false);
            }}
          >
            Restore
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
