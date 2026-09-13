import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { Download, Loader2, Plus, Radio, RefreshCw, Trash2, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { NodeDetailDto, PullProgress } from "@gsm/shared";
import { useAuth } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useInstances } from "@/api/instances";
import { managesNodes, useNode, useNodeAccess, useNodeImages, useNodeMutations } from "@/api/nodes";
import { useUserDirectory } from "@/api/users";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { CopyButton } from "@/components/data/copy-button";
import { EmptyState } from "@/components/data/empty-state";
import { ErrorView, PendingView } from "@/components/data/error-view";
import { Field } from "@/components/data/field";
import { PercentChart, RateChart, type SamplePoint } from "@/components/data/metric-chart";
import { InstanceStatusBadge } from "@/components/data/status-badge";
import { StatusDot } from "@/components/data/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes, formatDateTime, formatRelative, formatUptime } from "@/lib/format";
import { uiSocket } from "@/ws/ui-socket";

export const Route = createFileRoute("/_app/nodes/$nodeId")({
  beforeLoad: async ({ context }) => {
    if (!(await managesNodes(context.queryClient))) throw redirect({ to: "/" });
  },
  component: NodePage,
  errorComponent: ({ error, reset }) => <ErrorView error={error} reset={reset} />,
});

const MAX_POINTS = 120;

