export type Currency = "EUR" | "USD";

export type AssetType =
  | "tbill"
  | "bond"
  | "etf"
  | "stock"
  | "crypto"
  | "cash"
  | "interest_account"
  | "deposit";

export type AssetSource =
  | "greek-tbills"
  | "trade-republic"
  | "nbg"
  | "interest"
  | "cash"
  | "other";

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  tbill: "T-Bill",
  bond: "Bond",
  etf: "ETF",
  stock: "Stock",
  crypto: "Crypto",
  cash: "Cash",
  interest_account: "Interest Account",
  deposit: "Deposit",
};

export const SOURCE_LABEL: Record<AssetSource, string> = {
  "greek-tbills": "Greek T-Bills",
  "trade-republic": "Trade Republic",
  nbg: "National Bank of Greece",
  interest: "Interest Accounts",
  cash: "Cash",
  other: "Other",
};

export const SOURCE_ORDER: AssetSource[] = [
  "trade-republic",
  "greek-tbills",
  "nbg",
  "interest",
  "cash",
  "other",
];

export type Asset = {
  id: string;
  name: string;
  type: AssetType;
  source: AssetSource;
  currency: Currency;

  // For ETF/stock/crypto: ticker for live pricing
  ticker?: string;
  // For crypto: optional CoinGecko id override
  coingeckoId?: string;
  // For ETF/stock: ISIN if you have it
  isin?: string;

  // Quantity-based (ETF/stock/crypto)
  quantity?: number;
  // Total cost basis stored in BASE CURRENCY (EUR), regardless of asset.currency.
  // Source: pytr's TR avgBuyIn × qty (TR reports avg in EUR), or manual entry.
  costBasis?: number;

  // Cash-based (deposits, interest accounts, cash)
  amount?: number;

  // Yield (interest account / savings)
  rate?: number;
  // Optional dynamic rate source. When set, it overrides `rate` at calculation time.
  // - "ecb-dfr": tracks the ECB Deposit Facility Rate (Trade Republic uses this for cash).
  rateSource?: "ecb-dfr";

  // Bonds & T-bills
  faceValue?: number;
  purchasePrice?: number;
  issueDate?: string;
  maturityDate?: string;
  couponRate?: number;
  couponFrequency?: number;
  // optional override for current market value (otherwise we estimate)
  marketValueOverride?: number;

  // Manual price override (locks current price; won't refresh from API)
  manualPrice?: number;

  notes?: string;
  createdAt: string;
  updatedAt: string;
};

export type Portfolio = {
  version: 1;
  baseCurrency: "EUR";
  assets: Asset[];
  updatedAt: string;
};

export type PortfolioEvent =
  | {
      type: "asset.created";
      at: string;
      asset: Asset;
    }
  | {
      type: "asset.updated";
      at: string;
      assetId: string;
      before: Partial<Asset>;
      after: Partial<Asset>;
    }
  | {
      type: "asset.deleted";
      at: string;
      assetId: string;
      asset: Asset;
    }
  | {
      type: "price.updated";
      at: string;
      assetId: string;
      price: number;
      currency: Currency;
      source: "manual" | "yahoo" | "coingecko" | "frankfurter";
    }
  | {
      type: "snapshot";
      at: string;
      totalEur: number;
      breakdown: Record<AssetSource, number>;
    };

export type PriceQuote = {
  symbol: string;
  price: number;
  currency: Currency;
  source: "yahoo" | "coingecko" | "frankfurter" | "manual";
  fetchedAt: string;
};

export type FxRate = {
  base: "USD";
  quote: "EUR";
  rate: number;
  fetchedAt: string;
};

export type AssetValuation = {
  asset: Asset;
  // Native-currency value of the position right now
  nativeValue: number;
  // Converted to EUR
  eurValue: number;
  // Cost basis in EUR (best-effort)
  eurCostBasis?: number;
  // Unrealized gain in EUR
  eurGain?: number;
  eurGainPct?: number;
  // Last price used (for quantity-based assets)
  lastPrice?: number;
  priceSource?: PriceQuote["source"] | "n/a";
  // Resolved interest rate used in the calculation (after rateSource override)
  resolvedRate?: number;
  resolvedRateLabel?: string;
  // Bond/T-bill specific
  daysToMaturity?: number;
  ytm?: number;
  // Yield estimate (annual, EUR)
  estAnnualYieldEur?: number;
};
