import { lazy, Suspense, useEffect, useState } from "react";
import { Download, FileWarning, Loader2, Pencil, RotateCcw, Save, WrapText, X } from "lucide-react";
import { toast } from "sonner";
import { modeString } from "@gsm/shared";
import { ApiError, errorMessage } from "@/api/client";
import { useFileActions, useFileContent } from "@/api/files";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { CopyButton } from "@/components/data/copy-button";
import { EmptyState } from "@/components/data/empty-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBytes, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const CodeEditor = lazy(() => import("./code-editor"));

/**
 * View a file and edit it in place. Saving sends the SHA-256 it was opened with; if the file
 * changed on disk meanwhile the node refuses, and the operator reloads or overwrites.
 */
export function FileViewer({
  instanceId,
  path,
  startEditing,
  canEdit,
  onClose,
  onDownload,
}: {
  instanceId: number;
  path: string | null;
  startEditing: boolean;
  canEdit: boolean;
  onClose: () => void;
  onDownload: (path: string) => void;
}) {
  const q = useFileContent(instanceId, path);
  const { write } = useFileActions(instanceId);
  const [editing, setEditing] = useState(startEditing);
  const [base, setBase] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sha, setSha] = useState<string | null>(null);
  const [docKey, setDocKey] = useState(0);
  const [wrap, setWrap] = useState(false);
  const [conflict, setConflict] = useState(false);
  /** Size and time of our last save, which the file on disk now has. */
  const [saved, setSaved] = useState<{ size: number; mtime: string } | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  // A freshly read file (first open or reload) replaces the buffer.
  useEffect(() => {
    if (q.data?.content === undefined) return;
    const content = q.data.content ?? "";
    setBase(content);
    setDraft(content);
    setSha(q.data.sha256 || null);
    setConflict(false);
    setSaved(null);
    setDocKey((k) => k + 1);
  }, [q.data]);

  useEffect(() => setEditing(startEditing && canEdit), [path, startEditing, canEdit]);

  const dirty = base !== null && draft !== base;
  const f = q.data;
  const readable = f && f.content !== null;

  const save = (force = false) => {
    if (!path || !dirty || write.isPending) return;
    write.mutate({ path, content: draft, expectSha256: force ? null : sha }, {
      onSuccess: (r) => {
        setBase(draft);
        setSha(r.sha256);
        setConflict(false);
        setSaved({ size: r.size, mtime: r.mtime });
        toast.success(`Saved ${path}`);
      },
      onError: (e) => {
        if (e instanceof ApiError && e.code === "file_changed") setConflict(true);
        else toast.error(errorMessage(e));
      },
    });
  };

  const close = () => (dirty ? setConfirmClose(true) : onClose());

  return (
    <>
      <Dialog open={!!path} onOpenChange={(o) => !o && close()}>
        <DialogContent
          className="grid h-[min(88vh,60rem)] max-w-[min(96vw,80rem)] grid-rows-[auto_auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
          onEscapeKeyDown={(e) => {
            // Esc belongs to the editor's search panel while editing.
            if (editing) e.preventDefault();
          }}
        >
          <div className="flex flex-wrap items-center gap-2 border-b py-2.5 pr-12 pl-4">
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex min-w-0 items-center gap-1 font-mono text-sm">
                <span className="truncate" title={path ?? ""}>{path}</span>
                {path && <CopyButton value={path} label="Copy path" />}
                {dirty && (
                  <span className="text-xs font-normal text-status-degraded">● unsaved</span>
                )}
              </DialogTitle>
              <DialogDescription className="mt-0.5 font-mono">
                {f
                  ? `${formatBytes(saved?.size ?? f.size)} · ${
                    modeString(f.mode).slice(1)
                  } · modified ${formatDateTime(saved?.mtime ?? f.mtime)}`
                  : "Reading…"}
              </DialogDescription>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {readable && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant={wrap ? "secondary" : "ghost"}
                      onClick={() => setWrap(!wrap)}
                      aria-label="Wrap lines"
                    >
                      <WrapText />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Wrap long lines</TooltipContent>
                </Tooltip>
              )}
              {path && (
                <Button size="sm" variant="ghost" onClick={() => onDownload(path)}>
                  <Download /> Download
                </Button>
              )}
              {readable && canEdit && !editing && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setEditing(true)}
                >
                  <Pencil /> Edit
                </Button>
              )}
              {readable && editing && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={write.isPending}
                    onClick={() => {
                      setDraft(base ?? "");
                      setDocKey((k) => k + 1);
                      setEditing(false);
                    }}
                  >
                    <X /> {dirty ? "Discard" : "Done"}
                  </Button>
                  <Button size="sm" disabled={!dirty || write.isPending} onClick={() => save()}>
                    {write.isPending ? <Loader2 className="animate-spin" /> : <Save />} Save
                  </Button>
                </>
              )}
            </div>
          </div>

          {conflict
            ? (
              <div className="flex flex-wrap items-center gap-2 border-b bg-status-degraded/10 px-4 py-2 text-xs">
                <FileWarning className="size-4 text-status-degraded" />
                <span className="flex-1">
                  The file changed on disk since you opened it. Reload it (your changes are lost) or
                  overwrite it with yours.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(false);
                    q.refetch();
                  }}
                >
                  <RotateCcw /> Reload
                </Button>
                <Button size="sm" variant="destructive" onClick={() => save(true)}>
                  Overwrite
                </Button>
              </div>
            )
            : <div />}

          <div className="min-h-0">
            {q.isLoading && (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            )}
            {q.error && (
              <div className="p-6">
                <EmptyState
                  icon={FileWarning}
                  title="Couldn't open the file"
                  description={errorMessage(q.error)}
                />
              </div>
            )}
            {f && f.content === null && (
              <div className="p-6">
                <EmptyState
                  icon={FileWarning}
                  title={f.tooLarge ? "Too large to open here" : "Binary file"}
                  description={f.tooLarge
                    ? `The browser opens files up to ${
                      formatBytes(f.limit)
                    } (Settings → General). Download it instead.`
                    : "It holds bytes that aren't text. Download it instead."}
                  action={path && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => onDownload(path)}
                    >
                      <Download /> Download
                    </Button>
                  )}
                />
              </div>
            )}
            {readable && path && (
              <div className={cn("h-full", editing && "ring-1 ring-inset ring-primary/30")}>
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      <Loader2 className="size-5 animate-spin" />
                    </div>
                  }
                >
                  <CodeEditor
                    docKey={`${path}:${docKey}`}
                    value={draft}
                    path={path}
                    readOnly={!editing}
                    wrap={wrap}
                    onChange={setDraft}
                    onSave={() =>
                      save()}
                  />
                </Suspense>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmClose}
        onOpenChange={setConfirmClose}
        title="Discard your changes?"
        description={`${path} has unsaved changes.`}
        confirmLabel="Discard"
        onConfirm={() => {
          setConfirmClose(false);
          onClose();
        }}
      />
    </>
  );
}
