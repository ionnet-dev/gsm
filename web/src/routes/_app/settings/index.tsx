import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type {
  FilesSettings,
  GeneralSettings,
  HistoryRetentionSettings,
  SmtpSettings,
} from "@gsm/shared";
import { type RegistrySettings, useSettings, useSettingsMutations } from "@/api/settings";
import { useAuth } from "@/api/auth";
import { useHealth } from "@/api/system";
import { Field } from "@/components/data/field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const MIB = 1 << 20;
const GIB = 1024 ** 3;

export const Route = createFileRoute("/_app/settings/")({
  component: General,
});

function General() {
  const { user } = useAuth();
  const { data: health } = useHealth();
  if (user?.role !== "admin") {
    return (
      <div className="text-xs text-muted-foreground">
        Ionnet GSM v{health?.version ?? "…"}. Site settings are managed by administrators.
      </div>
    );
  }
  return <AdminGeneral />;
}

function AdminGeneral() {
  const { data } = useSettings();
  const sm = useSettingsMutations();
  const [general, setGeneral] = useState<GeneralSettings | null>(null);
  const [history, setHistory] = useState<HistoryRetentionSettings | null>(null);
  const [smtp, setSmtp] = useState<SmtpSettings | null>(null);
  const [files, setFiles] = useState<FilesSettings | null>(null);
  const [registry, setRegistry] = useState<RegistrySettings | null>(null);
  const [testTo, setTestTo] = useState("");
  useEffect(() => {
    if (data) {
      setGeneral(data.general);
      setHistory(data.history);
      setSmtp(data.smtp);
      setFiles(data.files);
      setRegistry(data.registry);
    }
  }, [data]);
  if (!general || !history || !smtp || !files || !registry) return null;
  const saved = () => toast.success("Saved");
  const err = (e: Error) => toast.error(e.message);

  return (
    <div className="grid max-w-3xl gap-4">
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Site name" htmlFor="site" hint="Used in email subjects">
              <Input
                id="site"
                value={general.siteName}
                onChange={(e) => setGeneral({ ...general, siteName: e.target.value })}
              />
            </Field>
            <Field
              label="Mark nodes offline after (seconds)"
              htmlFor="off"
              hint="Without a heartbeat. Agents send one every 30 s."
            >
              <Input
                id="off"
                type="number"
                min={30}
                value={general.offlineAfterSeconds}
                onChange={(e) =>
                  setGeneral({ ...general, offlineAfterSeconds: Number(e.target.value) })}
              />
            </Field>
            <Field
              label="Image registry"
              htmlFor="reg"
              hint="Prefix for template images that name a bare image (gsm-java:21)."
            >
              <Input
                id="reg"
                value={general.imageRegistry}
                onChange={(e) => setGeneral({ ...general, imageRegistry: e.target.value })}
                className="font-mono"
              />
            </Field>
            <Field
              label="Console history (lines)"
              htmlFor="hist"
              hint="Kept in memory per instance for newly opened consoles."
            >
              <Input
                id="hist"
                type="number"
                min={100}
                max={10000}
                value={general.consoleHistoryLines}
                onChange={(e) =>
                  setGeneral({ ...general, consoleHistoryLines: Number(e.target.value) })}
              />
            </Field>
          </div>
          <Button
            className="justify-self-start"
            size="sm"
            onClick={() => sm.general.mutate(general, { onSuccess: saved, onError: err })}
          >
            Save
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Registry credentials</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-xs text-muted-foreground">
            Used by every agent to pull private images. Leave the server empty to pull anonymously.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Server" htmlFor="rserver">
              <Input
                id="rserver"
                value={registry.server}
                onChange={(e) => setRegistry({ ...registry, server: e.target.value })}
                placeholder="ghcr.io"
                className="font-mono"
              />
            </Field>
            <Field label="Username" htmlFor="ruser">
              <Input
                id="ruser"
                value={registry.username}
                onChange={(e) => setRegistry({ ...registry, username: e.target.value })}
                autoComplete="off"
              />
            </Field>
            <Field label="Password or token" htmlFor="rpass">
              <Input
                id="rpass"
                type="password"
                value={registry.password}
                onChange={(e) => setRegistry({ ...registry, password: e.target.value })}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <Button
            className="justify-self-start"
            size="sm"
            onClick={() => sm.registry.mutate(registry, { onSuccess: saved, onError: err })}
          >
            Save
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History retention</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-xs text-muted-foreground">
            Older records are pruned once an hour. Set 0 to keep everything.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Audit log (days)"
              htmlFor="ret-audit"
              hint={history.auditDays === 0 ? "Kept forever" : "Archived before deletion"}
            >
              <Input
                id="ret-audit"
                type="number"
                min={0}
                value={history.auditDays}
                onChange={(e) => setHistory({ ...history, auditDays: Number(e.target.value) })}
              />
            </Field>
            <Field
              label="Backups kept per instance"
              htmlFor="ret-backups"
              hint={history.backupsPerInstance === 0 ? "No limit" : "The oldest are deleted"}
            >
              <Input
                id="ret-backups"
                type="number"
                min={0}
                value={history.backupsPerInstance}
                onChange={(e) =>
                  setHistory({ ...history, backupsPerInstance: Number(e.target.value) })}
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => sm.history.mutate(history, { onSuccess: saved, onError: err })}
            >
              Save
            </Button>
            <Button size="sm" variant="outline" asChild>
              <a href="/api/v1/audit/export?format=csv" download>
                Export audit log
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Files</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-xs text-muted-foreground">Limits for the instance file manager.</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Open and edit up to (MiB)"
              htmlFor="files-view"
              hint="Larger files can still be downloaded. At most 10 MiB."
            >
              <Input
                id="files-view"
                type="number"
                min={0.01}
                max={10}
                step={0.5}
                value={+(files.viewMaxBytes / MIB).toFixed(2)}
                onChange={(e) =>
                  setFiles({
                    ...files,
                    viewMaxBytes: Math.min(
                      10 * MIB,
                      Math.max(4096, Math.round(+e.target.value * MIB)),
                    ),
                  })}
              />
            </Field>
            <Field
              label="Transfers up to (GiB)"
              htmlFor="files-transfer"
              hint="Uploads and downloads. 0 for no limit; they stream, so size costs no memory."
            >
              <Input
                id="files-transfer"
                type="number"
                min={0}
                step={0.5}
                value={+(files.transferMaxBytes / GIB).toFixed(2)}
                onChange={(e) =>
                  setFiles({
                    ...files,
                    transferMaxBytes: Math.max(0, Math.round(+e.target.value * GIB)),
                  })}
              />
            </Field>
          </div>
          <Button
            className="justify-self-start"
            size="sm"
            onClick={() => sm.files.mutate(files, { onSuccess: saved, onError: err })}
          >
            Save
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Email (SMTP)</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <p className="text-xs text-muted-foreground">
            Used for two-factor sign-in codes and password reset links. Users can only enable email
            codes (My account) once a host and sender are set here.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-6">
            <Field label="Host" htmlFor="host" className="sm:col-span-3">
              <Input
                id="host"
                value={smtp.host}
                onChange={(e) => setSmtp({ ...smtp, host: e.target.value })}
                placeholder="smtp.example.com"
              />
            </Field>
            <Field label="Port" htmlFor="port">
              <Input
                id="port"
                type="number"
                value={smtp.port}
                onChange={(e) => setSmtp({ ...smtp, port: Number(e.target.value) })}
              />
            </Field>
            <Field label="TLS (implicit)" className="sm:col-span-2">
              <div className="flex h-8 items-center gap-2 text-xs">
                <Switch
                  checked={smtp.secure}
                  onCheckedChange={(v) => setSmtp({ ...smtp, secure: v })}
                />{" "}
                {smtp.secure ? "SMTPS on connect" : "STARTTLS if offered"}
              </div>
            </Field>
            <Field label="Username" htmlFor="user" className="sm:col-span-3">
              <Input
                id="user"
                value={smtp.user}
                onChange={(e) => setSmtp({ ...smtp, user: e.target.value })}
                autoComplete="off"
              />
            </Field>
            <Field label="Password" htmlFor="pass" className="sm:col-span-3">
              <Input
                id="pass"
                type="password"
                value={smtp.password}
                onChange={(e) => setSmtp({ ...smtp, password: e.target.value })}
                autoComplete="new-password"
              />
            </Field>
            <Field label="From address" htmlFor="from" className="sm:col-span-3">
              <Input
                id="from"
                value={smtp.from}
                onChange={(e) => setSmtp({ ...smtp, from: e.target.value })}
                placeholder="GSM <gsm@example.com>"
              />
            </Field>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Button
              size="sm"
              onClick={() => sm.smtp.mutate(smtp, { onSuccess: saved, onError: err })}
            >
              Save
            </Button>
            <div className="flex-1" />
            <Input
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              placeholder="you@example.com"
              className="w-56"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!testTo || sm.testSmtp.isPending}
              onClick={() =>
                sm.testSmtp.mutate(testTo, {
                  onSuccess: () => toast.success("Test email sent"),
                  onError: err,
                })}
            >
              Send test
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
