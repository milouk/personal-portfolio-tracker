import "server-only";
import { isFresh, readFxCache, writeFxCache } from "./cache";
import type { FxRate } from "../types";

const ONE_HOUR = 60 * 60 * 1000;

export async function getEurUsdRate(force = false): Promise<FxRate> {
  const cache = await readFxCache();
  if (!force && cache.eurUsd && isFresh(cache.eurUsd.fetchedAt, ONE_HOUR)) {
    return cache.eurUsd;
  }
  // frankfurter.app — free, no key, ECB rates
  // 1 USD = X EUR
  try {
    const res = await fetch("https://api.frankfurter.app/latest?from=USD&to=EUR", {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`fx http ${res.status}`);
    const data = (await res.json()) as { rates?: { EUR?: number } };
    const rate = data.rates?.EUR;
    if (typeof rate !== "number") throw new Error("fx missing rate");
    const fx: FxRate = {
      base: "USD",
      quote: "EUR",
      rate,
      fetchedAt: new Date().toISOString(),
    };
    await writeFxCache({ eurUsd: fx });
    return fx;
  } catch (err) {
    if (cache.eurUsd) return cache.eurUsd;
    // last-resort fallback so the UI never explodes
    return {
      base: "USD",
      quote: "EUR",
      rate: 0.92,
      fetchedAt: new Date().toISOString(),
    };
  }
}

export { usdToEur, eurToUsd } from "../fx-utils";
