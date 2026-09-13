import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { Copy, Download, FileJson, LayoutTemplate, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { TemplateDto } from "@gsm/shared";
import { TemplateDefinition } from "@gsm/shared";
import { authStatusQuery } from "@/api/auth";
import { errorMessage } from "@/api/client";
import { useTemplateMutations, useTemplates } from "@/api/templates";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { EmptyState } from "@/components/data/empty-state";
import { Field } from "@/components/data/field";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import { GENERIC_TEMPLATE } from "@/lib/template-defaults";

export const Route = createFileRoute("/_app/templates/")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.ensureQueryData(authStatusQuery);
    if (status.user?.role !== "admin") throw redirect({ to: "/" });
  },
  component: TemplatesPage,
});

function TemplatesPage() {
  const { data: templates = [] } = useTemplates();
  const tm = useTemplateMutations();
  const navigate = useNavigate();
  const err = (e: Error) => toast.error(errorMessage(e));
  const groups = useMemo(() => {
    const m = new Map<string, TemplateDto[]>();
    for (const t of templates) m.set(t.game, [...(m.get(t.game) ?? []), t]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [templates]);
  return (
    <>
      <PageHeader
        title="Templates"
        description="How each kind of game server is installed and run."
        actions={
          <>
            <ImportDialog />
            <Button
              size="sm"
              onClick={() =>
                tm.create.mutate(
                  {
                    ...GENERIC_TEMPLATE,
                    slug: `custom-${Date.now().toString(36)}`,
                    name: "New template",
                  },
                  {
                    onSuccess: (r) =>
                      navigate({
                        to: "/templates/$templateId",
                        params: { templateId: String(r.template.id) },
                      }),
                    onError: err,
                  },
                )}
            >
              <Plus /> New template
            </Button>
          </>
        }
      />
      <div className="grid gap-4 p-4 sm:p-6">
        {templates.length === 0 && (
          <EmptyState
            icon={LayoutTemplate}
            title="No templates"
            description="Built-in templates are seeded when the server starts."
          />
        )}
        {groups.map(([game, list]) => (
          <div key={game} className="grid gap-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {game}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((t) => (
                <div key={t.id} className="flex flex-col rounded-lg border bg-card p-4">
                  <div className="flex items-center gap-2">
                    <span className="text-xl leading-none">{t.icon}</span>
                    <Link
                      to="/templates/$templateId"
                      params={{ templateId: String(t.id) }}
                      className="font-medium hover:underline"
                    >
                      {t.name}
                    </Link>
                    {t.builtin && <Badge variant="muted" className="ml-auto">built-in</Badge>}
                  </div>
                  <p className="mt-2 line-clamp-3 flex-1 text-xs text-muted-foreground">
                    {t.description}
                  </p>
                  <div className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
                    <span className="font-mono">{t.slug}</span>
                    <span>· {t.instanceCount} instance{t.instanceCount === 1 ? "" : "s"}</span>
                    <div className="flex-1" />
                    <CopyDialog template={t} />
                    <Button variant="ghost" size="icon-sm" aria-label="Export JSON" asChild>
                      <a href={`/api/v1/templates/${t.id}/export`} download>
                        <Download />
                      </a>
                    </Button>
                    {!t.builtin && (
                      <ConfirmDialog
                        trigger={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Delete"
                            disabled={t.instanceCount > 0}
                          >
                            <Trash2 />
                          </Button>
                        }
                        title={`Delete ${t.name}?`}
                        confirmLabel="Delete"
                        onConfirm={() => tm.remove.mutate(t.id, { onError: err })}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function CopyDialog({ template: t }: { template: TemplateDto }) {
  const tm = useTemplateMutations();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState(`${t.slug}-copy`);
  const [name, setName] = useState(`${t.name} (copy)`);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Copy">
          <Copy />
        </Button>
      </DialogTrigger>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Copy {t.name}</DialogTitle>
          <DialogDescription>The copy is yours to edit.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Field label="Slug" htmlFor="cslug" hint="Lowercase letters, digits and dashes">
            <Input
              id="cslug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field label="Name" htmlFor="cname">
            <Input id="cname" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            disabled={tm.copy.isPending || !slug || !name}
            onClick={() =>
              tm.copy.mutate({ id: t.id, slug, name }, {
                onSuccess: (r) => {
                  setOpen(false);
                  navigate({
                    to: "/templates/$templateId",
                    params: { templateId: String(r.template.id) },
                  });
                },
                onError: (e) => toast.error(errorMessage(e)),
              })}
          >
            Copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog() {
  const tm = useTemplateMutations();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  let problem: string | null = null;
  let parsed: unknown = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
      const r = TemplateDefinition.safeParse(parsed);
      if (!r.success) {
        problem = r.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join(
          "; ",
        );
      }
    } catch (e) {
      problem = e instanceof Error ? e.message : "Invalid JSON";
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <FileJson /> Import
        </Button>
      </DialogTrigger>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Import a template</DialogTitle>
          <DialogDescription>
            Paste a template definition JSON (an export from here, or hand-written).
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={14}
          className="font-mono text-xs"
          placeholder='{ "schemaVersion": 1, "slug": "my-game", ... }'
        />
        {problem && <div className="text-xs text-status-critical">{problem}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button
            disabled={!parsed || !!problem || tm.import.isPending}
            onClick={() =>
              tm.import.mutate(parsed, {
                onSuccess: (r) => {
                  setOpen(false);
                  setText("");
                  navigate({
                    to: "/templates/$templateId",
                    params: { templateId: String(r.template.id) },
                  });
                },
                onError: (e) => toast.error(errorMessage(e)),
              })}
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
