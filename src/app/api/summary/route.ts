import { NextResponse } from "next/server";
import { readPortfolio } from "@/lib/storage/portfolio";
import { getEurUsdRate } from "@/lib/prices/fx";
import { getPricesForAssets } from "@/lib/prices";
import { getEcbDepositFacilityRate } from "@/lib/prices/ecb";
import { aggregate, valueAsset } from "@/lib/calc/valuation";
import { SOURCE_LABEL, type AssetSource } from "@/lib/types";
import { isApiAuthorized } from "@/lib/sync/auth";

export const dynamic = "force-dynamic";

/**
 * Read-only summary endpoint for embedding in self-hosted dashboards
 * (e.g. Glance custom widgets — https://github.com/glanceapp/glance).
 *
 * Auth: optional shared secret in PORTFOLIO_API_TOKEN env (see lib/sync/auth.ts).
 */
export async function GET(req: Request) {
  if (!isApiAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const portfolio = await readPortfolio();
  const [prices, fx, ecb] = await Promise.all([
    getPricesForAssets(portfolio.assets),
    getEurUsdRate(),
    getEcbDepositFacilityRate(),
  ]);
  const valuations = portfolio.assets.map((a) =>
    valueAsset(a, prices[a.id], fx, { ecbDepositRate: ecb.rate })
  );
  const totals = aggregate(valuations);

  const bySource = Object.entries(totals.bySource)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({
      key: k,
      label: SOURCE_LABEL[k as AssetSource] ?? k,
      valueEur: Number(v.toFixed(2)),
      pct:
        totals.totalEur > 0 ? Number((v / totals.totalEur).toFixed(4)) : 0,
    }))
    .sort((a, b) => b.valueEur - a.valueEur);

  return NextResponse.json(
    {
      totalEur: Number(totals.totalEur.toFixed(2)),
      gainEur: Number(totals.totalGainEur.toFixed(2)),
      gainPct: Number(totals.totalGainPct.toFixed(4)),
      estAnnualYieldEur: Number(totals.estAnnualYieldEur.toFixed(2)),
      fxEurUsd: Number((1 / fx.rate).toFixed(4)),
      ecbRate: Number(ecb.rate.toFixed(4)),
      currency: "EUR",
      asOf: new Date().toISOString(),
      bySource,
    },
    {
      headers: {
        // Make Glance's cache short — it polls.
        "cache-control": "no-store",
      },
    }
  );
}
