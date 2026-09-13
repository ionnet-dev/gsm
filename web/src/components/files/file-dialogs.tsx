import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { type FileEntry, modeOctal, modeString } from "@gsm/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Ask for one name or path (new folder, new file, rename or move, archive name). */
export function NameDialog({
  open,
  title,
  description,
  label,
  initial,
  confirmLabel,
  busy,
  validate,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  label: string;
  initial: string;
  confirmLabel: string;
  busy: boolean;
  validate: (v: string) => string | null;
  onSubmit: (v: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  const problem = value.trim() ? validate(value.trim()) : null;
  const submit = () => {
    if (!value.trim() || problem || busy) return;
    onSubmit(value.trim());
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="name-dialog-input">{label}</Label>
          <Input
            id="name-dialog-input"
            autoFocus
            value={value}
            className="font-mono"
            onChange={(e) => setValue(e.target.value)}
            onFocus={(e) => {
              // Select the name without its extension, as file managers do.
              const v = e.currentTarget.value;
              const dot = v.lastIndexOf(".");
              const slash = v.lastIndexOf("/");
              e.currentTarget.setSelectionRange(slash + 1, dot > slash + 1 ? dot : v.length);
            }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          {problem && <span className="text-xs text-status-critical">{problem}</span>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!value.trim() || !!problem || busy} onClick={submit}>
            {busy && <Loader2 className="animate-spin" />} {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const WHO = [["Owner", 6], ["Group", 3], ["Others", 0]] as const;
const WHAT = [["Read", 4], ["Write", 2], ["Execute", 1]] as const;

/** chmod for one or more entries. */
export function ChmodDialog({
  entries,
  busy,
  onSubmit,
  onClose,
}: {
  entries: FileEntry[] | null;
  busy: boolean;
  onSubmit: (v: { mode: number; recursive: boolean }) => void;
  onClose: () => void;
}) {
  const first = entries?.[0];
  const [mode, setMode] = useState(0o644);
  const [octal, setOctal] = useState("644");
  const [recursive, setRecursive] = useState(false);

  useEffect(() => {
    if (!first) return;
    setMode(first.mode);
    setOctal(modeOctal(first.mode));
    setRecursive(false);
  }, [first]);

  if (!entries || !first) return null;
  const many = entries.length > 1;
  const anyDir = entries.some((e) => e.type === "dir");
  const setBits = (m: number) => {
    setMode(m);
    setOctal(modeOctal(m));
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Permissions</DialogTitle>
          <DialogDescription className="font-mono">
            {many ? `${entries.length} items` : first.name}
            {!many && ` · ${modeString(first.mode, first.type)}`}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="chmod-octal" className="w-14">Mode</Label>
            <Input
              id="chmod-octal"
              value={octal}
              maxLength={3}
              className="w-20 font-mono"
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-7]/g, "");
                setOctal(v);
                if (/^[0-7]{3}$/.test(v)) setMode(parseInt(v, 8));
              }}
            />
            <span className="font-mono text-xs text-muted-foreground">
              {modeString(mode, first.type === "dir" ? "dir" : "file")}
            </span>
          </div>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="px-3 py-1.5 text-left font-normal" />
                  {WHAT.map(([w]) => <th key={w} className="px-3 py-1.5 font-normal">{w}</th>)}
                </tr>
              </thead>
              <tbody>
                {WHO.map(([who, shift]) => (
                  <tr key={who} className="border-b last:border-0">
                    <td className="px-3 py-1.5">{who}</td>
                    {WHAT.map(([w, bit]) => {
                      const b = bit << shift;
                      return (
                        <td key={w} className="px-3 py-1.5 text-center">
                          <Checkbox
                            aria-label={`${who} ${w}`}
                            checked={(mode & b) !== 0}
                            onCheckedChange={(v) => setBits(v ? mode | b : mode & ~b)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {anyDir && (
          <label className="flex items-start gap-2 text-xs">
            <Checkbox checked={recursive} onCheckedChange={(v) => setRecursive(!!v)} />
            <span>
              Apply to everything inside too
              <span className="block text-muted-foreground">
                Files and directories get the same mode, like chmod -R.
              </span>
            </span>
          </label>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={() => onSubmit({ mode, recursive })}>
            {busy && <Loader2 className="animate-spin" />} Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Delete entries; a directory needs its name (or the count) typed out. */
export function DeleteDialog({
  entries,
  busy,
  onSubmit,
  onClose,
}: {
  entries: FileEntry[] | null;
  busy: boolean;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => setTyped(""), [entries]);
  if (!entries?.length) return null;
  const dirs = entries.filter((e) => e.type === "dir");
  const phrase = entries.length === 1 ? entries[0].name : `delete ${entries.length}`;
  const needsTyping = dirs.length > 0;
  const ok = !needsTyping || typed === phrase;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>
            Delete {entries.length === 1 ? entries[0].name : `${entries.length} items`}?
          </DialogTitle>
          <DialogDescription>
            {needsTyping
              ? "Directories are deleted with everything in them. This can't be undone."
              : "This can't be undone."}
          </DialogDescription>
        </DialogHeader>
        {entries.length > 1 && (
          <ul className="max-h-40 overflow-auto rounded-md border px-3 py-2 font-mono text-xs">
            {entries.map((e) => (
              <li key={e.name} className="truncate">{e.name}{e.type === "dir" ? "/" : ""}</li>
            ))}
          </ul>
        )}
        {needsTyping && (
          <div className="grid gap-1.5">
            <Label htmlFor="delete-confirm" className="text-xs">
              Type <span className="font-mono font-semibold">{phrase}</span> to confirm
            </Label>
            <Input
              id="delete-confirm"
              autoFocus
              value={typed}
              className="font-mono"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ok && !busy && onSubmit()}
            />
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={!ok || busy} onClick={onSubmit}>
            {busy && <Loader2 className="animate-spin" />} Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
