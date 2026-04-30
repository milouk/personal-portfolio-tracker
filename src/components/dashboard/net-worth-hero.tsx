"use client";
import { motion } from "motion/react";
import { ArrowUpRight, ArrowDownRight, Sparkles } from "lucide-react";
import { formatCurrency, formatPercent, signed } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { EcbRate } from "@/lib/prices/ecb";

export function NetWorthHero({
  totalEur,
  gainEur,
  gainPct,
  estAnnualYieldEur,
  totalUsd,
  fxRate,
  fxAt,
  ecb,
}: {
  totalEur: number;
  gainEur: number;
  gainPct: number;
  estAnnualYieldEur: number;
  totalUsd: number;
  fxRate: number;
  fxAt: string;
  ecb?: EcbRate;
}) {
  const positive = gainEur >= 0;

  return (
    <section className="relative overflow-hidden rounded-3xl border border-border/60 bg-card/40 p-8 sm:p-10">
      <div
        className={cn(
          "pointer-events-none absolute inset-0 -z-10 opacity-70",
          positive ? "bg-glow-gain" : "bg-glow-loss"
        )}
      />
      <div className="pointer-events-none absolute inset-0 -z-10 bg-grid opacity-20" />

      <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
            <Sparkles className="h-3 w-3" /> Net worth
          </div>
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            data-private-hero
            className="mt-2 font-numeric text-5xl font-medium tracking-tight sm:text-6xl"
          >
            {formatCurrency(totalEur, "EUR", { decimals: 2 })}
          </motion.div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span className="font-numeric">
              ≈ {formatCurrency(totalUsd, "USD", { decimals: 0 })}
            </span>
            <span className="text-border">·</span>
            <span>EUR/USD {(1 / fxRate).toFixed(4)}</span>
            {ecb && (
              <>
                <span className="text-border">·</span>
                <span className="inline-flex items-center gap-1">
                  ECB DFR
                  <span className="font-numeric text-foreground">
                    {formatPercent(ecb.rate, 2)}
                  </span>
                </span>
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 sm:gap-6">
          <Stat
            label="Unrealized P/L"
            value={signed(gainEur, (v) =>
              formatCurrency(v, "EUR", { decimals: 0 })
            )}
            sub={signed(gainPct, (v) => formatPercent(v))}
            tone={positive ? "gain" : "loss"}
            icon={positive ? ArrowUpRight : ArrowDownRight}
          />
          <Stat
            label="Est. annual yield"
            value={formatCurrency(estAnnualYieldEur, "EUR", { decimals: 0 })}
            sub={
              totalEur > 0
                ? `${formatPercent(estAnnualYieldEur / totalEur)} yield`
                : "—"
            }
            tone="neutral"
          />
        </div>
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  tone,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub: string;
  tone: "gain" | "loss" | "neutral";
  icon?: React.ComponentType<{ className?: string }>;
}) {
  const toneCls =
    tone === "gain"
      ? "text-[color:var(--gain)]"
      : tone === "loss"
        ? "text-[color:var(--loss)]"
        : "text-foreground";
  return (
    <div className="rounded-xl border border-border/60 bg-card/60 p-4 backdrop-blur-sm">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-1.5 flex items-center gap-1.5 font-numeric text-xl font-medium", toneCls)}>
        {Icon && <Icon className="h-4 w-4" />}
        {value}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}
