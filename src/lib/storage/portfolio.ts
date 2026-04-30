import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { Asset, Portfolio, PortfolioEvent } from "../types";
import { DATA_DIR, EVENTS_FILE, PORTFOLIO_FILE } from "./paths";

const EMPTY: Portfolio = {
  version: 1,
  baseCurrency: "EUR",
  assets: [],
  updatedAt: new Date().toISOString(),
};

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}

async function writeJsonAtomic(file: string, data: unknown) {
  await ensureDir();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export async function readPortfolio(): Promise<Portfolio> {
  return readJsonOr<Portfolio>(PORTFOLIO_FILE, EMPTY);
}

export async function writePortfolio(p: Portfolio) {
  p.updatedAt = new Date().toISOString();
  await writeJsonAtomic(PORTFOLIO_FILE, p);
}

export async function appendEvent(event: PortfolioEvent) {
  await ensureDir();
  await fs.appendFile(EVENTS_FILE, JSON.stringify(event) + "\n", "utf8");
}

export async function readEvents(): Promise<PortfolioEvent[]> {
  try {
    const raw = await fs.readFile(EVENTS_FILE, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PortfolioEvent);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export type AssetInput = Omit<Asset, "id" | "createdAt" | "updatedAt">;

export async function createAsset(input: AssetInput): Promise<Asset> {
  const portfolio = await readPortfolio();
  const now = new Date().toISOString();
  const asset: Asset = {
    ...input,
    id: nanoid(10),
    createdAt: now,
    updatedAt: now,
  };
  portfolio.assets.push(asset);
  await writePortfolio(portfolio);
  await appendEvent({ type: "asset.created", at: now, asset });
  return asset;
}

export async function updateAsset(
  id: string,
  patch: Partial<Asset>
): Promise<Asset | null> {
  const portfolio = await readPortfolio();
  const idx = portfolio.assets.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  const before = portfolio.assets[idx];
  const now = new Date().toISOString();
  const after: Asset = { ...before, ...patch, id: before.id, updatedAt: now };
  portfolio.assets[idx] = after;
  await writePortfolio(portfolio);

  const beforeDiff: Partial<Asset> = {};
  const afterDiff: Partial<Asset> = {};
  for (const k of Object.keys(patch) as (keyof Asset)[]) {
    if (before[k] !== after[k]) {
      // narrow assignment
      (beforeDiff as Record<string, unknown>)[k] = before[k];
      (afterDiff as Record<string, unknown>)[k] = after[k];
    }
  }
  if (Object.keys(afterDiff).length > 0) {
    await appendEvent({
      type: "asset.updated",
      at: now,
      assetId: id,
      before: beforeDiff,
      after: afterDiff,
    });
  }
  return after;
}

export async function deleteAsset(id: string): Promise<boolean> {
  const portfolio = await readPortfolio();
  const idx = portfolio.assets.findIndex((a) => a.id === id);
  if (idx === -1) return false;
  const asset = portfolio.assets[idx];
  portfolio.assets.splice(idx, 1);
  await writePortfolio(portfolio);
  await appendEvent({
    type: "asset.deleted",
    at: new Date().toISOString(),
    assetId: id,
    asset,
  });
  return true;
}

export async function bulkReplace(assets: Asset[]): Promise<Portfolio> {
  const portfolio = await readPortfolio();
  portfolio.assets = assets;
  await writePortfolio(portfolio);
  return portfolio;
}

export function dataDir() {
  return DATA_DIR;
}
export function ensureDataDir() {
  return fs.mkdir(DATA_DIR, { recursive: true }).then(() =>
    fs.mkdir(path.join(DATA_DIR, "imports"), { recursive: true })
  );
}
