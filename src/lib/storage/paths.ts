import path from "node:path";

// In demo mode (DEMO=1) the app reads from /demo instead of /data, ignores
// edits, and skips live network fetches. Used for the GitHub Pages preview.
const DEMO = process.env.DEMO === "1" || process.env.NEXT_PUBLIC_DEMO === "1";

export const IS_DEMO = DEMO;
export const DATA_DIR = path.join(
  process.cwd(),
  DEMO ? "demo" : "data"
);
export const PORTFOLIO_FILE = path.join(DATA_DIR, "portfolio.json");
export const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
export const PRICES_CACHE_FILE = path.join(DATA_DIR, "prices.json");
export const FX_CACHE_FILE = path.join(DATA_DIR, "fx.json");
