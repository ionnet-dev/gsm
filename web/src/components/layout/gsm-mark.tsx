import { cn } from "@/lib/utils";

/** Product mark: a rounded tile with a play triangle in the accent colour. */
export function GsmMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={cn("text-primary", className)} aria-hidden>
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="7"
        className="fill-primary/10 stroke-primary/40"
      />
      <path d="M12 9.5v13l11-6.5z" className="fill-primary" />
    </svg>
  );
}
