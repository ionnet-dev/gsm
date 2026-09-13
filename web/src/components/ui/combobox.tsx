import * as React from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type ComboboxOption = {
  value: string;
  /** Shown in the list and the trigger; defaults to the value. */
  label?: string;
  /** Muted tag after the label, e.g. a release channel. Searchable too. */
  hint?: string;
  disabled?: boolean;
};

/**
 * Every typed word must appear in the value, label or hint; matches starting with the first word
 * rank first. cmdk's default fuzzy match lets "1.20" hit "a1.2.3_01", useless for versions.
 */
function filter(value: string, search: string, keywords?: string[]) {
  const hay = [value, ...(keywords ?? [])].join(" ").toLowerCase();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.every((w) => hay.includes(w))) return 0;
  return hay.startsWith(words[0] ?? "") ? 1 : 0.5;
}

/** A select whose list is filtered by typing. Looks and sizes like SelectTrigger. */
function Combobox({
  id,
  value,
  onValueChange,
  options,
  placeholder = "Choose…",
  searchPlaceholder = "Search…",
  emptyText = "Nothing matches.",
  disabled,
  className,
  itemClassName,
}: {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  itemClassName?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const current = options.find((o) => o.value === value);
  const listRef = React.useRef<HTMLDivElement>(null);
  // Open with the chosen option in view; long version lists would otherwise start at the top.
  const scrollTo = React.useCallback((el: HTMLDivElement | null) => {
    const list = listRef.current;
    if (el && list) list.scrollTop = el.offsetTop - list.clientHeight / 2 + el.offsetHeight / 2;
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            "flex h-8 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-2.5 py-1 text-[13px] whitespace-nowrap shadow-xs outline-none",
            "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value ? current?.label || value : placeholder}
            {current?.hint && <span className="ml-2 text-[10px] uppercase text-muted-foreground">{current.hint}</span>}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-56 p-0">
        <Command defaultValue={value} filter={filter}>
          <CommandInput
            placeholder={searchPlaceholder}
            className="h-9 text-[13px]"
            // Back to the top on each keystroke; otherwise the scroll from opening at the chosen
            // option leaves the best matches out of view.
            onValueChange={() => listRef.current?.scrollTo({ top: 0 })}
          />
          <CommandList ref={listRef} className="relative max-h-64">
            <CommandEmpty>{emptyText}</CommandEmpty>
            {options.map((o) => (
              <CommandItem
                key={o.value}
                ref={o.value === value ? scrollTo : undefined}
                value={o.value}
                keywords={[o.label, o.hint].filter((k): k is string => !!k)}
                disabled={o.disabled}
                onSelect={() => {
                  onValueChange(o.value);
                  setOpen(false);
                }}
                className={cn("pr-8", itemClassName)}
              >
                <span className="break-all">
                  {o.label || o.value}
                  {o.hint && <span className="ml-2 text-[10px] uppercase text-muted-foreground">{o.hint}</span>}
                </span>
                <CheckIcon className={cn("absolute right-2 size-3.5!", o.value !== value && "opacity-0")} />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export { Combobox, type ComboboxOption };
