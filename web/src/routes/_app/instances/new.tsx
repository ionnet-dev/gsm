import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { NodeDto, TemplateDetailDto, TemplateDto } from "@gsm/shared";
import { portRun, validateVariable } from "@gsm/shared";
import { errorMessage } from "@/api/client";
import { useInstanceMutations } from "@/api/instances";
import { managesNodes, useAllNodes, useNode } from "@/api/nodes";
import { useTemplate, useTemplates } from "@/api/templates";
import { EmptyState } from "@/components/data/empty-state";
import { Field } from "@/components/data/field";
import { MetricBar } from "@/components/data/metric-bar";
import { StatusDot } from "@/components/data/status-dot";
import { VariableFields } from "@/components/instances/variable-fields";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/instances/new")({
  beforeLoad: async ({ context }) => {
    if (!(await managesNodes(context.queryClient))) throw redirect({ to: "/instances" });
  },
  component: NewInstance,
});

const STEPS = ["Template", "Node & name", "Configure"] as const;

function NewInstance() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [nodeId, setNodeId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { data: template } = useTemplate(templateId);
  const { data: nodes = [] } = useAllNodes();
  const node = nodes.find((n) => n.id === nodeId) ?? null;

  return (
    <>
      <PageHeader
        title="New instance"
        description={template ? `${template.icon} ${template.name}` : "Pick a template to begin."}
      />
      <div className="grid gap-4 p-4 sm:p-6">
        <ol className="flex flex-wrap items-center gap-2 text-xs">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border font-mono text-[10px]",
                  i === step && "border-primary bg-primary text-primary-foreground",
                  i < step && "border-status-online text-status-online",
                )}
              >
                {i < step ? <Check className="size-3" /> : i + 1}
              </span>
              <span className={cn(i === step ? "font-medium" : "text-muted-foreground")}>{s}</span>
              {i < STEPS.length - 1 && <span className="text-muted-foreground">›</span>}
            </li>
          ))}
        </ol>
        {step === 0 && (
          <TemplateStep
            selected={templateId}
            onSelect={(id) => {
              setTemplateId(id);
              setStep(1);
            }}
          />
        )}
        {step === 1 && template && (
          <NodeStep
            nodes={nodes}
            template={template}
            nodeId={nodeId}
            name={name}
            description={description}
            onChange={(p) => {
              if (p.nodeId !== undefined) setNodeId(p.nodeId);
              if (p.name !== undefined) setName(p.name);
              if (p.description !== undefined) setDescription(p.description);
            }}
            onBack={() => setStep(0)}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && template && node && (
          <ConfigureStep
            template={template}
            node={node}
            name={name}
            description={description}
            onBack={() => setStep(1)}
            onCreated={(id) =>
              navigate({ to: "/instances/$instanceId", params: { instanceId: String(id) } })}
          />
        )}
      </div>
    </>
  );
}

