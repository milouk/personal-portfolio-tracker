import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./paths";

/**
 * AADE "Δημόσια κλήρωση — Συναλλαγές και Λαχνοί" snapshot for one year.
 * Source: scripts/sync-aade-card.ts (Playwright scrape of myaade.gr).
 * This is the same monthly card-spend figure AADE pre-fills into E1
 * codes 049/050 — the basis for the 30 % electronic-spend rule.
 */
export type AadeCardYear = {
  year: number;
  fetchedAt: string;
  /** EUR sums per month (1–12). Months with no spend may be omitted. */
  monthlyAmount: Record<number, number>;
  /** Optional lottery-ticket count per month — informational only. */
  monthlyLottery?: Record<number, number>;
  totalAmount: number;
};

const AADE_CARD_DIR = path.join(DATA_DIR, "aade-card");

export async function readAadeCard(year: number): Promise<AadeCardYear | null> {
  try {
    const raw = await fs.readFile(
      path.join(AADE_CARD_DIR, `${year}.json`),
      "utf8"
    );
    return JSON.parse(raw) as AadeCardYear;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
