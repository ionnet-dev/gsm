import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Copy, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  TemplateConfigFile,
  TemplateDefinition as TemplateDefinitionType,
  TemplateDetailDto,
  TemplatePort,
  TemplateVariable,
} from "@gsm/shared";
import {
  BUILTIN_VARIABLES,
  CONFIG_FILE_FORMATS,
  INSTALL_RESOLVERS,
  PORT_PROTOCOLS,
  STOP_SIGNALS,
  TemplateDefinition,
  VARIABLE_TYPES,
  VERSION_SOURCES,
} from "@gsm/shared";
import { authStatusQuery } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useTemplate, useTemplateMutations } from "@/api/templates";
import { ErrorView, PendingView } from "@/components/data/error-view";
import { Field } from "@/components/data/field";
import { PageHeader } from "@/components/layout/page-header";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { NEW_VARIABLE } from "@/lib/template-defaults";

const CodeEditor = lazy(() => import("@/components/files/code-editor"));

export const Route = createFileRoute("/_app/templates/$templateId")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (status.user?.role !== "admin") throw redirect({ to: "/" });
  },
  component: TemplatePage,
  errorComponent: ({ error, reset }) => <ErrorView error={error} reset={reset} />,
});

function TemplatePage() {
  const templateId = Number(Route.useParams().templateId);
  const q = useTemplate(templateId);
  if (q.isLoading) return <PendingView />;
  if (q.error) return <ErrorView error={q.error} reset={() => q.refetch()} />;
  return <TemplateEditor template={q.data!} />;
}

type Def = TemplateDefinitionType;

