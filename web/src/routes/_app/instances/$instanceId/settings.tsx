import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { InstanceDetailDto, TemplateDetailDto } from "@gsm/shared";
import { BUILTIN_VARIABLES, roleAllows, validateVariable } from "@gsm/shared";
import { useAuth } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useInstance, useInstanceMutations } from "@/api/instances";
import { useNode } from "@/api/nodes";
import { useTemplate } from "@/api/templates";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { Field } from "@/components/data/field";
import { VariableFields } from "@/components/instances/variable-fields";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
  const { admin } = useAuth();
  const { update, reinstall, remove } = useInstanceMutations();
  const { data: nodeDetail } = useNode(i.node.id);
  const def = template.definition;
  const canSettings = roleAllows(i.myRole, "settings");
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
  const portsChanged = i.ports.some((p) => ports[p.name] !== String(p.port));
  const portsBad = Object.values(ports).some((v) => {
    const n = Number(v);
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
        startupOverride: startup.trim() || null,
        ...(running ? {} : {
          image,
          limits,
          ports: Object.fromEntries(Object.entries(ports).map(([k, v]) => [k, Number(v)])),
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
                <Select value={image} onValueChange={setImage} disabled={running}>
                  <SelectTrigger className="font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {images.map((x) => (
                      <SelectItem key={x.ref} value={x.ref} className="font-mono">
                        {x.label !== "Default" ? `${x.label} · ` : ""}
                        {x.ref}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                      error={inUse.has(Number(ports[p.name])) ? "In use on this node" : null}
                    >
                      <Input
                        id={`sport-${p.name}`}
                        type="number"
                        min={1}
                        max={65535}
                        disabled={running}
                        className="font-mono"
                        value={ports[p.name] ?? ""}
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
              variables={def.variables.filter((v) => v.name in variables || admin)}
              values={variables}
              onChange={(n, v) => setVariables((s) => ({ ...s, [n]: v }))}
              admin={admin}
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
              hint="Empty uses the template's command. Placeholders like {{GSM_HEAP_MB}} are substituted."
            >
              <Textarea
                id="sstart"
                value={startup}
                onChange={(e) => setStartup(e.target.value)}
                rows={3}
                className="font-mono"
                placeholder={def.startup}
                disabled={!admin && !roleAllows(i.myRole, "settings")}
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
