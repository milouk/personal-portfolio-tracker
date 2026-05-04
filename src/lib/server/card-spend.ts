import "server-only";
import { readTrTransactions } from "../storage/transactions";
import { readAadeCard } from "../storage/aade-card";
import type { CardSpendBreakdown, MonthlyAmounts } from "../calc/card-spend";

function monthOf(iso: string): { year: number; month: number } | null {
  const m = iso.match(/^(\d{4})-(\d{2})/);
  if (!m) return null;
  return { year: parseInt(m[1], 10), month: parseInt(m[2], 10) };
}

export async function computeCardSpend(
  year: number
): Promise<CardSpendBreakdown> {
  const [aadeYear, txns] = await Promise.all([
    readAadeCard(year),
    readTrTransactions(),
  ]);

  // Only merchant card spend counts toward the 30 % rule (E1 codes 049/050).
  // - "card"        = CARD_TRANSACTION (real merchant payments)
  // - "card_aft"    = card → wallet top-ups (Payzy etc.) — self-transfer, NOT spend
  // - "atm_withdrawal" = ATM cash → cash, not electronic spend
  // - "card_refund" / "fee" / "card_verify" — explicitly excluded
  const trMonthly: MonthlyAmounts = {};
  for (const t of txns) {
    if (t.amountEur === null || t.type !== "card") continue;
    const ym = monthOf(t.date);
    if (!ym || ym.year !== year) continue;
    trMonthly[ym.month] = (trMonthly[ym.month] ?? 0) + Math.abs(t.amountEur);
  }
  // Round once at aggregation time — float accumulation drifts with many txns.
  for (const m of Object.keys(trMonthly).map(Number)) {
    trMonthly[m] = round2(trMonthly[m]);
  }
  const trTotal = round2(Object.values(trMonthly).reduce((s, v) => s + v, 0));

  const aade = aadeYear
    ? {
        monthly: aadeYear.monthlyAmount,
        total: aadeYear.totalAmount,
        fetchedAt: aadeYear.fetchedAt,
      }
    : null;

  return {
    year,
    aade,
    tr: { monthly: trMonthly, total: trTotal },
    combinedTotal: round2((aade?.total ?? 0) + trTotal),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
