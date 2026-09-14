import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router";
import { Database, Download, Eye, EyeOff, FileDown, FileUp, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { InstanceDatabaseDto, InstanceDetailDto } from "@gsm/shared";
import { roleAllows } from "@gsm/shared";
import { errorMessage } from "@/api/client";
import { useDumpDatabase, useImportDatabase, useInstanceDatabase } from "@/api/database";
import { useFileActions } from "@/api/files";
import { useInstance } from "@/api/instances";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { CopyButton } from "@/components/data/copy-button";
import { EmptyState } from "@/components/data/empty-state";
import { ErrorView, PendingView } from "@/components/data/error-view";
import { Field } from "@/components/data/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatBytes } from "@/lib/format";

const parent = getRouteApi("/_app/instances/$instanceId");

export const Route = createFileRoute("/_app/instances/$instanceId/database")({
  component: DatabaseTab,
});

function DatabaseTab() {
  const instanceId = Number(parent.useParams().instanceId);
  const { data: instance } = useInstance(instanceId);
  const allowed = !!instance && roleAllows(instance.myRole, "settings");
  const q = useInstanceDatabase(instanceId, allowed && !!instance?.database);
  if (!instance) return null;
  if (!instance.database) {
    return (
      <EmptyState
        icon={Database}
        title="No database"
        description="This instance's template has no database, or it is turned off in its variables."
      />
    );
  }
  if (!allowed) {
    return (
      <EmptyState
        icon={Database}
        title="No access"
        description="The database's details need the operator role."
      />
    );
  }
  if (q.isLoading) return <PendingView />;
  if (q.error) return <ErrorView error={q.error} reset={() => q.refetch()} />;
  return <DatabaseView instance={instance} db={q.data!} />;
}

function DatabaseView(
  { instance: i, db }: { instance: InstanceDetailDto; db: InstanceDatabaseDto },
) {
  const manage = roleAllows(i.myRole, "backups");
  // The server refuses both while the node is away or an install runs.
  const blocked = i.node.status === "offline"
    ? "The node is offline"
    : i.status === "installing"
    ? "Not while the instance is installing"
    : null;
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <ConnectionCard db={db} />
        <Card>
          <CardHeader>
            <CardTitle>How it runs</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-xs text-muted-foreground">
            <p>
              The database server runs beside the instance in its own container, on a private
              network only the two share. The game reaches it at{" "}
              <span className="font-mono text-foreground">{db.host}:{db.port}</span>.
            </p>
            <p>
              It starts before the game and stops after it; a restart keeps it running. Its files
              are kept apart from the instance's files.
            </p>
            <p>
              Backups include a dump of it. For a copy of your own, export a dump below; it lands in
              the instance's files.
            </p>
          </CardContent>
        </Card>
      </div>
      {manage && (
        <div className="grid gap-4 lg:grid-cols-2">
          <DumpCard instance={i} db={db} blocked={blocked} />
          <ImportCard instance={i} db={db} blocked={blocked} />
        </div>
      )}
    </div>
  );
}

