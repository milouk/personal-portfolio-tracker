import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./paths";

export type MyDataSummary = {
  netValue: number;
  vatAmount: number;
  withheldAmount: number;
  grossValue: number;
  count: number;
};

export type E3Summary = {
  byCode: Record<string, { sum: number; count: number }>;
  /**
   * Sum of E3 form lines `E3_585_*` only — the canonical "deductible
   * expenses" total the accountant uses on the actual filing. Excludes
   * `E3_882` (asset purchases — depreciated separately) and `E3_587`
   * (depreciation — typically rolled into a different E3 line). Validated
   * once against an accountant's pre-filing estimate (€4,255 vs ~€4,200
   * on 2025 data); n=1, treat as a starting point, not a guarantee.
   */
  deductibleE3585Total: number;
  count: number;
};

export type MyDataYear = {
  year: number;
  dateFrom: string;
  dateTo: string;
  fetchedAt: string;
  income: MyDataSummary;
  expenses: MyDataSummary;
  /** Optional — present when the sync ran against a v3+ script. */
  e3?: E3Summary;
};

const MYDATA_DIR = path.join(DATA_DIR, "mydata");

export async function readMyData(year: number): Promise<MyDataYear | null> {
  try {
    const raw = await fs.readFile(
      path.join(MYDATA_DIR, `${year}.json`),
      "utf8"
    );
    return JSON.parse(raw) as MyDataYear;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
