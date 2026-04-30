"use client";
import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { NetWorthHero } from "./net-worth-hero";
import { AllocationDonut } from "@/components/charts/allocation-donut";
import { SourceCard } from "./source-card";
import { BondsLadder } from "./bonds-ladder";
import { TbillsWidget } from "./tbills-widget";
import { CalendarWidget } from "./calendar-widget";
import { AssetForm } from "@/components/assets/asset-form";
import { SOURCE_COLOR, TYPE_COLOR } from "@/lib/colors";
import { eurToUsd } from "@/lib/fx-utils";
import {
  ASSET_TYPE_LABEL,
  SOURCE_LABEL,
  type Asset,
  type AssetSource,
  type AssetValuation,
  type FxRate,
} from "@/lib/types";
import type { PortfolioTotals } from "@/lib/calc/valuation";
import type { EcbRate } from "@/lib/prices/ecb";
import type { CalendarEvent } from "@/lib/calendar";

export function Dashboard({
  totals,
  grouped,
  valuations,
  fx,
  ecb,
  assets,
  calendar,
}: {
  totals: PortfolioTotals;
  grouped: { source: AssetSource; valuations: AssetValuation[] }[];
  valuations: AssetValuation[];
  fx: FxRate;
  ecb: EcbRate;
  assets: Asset[];
  calendar: CalendarEvent[];
}) {
  const [addOpen, setAddOpen] = useState(false);

  const totalUsd = eurToUsd(totals.totalEur, fx.rate);

  const sourceSlices = useMemo(
    () =>
      Object.entries(totals.bySource)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => ({
          key: k,
          label: SOURCE_LABEL[k as AssetSource],
          value: v,
          color: SOURCE_COLOR[k as AssetSource],
        })),
    [totals.bySource]
  );

  const typeSlices = useMemo(
    () =>
      Object.entries(totals.byType)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => ({
          key: k,
          label: ASSET_TYPE_LABEL[k as keyof typeof ASSET_TYPE_LABEL] ?? k,
          value: v,
          color: TYPE_COLOR[k as keyof typeof TYPE_COLOR],
        })),
    [totals.byType]
  );

  // Live default for the T-bill profit calculator: how much liquid cash you
  // could actually park in T-bills today. Rounded to the nearest €100 so the
  // input field doesn't show fractional cents.
  const liquidEur = useMemo(
    () =>
      valuations
        .filter(
          (v) =>
            v.asset.type === "cash" ||
            v.asset.type === "deposit" ||
            v.asset.type === "interest_account"
        )
        .reduce((acc, v) => acc + v.eurValue, 0),
    [valuations]
  );
  const tbillCalcDefault = Math.max(0, Math.round(liquidEur / 100) * 100);

  const empty = assets.length === 0;

  return (
    <div className="min-h-svh">
      <Header onAddAsset={() => setAddOpen(true)} />

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
        {empty ? (
          <EmptyState onAdd={() => setAddOpen(true)} />
        ) : (
          <div className="flex flex-col gap-6">
            <NetWorthHero
              totalEur={totals.totalEur}
              totalUsd={totalUsd}
              gainEur={totals.totalGainEur}
              gainPct={totals.totalGainPct}
              estAnnualYieldEur={totals.estAnnualYieldEur}
              fxRate={fx.rate}
              ecb={ecb}
            />

            <div className="grid gap-4 lg:grid-cols-2">
              <AllocationDonut
                title="By source"
                slices={sourceSlices}
                total={totals.totalEur}
              />
              <AllocationDonut
                title="By type"
                slices={typeSlices}
                total={totals.totalEur}
              />
            </div>

            <CalendarWidget events={calendar} />

            <BondsLadder valuations={valuations} />

            <TbillsWidget defaultAmount={tbillCalcDefault} />

            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Accounts
                </h2>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setAddOpen(true)}
                >
                  <Plus className="h-3.5 w-3.5" /> Add
                </Button>
              </div>
              <div className="grid gap-3">
                {grouped.map((g) => (
                  <SourceCard
                    key={g.source}
                    source={g.source}
                    valuations={g.valuations}
                    totalEur={totals.totalEur}
                  />
                ))}
              </div>
            </section>
          </div>
        )}

        <AssetForm open={addOpen} onOpenChange={setAddOpen} />
      </main>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="relative flex min-h-[60vh] flex-col items-center justify-center overflow-hidden rounded-3xl border border-dashed border-border/60 bg-card/30 px-8 py-16 text-center">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-grid opacity-30" />
      <div className="font-[family-name:var(--font-display)] text-5xl italic text-foreground/90">
        Your portfolio.
      </div>
      <p className="mt-3 max-w-md text-sm text-muted-foreground">
        Track every position across Trade Republic, Greek T-bills, NBG, interest
        accounts, and cash — with live prices and full history.
      </p>
      <Button onClick={onAdd} className="mt-6">
        <Plus className="h-4 w-4" /> Add your first asset
      </Button>
    </div>
  );
}
