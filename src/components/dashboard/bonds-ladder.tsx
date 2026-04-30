"use client";
import { Landmark, CalendarClock } from "lucide-react";
import { formatCurrency, formatPercent, formatRelativeDays } from "@/lib/format";
import type { AssetValuation } from "@/lib/types";
import { cn } from "@/lib/utils";

export function BondsLadder({ valuations }: { valuations: AssetValuation[] }) {
  const bonds = valuations
    .filter((v) => v.asset.type === "tbill" || v.asset.type === "bond")
    .sort(
      (a, b) =>
        (a.daysToMaturity ?? Infinity) - (b.daysToMaturity ?? Infinity)
    );

  if (bonds.length === 0) return null;

  const maxDays = Math.max(
    365,
    ...bonds.map((b) => Math.max(0, b.daysToMaturity ?? 0))
  );
  const totalIncome = bonds.reduce(
    (acc, b) => acc + (b.estAnnualYieldEur ?? 0),
    0
  );

  return (
    <section className="rounded-2xl border border-border/60 bg-card/40 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium tracking-tight">Maturity ladder</h2>
        </div>
        {totalIncome > 0 && (
          <div className="text-xs text-muted-foreground">
            Coupon income / yr ·{" "}
            <span className="font-numeric text-foreground">
              {formatCurrency(totalIncome, "EUR", { decimals: 0 })}
            </span>
          </div>
        )}
      </div>

      <ul className="flex flex-col gap-2.5">
        {bonds.map((b) => {
          const days = b.daysToMaturity ?? 0;
          const pct = Math.max(0, Math.min(1, days / maxDays));
          const overdue = days < 0;
          const soon = days <= 30 && days >= 0;
          return (
            <li key={b.asset.id} className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,2fr)_auto] items-center gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Landmark className="h-3 w-3 text-muted-foreground shrink-0" />
                  <span className="truncate text-sm font-medium">{b.asset.name}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                  {b.asset.maturityDate && (
                    <span>{new Date(b.asset.maturityDate).toLocaleDateString("en-IE")}</span>
                  )}
                  {b.ytm !== undefined && (
                    <>
                      <span className="text-border">·</span>
                      <span>YTM {formatPercent(b.ytm, 2)}</span>
                    </>
                  )}
                </div>
              </div>

              <div className="relative h-7">
                <div className="absolute inset-y-0 left-0 right-0 my-auto h-px bg-border" />
                <div
                  className={cn(
                    "absolute inset-y-0 my-auto h-1 rounded-full transition-all",
                    overdue
                      ? "bg-[color:var(--loss)]"
                      : soon
                        ? "bg-[color:var(--chart-2)]"
                        : "bg-[color:var(--chart-3)]"
                  )}
                  style={{ width: `${pct * 100}%`, left: 0 }}
                />
                <div
                  className={cn(
                    "absolute top-1/2 grid h-3 w-3 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border-2 border-background",
                    overdue
                      ? "bg-[color:var(--loss)]"
                      : soon
                        ? "bg-[color:var(--chart-2)]"
                        : "bg-[color:var(--chart-3)]"
                  )}
                  style={{ left: `${pct * 100}%` }}
                />
              </div>

              <div className="text-right">
                <div className="font-numeric text-sm tabular-nums">
                  {formatCurrency(b.eurValue, "EUR", { decimals: 0 })}
                </div>
                <div
                  className={cn(
                    "text-xs",
                    overdue
                      ? "text-[color:var(--loss)]"
                      : soon
                        ? "text-[color:var(--chart-2)]"
                        : "text-muted-foreground"
                  )}
                >
                  {b.daysToMaturity !== undefined
                    ? formatRelativeDays(b.daysToMaturity)
                    : "—"}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
