import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatRate } from "@/lib/format";

const AXIS = { fontSize: 10, fill: "var(--muted-foreground)" };
const GRID = "color-mix(in oklab, var(--border) 70%, transparent)";

export interface SamplePoint {
  at: string;
  [key: string]: number | string | null;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function ChartTip(
  { active, payload, label, format }: {
    active?: boolean;
    payload?: { name: string; value: number; color: string }[];
    label?: string;
    format: (v: number) => string;
  },
) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border bg-popover px-2 py-1.5 text-xs shadow-lg">
      <div className="mb-1 text-muted-foreground">
        {label ? new Date(label).toLocaleTimeString() : ""}
      </div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center gap-2 font-mono tabular-nums">
          <span className="size-2 rounded-sm" style={{ background: p.color }} />
          <span className="text-muted-foreground">{p.name}</span>
          <span className="ml-auto pl-3">{p.value == null ? "—" : format(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** Percent-style area chart (CPU, memory). */
export function PercentChart(
  { points, keys, height = 160 }: {
    points: SamplePoint[];
    keys: { key: string; label: string; color: string }[];
    height?: number;
  },
) {
  const data = points.map((p) => ({
    at: p.at,
    ...Object.fromEntries(keys.map((k) => [k.label, p[k.key] ?? null])),
  }));
  return (
    <div className="overflow-hidden">
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
          <defs>
            {keys.map((k) => (
              <linearGradient key={k.key} id={`g-${k.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={k.color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={k.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="at"
            tickFormatter={fmtTime}
            tick={AXIS}
            axisLine={false}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            domain={[0, 100]}
            tick={AXIS}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `${v}%`}
            width={50}
          />
          <Tooltip
            content={<ChartTip format={(v) => `${v.toFixed(1)}%`} />}
            cursor={{ stroke: "var(--border)" }}
          />
          {keys.map((k) => (
            <Area
              key={k.key}
              type="monotone"
              dataKey={k.label}
              stroke={k.color}
              strokeWidth={1.5}
              fill={`url(#g-${k.key})`}
              isAnimationActive={false}
              dot={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Network throughput line chart. */
export function RateChart(
  { points, height = 160 }: { points: SamplePoint[]; height?: number },
) {
  return (
    <div className="overflow-hidden">
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="at"
            tickFormatter={fmtTime}
            tick={AXIS}
            axisLine={false}
            tickLine={false}
            minTickGap={40}
          />
          <YAxis
            tick={AXIS}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => formatRate(v)}
            width={64}
          />
          <Tooltip
            content={<ChartTip format={formatRate} />}
            cursor={{ stroke: "var(--border)" }}
          />
          <Line
            type="monotone"
            dataKey="Download"
            stroke="var(--primary)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="Upload"
            stroke="oklch(0.75 0.15 320)"
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
