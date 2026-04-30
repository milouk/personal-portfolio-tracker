"use client";
import { motion, AnimatePresence } from "motion/react";
import {
  Banknote,
  Building2,
  Bitcoin,
  Coins,
  Landmark,
  Wallet,
  TrendingUp,
} from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatPercent, signed } from "@/lib/format";
import {
  ASSET_TYPE_LABEL,
  SOURCE_LABEL,
  type AssetSource,
  type AssetValuation,
} from "@/lib/types";
import { cn } from "@/lib/utils";

const SOURCE_ICON: Record<AssetSource, React.ComponentType<{ className?: string }>> = {
  "trade-republic": TrendingUp,
  "greek-tbills": Landmark,
  nbg: Building2,
  interest: Coins,
  cash: Wallet,
  other: Banknote,
};

export function SourceCard({
  source,
  valuations,
  totalEur,
}: {
  source: AssetSource;
  valuations: AssetValuation[];
  totalEur: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = SOURCE_ICON[source] ?? Banknote;
  const subtotal = valuations.reduce((acc, v) => acc + v.eurValue, 0);
  const subGain = valuations.reduce(
    (acc, v) => acc + (v.eurGain ?? 0),
    0
  );
  const subCost = valuations.reduce(
    (acc, v) => acc + (v.eurCostBasis ?? 0),
    0
  );
  const gainPct = subCost > 0 ? subGain / subCost : 0;
  const allocPct = totalEur > 0 ? subtotal / totalEur : 0;
  const positive = subGain >= 0;

  // Group rows by type
  const byType = new Map<string, AssetValuation[]>();
  for (const v of valuations) {
    const arr = byType.get(v.asset.type) ?? [];
    arr.push(v);
    byType.set(v.asset.type, arr);
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border/60 bg-card/40 transition-colors hover:border-border">
      <button
        type="button"
        onClick={() => setExpanded((x) => !x)}
        className="flex w-full items-center gap-4 px-5 py-4 text-left"
      >
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-secondary text-foreground/90">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium tracking-tight">
              {SOURCE_LABEL[source]}
            </span>
            <Badge variant="secondary" className="font-numeric">
              {valuations.length}
            </Badge>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {formatPercent(allocPct, 1)} of net worth
          </div>
        </div>
        <div className="text-right">
          <div className="font-numeric text-lg font-medium tabular-nums">
            {formatCurrency(subtotal, "EUR", { decimals: 0 })}
          </div>
          {subCost > 0 && (
            <div
              className={cn(
                "text-xs font-numeric tabular-nums",
                positive
                  ? "text-[color:var(--gain)]"
                  : "text-[color:var(--loss)]"
              )}
            >
              {signed(subGain, (v) =>
                formatCurrency(v, "EUR", { decimals: 0 })
              )}{" "}
              · {signed(gainPct, (v) => formatPercent(v))}
            </div>
          )}
        </div>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="overflow-hidden border-t border-border/60"
          >
            <div className="divide-y divide-border/60">
              {[...byType.entries()].map(([type, rows]) => (
                <div key={type} className="px-5 py-3">
                  <div className="mb-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                    {ASSET_TYPE_LABEL[type as keyof typeof ASSET_TYPE_LABEL]}
                  </div>
                  <ul className="flex flex-col gap-1.5">
                    {rows.map((v) => (
                      <AssetRow key={v.asset.id} v={v} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AssetRow({ v }: { v: AssetValuation }) {
  const a = v.asset;
  const positive = (v.eurGain ?? 0) >= 0;
  const showFx = a.currency !== "EUR";

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-1.5 hover:bg-secondary/40">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{a.name}</span>
          {a.ticker && (
            <span className="font-numeric text-[10px] uppercase tracking-wider text-muted-foreground">
              {a.ticker}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          {a.quantity !== undefined && a.quantity > 0 && (
            <span className="font-numeric">
              {a.quantity} × {v.lastPrice ? formatCurrency(v.lastPrice, a.currency, { decimals: 4 }) : "—"}
            </span>
          )}
          {a.maturityDate && (
            <span>matures {new Date(a.maturityDate).toLocaleDateString("en-IE")}</span>
          )}
          {v.resolvedRate !== undefined && (
            <span className="inline-flex items-center gap-1">
              {formatPercent(v.resolvedRate, 2)} APY
              {v.resolvedRateLabel === "ECB DFR" && (
                <span className="rounded border border-border px-1 py-0 text-[9px] uppercase tracking-wider text-muted-foreground">
                  live · ECB
                </span>
              )}
            </span>
          )}
          {v.ytm !== undefined && (
            <span>YTM {formatPercent(v.ytm, 2)}</span>
          )}
        </div>
      </div>
      <div className="text-right">
        <div className="font-numeric text-sm tabular-nums">
          {formatCurrency(v.eurValue, "EUR", { decimals: 0 })}
        </div>
        <div className="font-numeric text-[11px] tabular-nums text-muted-foreground">
          {showFx
            ? `${formatCurrency(v.nativeValue, a.currency, { decimals: 0 })}`
            : v.eurGain !== undefined
              ? (
                <span
                  className={cn(
                    positive
                      ? "text-[color:var(--gain)]"
                      : "text-[color:var(--loss)]"
                  )}
                >
                  {signed(v.eurGain, (n) =>
                    formatCurrency(n, "EUR", { decimals: 0 })
                  )}
                </span>
              )
              : "—"}
        </div>
      </div>
    </li>
  );
}
