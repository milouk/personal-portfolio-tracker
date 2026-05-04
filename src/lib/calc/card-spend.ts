/**
 * Greek 30 % electronic-spend rule (E1 codes 049/050) — pure math + types.
 *
 * Freelancers under Article 39 §9 must show electronic payments equal to
 * at least 30 % of declared income (capped at €6,000 of "required spend").
 * Shortfalls are taxed at 22 %. AADE pre-fills code 049 from monthly
 * reports submitted by Greek banks / card issuers — that's the "Ποσό
 * Συναλλαγών" figure scraped via `sync-aade-card`.
 *
 * Trade Republic is a German broker whose card spend may NOT propagate to
 * the AADE feed (Solaris-issued, no Greek bank in the loop). We track it
 * separately so the user can see what's potentially missing from the
 * official figure.
 *
 * No filesystem / server-only imports — safe to use in client components.
 * IO lives in src/lib/server/card-spend.ts.
 */

export type MonthlyAmounts = Record<number, number>;

export type CardSpendBreakdown = {
  year: number;
  /** From AADE myaade — what AADE pre-fills into E1 049 / 050. Authoritative. */
  aade: {
    monthly: MonthlyAmounts;
    total: number;
    fetchedAt: string | null;
  } | null;
  /** From data/tr-transactions.jsonl — informational; may or may not be in AADE. */
  tr: {
    monthly: MonthlyAmounts;
    total: number;
  };
  /** AADE total + TR total — only meaningful if TR is NOT reflected in AADE. */
  combinedTotal: number;
};

/**
 * Required electronic spend for the 30 % rule.
 *   required = min(0.30 × incomeBasis, €6,000)
 *
 * `incomeBasis` is "πραγματικό εισόδημα" — for a freelancer that's
 * NET business income (gross invoices minus deductible expenses,
 * matching E3 code 401), NOT gross. Insurance contributions are not
 * subtracted from the basis — they reduce the tax base, not the 30 %
 * basis. The cap of €6,000 corresponds to a basis of €20,000.
 *
 * Shortfall is taxed at 22 %; surplus has no benefit.
 */
export function requiredElectronicSpend(incomeBasis: number): number {
  return Math.min(0.30 * Math.max(incomeBasis, 0), 6_000);
}

export function shortfallSurcharge(
  required: number,
  actual: number
): { shortfall: number; surcharge: number } {
  const shortfall = Math.max(required - actual, 0);
  return { shortfall, surcharge: shortfall * 0.22 };
}
