import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function CopyButton(
  { value, label = "Copy", size = "icon-sm" }: {
    value: string;
    label?: string;
    size?: "icon-sm" | "sm";
  },
) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable (insecure context); nothing sensible to do
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size={size} onClick={copy} aria-label={label}>
          {copied
            ? <Check className="size-3.5 text-status-online" />
            : <Copy className="size-3.5" />}
          {size === "sm" && (copied ? "Copied" : label)}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}
