import { cn } from "@/lib/utils";

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "rounded border bg-muted px-1 font-mono text-[10px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
