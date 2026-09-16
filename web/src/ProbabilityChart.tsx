import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DashboardData } from "./types";

function formatUtc(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hour12: false,
  }).format(new Date(value));
}

export default function ProbabilityChart({
  history,
}: {
  history: DashboardData["probability_history"];
}): React.JSX.Element {
  const chartData = history.map((point) => ({
    time: formatUtc(point.timestamp_utc),
    "15m": point.higher_probability["15m"] * 100,
    "1h": point.higher_probability["1h"] * 100,
    "4h": point.higher_probability["4h"] * 100,
    eod: point.higher_probability.eod * 100,
  }));

  return (
    <ResponsiveContainer width="100%" height={330}>
      <LineChart data={chartData} margin={{ top: 16, right: 10, left: -18, bottom: 4 }}>
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey="time" tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={36} />
        <YAxis domain={[0, 100]} tickFormatter={(value: number) => `${value}%`} tick={{ fill: "var(--muted)", fontSize: 11 }} tickLine={false} axisLine={false} />
        <Tooltip
          contentStyle={{ background: "var(--surface-strong)", border: "1px solid var(--line)", borderRadius: 12 }}
          formatter={(value) => [`${Number(value).toFixed(1)}%`, "Higher"]}
        />
        <Legend iconType="plainline" />
        <Line type="monotone" dataKey="15m" stroke="var(--accent)" strokeWidth={3} dot={false} />
        <Line type="monotone" dataKey="1h" stroke="var(--chart-2)" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="4h" stroke="var(--chart-3)" strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="eod" stroke="var(--chart-4)" strokeWidth={2} strokeDasharray="6 5" dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
