import { readPortfolio } from "@/lib/storage/portfolio";
import { getEurUsdRate } from "@/lib/prices/fx";
import { getPricesForAssets } from "@/lib/prices";
import { getEcbDepositFacilityRate } from "@/lib/prices/ecb";
import { aggregate, valueAsset } from "@/lib/calc/valuation";
import { buildCalendar } from "@/lib/calendar";
import { Dashboard } from "@/components/dashboard/dashboard";
import { SOURCE_ORDER, type AssetValuation } from "@/lib/types";

export const dynamic = "force-dynamic";

// How far ahead to surface upcoming events (maturities + dividends) on the
// dashboard. A full year covers most T-bill / bond ladders.
const CALENDAR_WINDOW_DAYS = 365;

export default async function HomePage() {
  const portfolio = await readPortfolio();
  const [prices, fx, ecb, calendar] = await Promise.all([
    getPricesForAssets(portfolio.assets),
    getEurUsdRate(),
    getEcbDepositFacilityRate(),
    buildCalendar(portfolio.assets, CALENDAR_WINDOW_DAYS),
  ]);

  const valuations: AssetValuation[] = portfolio.assets.map((a) =>
    valueAsset(a, prices[a.id], fx, { ecbDepositRate: ecb.rate })
  );
  const totals = aggregate(valuations);

  const grouped = SOURCE_ORDER.map((s) => ({
    source: s,
    valuations: valuations.filter((v) => v.asset.source === s),
  })).filter((g) => g.valuations.length > 0);

  return (
    <Dashboard
      totals={totals}
      grouped={grouped}
      valuations={valuations}
      fx={fx}
      ecb={ecb}
      assets={portfolio.assets}
      calendar={calendar}
    />
  );
}
