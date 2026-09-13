import { Link } from "@tanstack/react-router";
import { KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { InstanceSftpDto } from "@gsm/shared";
import { errorMessage } from "@/api/client";
import { useInstanceSftp, useSftpPassword } from "@/api/sftp";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { CopyButton } from "@/components/data/copy-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { formatRelative } from "@/lib/format";
import { REACHABILITY_LABEL } from "@/components/instances/reachability";

/** A line above the file manager with the SFTP address; the dialog has the rest. */
export function SftpBar({ instanceId }: { instanceId: number }) {
  const { data: s } = useInstanceSftp(instanceId);
  if (!s) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-2 text-xs">
      <span className="font-medium">SFTP</span>
      {s.available
        ? (
          <span className="flex min-w-0 items-center gap-1 font-mono text-muted-foreground">
            <span className="truncate">{s.username}@{s.host}:{s.port}</span>
            <CopyButton value={`sftp://${s.username}@${s.host}:${s.port}`} label="Copy address" />
          </span>
        )
        : <span className="text-muted-foreground">{s.problem}</span>}
      {s.available && s.reachable && s.reachable.status !== "open" && (
        <span className="text-status-degraded" title={s.reachable.detail ?? undefined}>
          {s.reachable.status === "untested"
            ? "Not checked from outside"
            : "Not reachable from outside"}
        </span>
      )}
      <span className="flex-1" />
      <SftpDialog instanceId={instanceId} sftp={s} />
    </div>
  );
}

function Row({ k, v, mono = true }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <span className="text-muted-foreground">{k}</span>
      <span className={`flex min-w-0 items-center gap-1 ${mono ? "font-mono" : ""}`}>
        <span className="truncate" title={v}>{v}</span>
        <CopyButton value={v} label={`Copy ${k.toLowerCase()}`} />
      </span>
    </>
  );
}

function SftpDialog({ instanceId, sftp: s }: { instanceId: number; sftp: InstanceSftpDto }) {
  const [issued, setIssued] = useState<string | null>(null);
  const pw = useSftpPassword(instanceId);
  const err = (e: Error) => toast.error(errorMessage(e));
  const makePassword = () =>
    pw.reset.mutate(undefined, { onSuccess: (r) => setIssued(r.password), onError: err });
  return (
    <Dialog onOpenChange={(open) => !open && setIssued(null)}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">Connection details</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>SFTP access</DialogTitle>
          <DialogDescription>
            Connect with FileZilla, WinSCP, Cyberduck or{" "}
            <code className="font-mono">sftp</code>. You only see this instance's files, and you can
            reach them while the server is stopped.
          </DialogDescription>
        </DialogHeader>
        {!s.available && (
          <p className="rounded-md border border-status-degraded/40 bg-status-degraded/5 p-2 text-xs">
            {s.problem}
          </p>
        )}
        <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-xs">
          <Row k="Host" v={s.host} />
          <Row k="Port" v={s.port === null ? "—" : String(s.port)} />
          <Row k="Username" v={s.username} />
          {s.hostKey && <Row k="Host key" v={s.hostKey} />}
        </div>
        {s.reachable && (
          <p className="text-xs text-muted-foreground">
            From outside:{" "}
            <span
              className={s.reachable.status === "open"
                ? "text-status-online"
                : "text-status-degraded"}
            >
              {REACHABILITY_LABEL[s.reachable.status].toLowerCase()}
            </span>
            {s.reachable.detail ? ` (${s.reachable.detail})` : ""}, checked{" "}
            {formatRelative(s.reachable.checkedAt)}.
          </p>
        )}
        {s.port !== null && (
          <div className="rounded bg-muted p-2 font-mono text-[11px] text-muted-foreground">
            sftp -P {s.port} {s.username}@{s.host}
          </div>
        )}
        <div className="grid gap-2 border-t pt-3">
          <div className="text-xs font-medium">Password</div>
          {issued && (
            <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
              <div className="mb-1 text-xs font-medium text-primary">
                Copy it now; it is shown once
              </div>
              <div className="flex items-center gap-2 font-mono text-sm break-all">
                {issued} <CopyButton value={issued} label="Copy password" />
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="flex-1">
              {s.password
                ? `Set ${formatRelative(s.password.createdAt)}, last used ${
                  formatRelative(s.password.lastUsedAt)
                }. It works on this instance only.`
                : "No SFTP password yet. It is separate from your panel password and works on this instance only."}
            </span>
            {s.password
              ? (
                <>
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="outline" disabled={pw.reset.isPending}>
                        <RefreshCw /> New password
                      </Button>
                    }
                    title="Replace your SFTP password?"
                    description="The current one stops working and its open connections close."
                    confirmLabel="Replace"
                    onConfirm={makePassword}
                  />
                  <ConfirmDialog
                    trigger={
                      <Button size="icon-sm" variant="ghost" aria-label="Remove password">
                        <Trash2 />
                      </Button>
                    }
                    title="Remove your SFTP password?"
                    description="Sign-ins with it stop working; SSH keys keep working."
                    confirmLabel="Remove"
                    onConfirm={() =>
                      pw.remove.mutate(undefined, {
                        onSuccess: () => setIssued(null),
                        onError: err,
                      })}
                  />
                </>
              )
              : (
                <Button size="sm" onClick={makePassword} disabled={pw.reset.isPending}>
                  Create password
                </Button>
              )}
          </div>
        </div>
        <div className="flex items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
          <KeyRound className="size-4 shrink-0" />
          <span>
            {s.sshKeys
              ? `Your ${s.sshKeys} SSH key${s.sshKeys === 1 ? "" : "s"} also work here.`
              : "SSH keys work too, on every instance you manage files on."}{" "}
            <Link to="/settings/account" className="underline hover:text-foreground">
              Manage SSH keys
            </Link>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
