import "server-only";
import fs from "node:fs/promises";
import { FX_CACHE_FILE, PRICES_CACHE_FILE } from "../storage/paths";
import type { FxRate, PriceQuote } from "../types";

type PriceCache = Record<string, PriceQuote>;
type FxCache = { eurUsd?: FxRate };

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return fallback;
    if (err instanceof SyntaxError) {
      // Corrupted file (likely concurrent write). Wipe it; next call will rebuild.
      await fs.unlink(file).catch(() => undefined);
      return fallback;
    }
    throw e;
  }
}
async function writeJson(file: string, data: unknown) {
  // Atomic write: tmp → rename. Survives concurrent fetches.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function readPriceCache(): Promise<PriceCache> {
  return readJson<PriceCache>(PRICES_CACHE_FILE, {});
}
export async function writePriceCache(cache: PriceCache) {
  await writeJson(PRICES_CACHE_FILE, cache);
}
export async function readFxCache(): Promise<FxCache> {
  return readJson<FxCache>(FX_CACHE_FILE, {});
}
export async function writeFxCache(cache: FxCache) {
  await writeJson(FX_CACHE_FILE, cache);
}

export function isFresh(iso: string | undefined, maxAgeMs: number) {
  if (!iso) return false;
  return Date.now() - new Date(iso).getTime() < maxAgeMs;
}
