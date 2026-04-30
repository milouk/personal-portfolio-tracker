import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "../storage/paths";

export type EcbRate = {
  // ECB Deposit Facility Rate as a decimal (e.g. 0.02 for 2%)
  rate: number;
  // ISO date the rate is effective for
  effectiveDate: string;
  fetchedAt: string;
};

const CACHE_FILE = path.join(DATA_DIR, "ecb.json");
const ONE_DAY = 24 * 60 * 60 * 1000;
const URL =
  "https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.DFR.LEV?lastNObservations=1&format=jsondata";

async function readCache(): Promise<EcbRate | undefined> {
  try {
    const raw = await fs.readFile(CACHE_FILE, "utf8");
    return JSON.parse(raw) as EcbRate;
  } catch {
    return undefined;
  }
}
async function writeCache(rate: EcbRate) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CACHE_FILE, JSON.stringify(rate, null, 2), "utf8");
}

export async function getEcbDepositFacilityRate(force = false): Promise<EcbRate> {
  const cached = await readCache();
  if (
    !force &&
    cached &&
    Date.now() - new Date(cached.fetchedAt).getTime() < ONE_DAY
  ) {
    return cached;
  }
  try {
    const res = await fetch(URL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`ecb http ${res.status}`);
    const data = (await res.json()) as {
      dataSets?: Array<{
        series?: Record<
          string,
          { observations?: Record<string, [number, ...unknown[]]> }
        >;
      }>;
      structure?: {
        dimensions?: {
          observation?: Array<{
            values?: Array<{ id?: string }>;
          }>;
        };
      };
    };
    const series = data.dataSets?.[0]?.series ?? {};
    const seriesKey = Object.keys(series)[0];
    if (!seriesKey) throw new Error("ecb: no series");
    const obs = series[seriesKey]?.observations ?? {};
    const obsKey = Object.keys(obs)[0];
    if (!obsKey) throw new Error("ecb: no observation");
    const valuePct = obs[obsKey]?.[0];
    if (typeof valuePct !== "number") throw new Error("ecb: bad value");

    const dates = data.structure?.dimensions?.observation?.[0]?.values ?? [];
    const effectiveDate = dates[parseInt(obsKey, 10)]?.id ?? new Date().toISOString().slice(0, 10);

    const rate: EcbRate = {
      rate: valuePct / 100,
      effectiveDate,
      fetchedAt: new Date().toISOString(),
    };
    await writeCache(rate);
    return rate;
  } catch {
    if (cached) return cached;
    return {
      rate: 0.02,
      effectiveDate: new Date().toISOString().slice(0, 10),
      fetchedAt: new Date().toISOString(),
    };
  }
}
