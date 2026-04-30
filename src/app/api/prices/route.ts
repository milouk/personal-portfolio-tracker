import { NextResponse } from "next/server";
import { readPortfolio } from "@/lib/storage/portfolio";
import { getPricesForAssets } from "@/lib/prices";
import { getEurUsdRate } from "@/lib/prices/fx";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const portfolio = await readPortfolio();
  const [prices, fx] = await Promise.all([
    getPricesForAssets(portfolio.assets, force),
    getEurUsdRate(force),
  ]);
  return NextResponse.json({ prices, fx });
}
