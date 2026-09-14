import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  HostMount,
  InstanceDetailDto,
  InstanceVolumeDto,
  NodeDetailDto,
  TemplateDetailDto,
} from "@gsm/shared";
import {
  BUILTIN_VARIABLES,
  containerPathProblem,
  hostPathProblem,
  portRun,
  roleAllows,
  validateVariable,
} from "@gsm/shared";
import { useAuth } from "@/api/auth";
import { ApiError, errorMessage } from "@/api/client";
import { useInstance, useInstanceMutations } from "@/api/instances";
import { useNode } from "@/api/nodes";
import { useTemplate } from "@/api/templates";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { Field } from "@/components/data/field";
import { VariableFields } from "@/components/instances/variable-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const parent = getRouteApi("/_app/instances/$instanceId");

export const Route = createFileRoute("/_app/instances/$instanceId/settings")({
  component: SettingsTab,
});

function SettingsTab() {
  const instanceId = Number(parent.useParams().instanceId);
  const { data: instance } = useInstance(instanceId);
  const { data: template } = useTemplate(instance?.template.id ?? null);
  if (!instance || !template) return null;
  return <SettingsForm instance={instance} template={template} />;
}

function SettingsForm(
  { instance: i, template }: { instance: InstanceDetailDto; template: TemplateDetailDto },
) {
  const navigate = useNavigate();
  const { update, reinstall, remove } = useInstanceMutations();
  const { data: nodeDetail } = useNode(i.node.id);
  const def = template.definition;
  const canSettings = roleAllows(i.myRole, "settings");
  // Admins and the node's owners are owners too: they see hidden and change fixed values.
  const owner = i.myRole === "owner";
  const running = i.status !== "stopped" && i.status !== "crashed" && i.status !== "install_failed";
  const [name, setName] = useState(i.name);
  const [description, setDescription] = useState(i.description ?? "");
  const [image, setImage] = useState(i.image);
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [limits, setLimits] = useState(i.limits);
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [restartOnCrash, setRestartOnCrash] = useState(i.restartOnCrash);
  const [autoStart, setAutoStart] = useState(i.autoStart);
  const [startup, setStartup] = useState(i.startupOverride ?? "");
  const [keepFiles, setKeepFiles] = useState(false);

  useEffect(() => {
    setName(i.name);
    setDescription(i.description ?? "");
    setImage(i.image);
    setVariables({ ...i.variables });
    setLimits(i.limits);
    setPorts(Object.fromEntries(i.ports.map((p) => [p.name, String(p.port)])));
    setRestartOnCrash(i.restartOnCrash);
    setAutoStart(i.autoStart);
    setStartup(i.startupOverride ?? "");
  }, [i]);

  const problems = def.variables
    .filter((v) => v.name in variables)
    .map((v) => validateVariable(v, variables[v.name]))
    .filter(Boolean);
  const inUse = new Set(
    (nodeDetail?.node.portsInUse ?? []).filter((p) => p.instanceId !== i.id).map((p) => p.port),
  );
  // A port that follows another is always that port plus its offset; it is shown, never sent.
  const followerOf = (name: string) => {
    const run = portRun(def.ports, name);
    return run.offset > 0 ? run : null;
  };
  const portValue = (name: string) => {
    const run = followerOf(name);
    if (!run) return ports[name] ?? "";
    const head = ports[run.head] ?? "";
    return head !== "" && Number.isInteger(Number(head)) ? String(Number(head) + run.offset) : "";
  };
  const portsChanged = i.ports.some((p) => portValue(p.name) !== String(p.port));
  const portsBad = i.ports.some((p) => {
    const n = Number(portValue(p.name));
    return !Number.isInteger(n) || n < 1 || n > 65535 || inUse.has(n);
  });
  const images = [
    { label: "Default", ref: def.image },
    ...def.images.filter((x) => x.ref !== def.image),
  ];
  if (!images.some((x) => x.ref === i.image)) images.push({ label: "Current", ref: i.image });

  const save = () =>
    update.mutate(
      {
        id: i.id,
        name: name.trim(),
        description: description.trim() || null,
        variables,
        restartOnCrash,
        autoStart,
        ...(owner ? { startupOverride: startup.trim() || null } : {}),
        ...(running ? {} : {
          image,
          limits,
          ports: Object.fromEntries(
            Object.entries(ports).filter(([k]) => !followerOf(k)).map(([k, v]) => [k, Number(v)]),
          ),
        }),
      },
      { onSuccess: () => toast.success("Saved"), onError: (e) => toast.error(errorMessage(e)) },
    );

  return (
    <div className="grid gap-4">
      {!canSettings && (
        <p className="text-xs text-muted-foreground">
          You can view these settings; changing them needs the operator role.
        </p>
      )}
      <fieldset disabled={!canSettings} className="contents">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>General</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Field label="Name" htmlFor="sname">
                <Input id="sname" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Description" htmlFor="sdesc">
                <Textarea
                  id="sdesc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                />
              </Field>
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={restartOnCrash} onCheckedChange={setRestartOnCrash} />
                Restart when the server crashes
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={autoStart} onCheckedChange={setAutoStart} />
                Start automatically when the node comes up
              </label>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Runtime</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {running && (
                <p className="text-xs text-status-degraded">
                  Image, resources and ports can only change while the instance is stopped.
                </p>
              )}
              <Field label="Image">
                <Combobox
                  value={image}
                  onValueChange={setImage}
                  disabled={running}
                  className="font-mono"
                  itemClassName="font-mono"
                  searchPlaceholder="Search images…"
                  options={images.map((x) => ({
                    value: x.ref,
                    label: x.label !== "Default" ? `${x.label} · ${x.ref}` : x.ref,
                  }))}
                />
              </Field>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Memory (MB)" htmlFor="smem" hint="0 = unlimited">
                  <Input
                    id="smem"
                    type="number"
                    min={0}
                    disabled={running}
                    value={limits.memoryMb}
                    onChange={(e) => setLimits({ ...limits, memoryMb: Number(e.target.value) })}
                  />
                </Field>
                <Field label="CPU cores" htmlFor="scpu" hint="0 = unlimited">
                  <Input
                    id="scpu"
                    type="number"
                    min={0}
                    step={0.5}
                    disabled={running}
                    value={limits.cpuCores}
                    onChange={(e) => setLimits({ ...limits, cpuCores: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Disk (MB)" htmlFor="sdisk" hint="Advisory">
                  <Input
                    id="sdisk"
                    type="number"
                    min={0}
                    disabled={running}
                    value={limits.diskMb}
                    onChange={(e) => setLimits({ ...limits, diskMb: Number(e.target.value) })}
                  />
                </Field>
              </div>
              {i.ports.length > 0 && (
                <div className="grid grid-cols-2 gap-3">
                  {i.ports.map((p) => (
                    <Field
                      key={p.name}
                      label={`${p.label} (${p.protocol})`}
                      htmlFor={`sport-${p.name}`}
                      error={inUse.has(Number(portValue(p.name))) ? "In use on this node" : null}
                      hint={followerOf(p.name)
                        ? `Always ${followerOf(p.name)!.head} + ${followerOf(p.name)!.offset}`
                        : undefined}
                    >
                      <Input
                        id={`sport-${p.name}`}
                        type="number"
                        min={1}
                        max={65535}
                        disabled={running || !!followerOf(p.name)}
                        className="font-mono"
                        value={portValue(p.name)}
                        onChange={(e) => setPorts({ ...ports, [p.name]: e.target.value })}
                      />
                    </Field>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Variables</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <VariableFields
              variables={def.variables.filter((v) => v.name in variables || owner)}
              values={variables}
              onChange={(n, v) => setVariables((s) => ({ ...s, [n]: v }))}
              owner={owner}
            />
            <p className="text-xs text-muted-foreground">
              Changes apply at the next start. Version changes need a reinstall.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Startup command</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Field
              label="Override"
              htmlFor="sstart"
              hint={`Empty uses the template's command. Placeholders like {{GSM_HEAP_MB}} are substituted.${
                owner ? "" : " Only an owner changes it."
              }`}
            >
              <Textarea
                id="sstart"
                value={startup}
                onChange={(e) => setStartup(e.target.value)}
                rows={3}
                className="font-mono"
                placeholder={def.startup}
                disabled={!owner}
              />
            </Field>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Built-in variables</summary>
              <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
                {BUILTIN_VARIABLES.map((b) => (
                  <div key={b.name} className="contents">
                    <dt className="font-mono text-foreground">{`{{${b.name}}}`}</dt>
                    <dd>{b.description}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </CardContent>
        </Card>
        <div className="flex items-center gap-3">
          <Button
            onClick={save}
            disabled={!canSettings || update.isPending || problems.length > 0 ||
              (!running && portsBad) ||
              !name.trim()}
          >
            {update.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
          </Button>
          {portsChanged && running && (
            <span className="text-xs text-status-degraded">
              Port changes need a stopped instance.
            </span>
          )}
        </div>
      </fieldset>

      {i.volumes.length > 0 && <VolumesCard volumes={i.volumes} />}
      <HostMountsCard
        instance={i}
        node={nodeDetail?.node ?? null}
        running={running}
        canSettings={canSettings}
      />

      {roleAllows(i.myRole, "delete") && (
        <Card className="border-status-critical/40">
          <CardHeader>
            <CardTitle className="text-status-critical">Danger zone</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs">
                <div className="font-medium text-foreground">Reinstall</div>
                <div className="text-muted-foreground">
                  Runs the template's install script again over the existing files. The instance
                  must be stopped.
                </div>
              </div>
              <ConfirmDialog
                trigger={
                  <Button variant="outline" size="sm" disabled={running || reinstall.isPending}>
                    Reinstall
                  </Button>
                }
                title={`Reinstall ${i.name}?`}
                description="Server files are downloaded again; worlds and configs are kept unless the script replaces them."
                confirmLabel="Reinstall"
                onConfirm={() =>
                  reinstall.mutate(i.id, {
                    onSuccess: () =>
                      navigate({
                        to: "/instances/$instanceId",
                        params: { instanceId: String(i.id) },
                      }),
                    onError: (e) => toast.error(errorMessage(e)),
                  })}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs">
                <div className="font-medium text-foreground">Delete instance</div>
                <div className="text-muted-foreground">
                  Stops and removes the container, frees its ports and, unless kept, deletes every
                  file and backup on the node.
                </div>
                <label className="mt-1 flex items-center gap-2">
                  <Checkbox checked={keepFiles} onCheckedChange={(v) => setKeepFiles(!!v)} />
                  Keep the files on the node
                </label>
              </div>
              <ConfirmDialog
                trigger={
                  <Button variant="destructive" size="sm" disabled={remove.isPending}>
                    Delete
                  </Button>
                }
                title={`Delete ${i.name}?`}
                description={keepFiles
                  ? "The instance is removed from the panel; its files stay on the node."
                  : "Everything about this instance is deleted, backups included. This can't be undone."}
                confirmLabel="Delete"
                onConfirm={() =>
                  remove.mutate({ id: i.id, keepFiles }, {
                    onSuccess: () => {
                      toast.success(`Deleted ${i.name}`);
                      navigate({ to: "/instances" });
                    },
                    onError: (e) => toast.error(errorMessage(e)),
                  })}
              />
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** The template's volumes: read-only here, they come with the template. */
function VolumesCard({ volumes }: { volumes: InstanceVolumeDto[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Volumes</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          Folders of the instance's files that the template mounts elsewhere in the container. Like
          the rest of the files, they outlive reinstalls and image updates.
        </p>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Volume</TableHead>
                <TableHead>In the container</TableHead>
                <TableHead>In the files</TableHead>
                <TableHead>Backups</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {volumes.map((v) => (
                <TableRow key={v.name}>
                  <TableCell>
                    <div className="font-medium">{v.label}</div>
                    {v.description && (
                      <div className="text-xs text-muted-foreground">{v.description}</div>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{v.path}</TableCell>
                  <TableCell className="font-mono text-xs">{v.folder}</TableCell>
                  <TableCell className="text-xs">
                    {v.backup
                      ? "Included"
                      : <span className="text-muted-foreground">Left out</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/** Whether `path` is `root` or inside it; the server and the agent check the same way. */
const within = (path: string, root: string) => {
  const r = root.replace(/\/+$/, "");
  return path === r || path.startsWith(`${r}/`);
};

/** Per-field messages of a refused save: zod issues, or the server's `{ "mounts.0.hostPath": … }`. */
function fieldErrors(e: Error): Record<string, string> {
  if (!(e instanceof ApiError) || !e.details || typeof e.details !== "object") return {};
  if (Array.isArray(e.details)) {
    return Object.fromEntries(
      (e.details as { path?: (string | number)[]; message?: string }[])
        .filter((d) => d.path?.length && d.message)
        .map((d) => [d.path!.join("."), d.message!]),
    );
  }
  return Object.fromEntries(
    Object.entries(e.details).filter(([, v]) => typeof v === "string"),
  ) as Record<string, string>;
}

/** Node directories in the container. Everyone with settings sees them; only admins change them. */
function HostMountsCard({ instance: i, node, running, canSettings }: {
  instance: InstanceDetailDto;
  node: NodeDetailDto | null;
  running: boolean;
  canSettings: boolean;
}) {
  const { admin } = useAuth();
  const { update } = useInstanceMutations();
  const [rows, setRows] = useState<HostMount[]>(i.mounts);
  const [rejected, setRejected] = useState<Record<string, string>>({});
  // Refetches (stats, status) bring a new array with the same mounts: only a saved change resets.
  const saved = JSON.stringify(i.mounts);
  useEffect(() => {
    setRows(JSON.parse(saved));
    setRejected({});
  }, [saved]);
  if (!canSettings || (!admin && i.mounts.length === 0)) return null;

  // Null until the node has reported which directories its agent allows.
  const roots = node?.inventory ? node.inventory.hostMountRoots ?? [] : null;
  const edit = (next: HostMount[]) => {
    setRows(next);
    setRejected({});
  };
  const set = (k: number, patch: Partial<HostMount>) =>
    edit(rows.map((m, j) => (j === k ? { ...m, ...patch } : m)));
  const hostError = (m: HostMount, k: number) =>
    rejected[`mounts.${k}.hostPath`] ?? (m.hostPath === "" ? null : hostPathProblem(m.hostPath) ??
      (roots && !roots.some((r) => within(m.hostPath, r))
        ? `Not under a directory ${i.node.name} allows`
        : null));
  const containerError = (m: HostMount, k: number) =>
    rejected[`mounts.${k}.containerPath`] ??
      (m.containerPath === "" ? null : containerPathProblem(m.containerPath) ??
        (rows.some((o, j) => j < k && o.containerPath === m.containerPath)
          ? "Another mount uses that path"
          : i.volumes.some((v) => v.path === m.containerPath)
          ? "A volume of the template is mounted there"
          : null));
  const bad = rows.some((m, k) =>
    !m.hostPath || !m.containerPath || hostError(m, k) || containerError(m, k)
  );
  const dirty = JSON.stringify(rows) !== JSON.stringify(i.mounts);
  const save = () =>
    update.mutate({ id: i.id, mounts: rows }, {
      onSuccess: () => toast.success("Mounts saved"),
      onError: (e) => {
        setRejected(fieldErrors(e));
        toast.error(errorMessage(e));
      },
    });
  const cols = "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_5rem_1.75rem]";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Host mounts</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          Directories on the node mounted into the container. {admin
            ? (
              <>
                The node's agent must allow each one under{" "}
                <code className="font-mono">host_mounts</code> in its{" "}
                <code className="font-mono">config.yaml</code>.
              </>
            )
            : "Only admins change them."}
        </p>
        {admin && roots && (
          <p className="text-xs text-muted-foreground">
            {roots.length
              ? (
                <>
                  {i.node.name} allows:{" "}
                  <span className="font-mono text-foreground">{roots.join(", ")}</span>
                </>
              )
              : `${i.node.name} allows no host mounts yet.`}
          </p>
        )}
        {!admin && (
          <div className="grid gap-1 text-xs">
            {i.mounts.map((m) => (
              <div key={m.containerPath} className="flex flex-wrap items-center gap-x-2 font-mono">
                <span className="break-all">{m.hostPath}</span>
                <span className="text-muted-foreground">→</span>
                <span className="break-all">{m.containerPath}</span>
                {m.readOnly && <Badge variant="muted">read-only</Badge>}
              </div>
            ))}
          </div>
        )}
        {admin && (
          <>
            {running && (
              <p className="text-xs text-status-degraded">
                Mounts can only change while the instance is stopped.
              </p>
            )}
            <fieldset disabled={running || update.isPending} className="grid gap-2">
              {rows.length === 0 && (
                <p className="text-xs text-muted-foreground">No host mounts.</p>
              )}
              {rows.length > 0 && (
                <div className={`hidden gap-2 text-xs font-medium sm:grid ${cols}`}>
                  <span>On the node</span>
                  <span>In the container</span>
                  <span>Read-only</span>
                </div>
              )}
              {rows.map((m, k) => {
                const he = hostError(m, k);
                const ce = containerError(m, k);
                return (
                  <div key={k} className={`grid gap-2 sm:items-start ${cols}`}>
                    <div className="grid gap-1">
                      <Input
                        value={m.hostPath}
                        onChange={(e) => set(k, { hostPath: e.target.value.trim() })}
                        placeholder="/srv/shared/maps"
                        aria-label="Path on the node"
                        className="font-mono"
                        spellCheck={false}
                      />
                      {he && <p className="text-xs text-destructive">{he}</p>}
                    </div>
                    <div className="grid gap-1">
                      <Input
                        value={m.containerPath}
                        onChange={(e) => set(k, { containerPath: e.target.value.trim() })}
                        placeholder="/opt/maps"
                        aria-label="Path in the container"
                        className="font-mono"
                        spellCheck={false}
                      />
                      {ce && <p className="text-xs text-destructive">{ce}</p>}
                    </div>
                    <label className="flex h-8 items-center gap-2 text-xs">
                      <Switch
                        checked={m.readOnly}
                        onCheckedChange={(v) => set(k, { readOnly: v })}
                        aria-label="Read-only"
                      />
                      <span className="sm:hidden">Read-only</span>
                    </label>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Remove mount"
                      className="mt-0.5"
                      onClick={() => edit(rows.filter((_, j) => j !== k))}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                );
              })}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={rows.length >= 16}
                  onClick={() =>
                    edit([...rows, { hostPath: "", containerPath: "", readOnly: false }])}
                >
                  <Plus /> Add mount
                </Button>
                <Button size="sm" disabled={!dirty || bad || update.isPending} onClick={save}>
                  {update.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save mounts
                </Button>
              </div>
            </fieldset>
          </>
        )}
      </CardContent>
    </Card>
  );
}