function ConnectionCard({ db }: { db: InstanceDatabaseDto }) {
  const [shown, setShown] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connection</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-4 gap-y-1.5 text-xs">
          <Row k="Host" v={db.host} />
          <Row k="Port" v={String(db.port)} />
          <Row k="Database" v={db.name} />
          <Row k="User" v={db.user} />
          <span className="text-muted-foreground">Password</span>
          <span className="flex min-w-0 items-center gap-1 font-mono">
            <span className="truncate" title={shown ? db.password : undefined}>
              {shown ? db.password : "•".repeat(16)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={shown ? "Hide password" : "Show password"}
              onClick={() => setShown((s) => !s)}
            >
              {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </Button>
            <CopyButton value={db.password} label="Copy password" />
          </span>
          <span className="text-muted-foreground">Engine</span>
          <span>{db.engine === "mariadb" ? "MariaDB" : db.engine}</span>
          <Row k="Image" v={db.image} />
        </div>
        <p className="text-xs text-muted-foreground">
          The game gets these as <code className="font-mono">GSM_DB_HOST</code>,{" "}
          <code className="font-mono">GSM_DB_PORT</code>,{" "}
          <code className="font-mono">GSM_DB_NAME</code>,{" "}
          <code className="font-mono">GSM_DB_USER</code> and{" "}
          <code className="font-mono">GSM_DB_PASSWORD</code>.
        </p>
      </CardContent>
    </Card>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span className="text-muted-foreground">{k}</span>
      <span className="flex min-w-0 items-center gap-1 font-mono">
        <span className="truncate" title={v}>{v}</span>
        <CopyButton value={v} label={`Copy ${k.toLowerCase()}`} />
      </span>
    </>
  );
}

function DumpCard(
  { instance: i, db, blocked }: {
    instance: InstanceDetailDto;
    db: InstanceDatabaseDto;
    blocked: string | null;
  },
) {
  const dump = useDumpDatabase(i.id);
  const files = useFileActions(i.id);
  const [path, setPath] = useState("");
  const [result, setResult] = useState<{ path: string; size: number } | null>(null);
  const err = (e: Error) => toast.error(errorMessage(e));
  const run = () =>
    dump.mutate({ path: path.trim() || null }, {
      onSuccess: (r) => {
        setResult(r);
        toast.success("Dump exported");
      },
      onError: err,
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Export dump</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          Writes a gzipped SQL dump of the database into the instance's files. A stopped database is
          started for it.
        </p>
        <Field
          label="Path (optional)"
          htmlFor="dbdump"
          hint={`In the instance's files. Empty = database-dumps/${db.name}-<time>.sql.gz`}
        >
          <Input
            id="dbdump"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={`database-dumps/${db.name}.sql.gz`}
            className="font-mono"
            spellCheck={false}
          />
        </Field>
        <div>
          <Button
            size="sm"
            onClick={run}
            disabled={dump.isPending || !!blocked}
            title={blocked ?? undefined}
          >
            {dump.isPending ? <Loader2 className="animate-spin" /> : <FileDown />} Export dump
          </Button>
        </div>
        {result && (
          <div className="grid gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-xs">
            <div className="flex min-w-0 items-center gap-1">
              <span className="truncate font-mono" title={result.path}>{result.path}</span>
              <CopyButton value={result.path} label="Copy path" />
              <span className="shrink-0 text-muted-foreground">{formatBytes(result.size)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
              <span>
                It is in the{" "}
                <Link
                  to="/instances/$instanceId/files"
                  params={{ instanceId: String(i.id) }}
                  className="underline hover:text-foreground"
                >
                  instance's files
                </Link>{" "}
                and over SFTP.
              </span>
              {roleAllows(i.myRole, "files") && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={files.download.isPending}
                  onClick={() => files.download.mutate({ paths: [result.path] }, { onError: err })}
                >
                  <Download /> Download
                </Button>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ImportCard(
  { instance: i, db, blocked }: {
    instance: InstanceDetailDto;
    db: InstanceDatabaseDto;
    blocked: string | null;
  },
) {
  const imp = useImportDatabase(i.id);
  const [path, setPath] = useState("");
  const file = path.trim();
  const problem = file && !/\.sql(\.gz)?$/i.test(file) ? "Must be a .sql or .sql.gz file" : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Import SQL file</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-xs text-muted-foreground">
          Replaces everything in the database with a .sql or .sql.gz file from the instance's files.
          Upload it under{" "}
          <Link
            to="/instances/$instanceId/files"
            params={{ instanceId: String(i.id) }}
            className="underline hover:text-foreground"
          >
            Files
          </Link>{" "}
          or over SFTP first.
        </p>
        <Field label="File" htmlFor="dbimport" error={problem} hint="Path in the instance's files">
          <Input
            id="dbimport"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder={`database-dumps/${db.name}.sql.gz`}
            className="font-mono"
            spellCheck={false}
          />
        </Field>
        <div>
          <ConfirmDialog
            trigger={
              <Button
                size="sm"
                variant="destructive"
                disabled={!file || !!problem || imp.isPending || !!blocked}
                title={blocked ?? undefined}
              >
                {imp.isPending ? <Loader2 className="animate-spin" /> : <FileUp />} Import
              </Button>
            }
            title={`Replace the ${db.name} database?`}
            description={`Everything in the database is replaced with the contents of ${file}. Export a dump first if you may need the current data. Stop the server first so it does not write meanwhile.`}
            confirmLabel="Replace"
            onConfirm={() =>
              imp.mutate({ path: file }, {
                onSuccess: () => toast.success("Database imported"),
                onError: (e) => toast.error(errorMessage(e)),
              })}
          />
        </div>
      </CardContent>
    </Card>
  );
}
