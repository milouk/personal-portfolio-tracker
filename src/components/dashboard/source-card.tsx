"use client";
import { motion, AnimatePresence } from "motion/react";
import {
  Banknote,
  Building2,
  Coins,
  CreditCard,
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
  type Asset,
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

  // Group rows by type. Hide inactive cards entirely.
  const byType = new Map<string, AssetValuation[]>();
  for (const v of valuations) {
    if (v.asset.type === "card" && v.asset.cardActive === false) continue;
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
            {formatCurrency(subtotal, "EUR", { decimals: 2 })}
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
                formatCurrency(v, "EUR", { decimals: 2 })
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
  if (a.type === "card") return <CardRow asset={a} />;
  const isBondLike = a.type === "tbill" || a.type === "bond";
  const positive = (v.eurGain ?? 0) >= 0;
  const showFx = a.currency !== "EUR";

  // T-bill / bond specific surface: face value at maturity, pre-received
  // interest (face - purchase), days remaining.
  const face = a.faceValue;
  const purchase = a.purchasePrice;
  const discount =
    face !== undefined && purchase !== undefined ? face - purchase : undefined;

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
          {a.isin && !a.ticker && (
            <span className="font-numeric text-[10px] tabular-nums text-muted-foreground">
              {a.isin}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {a.quantity !== undefined && a.quantity > 0 && !isBondLike && (
            <span className="font-numeric">
              {a.quantity} ×{" "}
              {v.lastPrice
                ? formatCurrency(v.lastPrice, a.currency, { decimals: 4 })
                : "—"}
            </span>
          )}
          {a.maturityDate && (
            <span>
              matures {new Date(a.maturityDate).toLocaleDateString("en-IE")}
              {v.daysToMaturity !== undefined && (
                <span className="ml-1 text-foreground/70">
                  ({v.daysToMaturity}d)
                </span>
              )}
            </span>
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
          {a.iban && (
            <span
              className="font-numeric text-[10px] tabular-nums"
              data-blur-when-private
              title={a.iban}
            >
              {maskIban(a.iban)}
            </span>
          )}
        </div>
        {/* Bond/T-bill: show purchase → maturity arc with pre-received interest */}
        {isBondLike && face !== undefined && (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] font-numeric tabular-nums">
            {purchase !== undefined && (
              <>
                <span className="text-muted-foreground">paid</span>
                <span>{formatCurrency(purchase, a.currency, { decimals: 2 })}</span>
                <span className="text-border">→</span>
              </>
            )}
            <span className="text-muted-foreground">face</span>
            <span>{formatCurrency(face, a.currency, { decimals: 2 })}</span>
            {discount !== undefined && discount !== 0 && (
              <span className="text-[color:var(--gain)]">
                +{formatCurrency(discount, a.currency, { decimals: 2 })}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="text-right">
        <div className="font-numeric text-sm tabular-nums">
          {formatCurrency(v.eurValue, "EUR", { decimals: 2 })}
        </div>
        <div className="font-numeric text-[11px] tabular-nums text-muted-foreground">
          {showFx
            ? `${formatCurrency(v.nativeValue, a.currency, { decimals: 2 })}`
            : v.eurGain !== undefined
              ? (
                <span
                  className={
                    positive
                      ? "text-[color:var(--gain)]"
                      : "text-[color:var(--loss)]"
                  }
                >
                  {signed(v.eurGain, (n) =>
                    formatCurrency(n, "EUR", { decimals: 2 })
                  )}
                </span>
              )
              : "—"}
        </div>
      </div>
    </li>
  );
}

function maskIban(iban: string): string {
  const compact = iban.replace(/\s/g, "");
  if (compact.length < 8) return compact;
  return `${compact.slice(0, 4)} ··· ${compact.slice(-4)}`;
}

const NETWORK_LABEL: Record<string, string> = {
  visa: "VISA",
  mastercard: "Mastercard",
  maestro: "Maestro",
  amex: "Amex",
  other: "Card",
};

function CardRow({ asset }: { asset: Asset }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-1.5 hover:bg-secondary/40">
      <div className="flex min-w-0 items-center gap-2">
        <CreditCard className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium">{asset.name}</span>
        {asset.cardLast4 && (
          <span
            className="font-numeric text-[10px] tabular-nums text-muted-foreground"
            data-blur-when-private
          >
            ···· {asset.cardLast4}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        {asset.cardNetwork && (
          <span className="rounded border border-border px-1.5 py-0.5">
            {NETWORK_LABEL[asset.cardNetwork] ?? asset.cardNetwork}
          </span>
        )}
        {asset.cardExpiry && (
          <span className="font-numeric tabular-nums" data-blur-when-private>
            exp {asset.cardExpiry}
          </span>
        )}
      </div>
    </li>
  );
}
