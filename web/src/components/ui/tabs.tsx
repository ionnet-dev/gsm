import * as React from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List className={cn("inline-flex h-8 items-center gap-1 rounded-md bg-muted p-0.5 text-muted-foreground", className)} {...props} />;
}
function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "inline-flex h-7 items-center justify-center gap-1.5 rounded-sm px-2.5 text-xs font-medium whitespace-nowrap transition-colors",
        "data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm hover:text-foreground disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
const TabsContent = TabsPrimitive.Content;

export { Tabs, TabsContent, TabsList, TabsTrigger };