function NodePage() {
  const nodeId = Number(Route.useParams().nodeId);
  const q = useNode(nodeId);
  const nm = useNodeMutations();
  if (q.isLoading) return <PendingView />;
  if (q.error) return <ErrorView error={q.error} reset={() => q.refetch()} />;
  const n = q.data!.node;
  const err = (e: Error) => toast.error(errorMessage(e));
  return (
    <>
      <div className="border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div>
            <div className="flex items-center gap-2">
              <StatusDot status={n.status} />
              <h1 className="text-lg font-semibold tracking-tight">{n.name}</h1>
              {n.agentVersion && (
                <Badge variant="outline" className="font-mono">v{n.agentVersion}</Badge>
              )}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {n.hostname} · {n.os.prettyName ?? "unknown OS"} · {n.arch ?? "?"} ·{" "}
              {n.status === "online" ? "online" : `last seen ${formatRelative(n.lastSeenAt)}`}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={n.status !== "online" || nm.ping.isPending}
              onClick={() =>
                nm.ping.mutate(n.id, {
                  onSuccess: (r) =>
                    toast.success(`Pong in ${r.rttMs} ms (agent ${r.agentVersion})`),
                  onError: err,
                })}
            >
              <Radio /> Ping
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={n.status !== "online" || nm.refresh.isPending}
              onClick={() => nm.refresh.mutate(n.id, { onError: err })}
            >
              <RefreshCw /> Refresh inventory
            </Button>
          </div>
        </div>
      </div>
      <div className="p-4 sm:p-6">
        <Tabs defaultValue="overview">
          <TabsList className="mb-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="instances">Instances</TabsTrigger>
            <TabsTrigger value="ports">Ports</TabsTrigger>
            <TabsTrigger value="images">Images</TabsTrigger>
            <TabsTrigger value="owners">Owners</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <Overview node={n} />
          </TabsContent>
          <TabsContent value="instances">
            <NodeInstances nodeId={n.id} />
          </TabsContent>
          <TabsContent value="ports">
            <Ports node={n} />
          </TabsContent>
          <TabsContent value="images">
            <Images node={n} />
          </TabsContent>
          <TabsContent value="owners">
            <Owners nodeId={n.id} />
          </TabsContent>
          <TabsContent value="settings">
            <NodeSettings node={n} />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

function Overview({ node: n }: { node: NodeDetailDto }) {
  const [points, setPoints] = useState<SamplePoint[]>([]);
  const seeded = useRef(false);
  useEffect(() => {
    const add = (m: NonNullable<NodeDetailDto["lastMetrics"]>) =>
      setPoints((ps) => {
        if (ps.length && ps[ps.length - 1].at === m.at) return ps;
        const p: SamplePoint = {
          at: m.at,
          cpu: m.cpuPct,
          mem: m.memTotalBytes ? (m.memUsedBytes / m.memTotalBytes) * 100 : 0,
          Download: m.net.rxBytesPerSec,
          Upload: m.net.txBytesPerSec,
        };
        return [...ps, p].slice(-MAX_POINTS);
      });
    if (!seeded.current && n.lastMetrics) {
      seeded.current = true;
      add(n.lastMetrics);
    }
    return uiSocket.on("node.metrics", (d) => {
      if (d.nodeId === n.id) add(d.metrics);
    });
  }, [n.id, n.lastMetrics]);
  const m = n.lastMetrics;
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>CPU and memory</CardTitle>
          <span className="text-xs text-muted-foreground">live, last {MAX_POINTS} samples</span>
        </CardHeader>
        <CardContent>
          <PercentChart
            points={points}
            keys={[
              { key: "cpu", label: "CPU", color: "var(--primary)" },
              { key: "mem", label: "Memory", color: "oklch(0.75 0.15 155)" },
            ]}
          />
          <RateChart points={points} height={120} />
        </CardContent>
      </Card>
      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Facts</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            <Fact
              k="CPU"
              v={`${n.cpu.model ?? "?"} (${n.cpu.cores ?? "?"}c/${n.cpu.threads ?? "?"}t)`}
            />
            <Fact k="Memory" v={formatBytes(n.memoryTotal, 0)} />
            <Fact k="Kernel" v={n.inventory?.kernel ?? "—"} />
            <Fact k="Uptime" v={m ? formatUptime(m.uptimeSeconds) : "—"} />
            <Fact k="Load" v={m ? m.load.map((l) => l.toFixed(2)).join(" ") : "—"} />
            <Fact k="Public address" v={n.publicAddress} copy />
            <Fact k="Agent from" v={n.remoteAddress ?? "—"} />
            <Fact k="Data dir" v={n.dataDir ?? "—"} />
            <Fact k="Data used" v={m ? formatBytes(m.dataUsedBytes) : "—"} />
            <Fact k="Enrolled" v={formatDateTime(n.enrolledAt)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Docker</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            {n.docker?.available
              ? (
                <>
                  <Fact k="Version" v={n.docker.version} />
                  <Fact k="API" v={n.docker.apiVersion} />
                  <Fact k="Storage" v={n.docker.storageDriver} />
                  <Fact k="Root" v={n.docker.rootDir} />
                </>
              )
              : (
                <div className="col-span-2 text-status-critical">
                  Docker is not available: {n.docker?.error || "no report yet"}
                </div>
              )}
          </CardContent>
        </Card>
        {m && m.disks.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Disks</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1 text-xs">
              {m.disks.map((d) => (
                <div
                  key={d.mountpoint}
                  className="flex items-center justify-between gap-2 font-mono"
                >
                  <span className="truncate">{d.mountpoint}</span>
                  <span className="text-muted-foreground">
                    {formatBytes(d.usedBytes, 0)} / {formatBytes(d.totalBytes, 0)}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function Fact({ k, v, copy }: { k: string; v: string; copy?: boolean }) {
  return (
    <>
      <span className="text-muted-foreground">{k}</span>
      <span className="flex min-w-0 items-center gap-1 truncate font-mono" title={v}>
        <span className="truncate">{v}</span>
        {copy && v && <CopyButton value={v} />}
      </span>
    </>
  );
}

function NodeInstances({ nodeId }: { nodeId: number }) {
  const { data } = useInstances({ nodeId, pageSize: 200 });
  if (!data) return null;
  if (!data.items.length) return <EmptyState title="No instances on this node" />;
  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Instance</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Memory limit</TableHead>
            <TableHead>Ports</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.map((i) => (
            <TableRow key={i.id}>
              <TableCell>
                <Link
                  to="/instances/$instanceId"
                  params={{ instanceId: String(i.id) }}
                  className="font-medium hover:underline"
                >
                  {i.template.icon} {i.name}
                </Link>
              </TableCell>
              <TableCell>
                <InstanceStatusBadge status={i.status} />
              </TableCell>
              <TableCell className="font-mono text-xs">
                {i.limits.memoryMb ? `${i.limits.memoryMb} MB` : "unlimited"}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {i.ports.map((p) => `${p.port}/${p.protocol}`).join(", ")}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Ports({ node: n }: { node: NodeDetailDto }) {
  return (
    <div className="grid gap-3">
      <div className="text-xs text-muted-foreground">
        Pool {n.portRangeStart}–{n.portRangeEnd} on {n.bindAddress}; {n.portsInUse.length} in use.
      </div>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Port</TableHead>
              <TableHead>Protocol</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Instance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {n.portsInUse.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="p-0">
                  <EmptyState title="No ports reserved" className="border-0" />
                </TableCell>
              </TableRow>
            )}
            {n.portsInUse.map((p) => (
              <TableRow key={`${p.port}/${p.protocol}`}>
                <TableCell className="font-mono">{p.port}</TableCell>
                <TableCell className="font-mono text-xs">{p.protocol}</TableCell>
                <TableCell className="text-xs">{p.name}</TableCell>
                <TableCell>
                  <Link
                    to="/instances/$instanceId"
                    params={{ instanceId: String(p.instanceId) }}
                    className="text-xs hover:underline"
                  >
                    #{p.instanceId}
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function Images({ node: n }: { node: NodeDetailDto }) {
  const online = n.status === "online" && !!n.docker?.available;
  const { data: images = [], error, isLoading } = useNodeImages(n.id, online);
  const nm = useNodeMutations();
  const [ref, setRef] = useState("");
  const [pull, setPull] = useState<
    { ref: string; progress: PullProgress | null; error: string | null } | null
  >(null);
  useEffect(() =>
    uiSocket.on("image.pull", (d) => {
      if (d.nodeId !== n.id) return;
      if (d.done) {
        if (d.error) toast.error(`Pull of ${d.ref} failed: ${d.error}`);
        else toast.success(`Pulled ${d.ref}`);
        setPull(null);
      } else setPull({ ref: d.ref, progress: d.progress, error: d.error });
    }), [n.id]);
  const err = (e: Error) => toast.error(errorMessage(e));
  return (
    <div className="grid gap-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ref.trim()) return;
          setPull({ ref: ref.trim(), progress: null, error: null });
          nm.pullImage.mutate({ id: n.id, ref: ref.trim() }, {
            onError: (e) => {
              setPull(null);
              err(e);
            },
          });
          setRef("");
        }}
      >
        <Input
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="ghcr.io/ionnet-dev/gsm-java:21"
          className="w-80 font-mono"
          disabled={!online}
        />
        <Button type="submit" size="sm" disabled={!online || !ref.trim() || !!pull}>
          <Download /> Pull
        </Button>
        {pull && (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Pulling {pull.ref}
            {pull.progress && (
              <span className="font-mono">
                {" "}· {pull.progress.status}
                {pull.progress.total > 0 &&
                  ` ${Math.round((pull.progress.current / pull.progress.total) * 100)}%`}
              </span>
            )}
          </span>
        )}
      </form>
      {!online && (
        <EmptyState title="Node offline" description="Images are listed live from Docker." />
      )}
      {error && <EmptyState title="Couldn't list images" description={errorMessage(error)} />}
      {online && !error && (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Image</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center">
                    <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && images.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="p-0">
                    <EmptyState
                      title="No images yet"
                      description="They are pulled at first start."
                      className="border-0"
                    />
                  </TableCell>
                </TableRow>
              )}
              {images.map((img) => (
                <TableRow key={img.id}>
                  <TableCell className="font-mono text-xs">{img.ref}</TableCell>
                  <TableCell className="font-mono text-xs">{formatBytes(img.size, 0)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatRelative(img.created)}
                  </TableCell>
                  <TableCell>
                    <ConfirmDialog
                      trigger={
                        <Button variant="ghost" size="icon-sm" aria-label="Remove image">
                          <Trash2 />
                        </Button>
                      }
                      title={`Remove ${img.ref}?`}
                      description="Fails while a container uses it; it is pulled again at the next start."
                      confirmLabel="Remove"
                      onConfirm={() =>
                        nm.removeImage.mutate({ id: n.id, ref: img.ref }, { onError: err })}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function NodeSettings({ node: n }: { node: NodeDetailDto }) {
  const nm = useNodeMutations();
  const navigate = useNavigate();
  const { admin } = useAuth();
  const [name, setName] = useState(n.name);
  const [publicAddress, setPublicAddress] = useState(n.publicAddress);
  const [bindAddress, setBindAddress] = useState(n.bindAddress);
  const [start, setStart] = useState(n.portRangeStart);
  const [end, setEnd] = useState(n.portRangeEnd);
  const [notes, setNotes] = useState(n.notes ?? "");
  const err = (e: Error) => toast.error(errorMessage(e));
  return (
    <div className="grid max-w-2xl gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Node</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Field label="Name" htmlFor="nname">
            <Input id="nname" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Public address"
              htmlFor="npub"
              hint={`Shown to players. Empty uses the agent's address (${n.remoteAddress ?? "?"}).`}
            >
              <Input
                id="npub"
                value={publicAddress}
                onChange={(e) => setPublicAddress(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Bind address" htmlFor="nbind" hint="Where instance ports are published.">
              <Input
                id="nbind"
                value={bindAddress}
                onChange={(e) => setBindAddress(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Port pool start" htmlFor="nps">
              <Input
                id="nps"
                type="number"
                min={1024}
                max={65535}
                value={start}
                onChange={(e) => setStart(Number(e.target.value))}
              />
            </Field>
            <Field label="Port pool end" htmlFor="npe">
              <Input
                id="npe"
                type="number"
                min={1024}
                max={65535}
                value={end}
                onChange={(e) => setEnd(Number(e.target.value))}
              />
            </Field>
          </div>
          <Field label="Notes" htmlFor="nnotes">
            <Textarea
              id="nnotes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </Field>
          <Button
            className="justify-self-start"
            size="sm"
            disabled={nm.update.isPending || !name.trim()}
            onClick={() =>
              nm.update.mutate(
                {
                  id: n.id,
                  name: name.trim(),
                  publicAddress,
                  bindAddress,
                  portRangeStart: start,
                  portRangeEnd: end,
                  notes: notes || null,
                },
                { onSuccess: () => toast.success("Saved"), onError: err },
              )}
          >
            Save
          </Button>
        </CardContent>
      </Card>
      {admin && (
        <Card className="border-status-critical/40">
          <CardHeader>
            <CardTitle className="text-status-critical">Danger zone</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-muted-foreground">
              Removes the node from the panel. Refused while it hosts instances; the agent on the
              machine keeps running until you uninstall it.
            </div>
            <ConfirmDialog
              trigger={<Button variant="destructive" size="sm">Delete node</Button>}
              title={`Delete ${n.name}?`}
              description="The agent's credentials stop working. Re-enrolling the same machine re-creates it."
              confirmLabel="Delete"
              onConfirm={() =>
                nm.remove.mutate(n.id, {
                  onSuccess: () => navigate({ to: "/nodes" }),
                  onError: err,
                })}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Owners({ nodeId }: { nodeId: number }) {
  const { admin, user: me } = useAuth();
  const { data: owners = [] } = useNodeAccess(nodeId);
  const nm = useNodeMutations();
  const err = (e: Error) => toast.error(errorMessage(e));
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="max-w-2xl text-xs text-muted-foreground">
          Owners manage this node (settings, images, new instances) and are owner of every instance
          on it, including instances created later. Only administrators add or remove owners.
        </div>
        {admin && (
          <AddOwnerDialog
            exclude={owners.map((o) => o.userId)}
            busy={nm.grant.isPending}
            onAdd={(userId) =>
              nm.grant.mutate({ id: nodeId, userId }, {
                onSuccess: () => toast.success("Owner added"),
                onError: err,
              })}
          />
        )}
      </div>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>User</TableHead>
              <TableHead>Added</TableHead>
              {admin && <TableHead className="w-12" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {owners.length === 0 && (
              <TableRow>
                <TableCell colSpan={admin ? 3 : 2} className="p-0">
                  <EmptyState
                    icon={Users}
                    title="No owners"
                    description="Only administrators manage this node."
                    className="border-0"
                  />
                </TableCell>
              </TableRow>
            )}
            {owners.map((o) => (
              <TableRow key={o.userId}>
                <TableCell>
                  <div className="font-medium">
                    {o.name}{" "}
                    {o.userId === me?.id && (
                      <span className="text-xs text-muted-foreground">(you)</span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{o.email}</div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatRelative(o.grantedAt)}
                </TableCell>
                {admin && (
                  <TableCell>
                    <ConfirmDialog
                      trigger={
                        <Button variant="ghost" size="icon-sm" aria-label="Remove owner">
                          <Trash2 />
                        </Button>
                      }
                      title={`Remove ${o.name} as owner?`}
                      description="They lose this node and its instances, except instances shared with them directly."
                      confirmLabel="Remove"
                      onConfirm={() =>
                        nm.revoke.mutate({ id: nodeId, userId: o.userId }, { onError: err })}
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function AddOwnerDialog(
  { exclude, busy, onAdd }: {
    exclude: number[];
    busy: boolean;
    onAdd: (userId: number) => void;
  },
) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const { data: users = [] } = useUserDirectory(open);
  const candidates = users.filter((u) => !exclude.includes(u.id) && u.role !== "admin");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> Add owner
        </Button>
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add an owner</DialogTitle>
          <DialogDescription>
            They get full access to this node and every instance on it. Administrators already have
            it.
          </DialogDescription>
        </DialogHeader>
        <Field label="User">
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger>
              <SelectValue placeholder="Pick a user" />
            </SelectTrigger>
            <SelectContent>
              {candidates.length === 0 && (
                <SelectItem value="none" disabled>No other users</SelectItem>
              )}
              {candidates.map((u) => (
                <SelectItem key={u.id} value={String(u.id)}>{u.name} · {u.email}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            disabled={!userId || userId === "none" || busy}
            onClick={() => {
              onAdd(Number(userId));
              setOpen(false);
              setUserId("");
            }}
          >
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
