import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./paths";

export type TrTransaction = {
  id: string;
  date: string;
  type: string;
  description: string;
  amountEur: number | null;
  rawType: string;
};

const TR_TX_FILE = path.join(DATA_DIR, "tr-transactions.jsonl");

export async function readTrTransactions(): Promise<TrTransaction[]> {
  try {
    const raw = await fs.readFile(TR_TX_FILE, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TrTransaction);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

export type TrTransactionStats = {
  totalIncome: { interest: number; dividend: number; saveback: number };
  totalInvested: { savings_plan: number; buy: number };
  totalRealised: { sell: number };
  totalCardSpend: number;
  totalDeposits: number;
  totalWithdrawals: number;
  totalCount: number;
};

export function summariseTransactions(txns: TrTransaction[]): TrTransactionStats {
  const stats: TrTransactionStats = {
    totalIncome: { interest: 0, dividend: 0, saveback: 0 },
    totalInvested: { savings_plan: 0, buy: 0 },
    totalRealised: { sell: 0 },
    totalCardSpend: 0,
    totalDeposits: 0,
    totalWithdrawals: 0,
    totalCount: txns.length,
  };
  for (const t of txns) {
    if (t.amountEur === null) continue;
    const a = t.amountEur;
    switch (t.type) {
      case "interest":
        stats.totalIncome.interest += a;
        break;
      case "dividend":
        stats.totalIncome.dividend += a;
        break;
      case "saveback":
        stats.totalIncome.saveback += Math.abs(a);
        break;
      case "savings_plan":
        // amounts are negative (cash outflow)
        stats.totalInvested.savings_plan += Math.abs(a);
        break;
      case "buy":
        stats.totalInvested.buy += Math.abs(a);
        break;
      case "sell":
        stats.totalRealised.sell += a;
        break;
      case "card":
      case "atm_withdrawal":
        stats.totalCardSpend += Math.abs(a);
        break;
      case "deposit":
        stats.totalDeposits += a;
        break;
      case "withdrawal":
        stats.totalWithdrawals += Math.abs(a);
        break;
    }
  }
  return stats;
}
