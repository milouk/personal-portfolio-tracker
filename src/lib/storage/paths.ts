import path from "node:path";

export const DATA_DIR = path.join(process.cwd(), "data");
export const PORTFOLIO_FILE = path.join(DATA_DIR, "portfolio.json");
export const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
export const PRICES_CACHE_FILE = path.join(DATA_DIR, "prices.json");
export const FX_CACHE_FILE = path.join(DATA_DIR, "fx.json");