function TemplateStep(
  { selected, onSelect }: { selected: number | null; onSelect: (id: number) => void },
) {
  const { data: templates = [], isLoading } = useTemplates();
  const groups = useMemo(() => {
    const m = new Map<string, TemplateDto[]>();
    for (const t of templates) m.set(t.game, [...(m.get(t.game) ?? []), t]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [templates]);
  if (!isLoading && !templates.length) {
    return <EmptyState title="No templates" description="Add a template under Templates first." />;
  }
  return (
    <div className="grid gap-4">
      {groups.map(([game, list]) => (
        <div key={game} className="grid gap-2">
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {game}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((t) => (
              <button
                key={t.id}
                onClick={() => onSelect(t.id)}
                className={cn(
                  "rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/60 hover:bg-accent/40",
                  selected === t.id && "border-primary",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="text-xl leading-none">{t.icon}</span>
                  <span className="font-medium">{t.name}</span>
                  {t.builtin && <Badge variant="muted" className="ml-auto">built-in</Badge>}
                </div>
                <p className="mt-2 line-clamp-3 text-xs text-muted-foreground">{t.description}</p>
                {t.tags.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {t.tags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function NodeStep({
  nodes,
  template,
  nodeId,
  name,
  description,
  onChange,
  onBack,
  onNext,
}: {
  nodes: NodeDto[];
  template: TemplateDetailDto;
  nodeId: number | null;
  name: string;
  description: string;
  onChange: (p: { nodeId?: number; name?: string; description?: string }) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const need = template.definition.resources.memoryMb;
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Node
        </div>
        {nodes.length === 0 && (
          <EmptyState
            title="No nodes enrolled"
            description="Enroll a node under Settings → Enrollment first."
          />
        )}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {nodes.map((n) => {
            const free = n.memoryTotal ? n.memoryTotal / 1048576 - n.allocatedMemoryMb : null;
            const allocPct = n.memoryTotal
              ? (n.allocatedMemoryMb * 1048576 / n.memoryTotal) * 100
              : null;
            return (
              <button
                key={n.id}
                onClick={() => onChange({ nodeId: n.id })}
                disabled={!n.docker?.available}
                className={cn(
                  "rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/60 disabled:opacity-50",
                  nodeId === n.id && "border-primary",
                )}
              >
                <div className="flex items-center gap-2">
                  <StatusDot status={n.status} />
                  <span className="font-medium">{n.name}</span>
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                    {n.runningCount}/{n.instanceCount} running
                  </span>
                </div>
                <div className="mt-2 grid gap-1 text-xs text-muted-foreground">
                  <div>{n.os.prettyName ?? n.hostname}</div>
                  <div className="flex items-center gap-2">
                    <span>Allocated</span>
                    <MetricBar value={allocPct} />
                  </div>
                  <div className="font-mono">
                    {formatBytes(n.allocatedMemoryMb * 1048576, 0)} of{" "}
                    {formatBytes(n.memoryTotal, 0)}
                    {free !== null && free < need && (
                      <span className="text-status-degraded">· tight for {need} MB</span>
                    )}
                  </div>
                  {!n.docker?.available && (
                    <div className="text-status-critical">Docker is not available on this node</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Name</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:max-w-xl">
          <Field label="Instance name" htmlFor="iname">
            <Input
              id="iname"
              value={name}
              onChange={(e) => onChange({ name: e.target.value })}
              placeholder={`My ${template.game} server`}
              autoFocus
            />
          </Field>
          <Field label="Description (optional)" htmlFor="idesc">
            <Textarea
              id="idesc"
              value={description}
              onChange={(e) => onChange({ description: e.target.value })}
              rows={2}
            />
          </Field>
        </CardContent>
      </Card>
      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft /> Back
        </Button>
        <Button disabled={!nodeId || !name.trim()} onClick={onNext}>
          Next <ArrowRight />
        </Button>
      </div>
    </div>
  );
}

function ConfigureStep({
  template,
  node,
  name,
  description,
  onBack,
  onCreated,
}: {
  template: TemplateDetailDto;
  node: NodeDto;
  name: string;
  description: string;
  onBack: () => void;
  onCreated: (id: number) => void;
}) {
  const def = template.definition;
  const { data: detail } = useNode(node.id);
  const { create } = useInstanceMutations();
  const [variables, setVariables] = useState<Record<string, string>>(() =>
    Object.fromEntries(def.variables.map((v) => [v.name, v.default]))
  );
  const [image, setImage] = useState(def.image);
  const [limits, setLimits] = useState({ ...def.resources });
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [restartOnCrash, setRestartOnCrash] = useState(def.restartOnCrash);
  const [autoStart, setAutoStart] = useState(false);
  const [install, setInstall] = useState(true);
  useEffect(() => setImage(def.image), [def.image]);

  const problems = def.variables
    .map((v) => ({ v, p: validateVariable(v, variables[v.name] ?? "") }))
    .filter((x) => x.p);
  const inUse = new Set((detail?.node.portsInUse ?? []).map((p) => p.port));
  // A chosen port takes its followers along: every port of the run must be free.
  const runLength = (head: string) =>
    1 + Math.max(
      0,
      ...def.ports.map((p) => {
        const run = portRun(def.ports, p.name);
        return run.head === head ? run.offset : 0;
      }),
    );
  const portProblems = Object.entries(ports).filter(([k, v]) => {
    if (!v) return false;
    const n = Number(v);
    const span = runLength(k);
    return !Number.isInteger(n) || n < 1 || n + span - 1 > 65535 ||
      Array.from({ length: span }, (_, j) => n + j).some((x) => inUse.has(x));
  });
  const images = [
    { label: "Default", ref: def.image },
    ...def.images.filter((i) => i.ref !== def.image),
  ];

  const submit = () =>
    create.mutate(
      {
        name: name.trim(),
        description: description.trim() || null,
        nodeId: node.id,
        templateId: template.id,
        image: image === def.image ? null : image,
        variables,
        ports: Object.fromEntries(
          Object.entries(ports).filter(([, v]) => v).map(([k, v]) => [k, Number(v)]),
        ),
        limits,
        restartOnCrash,
        autoStart,
        install,
      },
      {
        onSuccess: (r) => {
          toast.success(`Created ${r.instance.name}`);
          onCreated(r.instance.id);
        },
        onError: (e) => toast.error(errorMessage(e)),
      },
    );

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Variables</CardTitle>
        </CardHeader>
        <CardContent>
          <VariableFields
            variables={def.variables}
            values={variables}
            onChange={(n, v) => setVariables((s) => ({ ...s, [n]: v }))}
            owner
          />
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Runtime</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Field label="Image" hint="Pulled on the node at first start.">
              <Combobox
                value={image}
                onValueChange={setImage}
                className="font-mono"
                itemClassName="font-mono"
                searchPlaceholder="Search images…"
                options={images.map((i) => ({
                  value: i.ref,
                  label: i.label !== "Default" ? `${i.label} · ${i.ref}` : i.ref,
                }))}
              />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Memory (MB)" htmlFor="mem" hint="0 = unlimited">
                <Input
                  id="mem"
                  type="number"
                  min={0}
                  value={limits.memoryMb}
                  onChange={(e) => setLimits({ ...limits, memoryMb: Number(e.target.value) })}
                />
              </Field>
              <Field label="CPU cores" htmlFor="cpu" hint="0 = unlimited">
                <Input
                  id="cpu"
                  type="number"
                  min={0}
                  step={0.5}
                  value={limits.cpuCores}
                  onChange={(e) => setLimits({ ...limits, cpuCores: Number(e.target.value) })}
                />
              </Field>
              <Field label="Disk (MB)" htmlFor="disk" hint="Advisory">
                <Input
                  id="disk"
                  type="number"
                  min={0}
                  value={limits.diskMb}
                  onChange={(e) => setLimits({ ...limits, diskMb: Number(e.target.value) })}
                />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={restartOnCrash} onCheckedChange={setRestartOnCrash} />
              Restart when the server crashes
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={autoStart} onCheckedChange={setAutoStart} />
              Start automatically when the node comes up
            </label>
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={install} onCheckedChange={setInstall} />
              Run the install right away
            </label>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Ports</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-xs text-muted-foreground">
              Leave empty to take the next free port from the node's pool ({node.portRangeStart}–
              {node.portRangeEnd}).
            </p>
            {def.ports.length === 0 && (
              <p className="text-xs text-muted-foreground">This template publishes no ports.</p>
            )}
            {def.ports.map((p) => {
              const run = portRun(def.ports, p.name);
              if (run.offset > 0) {
                const head = ports[run.head] ?? "";
                return (
                  <Field
                    key={p.name}
                    label={`${p.label} (${p.protocol})`}
                    htmlFor={`port-${p.name}`}
                    hint={`Always ${run.head} + ${run.offset}`}
                  >
                    <Input
                      id={`port-${p.name}`}
                      disabled
                      placeholder="auto"
                      className="font-mono"
                      value={head ? String(Number(head) + run.offset) : ""}
                    />
                  </Field>
                );
              }
              const v = ports[p.name] ?? "";
              const bad = portProblems.some(([k]) => k === p.name);
              return (
                <Field
                  key={p.name}
                  label={`${p.label} (${p.protocol})${p.primary ? " · primary" : ""}`}
                  htmlFor={`port-${p.name}`}
                  hint={`Preferred ${p.default}`}
                  error={bad ? "Invalid or already in use on this node" : null}
                >
                  <Input
                    id={`port-${p.name}`}
                    type="number"
                    min={1}
                    max={65535}
                    placeholder="auto"
                    value={v}
                    className="font-mono"
                    onChange={(e) => setPorts({ ...ports, [p.name]: e.target.value })}
                  />
                </Field>
              );
            })}
            {inUse.size > 0 && (
              <p className="text-xs text-muted-foreground">
                In use on {node.name}: {[...inUse].sort((a, b) => a - b).join(", ")}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          <ArrowLeft /> Back
        </Button>
        <Button
          disabled={create.isPending || problems.length > 0 || portProblems.length > 0}
          onClick={submit}
        >
          {create.isPending ? <Loader2 className="animate-spin" /> : <Check />} Create instance
        </Button>
      </div>
    </div>
  );
}
