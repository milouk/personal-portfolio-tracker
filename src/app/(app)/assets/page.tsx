import { readPortfolio } from "@/lib/storage/portfolio";
import { getEurUsdRate } from "@/lib/prices/fx";
import { getPricesForAssets } from "@/lib/prices";
import { getEcbDepositFacilityRate } from "@/lib/prices/ecb";
import { valueAsset } from "@/lib/calc/valuation";
import { AssetsView } from "@/components/assets/assets-view";

export const dynamic = "force-dynamic";

export default async function AssetsPage() {
  const portfolio = await readPortfolio();
  const [prices, fx, ecb] = await Promise.all([
    getPricesForAssets(portfolio.assets),
    getEurUsdRate(),
    getEcbDepositFacilityRate(),
  ]);
  const valuations = portfolio.assets.map((a) =>
    valueAsset(a, prices[a.id], fx, { ecbDepositRate: ecb.rate })
  );
  return <AssetsView valuations={valuations} fx={fx} />;
}
