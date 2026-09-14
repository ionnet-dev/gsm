import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Copy, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { type ComponentProps, lazy, Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  TemplateConfigFile,
  TemplateContainer,
  TemplateDatabase,
  TemplateDefinition as TemplateDefinitionType,
  TemplateDetailDto,
  TemplatePlayers,
  TemplatePort,
  TemplateVariable,
  TemplateVolume,
} from "@gsm/shared";
import {
  BUILTIN_VARIABLES,
  CONFIG_FILE_FORMATS,
  containerPathProblem,
  DATABASE_ENGINES,
  IMAGE_PULL_POLICIES,
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
import {
  DEFAULT_CONTAINER,
  NEW_VARIABLE,
  STARTER_DATABASE,
  STARTER_PLAYERS,
} from "@/lib/template-defaults";

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
        <Tabs value={tab} onValueChange={onTab}>
          <TabsList className="mb-4 flex-wrap">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="runtime">Runtime</TabsTrigger>
            <TabsTrigger value="install">Install</TabsTrigger>
            <TabsTrigger value="variables">Variables ({def.variables.length})</TabsTrigger>
            <TabsTrigger value="ports">Ports ({def.ports.length})</TabsTrigger>
            <TabsTrigger value="files">Files ({def.files.length})</TabsTrigger>
            <TabsTrigger value="volumes">Volumes ({(def.volumes ?? []).length})</TabsTrigger>
            <TabsTrigger value="database">Database</TabsTrigger>
            <TabsTrigger value="players">Players</TabsTrigger>
            <TabsTrigger value="raw">Raw JSON</TabsTrigger>
          </TabsList>
          {/* Only the panels are locked for built-ins; the tabs stay usable to read them. */}
          <fieldset disabled={readOnly} className="contents">
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
                        onChange={(e) =>
                          up({ console: { ...def.console, readyPattern: e.target.value || null } })}
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
                <ContainerCard
                  value={def.container ?? DEFAULT_CONTAINER}
                  onChange={(container) => up({ container })}
                />
                <EnvCard value={def.env ?? {}} onChange={(env) => up({ env })} />
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

            <TabsContent value="volumes">
              <VolumesEditor volumes={def.volumes ?? []} onChange={(volumes) => up({ volumes })} />
            </TabsContent>

            <TabsContent value="database">
              <DatabaseEditor
                value={def.database ?? null}
                variables={def.variables}
                readOnly={readOnly}
                onChange={(database) => up({ database })}
              />
            </TabsContent>

            <TabsContent value="players">
              <PlayersEditor
                value={def.players ?? null}
                templateId={t.id}
                readOnly={readOnly}
                onChange={(players) => up({ players })}
              />
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
          </fieldset>
        </Tabs>
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
            <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
              <Field label="Description">
                <Input
                  value={v.description}
                  onChange={(e) => set(i, { description: e.target.value })}
                />
              </Field>
              <Field label="Group" hint="Heading it is shown under">
                <Input value={v.group} onChange={(e) => set(i, { group: e.target.value })} />
              </Field>
            </div>
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
                <>
                  <Field
                    label="Options"
                    hint="One per line: value = label"
                    className="sm:col-span-2"
                  >
                    <Textarea
                      value={v.options.map((o) => (o.label ? `${o.value} = ${o.label}` : o.value))
                        .join("\n")}
                      onChange={(e) =>
                        set(i, {
                          options: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean)
                            .map((l) => {
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
                  <Field label="Other values">
                    <label className="flex h-8 items-center gap-2 text-xs">
                      <Switch
                        checked={v.allowCustom}
                        onCheckedChange={(c) => set(i, { allowCustom: c })}
                      />
                      Allow any value
                    </label>
                  </Field>
                </>
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
            follows: null,
          }])}
      />
      {ports.length === 0 && <p className="text-xs text-muted-foreground">No ports published.</p>}
      {ports.map((p, i) => (
        <Card key={i}>
          <CardContent className="grid gap-3 pt-4 sm:grid-cols-[1fr_1fr_8rem_8rem_9rem_auto_auto]">
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
            <Field label="Follows" hint="Always that port + 1">
              <Select
                value={p.follows ?? "none"}
                onValueChange={(v) => set(i, { follows: v === "none" ? null : v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Nothing</SelectItem>
                  {ports.slice(0, i).map((o) => (
                    <SelectItem key={o.name} value={o.name}>{o.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
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

/** The players section as JSON: too nested for a form, and rarely edited. */
function PlayersEditor({ value, templateId, readOnly, onChange }: {
  value: TemplatePlayers | null;
  templateId: number;
  readOnly: boolean;
  onChange: (players: TemplatePlayers | null) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const replace = (next: TemplatePlayers | null) => {
    setText(JSON.stringify(next, null, 2));
    setVersion((v) => v + 1);
    setError(null);
    onChange(next);
  };
  const edit = (next: string) => {
    setText(next);
    try {
      onChange(JSON.parse(next));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid JSON");
    }
  };
  return (
    <div className="grid gap-3">
      <Card>
        <CardContent className="grid gap-3 pt-4 text-xs text-muted-foreground">
          <p>
            How the panel sees who is online and what it can do to a player. Console patterns are
            JavaScript regular expressions tried on every console line: <code>join</code> and{" "}
            <code>leave</code> need a <code>name</code> group, <code>identify</code> a{" "}
            <code>name</code> and an <code>id</code>, and the list answer a <code>names</code>{" "}
            group. Lists are files in the instance (<code>json</code> arrays or plain{" "}
            <code>lines</code>). Actions are single console commands using{" "}
            <code>{"{{PLAYER}}"}</code>, <code>{"{{PLAYER_ID}}"}</code> and their fields.
          </p>
          {!readOnly && (
            <div>
              {value === null
                ? (
                  <Button size="sm" variant="outline" onClick={() => replace(STARTER_PLAYERS)}>
                    <Plus /> Add a players section
                  </Button>
                )
                : (
                  <Button size="sm" variant="outline" onClick={() => replace(null)}>
                    <Trash2 /> Remove the players section
                  </Button>
                )}
            </div>
          )}
        </CardContent>
      </Card>
      {error && <div className="text-xs text-status-critical">{error}</div>}
      <div className="h-[60vh] overflow-hidden rounded-md border">
        <Suspense
          fallback={<div className="p-4 text-xs text-muted-foreground">Loading editor…</div>}
        >
          <CodeEditor
            docKey={`tpl-players-${templateId}-${version}`}
            value={text}
            path="players.json"
            readOnly={readOnly}
            wrap={false}
            onChange={edit}
          />
        </Suspense>
      </div>
    </div>
  );
}

/**
 * A textarea for a value kept as lines. The text stays as typed, so a new, still empty line
 * survives; it is replaced only when the value changes from outside (a reload, the raw JSON tab).
 */
function LinesTextarea<T>({ value, parse, format, onChange, ...props }: {
  value: T;
  parse: (text: string) => T;
  format: (value: T) => string;
  onChange: (value: T) => void;
} & Omit<ComponentProps<typeof Textarea>, "value" | "onChange">) {
  const [text, setText] = useState(() => format(value));
  useEffect(() => {
    if (JSON.stringify(parse(text)) !== JSON.stringify(value)) setText(format(value));
  }, [value]);
  return (
    <Textarea
      {...props}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parse(e.target.value));
      }}
    />
  );
}

const PULL_LABEL: Record<TemplateContainer["pull"], string> = {
  missing: "When it is missing",
  always: "Before every start and install",
};

/** How the container runs, for images not built on the base image. */
function ContainerCard(
  { value, onChange }: { value: TemplateContainer; onChange: (c: TemplateContainer) => void },
) {
  const set = (patch: Partial<TemplateContainer>) => onChange({ ...value, ...patch });
  const entrypoint = value.entrypoint;
  const user = value.user;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Container</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          For images not built on the base image. The defaults suit the base image: its entrypoint,
          the gsm user (1500), and pulling only when the image is missing.
        </p>
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={entrypoint === null}
            onCheckedChange={(c) => set({ entrypoint: c ? null : [] })}
          />
          Keep the image's entrypoint
        </label>
        {entrypoint !== null && (
          <Field
            label="Entrypoint"
            hint='One argument per line; sh -c "<startup>" follows it. Empty runs the startup command without one.'
          >
            <LinesTextarea
              value={entrypoint}
              parse={(t) => t.split("\n").map((l) => l.trim()).filter(Boolean)}
              format={(v) => v.join("\n")}
              onChange={(next) => set({ entrypoint: next })}
              rows={3}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </Field>
        )}
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={user !== null}
            onCheckedChange={(c) => set({ user: c ? { uid: 1000, gid: 1000 } : null })}
          />
          Run as another user than gsm (1500)
        </label>
        {user !== null && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="User id" htmlFor="tuid" hint="Also owns the instance's files">
              <Input
                id="tuid"
                type="number"
                min={1}
                value={user.uid}
                onChange={(e) => set({ user: { ...user, uid: Number(e.target.value) } })}
              />
            </Field>
            <Field label="Group id" htmlFor="tgid">
              <Input
                id="tgid"
                type="number"
                min={1}
                value={user.gid}
                onChange={(e) => set({ user: { ...user, gid: Number(e.target.value) } })}
              />
            </Field>
          </div>
        )}
        <Field label="Pull the image">
          <Select
            value={value.pull}
            onValueChange={(v) => set({ pull: v as TemplateContainer["pull"] })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {IMAGE_PULL_POLICIES.map((p) => (
                <SelectItem key={p} value={p}>{PULL_LABEL[p]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="grid gap-1">
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={value.seccompUnconfined}
              onCheckedChange={(c) => set({ seccompUnconfined: c })}
            />
            Turn off the seccomp filter
          </label>
          <p className="text-xs text-muted-foreground">
            Admins only. It loosens the container's isolation; use it only for a game that fails
            without it.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function EnvCard(
  { value, onChange }: {
    value: Record<string, string>;
    onChange: (env: Record<string, string>) => void;
  },
) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Environment</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <Field
          label="Extra variables"
          hint="One per line: NAME = value, with {{VAR}} placeholders, for images that read their own names (DB_HOST = {{GSM_DB_HOST}}). GSM_* names are the platform's."
        >
          <LinesTextarea
            value={value}
            parse={(t): Record<string, string> =>
              Object.fromEntries(
                t.split("\n").filter((l) => l.includes("=")).map((l) => {
                  const [k, ...rest] = l.split("=");
                  return [k.trim(), rest.join("=").trim()];
                }),
              )}
            format={(v) => Object.entries(v).map(([k, x]) => `${k} = ${x}`).join("\n")}
            onChange={onChange}
            rows={6}
            className="font-mono text-xs"
            spellCheck={false}
          />
        </Field>
      </CardContent>
    </Card>
  );
}

function VolumesEditor(
  { volumes, onChange }: { volumes: TemplateVolume[]; onChange: (v: TemplateVolume[]) => void },
) {
  const set = (i: number, patch: Partial<TemplateVolume>) =>
    onChange(volumes.map((v, k) => (k === i ? { ...v, ...patch } : v)));
  return (
    <div className="grid gap-3">
      <ListHeader
        title="Volumes"
        onAdd={() =>
          onChange([...volumes, {
            name: `data${volumes.length + 1}`,
            label: "Volume",
            description: "",
            path: `/opt/data${volumes.length + 1}`,
            seed: false,
            backup: true,
          }])}
      />
      <p className="text-xs text-muted-foreground">
        Folders of the instance mounted somewhere other than /data, for images that keep their
        server elsewhere. Each is kept in the instance's files as volumes/&lt;name&gt;, so the file
        manager, SFTP and backups see it, and it outlives image updates and reinstalls.
      </p>
      {volumes.length === 0 && (
        <p className="text-xs text-muted-foreground">No volumes; everything lives in /data.</p>
      )}
      {volumes.map((v, i) => (
        <Card key={i}>
          <CardContent className="grid gap-3 pt-4">
            <div className="grid gap-3 sm:grid-cols-[12rem_1fr_1fr_auto]">
              <Field label="Name" hint={`volumes/${v.name} in the files`}>
                <Input
                  value={v.name}
                  onChange={(e) => set(i, { name: e.target.value.toLowerCase() })}
                  className="font-mono"
                />
              </Field>
              <Field label="Label">
                <Input value={v.label} onChange={(e) => set(i, { label: e.target.value })} />
              </Field>
              <Field
                label="Path in the container"
                hint="Absolute, outside /data"
                error={containerPathProblem(v.path)}
              >
                <Input
                  value={v.path}
                  onChange={(e) => set(i, { path: e.target.value.trim() })}
                  className="font-mono"
                />
              </Field>
              <div className="self-end">
                <RowTools
                  index={i}
                  count={volumes.length}
                  onMove={(d) => onChange(move(volumes, i, d))}
                  onRemove={() => onChange(volumes.filter((_, k) => k !== i))}
                />
              </div>
            </div>
            <Field label="Description">
              <Input
                value={v.description}
                onChange={(e) => set(i, { description: e.target.value })}
              />
            </Field>
            <div className="flex flex-wrap gap-4 text-xs">
              <label className="flex items-center gap-2">
                <Switch checked={v.seed} onCheckedChange={(c) => set(i, { seed: c })} />
                Fill it from the image while the folder does not exist
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={v.backup} onCheckedChange={(c) => set(i, { backup: c })} />
                Include in backups
              </label>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** A database server beside each instance. */
function DatabaseEditor({ value, variables, readOnly, onChange }: {
  value: TemplateDatabase | null;
  variables: TemplateVariable[];
  readOnly: boolean;
  onChange: (db: TemplateDatabase | null) => void;
}) {
  const switches = variables.filter((v) => v.type === "boolean");
  return (
    <div className="grid gap-3">
      <Card>
        <CardContent className="grid gap-3 pt-4 text-xs text-muted-foreground">
          <p>
            A database server beside each instance, in its own container on a private network only
            the two share. It starts before the game and stops after it, and backups carry a dump of
            it. The game finds it through <code>GSM_DB_HOST</code>, <code>GSM_DB_PORT</code>,{" "}
            <code>GSM_DB_NAME</code>, <code>GSM_DB_USER</code> and{" "}
            <code>GSM_DB_PASSWORD</code>; pass them on under an image's own names with Environment
            on the Runtime tab.
          </p>
          {readOnly && value === null && <p>This template has no database.</p>}
          {!readOnly && (
            <div>
              {value === null
                ? (
                  <Button size="sm" variant="outline" onClick={() => onChange(STARTER_DATABASE)}>
                    <Plus /> Add a database
                  </Button>
                )
                : (
                  <Button size="sm" variant="outline" onClick={() => onChange(null)}>
                    <Trash2 /> Remove the database
                  </Button>
                )}
            </div>
          )}
        </CardContent>
      </Card>
      {value && (
        <Card>
          <CardContent className="grid gap-3 pt-4 sm:grid-cols-2">
            <Field label="Engine">
              <Select
                value={value.engine}
                onValueChange={(v) =>
                  onChange({ ...value, engine: v as TemplateDatabase["engine"] })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DATABASE_ENGINES.map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Image" htmlFor="tdbimg" hint="An image of the engine, like mariadb:11.4">
              <Input
                id="tdbimg"
                value={value.image}
                onChange={(e) => onChange({ ...value, image: e.target.value })}
                className="font-mono"
              />
            </Field>
            <Field
              label="Database name"
              htmlFor="tdbname"
              hint="Also the user's name: lowercase letters, digits and _"
            >
              <Input
                id="tdbname"
                value={value.name}
                onChange={(e) => onChange({ ...value, name: e.target.value.toLowerCase() })}
                className="font-mono"
              />
            </Field>
            <Field
              label="Memory (MB)"
              htmlFor="tdbmem"
              hint="The database's own limit; 0 = unlimited"
            >
              <Input
                id="tdbmem"
                type="number"
                min={0}
                value={value.memoryMb}
                onChange={(e) => onChange({ ...value, memoryMb: Number(e.target.value) })}
              />
            </Field>
            <Field
              label="Turned on by"
              hint="Always on, or only for instances where a boolean variable is true"
              className="sm:col-span-2"
            >
              <Select
                value={value.enabledBy ?? "always"}
                onValueChange={(v) => onChange({ ...value, enabledBy: v === "always" ? null : v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">Always on</SelectItem>
                  {switches.map((v) => (
                    <SelectItem key={v.name} value={v.name}>{v.label} ({v.name})</SelectItem>
                  ))}
                  {value.enabledBy && !switches.some((v) => v.name === value.enabledBy) && (
                    <SelectItem value={value.enabledBy}>{value.enabledBy}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </Field>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
