import { useCallback, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronRight,
  Download,
  File,
  FileArchive,
  FilePlus,
  Folder,
  FolderPlus,
  Link2,
  Loader2,
  MoreHorizontal,
  PackageOpen,
  Pencil,
  RefreshCw,
  Shield,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import {
  baseName,
  type FileEntry,
  isArchiveName,
  joinPath,
  modeString,
  parentPath,
  validFileName,
} from "@gsm/shared";
import { errorMessage } from "@/api/client";
import { uploads, useDirectory, useFileActions } from "@/api/files";
import { EmptyState } from "@/components/data/empty-state";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ChmodDialog, DeleteDialog, NameDialog } from "./file-dialogs";
import { FileViewer } from "./file-viewer";

type Dialog =
  | { kind: "none" }
  | { kind: "mkdir" }
  | { kind: "newfile" }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "compress"; entries: FileEntry[] }
  | { kind: "chmod"; entries: FileEntry[] }
  | { kind: "delete"; entries: FileEntry[] };

const nameProblem = (v: string) =>
  validFileName(v) ? null : "A name can't be empty, '.' or '..' or contain '/'";

/** Browse and manage files under one instance's data directory. */
export function FileManager(
  { instanceId, canEdit }: { instanceId: number; canEdit: boolean },
) {
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>({ kind: "none" });
  const [viewing, setViewing] = useState<{ path: string; edit: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const q = useDirectory(instanceId, path);
  const actions = useFileActions(instanceId);
  const err = (e: Error) => toast.error(errorMessage(e));

  const entries = useMemo(() => {
    const list = q.data?.entries ?? [];
    return [...list].sort((a, b) => {
      const da = a.type === "dir" || a.targetType === "dir";
      const db = b.type === "dir" || b.targetType === "dir";
      if (da !== db) return da ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
  }, [q.data]);

  const go = useCallback((p: string) => {
    setPath(p);
    setSelected(new Set());
  }, []);

  const selectedEntries = entries.filter((e) => selected.has(e.name));
  const crumbs = path ? path.split("/") : [];
  const close = () => setDialog({ kind: "none" });

  const open = (e: FileEntry) => {
    const kind = e.type === "symlink" ? e.targetType : e.type;
    if (kind === "dir") go(joinPath(path, e.name));
    else if (kind === "file") setViewing({ path: joinPath(path, e.name), edit: false });
  };

  const download = (names: string[]) =>
    actions.download.mutate({ paths: names.map((n) => joinPath(path, n)) }, { onError: err });

  const uploadFiles = (files: FileList | File[]) => {
    for (const f of Array.from(files)) uploads.start(instanceId, path, f, { overwrite: true });
  };

  return (
    <div
      className={cn("grid gap-3", dragging && "rounded-lg ring-2 ring-primary/50")}
      onDragOver={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!canEdit) return;
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto font-mono text-xs">
          <button
            className="rounded px-1.5 py-0.5 hover:bg-accent"
            onClick={() => go("")}
          >
            /data
          </button>
          {crumbs.map((c, i) => {
            const target = crumbs.slice(0, i + 1).join("/");
            return (
              <span key={target} className="flex items-center gap-0.5">
                <ChevronRight className="size-3 text-muted-foreground" />
                <button
                  className={cn(
                    "rounded px-1.5 py-0.5 hover:bg-accent",
                    i === crumbs.length - 1 && "font-medium",
                  )}
                  onClick={() => go(target)}
                >
                  {c}
                </button>
              </span>
            );
          })}
        </nav>
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => q.refetch()} aria-label="Refresh">
            <RefreshCw className={cn(q.isFetching && "animate-spin")} />
          </Button>
          {selected.size > 0 && (
            <>
              <Button size="sm" variant="outline" onClick={() => download([...selected])}>
                <Download />{" "}
                Download{selected.size > 1 || selectedEntries.some((e) => e.type === "dir")
                  ? " as archive"
                  : ""}
              </Button>
              {canEdit && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDialog({ kind: "compress", entries: selectedEntries })}
                  >
                    <Archive /> Compress
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDialog({ kind: "chmod", entries: selectedEntries })}
                  >
                    <Shield /> Permissions
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setDialog({ kind: "delete", entries: selectedEntries })}
                  >
                    <Trash2 /> Delete
                  </Button>
                </>
              )}
            </>
          )}
          {canEdit && (
            <>
              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "newfile" })}>
                <FilePlus /> New file
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "mkdir" })}>
                <FolderPlus /> New folder
              </Button>
              <Button size="sm" onClick={() => fileInput.current?.click()}>
                <Upload /> Upload
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) uploadFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-8">
                <Checkbox
                  aria-label="Select all"
                  checked={entries.length > 0 && selected.size === entries.length}
                  onCheckedChange={(v) =>
                    setSelected(v ? new Set(entries.map((e) => e.name)) : new Set())}
                />
              </TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-24 text-right">Size</TableHead>
              <TableHead className="w-44">Modified</TableHead>
              <TableHead className="w-28">Mode</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  <Loader2 className="mx-auto size-5 animate-spin" />
                </TableCell>
              </TableRow>
            )}
            {q.error && (
              <TableRow>
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    title="Couldn't list the directory"
                    description={errorMessage(q.error)}
                    className="border-0"
                  />
                </TableCell>
              </TableRow>
            )}
            {q.data && entries.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={Folder}
                    title="Empty directory"
                    description={canEdit ? "Drop files here to upload them." : undefined}
                    className="border-0"
                  />
                </TableCell>
              </TableRow>
            )}
            {path && q.data && (
              <TableRow
                className="cursor-pointer"
                onClick={() => go(parentPath(path))}
              >
                <TableCell />
                <TableCell className="font-mono text-muted-foreground" colSpan={5}>..</TableCell>
              </TableRow>
            )}
            {entries.map((e) => {
              const kind = e.type === "symlink" ? e.targetType : e.type;
              const Icon = kind === "dir"
                ? Folder
                : e.type === "symlink"
                ? Link2
                : isArchiveName(e.name)
                ? FileArchive
                : File;
              return (
                <TableRow
                  key={e.name}
                  className={cn("cursor-default", selected.has(e.name) && "bg-accent/40")}
                  onDoubleClick={() => open(e)}
                >
                  <TableCell>
                    <Checkbox
                      aria-label={`Select ${e.name}`}
                      checked={selected.has(e.name)}
                      onCheckedChange={(v) => {
                        const next = new Set(selected);
                        if (v) next.add(e.name);
                        else next.delete(e.name);
                        setSelected(next);
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <button
                      className="flex items-center gap-2 text-left font-mono hover:underline"
                      onClick={() => open(e)}
                    >
                      <Icon
                        className={cn(
                          "size-4 shrink-0",
                          kind === "dir" ? "text-primary" : "text-muted-foreground",
                        )}
                      />
                      <span className="truncate">{e.name}</span>
                    </button>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">
                    {kind === "dir" ? "—" : formatBytes(e.size)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDateTime(e.mtime)}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {modeString(e.mode, e.type)}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon-sm" variant="ghost" aria-label="Actions">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {kind === "file" && (
                          <DropdownMenuItem onSelect={() => open(e)}>
                            <File /> Open
                          </DropdownMenuItem>
                        )}
                        {kind === "file" && canEdit && (
                          <DropdownMenuItem
                            onSelect={() =>
                              setViewing({ path: joinPath(path, e.name), edit: true })}
                          >
                            <Pencil /> Edit
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => download([e.name])}>
                          <Download /> Download{kind === "dir" ? " as archive" : ""}
                        </DropdownMenuItem>
                        {canEdit && (
                          <>
                            <DropdownMenuSeparator />
                            {kind === "file" && isArchiveName(e.name) && (
                              <DropdownMenuItem
                                onSelect={() =>
                                  actions.extract.mutate(
                                    { path: joinPath(path, e.name), dest: path },
                                    {
                                      onSuccess: (r) => toast.success(`Extracted ${r.files} files`),
                                      onError: err,
                                    },
                                  )}
                              >
                                <PackageOpen /> Extract here
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                              onSelect={() => setDialog({ kind: "compress", entries: [e] })}
                            >
                              <Archive /> Compress
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => setDialog({ kind: "rename", entry: e })}
                            >
                              <Pencil /> Rename or move
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => setDialog({ kind: "chmod", entries: [e] })}
                            >
                              <Shield /> Permissions
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-status-critical"
                              onSelect={() => setDialog({ kind: "delete", entries: [e] })}
                            >
                              <Trash2 /> Delete
                            </DropdownMenuItem>
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {q.data?.truncated && (
          <div className="border-t px-3 py-2 text-xs text-status-degraded">
            Only the first entries are listed; the directory is very large.
          </div>
        )}
      </div>

      <NameDialog
        open={dialog.kind === "mkdir"}
        title="New folder"
        label="Name"
        initial=""
        confirmLabel="Create"
        busy={actions.mkdir.isPending}
        validate={nameProblem}
        onSubmit={(name) =>
          actions.mkdir.mutate({ path: joinPath(path, name) }, { onSuccess: close, onError: err })}
        onClose={close}
      />
      <NameDialog
        open={dialog.kind === "newfile"}
        title="New file"
        description="An empty file is created; open it to edit."
        label="Name"
        initial=""
        confirmLabel="Create"
        busy={actions.write.isPending}
        validate={nameProblem}
        onSubmit={(name) =>
          actions.write.mutate(
            { path: joinPath(path, name), content: "", expectSha256: null, create: true },
            {
              onSuccess: () => {
                close();
                setViewing({ path: joinPath(path, name), edit: true });
              },
              onError: err,
            },
          )}
        onClose={close}
      />
      <NameDialog
        open={dialog.kind === "rename"}
        title="Rename or move"
        description="A path with slashes moves it; it must stay inside the instance."
        label="New path"
        initial={dialog.kind === "rename" ? joinPath(path, dialog.entry.name) : ""}
        confirmLabel="Rename"
        busy={actions.rename.isPending}
        validate={(v) =>
          v.startsWith("/") || v.split("/").includes("..") ? "Must stay inside the instance" : null}
        onSubmit={(to) => {
          if (dialog.kind !== "rename") return;
          actions.rename.mutate({ from: joinPath(path, dialog.entry.name), to }, {
            onSuccess: close,
            onError: err,
          });
        }}
        onClose={close}
      />
      <NameDialog
        open={dialog.kind === "compress"}
        title="Compress"
        description="Ends in .tar.gz or .zip; created in the current directory."
        label="Archive name"
        initial={dialog.kind === "compress"
          ? `${dialog.entries.length === 1 ? baseName(dialog.entries[0].name) : "archive"}.tar.gz`
          : ""}
        confirmLabel="Compress"
        busy={actions.compress.isPending}
        validate={(v) =>
          !validFileName(v)
            ? "Invalid name"
            : /\.(zip|tar\.gz|tgz)$/i.test(v)
            ? null
            : "Use .tar.gz or .zip"}
        onSubmit={(name) => {
          if (dialog.kind !== "compress") return;
          actions.compress.mutate(
            {
              paths: dialog.entries.map((e) => joinPath(path, e.name)),
              dest: joinPath(path, name),
            },
            {
              onSuccess: (r) => {
                toast.success(`Created ${baseName(r.path)} (${formatBytes(r.size)})`);
                close();
                setSelected(new Set());
              },
              onError: err,
            },
          );
        }}
        onClose={close}
      />
      <ChmodDialog
        entries={dialog.kind === "chmod" ? dialog.entries : null}
        busy={actions.chmod.isPending}
        onSubmit={({ mode, recursive }) => {
          if (dialog.kind !== "chmod") return;
          actions.chmod.mutate(
            { paths: dialog.entries.map((e) => joinPath(path, e.name)), mode, recursive },
            { onSuccess: close, onError: err },
          );
        }}
        onClose={close}
      />
      <DeleteDialog
        entries={dialog.kind === "delete" ? dialog.entries : null}
        busy={actions.remove.isPending}
        onSubmit={() => {
          if (dialog.kind !== "delete") return;
          actions.remove.mutate({ paths: dialog.entries.map((e) => joinPath(path, e.name)) }, {
            onSuccess: () => {
              close();
              setSelected(new Set());
            },
            onError: err,
          });
        }}
        onClose={close}
      />
      <FileViewer
        instanceId={instanceId}
        path={viewing?.path ?? null}
        startEditing={viewing?.edit ?? false}
        canEdit={canEdit}
        onClose={() => setViewing(null)}
        onDownload={(p) => actions.download.mutate({ paths: [p] }, { onError: err })}
      />
    </div>
  );
}
