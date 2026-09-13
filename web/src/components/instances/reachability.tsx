import { AlertTriangle, Check, HelpCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { FirewallRule, InstanceDto, ReachabilityStatus, SftpReachability } from "@gsm/shared";
import { roleAllows } from "@gsm/shared";
import { errorMessage } from "@/api/client";
import { useInstanceFirewall } from "@/api/firewall";
import { useInstanceReachabilityCheck } from "@/api/reachability";
import { useInstanceSftp } from "@/api/sftp";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

export const REACHABILITY_LABEL: Record<ReachabilityStatus, string> = {
  open: "Reachable",
  closed: "Refused",
  timeout: "No answer",
  error: "Problem",
  untested: "Not checked",
};

const TONE: Record<ReachabilityStatus, string> = {
  open: "text-status-online",
  closed: "text-status-critical",
  timeout: "text-status-critical",
  error: "text-status-degraded",
  untested: "text-muted-foreground",
};

const isProblem = (s: ReachabilityStatus) => s === "closed" || s === "timeout" || s === "error";

/** True when the last check found a port players cannot reach. */
export function hasReachabilityProblem(i: InstanceDto): boolean {
  return i.reachability?.ports.some((p) => isProblem(p.status)) ?? false;
}

/** An icon next to the address; the popover lists every port and SFTP, and checks again. */
export function ReachabilityIndicator({ instance: i }: { instance: InstanceDto }) {
  const statuses = i.reachability?.ports.map((p) => p.status) ?? [];
  const problem = statuses.some(isProblem);
  const allOpen = statuses.length > 0 && statuses.every((s) => s === "open");
  const label = problem
    ? "Not reachable from outside"
    : allOpen
    ? "Reachable from outside"
    : "Reachability not checked yet";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          title={label}
          className="rounded p-0.5 hover:bg-accent"
        >
          {problem
            ? <AlertTriangle className="size-3.5 text-status-degraded" />
            : allOpen
            ? <Check className="size-3.5 text-status-online" />
            : <HelpCircle className="size-3.5 text-muted-foreground" />}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 text-xs" align="start">
        <ReachabilityDetails instance={i} />
      </PopoverContent>
    </Popover>
  );
}

function StatusLine(
  { title, status, detail, note }: {
    title: string;
    status: ReachabilityStatus;
    detail: string | null;
    note?: string;
  },
) {
  return (
    <div className="grid gap-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-mono">{title}</span>
        <span className={cn("shrink-0 font-medium", TONE[status])}>
          {REACHABILITY_LABEL[status]}
        </span>
      </div>
      {(detail || note) && (
        <div className="text-muted-foreground">{[detail, note].filter(Boolean).join(" · ")}</div>
      )}
    </div>
  );
}

function SftpLine({ sftp }: { sftp: SftpReachability }) {
  return <StatusLine title={`SFTP ${sftp.port}/tcp`} status={sftp.status} detail={sftp.detail} />;
}

function ReachabilityDetails({ instance: i }: { instance: InstanceDto }) {
  const check = useInstanceReachabilityCheck(i.id);
  const { data: sftp } = useInstanceSftp(i.id, roleAllows(i.myRole, "files"));
  const r = i.reachability;
  return (
    <div className="grid gap-3">
      <div className="font-medium">Reachable from outside?</div>
      {r
        ? (
          <div className="grid gap-2">
            {r.ports.map((p) => (
              <StatusLine
                key={`${p.name}/${p.port}/${p.protocol}`}
                title={`${p.label} ${p.port}/${p.protocol}`}
                status={p.status}
                detail={p.detail}
                note={p.method === "probe" ? "tested while stopped" : undefined}
              />
            ))}
            {sftp?.reachable && <SftpLine sftp={sftp.reachable} />}
          </div>
        )
        : <p className="text-muted-foreground">Not checked yet.</p>}
      <p className="text-muted-foreground">
        The panel server connects to {r?.host ?? i.node.publicAddress} like a player would
        {r ? `, last ${formatRelative(r.checkedAt)}` : ""}. Checks also run when the server starts.
      </p>
      {roleAllows(i.myRole, "settings") && (
        <Button
          size="sm"
          variant="outline"
          className="justify-self-start"
          disabled={check.isPending}
          onClick={() =>
            check.mutate(undefined, {
              onSuccess: (res) => {
                const bad = res.reachability.ports.some((p) => isProblem(p.status)) ||
                  (res.sftp ? isProblem(res.sftp.status) : false);
                if (bad) toast.warning("Something is not reachable from outside");
                else toast.success("Checked");
              },
              onError: (e) => toast.error(errorMessage(e)),
            })}
        >
          <RefreshCw className={cn(check.isPending && "animate-spin")} /> Check now
        </Button>
      )}
      <FirewallSection instance={i} />
    </div>
  );
}

const RULE_LABEL: Record<FirewallRule["state"], string> = {
  open: "opened by the panel",
  existing: "already open",
  error: "failed",
};

/** Owners open the instance's ports (and make sure SFTP's is open) in the node's firewall. */
function FirewallSection({ instance: i }: { instance: InstanceDto }) {
  const f = i.firewall;
  const fw = useInstanceFirewall(i.id);
  const owner = roleAllows(i.myRole, "firewall");
  if (!owner && !f.open) return null;
  const rows = [
    ...f.rules.map((r) => ({ r, title: `${r.port}/${r.protocol}` })),
    ...f.sftp.map((r) => ({ r, title: `SFTP ${r.port}/${r.protocol}` })),
  ];
  const err = (e: Error) => toast.error(errorMessage(e));
  return (
    <div className="grid gap-2 border-t pt-3">
      <div className="font-medium">
        Node firewall{f.backend
          ? <span className="font-normal text-muted-foreground">· {f.backend}</span>
          : null}
      </div>
      {f.problem && (
        <p className="text-muted-foreground">
          {f.problem}.
          {!f.managed && " An admin or the node's owner can turn it on in the node's settings."}
          {f.managed && !f.backend &&
            " If a port is blocked, look at the network in front of the node (cloud firewall, router)."}
        </p>
      )}
      {rows.length > 0 && (f.open || f.managed) && (
        <div className="grid gap-1">
          {rows.map(({ r, title }) => (
            <div key={title} className="flex items-center justify-between gap-2">
              <span className="font-mono">{title}</span>
              <span
                className={cn(
                  "text-right",
                  r.state === "error" ? "text-status-critical" : "text-muted-foreground",
                )}
                title={r.error ?? undefined}
              >
                {r.state === "error" ? `failed: ${r.error}` : RULE_LABEL[r.state]}
              </span>
            </div>
          ))}
        </div>
      )}
      {owner && (f.open
        ? (
          <Button
            size="sm"
            variant="outline"
            className="justify-self-start"
            disabled={fw.isPending}
            onClick={() =>
              fw.mutate(false, {
                onSuccess: () => toast.success("Ports closed in the node's firewall"),
                onError: err,
              })}
          >
            Close ports
          </Button>
        )
        : (
          <Button
            size="sm"
            className="justify-self-start"
            disabled={!!f.problem || fw.isPending}
            onClick={() =>
              fw.mutate(true, {
                onSuccess: (res) =>
                  res.rules.some((r) => r.state === "error")
                    ? toast.warning("Some ports could not be opened")
                    : toast.success("Ports opened in the node's firewall; checking again"),
                onError: err,
              })}
          >
            Open ports in firewall
          </Button>
        ))}
    </div>
  );
}
