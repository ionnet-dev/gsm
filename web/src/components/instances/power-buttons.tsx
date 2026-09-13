import { Loader2, Play, RotateCcw, Skull, Square } from "lucide-react";
import { toast } from "sonner";
import type { InstanceDto, PowerAction } from "@gsm/shared";
import { roleAllows } from "@gsm/shared";
import { errorMessage } from "@/api/client";
import { useInstanceMutations } from "@/api/instances";
import { ConfirmDialog } from "@/components/data/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { powerAllowed } from "@/lib/status";

/** Start / stop / restart / kill for one instance, sized for a header or a table row. */
export function PowerButtons(
  { instance, compact = false }: { instance: InstanceDto; compact?: boolean },
) {
  const { power } = useInstanceMutations();
  const can = roleAllows(instance.myRole, "power");
  const busy = power.isPending && power.variables?.id === instance.id;
  const run = (action: PowerAction) =>
    power.mutate({ id: instance.id, action }, { onError: (e) => toast.error(errorMessage(e)) });
  const size = compact ? "icon-sm" : "sm";
  const btn = (
    action: PowerAction,
    label: string,
    Icon: typeof Play,
    variant: "default" | "outline" | "destructive" = "outline",
  ) => {
    const allowed = can && powerAllowed(instance.status, action) && !busy;
    const b = (
      <Button
        size={size}
        variant={variant}
        disabled={!allowed}
        onClick={action === "kill" ? undefined : () => run(action)}
        aria-label={label}
      >
        {busy && power.variables?.action === action
          ? <Loader2 className="animate-spin" />
          : <Icon />}
        {!compact && label}
      </Button>
    );
    if (action === "kill") {
      return (
        <ConfirmDialog
          trigger={b}
          title={`Kill ${instance.name}?`}
          description="The process is terminated immediately without saving. Use Stop when you can."
          confirmLabel="Kill"
          onConfirm={() => run("kill")}
        />
      );
    }
    return compact
      ? (
        <Tooltip>
          <TooltipTrigger asChild>{b}</TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      )
      : b;
  };
  return (
    <div className="flex items-center gap-1">
      {btn("start", "Start", Play, "default")}
      {btn("stop", "Stop", Square)}
      {btn("restart", "Restart", RotateCcw)}
      {btn("kill", "Kill", Skull, "destructive")}
    </div>
  );
}
