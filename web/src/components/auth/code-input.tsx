import { Input } from "@/components/ui/input";

/** Single field for a 6-digit email code; accepts pasted codes with spaces or dashes. */
export function CodeInput({
  id,
  value,
  onChange,
  autoFocus,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <Input
      id={id}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={7}
      placeholder="123456"
      className="font-mono text-lg tracking-[0.35em]"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
      autoFocus={autoFocus}
      disabled={disabled}
      required
    />
  );
}

export const codeReady = (code: string) => code.length === 6;