function TemplateEditor({ template: t }: { template: TemplateDetailDto }) {
  const tm = useTemplateMutations();
  const navigate = useNavigate();
  const [def, setDef] = useState<Def>(t.definition);
  const [raw, setRaw] = useState(JSON.stringify(t.definition, null, 2));
  const [rawKey, setRawKey] = useState(0);
  const [rawError, setRawError] = useState<string | null>(null);
  const [tab, setTab] = useState("general");
  useEffect(() => {
    setDef(t.definition);
    setRaw(JSON.stringify(t.definition, null, 2));
    setRawKey((k) => k + 1);
  }, [t]);

  const parsed = TemplateDefinition.safeParse(def);
  const issues = parsed.success
    ? []
    : parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`);
  const dirty = JSON.stringify(def) !== JSON.stringify(t.definition);
  const readOnly = t.builtin;

  const up = (patch: Partial<Def>) => setDef((d) => ({ ...d, ...patch }));
  const onTab = (next: string) => {
    if (tab === "raw" && next !== "raw") {
      try {
        const obj = JSON.parse(raw);
        setDef({ ...def, ...obj });
        setRawError(null);
      } catch (e) {
        setRawError(e instanceof Error ? e.message : "Invalid JSON");
        return;
      }
    }
    if (next === "raw") {
      setRaw(JSON.stringify(def, null, 2));
      setRawKey((k) => k + 1);
    }
    setTab(next);
  };
  const save = () => {
    let body = def;
    if (tab === "raw") {
      try {
        body = { ...def, ...JSON.parse(raw) };
        setDef(body);
      } catch (e) {
        setRawError(e instanceof Error ? e.message : "Invalid JSON");
        return;
      }
    }
    const r = TemplateDefinition.safeParse(body);
    if (!r.success) return toast.error(r.error.issues[0]?.message ?? "Invalid template");
    tm.update.mutate({ id: t.id, definition: r.data }, {
      onSuccess: () => toast.success("Saved"),
      onError: (e) => toast.error(errorMessage(e)),
    });
  };

  return (
    <>
      <PageHeader
        title={`${def.icon} ${def.name}`}
        description={readOnly
          ? "Built-in templates can't be edited; copy one to customise it."
          : `${def.game} · ${def.slug}`}
        actions={
          <>
            {t.builtin && <Badge variant="muted">built-in · rev {t.revision}</Badge>}
            {readOnly
              ? (
                <Button
                  size="sm"
                  onClick={() =>
                    tm.copy.mutate({ id: t.id, slug: `${t.slug}-copy`, name: `${t.name} (copy)` }, {
                      onSuccess: (r) =>
                        navigate({
                          to: "/templates/$templateId",
                          params: { templateId: String(r.template.id) },
                        }),
                      onError: (e) => toast.error(errorMessage(e)),
                    })}
                >
                  <Copy /> Copy to edit
                </Button>
              )
              : (
                <Button
                  size="sm"
                  disabled={!dirty || tm.update.isPending || issues.length > 0}
                  onClick={save}
                >
                  {tm.update.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
                </Button>
              )}
          </>
        }
      />
      <div className="grid gap-4 p-4 sm:p-6">
        {issues.length > 0 && (
          <div className="rounded-md border border-status-critical/40 bg-status-critical/10 px-3 py-2 text-xs">
            {issues.slice(0, 5).map((i) => <div key={i}>{i}</div>)}
          </div>
        )}
        <fieldset disabled={readOnly} className="contents">
          <Tabs value={tab} onValueChange={onTab}>
            <TabsList className="mb-4 flex-wrap">
              <TabsTrigger value="general">General</TabsTrigger>
              <TabsTrigger value="runtime">Runtime</TabsTrigger>
              <TabsTrigger value="install">Install</TabsTrigger>
              <TabsTrigger value="variables">Variables ({def.variables.length})</TabsTrigger>
              <TabsTrigger value="ports">Ports ({def.ports.length})</TabsTrigger>
              <TabsTrigger value="files">Files ({def.files.length})</TabsTrigger>
              <TabsTrigger value="raw">Raw JSON</TabsTrigger>
            </TabsList>

            <TabsContent value="general">
              <Card>
                <CardContent className="grid gap-3 pt-4 sm:grid-cols-2">
                  <Field label="Slug" htmlFor="tslug" hint="Lowercase letters, digits and dashes">
                    <Input
                      id="tslug"
                      value={def.slug}
                      onChange={(e) => up({ slug: e.target.value })}
                      className="font-mono"
                    />
                  </Field>
                  <Field label="Name" htmlFor="tname">
                    <Input
                      id="tname"
                      value={def.name}
                      onChange={(e) => up({ name: e.target.value })}
                    />
                  </Field>
                  <Field label="Game" htmlFor="tgame" hint="Groups templates on the picker">
                    <Input
                      id="tgame"
                      value={def.game}
                      onChange={(e) => up({ game: e.target.value })}
                    />
                  </Field>
                  <Field label="Icon" htmlFor="ticon" hint="An emoji">
                    <Input
                      id="ticon"
                      value={def.icon}
                      onChange={(e) => up({ icon: e.target.value })}
                      className="w-20"
                    />
                  </Field>
                  <Field label="Description" htmlFor="tdesc" className="sm:col-span-2">
                    <Textarea
                      id="tdesc"
                      value={def.description}
                      onChange={(e) => up({ description: e.target.value })}
                      rows={3}
                    />
                  </Field>
                  <Field
                    label="Tags"
                    htmlFor="ttags"
                    hint="Comma separated"
                    className="sm:col-span-2"
                  >
                    <Input
                      id="ttags"
                      value={def.tags.join(", ")}
                      onChange={(e) =>
                        up({
                          tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                        })}
                    />
                  </Field>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="runtime">
              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Image and startup</CardTitle>
                  </CardHeader>
                  <CardContent className="grid gap-3">
                    <Field
                      label="Default image"
                      htmlFor="timg"
                      hint="Bare names are prefixed with the registry from Settings"
                    >
                      <Input
                        id="timg"
                        value={def.image}
                        onChange={(e) => up({ image: e.target.value })}
                        className="font-mono"
                      />
                    </Field>
                    <Field label="Alternative images" hint="One per line: label = ref">
                      <Textarea
                        value={def.images.map((i) => `${i.label} = ${i.ref}`).join("\n")}
                        onChange={(e) =>
                          up({
                            images: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean)
                              .map((l) => {
                                const [label, ...rest] = l.split("=");
                                return { label: label.trim(), ref: rest.join("=").trim() };
                              }),
                          })}
                        rows={3}
                        className="font-mono text-xs"
                      />
                    </Field>
                    <Field
                      label="Startup command"
                      htmlFor="tstart"
                      hint="Run by the image's entrypoint; {{VAR}} placeholders are substituted"
                    >
                      <Textarea
                        id="tstart"
                        value={def.startup}
                        onChange={(e) => up({ startup: e.target.value })}
                        rows={3}
                        className="font-mono text-xs"
                      />
                    </Field>
                    <Field
                      label="Ready pattern"
                      htmlFor="tready"
                      hint="Regular expression matched against console lines; empty = running as soon as the process starts"
                    >
                      <Input
                        id="tready"
                        value={def.console.readyPattern ?? ""}
                        onChange={(e) => up({ console: { readyPattern: e.target.value || null } })}
                        className="font-mono"
                      />
                    </Field>
                  </CardContent>
                </Card>
                <div className="grid gap-4">
                  <Card>
                    <CardHeader>
                      <CardTitle>Stopping</CardTitle>
                    </CardHeader>
                    <CardContent className="grid grid-cols-3 gap-3">
                      <Field label="Console command" htmlFor="tstopc" hint="Empty = signal only">
                        <Input
                          id="tstopc"
                          value={def.stop.command ?? ""}
                          onChange={(e) =>
                            up({ stop: { ...def.stop, command: e.target.value || null } })}
                          className="font-mono"
                        />
                      </Field>
                      <Field label="Signal">
                        <Select
                          value={def.stop.signal}
                          onValueChange={(v) =>
                            up({ stop: { ...def.stop, signal: v as Def["stop"]["signal"] } })}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STOP_SIGNALS.map((s) => <SelectItem key={s} value={s}>{s}
                            </SelectItem>)}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label="Timeout (s)" htmlFor="tstopt">
                        <Input
                          id="tstopt"
                          type="number"
                          min={1}
                          value={def.stop.timeoutSeconds}
                          onChange={(e) =>
                            up({ stop: { ...def.stop, timeoutSeconds: Number(e.target.value) } })}
                        />
                      </Field>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle>Defaults for new instances</CardTitle>
                    </CardHeader>
                    <CardContent className="grid gap-3">
                      <div className="grid grid-cols-3 gap-3">
                        <Field label="Memory (MB)" htmlFor="tmem">
                          <Input
                            id="tmem"
                            type="number"
                            min={0}
                            value={def.resources.memoryMb}
                            onChange={(e) =>
                              up({
                                resources: { ...def.resources, memoryMb: Number(e.target.value) },
                              })}
                          />
                        </Field>
                        <Field label="CPU cores" htmlFor="tcpu">
                          <Input
                            id="tcpu"
                            type="number"
                            min={0}
                            step={0.5}
                            value={def.resources.cpuCores}
                            onChange={(e) =>
                              up({
                                resources: { ...def.resources, cpuCores: Number(e.target.value) },
                              })}
                          />
                        </Field>
                        <Field label="Disk (MB)" htmlFor="tdisk">
                          <Input
                            id="tdisk"
                            type="number"
                            min={0}
                            value={def.resources.diskMb}
                            onChange={(e) =>
                              up({
                                resources: { ...def.resources, diskMb: Number(e.target.value) },
                              })}
                          />
                        </Field>
                      </div>
                      <label className="flex items-center gap-2 text-xs">
                        <Switch
                          checked={def.restartOnCrash}
                          onCheckedChange={(v) => up({ restartOnCrash: v })}
                        />
                        Restart on crash
                      </label>
                      <Field label="Backup ignore globs" hint="One per line">
                        <Textarea
                          value={def.backupIgnore.join("\n")}
                          onChange={(e) =>
                            up({
                              backupIgnore: e.target.value.split("\n").map((s) => s.trim()).filter(
                                Boolean,
                              ),
                            })}
                          rows={3}
                          className="font-mono text-xs"
                        />
                      </Field>
                    </CardContent>
                  </Card>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="install">
              <Card>
                <CardContent className="grid gap-3 pt-4">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field
                      label="Resolver"
                      hint="Turns version variables into download URLs in the script's environment"
                    >
                      <Select
                        value={def.install.resolver ?? "none"}
                        onValueChange={(v) =>
                          up({
                            install: {
                              ...def.install,
                              resolver: v === "none" ? null : v as Def["install"]["resolver"],
                            },
                          })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          {INSTALL_RESOLVERS.map((r) => (
                            <SelectItem key={r} value={r}>{r}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field label="Install image" htmlFor="tiimg" hint="Empty = the runtime image">
                      <Input
                        id="tiimg"
                        value={def.install.image ?? ""}
                        onChange={(e) =>
                          up({ install: { ...def.install, image: e.target.value || null } })}
                        className="font-mono"
                      />
                    </Field>
                    <Field label="Timeout (s)" htmlFor="titime">
                      <Input
                        id="titime"
                        type="number"
                        min={60}
                        value={def.install.timeoutSeconds}
                        onChange={(e) => up({
                          install: { ...def.install, timeoutSeconds: Number(e.target.value) },
                        })}
                      />
                    </Field>
                  </div>
                  <Field
                    label="Install script"
                    hint="POSIX sh, run in /data with the variables and resolver output as environment"
                  >
                    <Textarea
                      value={def.install.script}
                      onChange={(e) => up({ install: { ...def.install, script: e.target.value } })}
                      rows={18}
                      className="font-mono text-xs"
                      spellCheck={false}
                    />
                  </Field>
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Built-in variables</summary>
                    <ul className="mt-1 grid gap-0.5">
                      {BUILTIN_VARIABLES.map((b) => (
                        <li key={b.name}>
                          <span className="font-mono text-foreground">{b.name}</span> —{" "}
                          {b.description}
                        </li>
                      ))}
                    </ul>
                  </details>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="variables">
              <VariablesEditor
                variables={def.variables}
                onChange={(variables) => up({ variables })}
              />
            </TabsContent>

            <TabsContent value="ports">
              <PortsEditor ports={def.ports} onChange={(ports) => up({ ports })} />
            </TabsContent>

            <TabsContent value="files">
              <FilesEditor files={def.files} onChange={(files) => up({ files })} />
            </TabsContent>

            <TabsContent value="raw">
              <div className="grid gap-2">
                {rawError && <div className="text-xs text-status-critical">{rawError}</div>}
                <div className="h-[70vh] overflow-hidden rounded-md border">
                  <Suspense
                    fallback={
                      <div className="p-4 text-xs text-muted-foreground">Loading editor…</div>
                    }
                  >
                    <CodeEditor
                      docKey={`tpl-${t.id}-${rawKey}`}
                      value={raw}
                      path="template.json"
                      readOnly={readOnly}
                      wrap={false}
                      onChange={setRaw}
                      onSave={save}
                    />
                  </Suspense>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </fieldset>
      </div>
    </>
  );
}

function ListHeader({ title, onAdd }: { title: string; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <Button size="sm" variant="outline" onClick={onAdd}>
        <Plus /> Add
      </Button>
    </div>
  );
}

function RowTools({ index, count, onMove, onRemove }: {
  index: number;
  count: number;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex gap-1">
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={index === 0}
        onClick={() => onMove(-1)}
        aria-label="Move up"
      >
        <ArrowUp />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={index === count - 1}
        onClick={() => onMove(1)}
        aria-label="Move down"
      >
        <ArrowDown />
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={onRemove} aria-label="Remove">
        <Trash2 />
      </Button>
    </div>
  );
}

function move<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

function VariablesEditor(
  { variables, onChange }: {
    variables: TemplateVariable[];
    onChange: (v: TemplateVariable[]) => void;
  },
) {
  const set = (i: number, patch: Partial<TemplateVariable>) =>
    onChange(variables.map((v, k) => (k === i ? { ...v, ...patch } : v)));
  return (
    <div className="grid gap-3">
      <ListHeader
        title="Variables"
        onAdd={() =>
          onChange([...variables, { ...NEW_VARIABLE, name: `VAR_${variables.length + 1}` }])}
      />
      {variables.length === 0 && <p className="text-xs text-muted-foreground">No variables.</p>}
      {variables.map((v, i) => (
        <Card key={i}>
          <CardContent className="grid gap-3 pt-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_10rem_auto]">
              <Field label="Name" hint="UPPER_SNAKE; also the env var name">
                <Input
                  value={v.name}
                  onChange={(e) => set(i, { name: e.target.value.toUpperCase() })}
                  className="font-mono"
                />
              </Field>
              <Field label="Label">
                <Input value={v.label} onChange={(e) => set(i, { label: e.target.value })} />
              </Field>
              <Field label="Type">
                <Select
                  value={v.type}
                  onValueChange={(t) => set(i, { type: t as TemplateVariable["type"] })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VARIABLE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <div className="self-end">
                <RowTools
                  index={i}
                  count={variables.length}
                  onMove={(d) => onChange(move(variables, i, d))}
                  onRemove={() => onChange(variables.filter((_, k) => k !== i))}
                />
              </div>
            </div>
            <Field label="Description">
              <Input
                value={v.description}
                onChange={(e) => set(i, { description: e.target.value })}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Default">
                <Input
                  value={v.default}
                  onChange={(e) => set(i, { default: e.target.value })}
                  className="font-mono"
                />
              </Field>
              {v.type === "number" && (
                <>
                  <Field label="Min">
                    <Input
                      type="number"
                      value={v.min ?? ""}
                      onChange={(e) =>
                        set(i, { min: e.target.value === "" ? null : Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Max">
                    <Input
                      type="number"
                      value={v.max ?? ""}
                      onChange={(e) =>
                        set(i, { max: e.target.value === "" ? null : Number(e.target.value) })}
                    />
                  </Field>
                </>
              )}
              {v.type === "select" && (
                <Field label="Options" hint="One per line: value = label" className="sm:col-span-2">
                  <Textarea
                    value={v.options.map((o) => (o.label ? `${o.value} = ${o.label}` : o.value))
                      .join("\n")}
                    onChange={(e) =>
                      set(i, {
                        options: e.target.value.split("\n").map((l) =>
                          l.trim()
                        ).filter(Boolean).map((l) => {
                          const [value, ...rest] = l.split("=");
                          return {
                            value: value.trim(),
                            label: rest.join("=").trim() || value.trim(),
                          };
                        }),
                      })}
                    rows={3}
                    className="font-mono text-xs"
                  />
                </Field>
              )}
              {v.type === "version" && (
                <>
                  <Field label="Version source">
                    <Select
                      value={v.versionSource ?? "none"}
                      onValueChange={(s) =>
                        set(i, {
                          versionSource: s === "none"
                            ? null
                            : s as TemplateVariable["versionSource"],
                        })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">None</SelectItem>
                        {VERSION_SOURCES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Depends on" hint="Variable holding the parent version">
                    <Input
                      value={v.dependsOn ?? ""}
                      onChange={(e) => set(i, { dependsOn: e.target.value.toUpperCase() || null })}
                      className="font-mono"
                    />
                  </Field>
                </>
              )}
              {v.type === "text" && (
                <Field label="Pattern" hint="Regular expression the value must match">
                  <Input
                    value={v.pattern ?? ""}
                    onChange={(e) =>
                      set(i, { pattern: e.target.value || null })}
                    className="font-mono"
                  />
                </Field>
              )}
            </div>
            <div className="flex flex-wrap gap-4 text-xs">
              <label className="flex items-center gap-2">
                <Switch checked={v.required} onCheckedChange={(c) => set(i, { required: c })} />
                {" "}
                Required
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={v.editable} onCheckedChange={(c) => set(i, { editable: c })} />
                {" "}
                Instance users may edit
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={v.viewable} onCheckedChange={(c) => set(i, { viewable: c })} />
                {" "}
                Instance users may see
              </label>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function PortsEditor(
  { ports, onChange }: { ports: TemplatePort[]; onChange: (p: TemplatePort[]) => void },
) {
  const set = (i: number, patch: Partial<TemplatePort>) =>
    onChange(ports.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  return (
    <div className="grid gap-3">
      <ListHeader
        title="Ports"
        onAdd={() =>
          onChange([...ports, {
            name: `port${ports.length + 1}`,
            label: "Port",
            protocol: "tcp",
            default: 27015,
            primary: ports.length === 0,
          }])}
      />
      {ports.length === 0 && <p className="text-xs text-muted-foreground">No ports published.</p>}
      {ports.map((p, i) => (
        <Card key={i}>
          <CardContent className="grid gap-3 pt-4 sm:grid-cols-[1fr_1fr_8rem_8rem_auto_auto]">
            <Field label="Name" hint={`GSM_PORT_${p.name.toUpperCase()}`}>
              <Input
                value={p.name}
                onChange={(e) => set(i, { name: e.target.value.toLowerCase() })}
                className="font-mono"
              />
            </Field>
            <Field label="Label">
              <Input value={p.label} onChange={(e) => set(i, { label: e.target.value })} />
            </Field>
            <Field label="Protocol">
              <Select
                value={p.protocol}
                onValueChange={(v) => set(i, { protocol: v as TemplatePort["protocol"] })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PORT_PROTOCOLS.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Preferred">
              <Input
                type="number"
                min={1}
                max={65535}
                value={p.default}
                onChange={(e) => set(i, { default: Number(e.target.value) })}
              />
            </Field>
            <Field label="Primary">
              <div className="flex h-8 items-center">
                <Switch checked={p.primary} onCheckedChange={(c) => set(i, { primary: c })} />
              </div>
            </Field>
            <div className="self-end">
              <RowTools
                index={i}
                count={ports.length}
                onMove={(d) => onChange(move(ports, i, d))}
                onRemove={() => onChange(ports.filter((_, k) => k !== i))}
              />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function FilesEditor(
  { files, onChange }: { files: TemplateConfigFile[]; onChange: (f: TemplateConfigFile[]) => void },
) {
  const set = (i: number, patch: Partial<TemplateConfigFile>) =>
    onChange(files.map((f, k) => (k === i ? { ...f, ...patch } : f)));
  return (
    <div className="grid gap-3">
      <ListHeader
        title="Config files kept in step with variables"
        onAdd={() =>
          onChange([...files, { path: "server.properties", format: "properties", values: {} }])}
      />
      {files.length === 0 && (
        <p className="text-xs text-muted-foreground">No managed config files.</p>
      )}
      {files.map((f, i) => (
        <Card key={i}>
          <CardContent className="grid gap-3 pt-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_10rem_auto]">
              <Field label="Path" hint="Relative to the instance root">
                <Input
                  value={f.path}
                  onChange={(e) => set(i, { path: e.target.value })}
                  className="font-mono"
                />
              </Field>
              <Field label="Format">
                <Select
                  value={f.format}
                  onValueChange={(v) => set(i, { format: v as TemplateConfigFile["format"] })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONFIG_FILE_FORMATS.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <div className="self-end">
                <RowTools
                  index={i}
                  count={files.length}
                  onMove={(d) => onChange(move(files, i, d))}
                  onRemove={() => onChange(files.filter((_, k) => k !== i))}
                />
              </div>
            </div>
            <Field
              label="Values"
              hint="One per line: key = value; {{VAR}} placeholders are substituted before each start"
            >
              <Textarea
                value={Object.entries(f.values).map(([k, v]) => `${k} = ${v}`).join("\n")}
                onChange={(e) =>
                  set(i, {
                    values: Object.fromEntries(
                      e.target.value.split("\n").filter((l) => l.includes("=")).map((l) => {
                        const [k, ...rest] = l.split("=");
                        return [k.trim(), rest.join("=").trim()];
                      }),
                    ),
                  })}
                rows={5}
                className="font-mono text-xs"
              />
            </Field>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
