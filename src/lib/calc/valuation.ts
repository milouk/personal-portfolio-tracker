import type {
  Asset,
  AssetSource,
  AssetValuation,
  FxRate,
  PriceQuote,
} from "../types";

export type RateContext = {
  ecbDepositRate?: number;
};

function toEur(amount: number, currency: "EUR" | "USD", fx: FxRate): number {
  if (currency === "EUR") return amount;
  return amount * fx.rate;
}

export function valueAsset(
  asset: Asset,
  price: PriceQuote | undefined,
  fx: FxRate,
  rates: RateContext = {}
): AssetValuation {
  let nativeValue = 0;
  let lastPrice: number | undefined;
  let priceSource: AssetValuation["priceSource"] = "n/a";
  let estAnnualYieldEur: number | undefined;
  let daysToMaturity: number | undefined;
  let ytm: number | undefined;
  let eurCostBasis: number | undefined;
  let resolvedRate: number | undefined;
  let resolvedRateLabel: string | undefined;

  switch (asset.type) {
    case "etf":
    case "stock":
    case "crypto": {
      const qty = asset.quantity ?? 0;
      lastPrice = price?.price ?? asset.manualPrice;
      priceSource = price?.source ?? (asset.manualPrice ? "manual" : "n/a");
      nativeValue = qty * (lastPrice ?? 0);
      // costBasis is already in base currency (EUR) — no FX conversion needed.
      eurCostBasis = asset.costBasis;
      break;
    }
    case "cash":
    case "deposit": {
      nativeValue = asset.amount ?? 0;
      eurCostBasis = nativeValue !== undefined ? toEur(nativeValue, asset.currency, fx) : undefined;
      break;
    }
    case "interest_account": {
      nativeValue = asset.amount ?? 0;
      if (asset.rateSource === "ecb-dfr" && rates.ecbDepositRate !== undefined) {
        resolvedRate = rates.ecbDepositRate;
        resolvedRateLabel = "ECB DFR";
      } else {
        resolvedRate = asset.rate ?? 0;
        resolvedRateLabel = "fixed";
      }
      const yieldNative = nativeValue * resolvedRate;
      estAnnualYieldEur = toEur(yieldNative, asset.currency, fx);
      eurCostBasis = toEur(nativeValue, asset.currency, fx);
      break;
    }
    case "tbill":
    case "bond": {
      const result = valueBond(asset);
      nativeValue = result.value;
      daysToMaturity = result.daysToMaturity;
      ytm = result.ytm;
      estAnnualYieldEur = result.annualIncome
        ? toEur(result.annualIncome, asset.currency, fx)
        : undefined;
      // Prefer pytr-synced costBasis (always EUR) over purchasePrice when available.
      eurCostBasis =
        asset.costBasis ??
        (asset.purchasePrice !== undefined
          ? toEur(asset.purchasePrice, asset.currency, fx)
          : undefined);
      break;
    }
  }

  const eurValue = toEur(nativeValue, asset.currency, fx);
  let eurGain: number | undefined;
  let eurGainPct: number | undefined;
  if (eurCostBasis !== undefined && eurCostBasis > 0) {
    eurGain = eurValue - eurCostBasis;
    eurGainPct = eurGain / eurCostBasis;
  }

  return {
    asset,
    nativeValue,
    eurValue,
    eurCostBasis,
    eurGain,
    eurGainPct,
    lastPrice,
    priceSource,
    resolvedRate,
    resolvedRateLabel,
    daysToMaturity,
    ytm,
    estAnnualYieldEur,
  };
}

type BondResult = {
  value: number;
  daysToMaturity?: number;
  ytm?: number;
  annualIncome?: number;
};

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function valueBond(asset: Asset): BondResult {
  const face = asset.faceValue ?? 0;
  const purchase = asset.purchasePrice ?? 0;
  const coupon = asset.couponRate ?? 0;
  const annualIncome = face * coupon;
  const today = new Date();

  let daysToMaturity: number | undefined;
  let ytm: number | undefined;

  if (asset.maturityDate) {
    const m = new Date(asset.maturityDate);
    daysToMaturity = daysBetween(today, m);
  }

  // For zero-coupon T-bill: linear interpolation between purchase price and face value
  if (
    asset.type === "tbill" &&
    asset.issueDate &&
    asset.maturityDate &&
    purchase > 0 &&
    face > 0
  ) {
    const issue = new Date(asset.issueDate);
    const maturity = new Date(asset.maturityDate);
    const totalDays = Math.max(1, daysBetween(issue, maturity));
    const elapsed = Math.max(0, Math.min(totalDays, daysBetween(issue, today)));
    const accrued = (face - purchase) * (elapsed / totalDays);
    const value =
      asset.marketValueOverride !== undefined
        ? asset.marketValueOverride
        : purchase + accrued;
    if (totalDays > 0) {
      ytm = (face / purchase - 1) * (365 / totalDays);
    }
    // Annualised income equivalent so the dashboard's est. yield reflects T-bills.
    const tbillAnnualIncome =
      totalDays > 0 ? (face - purchase) * (365 / totalDays) : 0;
    return { value, daysToMaturity, ytm, annualIncome: tbillAnnualIncome };
  }

  // Coupon bond — use override if set, else fall back to face
  const value =
    asset.marketValueOverride !== undefined
      ? asset.marketValueOverride
      : face;
  if (purchase > 0 && asset.maturityDate) {
    const issue = asset.issueDate ? new Date(asset.issueDate) : today;
    const maturity = new Date(asset.maturityDate);
    const totalYears = Math.max(0.01, daysBetween(issue, maturity) / 365);
    if (totalYears > 0) {
      ytm =
        (annualIncome + (face - purchase) / totalYears) /
        ((face + purchase) / 2);
    }
  }
  return { value, daysToMaturity, ytm, annualIncome };
}

export type PortfolioTotals = {
  totalEur: number;
  totalCostBasisEur: number;
  totalGainEur: number;
  totalGainPct: number;
  estAnnualYieldEur: number;
  bySource: Record<AssetSource, number>;
  byType: Record<string, number>;
  byCurrency: Record<"EUR" | "USD", number>;
};

export function aggregate(valuations: AssetValuation[]): PortfolioTotals {
  const totals: PortfolioTotals = {
    totalEur: 0,
    totalCostBasisEur: 0,
    totalGainEur: 0,
    totalGainPct: 0,
    estAnnualYieldEur: 0,
    bySource: {
      "trade-republic": 0,
      "greek-tbills": 0,
      nbg: 0,
      interest: 0,
      cash: 0,
      other: 0,
    },
    byType: {},
    byCurrency: { EUR: 0, USD: 0 },
  };
  for (const v of valuations) {
    totals.totalEur += v.eurValue;
    totals.totalCostBasisEur += v.eurCostBasis ?? v.eurValue;
    if (v.eurGain) totals.totalGainEur += v.eurGain;
    if (v.estAnnualYieldEur) totals.estAnnualYieldEur += v.estAnnualYieldEur;
    totals.bySource[v.asset.source] =
      (totals.bySource[v.asset.source] ?? 0) + v.eurValue;
    totals.byType[v.asset.type] =
      (totals.byType[v.asset.type] ?? 0) + v.eurValue;
    totals.byCurrency[v.asset.currency] += v.eurValue;
  }
  totals.totalGainPct =
    totals.totalCostBasisEur > 0
      ? totals.totalGainEur / totals.totalCostBasisEur
      : 0;
  return totals;
}
