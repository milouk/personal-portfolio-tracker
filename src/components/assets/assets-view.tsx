"use client";
import { useMemo, useState } from "react";
import { Plus, Search, Pencil } from "lucide-react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AssetForm } from "./asset-form";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatPercent, signed } from "@/lib/format";
import {
  ASSET_TYPE_LABEL,
  SOURCE_LABEL,
  type Asset,
  type AssetSource,
  type AssetValuation,
  type FxRate,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export function AssetsView({
  valuations,
  fx,
}: {
  valuations: AssetValuation[];
  fx: FxRate;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Asset | null>(null);
  const [adding, setAdding] = useState(false);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return valuations;
    return valuations.filter(
      (v) =>
        v.asset.name.toLowerCase().includes(q) ||
        v.asset.ticker?.toLowerCase().includes(q) ||
        SOURCE_LABEL[v.asset.source].toLowerCase().includes(q) ||
        ASSET_TYPE_LABEL[v.asset.type].toLowerCase().includes(q)
    );
  }, [valuations, query]);

  const sorted = [...filtered].sort((a, b) => b.eurValue - a.eurValue);

  return (
    <div className="min-h-svh">
      <Header onAddAsset={() => setAdding(true)} />
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-medium tracking-tight">All assets</h1>
            <p className="text-sm text-muted-foreground">
              {valuations.length} positions · click any row to edit
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className="h-8 pl-7 w-48"
              />
            </div>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-border/60 bg-card/40">
          <div className="grid grid-cols-[minmax(0,1.6fr)_120px_140px_minmax(0,1fr)_minmax(0,1fr)_40px] items-center gap-3 border-b border-border/60 px-4 py-2.5 text-[11px] uppercase tracking-wider text-muted-foreground">
            <div>Name</div>
            <div>Type</div>
            <div>Source</div>
            <div className="text-right">Native</div>
            <div className="text-right">EUR · P/L</div>
            <div />
          </div>
          {sorted.length === 0 && (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground">
              {valuations.length === 0
                ? "No assets yet."
                : "No matching assets."}
            </div>
          )}
          {sorted.map((v) => (
            <Row key={v.asset.id} v={v} onEdit={() => setEditing(v.asset)} />
          ))}
        </div>
      </main>

      <AssetForm open={adding} onOpenChange={setAdding} />
      <AssetForm
        open={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
        initial={editing ?? undefined}
      />
    </div>
  );
}

function Row({
  v,
  onEdit,
}: {
  v: AssetValuation;
  onEdit: () => void;
}) {
  const a = v.asset;
  const positive = (v.eurGain ?? 0) >= 0;

  return (
    <button
      type="button"
      onClick={onEdit}
      className="grid w-full grid-cols-[minmax(0,1.6fr)_120px_140px_minmax(0,1fr)_minmax(0,1fr)_40px] items-center gap-3 border-b border-border/40 px-4 py-3 text-left transition-colors last:border-0 hover:bg-secondary/40"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{a.name}</span>
          {a.ticker && (
            <span className="font-numeric text-[10px] uppercase tracking-wider text-muted-foreground">
              {a.ticker}
            </span>
          )}
          {a.manualPrice !== undefined && (
            <Badge variant="outline" className="h-4 px-1 text-[9px]">
              manual
            </Badge>
          )}
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {a.quantity !== undefined && a.quantity > 0 && v.lastPrice ? (
            <span>
              {a.quantity} ×{" "}
              {formatCurrency(v.lastPrice, a.currency, { decimals: 4 })}
            </span>
          ) : a.maturityDate ? (
            <span>matures {new Date(a.maturityDate).toLocaleDateString("en-IE")}</span>
          ) : a.rate !== undefined ? (
            <span>{formatPercent(a.rate, 2)} APY</span>
          ) : (
            <span>—</span>
          )}
        </div>
      </div>

      <div>
        <Badge variant="secondary" className="font-normal">
          {ASSET_TYPE_LABEL[a.type]}
        </Badge>
      </div>

      <div className="truncate text-xs text-muted-foreground">
        {SOURCE_LABEL[a.source as AssetSource]}
      </div>

      <div className="text-right font-numeric text-sm tabular-nums">
        {formatCurrency(v.nativeValue, a.currency, { decimals: 0 })}
      </div>

      <div className="text-right">
        <div className="font-numeric text-sm tabular-nums">
          {formatCurrency(v.eurValue, "EUR", { decimals: 0 })}
        </div>
        {v.eurGain !== undefined ? (
          <div
            className={cn(
              "font-numeric text-[11px] tabular-nums",
              positive
                ? "text-[color:var(--gain)]"
                : "text-[color:var(--loss)]"
            )}
          >
            {signed(v.eurGain, (n) =>
              formatCurrency(n, "EUR", { decimals: 0 })
            )}{" "}
            {v.eurGainPct !== undefined &&
              `· ${signed(v.eurGainPct, (n) => formatPercent(n))}`}
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground">—</div>
        )}
      </div>

      <div className="text-muted-foreground">
        <Pencil className="h-3.5 w-3.5" />
      </div>
    </button>
  );
}
