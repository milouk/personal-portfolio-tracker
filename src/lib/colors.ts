import type { AssetSource, AssetType } from "./types";

export const SOURCE_COLOR: Record<AssetSource, string> = {
  "trade-republic": "var(--chart-4)",
  "greek-tbills": "var(--chart-2)",
  nbg: "var(--chart-1)",
  interest: "var(--chart-3)",
  cash: "var(--chart-8)",
  other: "var(--chart-7)",
};

export const TYPE_COLOR: Record<AssetType, string> = {
  etf: "var(--chart-4)",
  stock: "var(--chart-5)",
  crypto: "var(--chart-1)",
  bond: "var(--chart-2)",
  tbill: "var(--chart-2)",
  interest_account: "var(--chart-3)",
  deposit: "var(--chart-7)",
  cash: "var(--chart-8)",
};
