import { createFileRoute } from "@tanstack/react-router";
import { Download, Rocket, Star, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { AGENT_BUILDS, agentBuildLabel } from "@gsm/shared";
import { toast } from "sonner";
import { useReleaseMutations, useReleases } from "@/api/system";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { CopyButton } from "@/components/data/copy-button";
import { EmptyState } from "@/components/data/empty-state";
import { Field } from "@/components/data/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, formatRelative } from "@/lib/format";

export const Route = createFileRoute("/_app/settings/agent-releases")({
  component: ReleasesPage,
});

function ReleasesPage() {
  const { data } = useReleases();
  const rm = useReleaseMutations();
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState("");
  const [arch, setArch] = useState("x86_64");
  const [notes, setNotes] = useState("");
  const err = (e: Error) => toast.error(e.message);
  const summary = data?.summary;

  const upload = () => {
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    form.set("version", version);
    form.set("arch", arch);
    form.set("notes", notes);
    form.set("makeLatest", "true");
    rm.upload.mutate(form, {
      onSuccess: (r) => {
        toast.success(`Uploaded ${r.release.version} (${r.release.arch})`);
        setFile(null);
        setVersion("");
        setNotes("");
      },
      onError: err,
    });
  };

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Latest</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1 font-mono text-[13px]">
            {summary &&
              Object.entries(summary.latest).map(([a, v]) => (
                <div key={a} className="flex justify-between">
                  <span className="text-muted-foreground">{agentBuildLabel(a)}</span>
                  <span>{v ?? "—"}</span>
                </div>
              ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Nodes</CardTitle>
          </CardHeader>
          <CardContent className="text-[13px]">
            <div
              className={`font-mono text-2xl ${
                summary?.outdatedNodes ? "text-status-degraded" : "text-status-online"
              }`}
            >
              {summary?.outdatedNodes ?? "—"}
            </div>
            <div className="text-xs text-muted-foreground">
              of {summary?.totalNodes ?? "—"} nodes behind the latest release
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Roll out</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            <div className="text-xs text-muted-foreground">
              Connected agents behind the latest download it, verify the checksum, replace
              themselves and restart. Instances keep running.
            </div>
            <ConfirmDialog
              trigger={
                <Button size="sm" disabled={!summary?.outdatedNodes || rm.rollout.isPending}>
                  <Rocket /> Update all outdated agents
                </Button>
              }
              title="Update every outdated agent?"
              description="Each agent restarts briefly. Offline nodes are skipped."
              confirmLabel="Update"
              onConfirm={() =>
                rm.rollout.mutate(undefined, {
                  onSuccess: (r) =>
                    toast.success(
                      `Updated ${r.updated.length} agent(s)${
                        r.failed.length ? `, ${r.failed.length} failed` : ""
                      }${r.skipped ? `, ${r.skipped} skipped` : ""}`,
                    ),
                  onError: err,
                })}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Upload a release</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Binary" htmlFor="relfile" hint="Static gsm-agent build (ELF)">
              <Input
                id="relfile"
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </Field>
            <Field label="Version" htmlFor="relver" hint="e.g. 1.4.0">
              <Input
                id="relver"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Architecture">
              <Select value={arch} onValueChange={setArch}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AGENT_BUILDS.map((b) => (
                    <SelectItem key={b.key} value={b.key}>{b.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Notes (optional)" htmlFor="relnotes">
              <Input id="relnotes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              onClick={upload}
              disabled={!file || !version.trim() || rm.upload.isPending}
            >
              <Upload /> {rm.upload.isPending ? "Uploading…" : "Upload and mark latest"}
            </Button>
            <span className="text-xs text-muted-foreground">
              Build with{" "}
              <code className="font-mono">
                go build -ldflags "-X main.version=1.4.0" -o gsm-agent ./cmd/gsm-agent
              </code>
            </span>
          </div>
        </CardContent>
      </Card>

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Version</TableHead>
              <TableHead>Architecture</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>SHA-256</TableHead>
              <TableHead>Nodes</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead className="w-28" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data?.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="p-0">
                  <EmptyState
                    icon={Download}
                    title="No releases"
                    description="Upload an agent binary so the install script and self-update have something to serve."
                    className="border-0"
                  />
                </TableCell>
              </TableRow>
            )}
            {data?.items.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono">
                  {r.version}{" "}
                  {r.isLatest && <Badge variant="default" className="ml-1">latest</Badge>}
                  {r.notes && (
                    <div className="text-xs font-sans text-muted-foreground">{r.notes}</div>
                  )}
                </TableCell>
                <TableCell className="text-xs">{agentBuildLabel(r.arch)}</TableCell>
                <TableCell className="font-mono text-xs">{formatBytes(r.size)}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {r.sha256.slice(0, 16)}… <CopyButton value={r.sha256} label="Copy checksum" />
                </TableCell>
                <TableCell className="font-mono text-xs">{r.nodeCount}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatRelative(r.createdAt)}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <CopyButton
                      value={`${location.origin}/downloads/gsm-agent/${r.version}/${r.arch}`}
                      label="Copy download URL"
                    />
                    {!r.isLatest && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Mark latest"
                        title="Mark latest"
                        onClick={() => rm.setLatest.mutate(r.id, { onError: err })}
                      >
                        <Star />
                      </Button>
                    )}
                    {!r.isLatest && (
                      <ConfirmDialog
                        trigger={
                          <Button variant="ghost" size="icon-sm" aria-label="Delete">
                            <Trash2 />
                          </Button>
                        }
                        title={`Delete ${r.version} (${r.arch})?`}
                        confirmLabel="Delete"
                        onConfirm={() => rm.remove.mutate(r.id, { onError: err })}
                      />
                    )}
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
