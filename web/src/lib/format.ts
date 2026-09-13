const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  return `${(bytes / 1024 ** i).toFixed(digits)} ${UNITS[i]}`;
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec, 0)}/s`;
}

export function formatPercent(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v.toFixed(digits)}%`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function formatUptime(seconds: number | null | undefined): string {
  return seconds === null || seconds === undefined ? "—" : formatDuration(seconds * 1000);
}

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const diff = now - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? "ago" : "from now";
  if (abs < 5_000) return "just now";
  if (abs < 60_000) return `${Math.floor(abs / 1000)}s ${suffix}`;
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)}m ${suffix}`;
  if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)}h ${suffix}`;
  if (abs < 30 * 86_400_000) return `${Math.floor(abs / 86_400_000)}d ${suffix}`;
  return new Date(iso).toLocaleDateString();
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function between(a: string | null | undefined, b: string | null | undefined): string {
  if (!a) return "—";
  return formatDuration(new Date(b ?? Date.now()).getTime() - new Date(a).getTime());
}

/** Strip ANSI escape sequences from command output. */
export function stripAnsi(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function pluralize(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** "about 5 h", "about 6 days", "about 3 weeks" for a forecast `days` ahead. */
export function formatDaysAhead(days: number): string {
  if (days < 1) return `about ${Math.max(1, Math.round(days * 24))} h`;
  if (days < 21) return `about ${pluralize(Math.round(days), "day")}`;
  if (days < 60) return `about ${pluralize(Math.round(days / 7), "week")}`;
  return `about ${pluralize(Math.round(days / 30), "month")}`;
}

/** Text colour for a forecast: critical within a week, degraded within a month. */
export function forecastTone(days: number): string {
  return days <= 7
    ? "text-status-critical"
    : days <= 30
    ? "text-status-degraded"
    : "text-muted-foreground";
}
