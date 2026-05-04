"use client";
import { useMemo, useState, useSyncExternalStore } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { motion } from "motion/react";
import { formatCurrency, formatPercent } from "@/lib/format";

// Recharts' ResponsiveContainer measures its parent's box on first render.
// During Next's server pass there's no DOM, so it gets 0 × 0 and logs:
//   "The width(-1) and height(-1) of chart should be greater than 0…"
// — for every chart on every request, multi-line, drowning the log.
// Skip the SSR pass entirely with this hook (returns true only after the
// first client commit) so the chart only ever renders in a real browser.
const subscribeNoop = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false
  );
}

export type AllocationSlice = {
  key: string;
  label: string;
  value: number;
  color: string;
};

export function AllocationDonut({
  slices,
  title,
  total,
}: {
  slices: AllocationSlice[];
  title: string;
  total: number;
}) {
  const data = useMemo(
    () => slices.filter((s) => s.value > 0).sort((a, b) => b.value - a.value),
    [slices]
  );
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const mounted = useMounted();

  const focused = activeIdx !== null ? data[activeIdx] : null;
  const focusedTotal = focused ? focused.value : total;
  const focusedLabel = focused ? focused.label : title;
  const focusedPct = focused && total > 0 ? focused.value / total : 1;

  return (
    <div className="rounded-2xl border border-border/60 bg-card/40 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium tracking-tight">{title}</h3>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] sm:gap-6">
        <div className="relative w-full max-w-[220px]" style={{ minHeight: 180 }}>
          {mounted && (
            <ResponsiveContainer width="100%" aspect={1} minHeight={180}>
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  innerRadius="68%"
                  outerRadius="98%"
                  paddingAngle={1.5}
                  stroke="none"
                  onMouseEnter={(_, idx) => setActiveIdx(idx)}
                  onMouseLeave={() => setActiveIdx(null)}
                  isAnimationActive
                  animationDuration={500}
                >
                  {data.map((d, i) => (
                    <Cell
                      key={d.key}
                      fill={d.color}
                      style={{
                        transition: "opacity 0.2s",
                        opacity:
                          activeIdx === null || activeIdx === i ? 1 : 0.35,
                      }}
                    />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          )}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <motion.div
              key={focusedLabel}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-[11px] uppercase tracking-wider text-muted-foreground"
            >
              {focusedLabel}
            </motion.div>
            <motion.div
              key={focusedTotal}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="font-numeric text-lg font-medium leading-tight"
            >
              {formatCurrency(focusedTotal, "EUR", { compact: true })}
            </motion.div>
            <div className="text-xs text-muted-foreground">
              {formatPercent(focusedPct, 1)}
            </div>
          </div>
        </div>
        <ul className="flex flex-col justify-center gap-1.5 text-sm">
          {data.map((s, i) => {
            const pct = total > 0 ? s.value / total : 0;
            const dim = activeIdx !== null && activeIdx !== i;
            return (
              <li
                key={s.key}
                onMouseEnter={() => setActiveIdx(i)}
                onMouseLeave={() => setActiveIdx(null)}
                className="group flex cursor-default items-center gap-2.5 rounded-md px-1.5 py-1 transition-opacity hover:bg-secondary/50"
                style={{ opacity: dim ? 0.4 : 1 }}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ background: s.color }}
                />
                <span className="flex-1 truncate text-foreground/90">
                  {s.label}
                </span>
                <span className="font-numeric tabular-nums text-muted-foreground">
                  {formatPercent(pct, 1)}
                </span>
                <span className="font-numeric tabular-nums text-foreground/80 w-20 text-right">
                  {formatCurrency(s.value, "EUR", { compact: true })}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
