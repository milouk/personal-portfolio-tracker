import { TaxEstimator } from "@/components/tax/tax-estimator";
import { computeCardSpend } from "@/lib/server/card-spend";
import { readMyData } from "@/lib/storage/mydata";
import { IS_DEMO } from "@/lib/storage/paths";

// Server-side render so we can read non-public env vars and hand the
// values to the client component as props. Avoids leaking BIRTH_DATE
// into the JS bundle and lets it be set at runtime (compose.yaml /
// .env.local) rather than at image-build time.
export const dynamic = "force-dynamic";

export default async function TaxPage() {
  // Demo mode hard-codes a plausible birth date so the under-30 benefit
  // is visibly applied without requiring a BIRTH_DATE env var (and so the
  // public demo doesn't leak whatever's in a contributor's .env.local).
  const defaultBirthDate = IS_DEMO
    ? "1996-04-15"
    : process.env.BIRTH_DATE?.trim() || "";
  const currentYear = new Date().getFullYear();
  // Look 3 years back; only include years that actually have a synced
  // myDATA snapshot — empty years just clutter the year picker.
  const candidateYears = [currentYear, currentYear - 1, currentYear - 2, currentYear - 3];
  const fetched = await Promise.all(candidateYears.map((y) => readMyData(y)));
  const mydataByYear = Object.fromEntries(
    candidateYears
      .map((y, i) => [y, fetched[i]] as const)
      .filter(([, data]) => data != null)
  );
  // Land on the most recent year with data (so the form pre-fills); fall
  // back to the current year for first-time users with no syncs at all.
  const syncedYears = Object.keys(mydataByYear)
    .map((y) => parseInt(y, 10))
    .sort((a, b) => b - a);
  const defaultTaxYear = syncedYears[0] ?? currentYear;

  // Card-spend (AADE TaxisNet scrape + TR transactions) — one per candidate
  // year. Always returned even when no AADE snapshot exists; in that case
  // `aade` is null but `tr` is still computed from tr-transactions.jsonl.
  const cardSpendList = await Promise.all(
    candidateYears.map((y) => computeCardSpend(y))
  );
  const cardSpendByYear = Object.fromEntries(
    candidateYears.map((y, i) => [y, cardSpendList[i]] as const)
  );

  return (
    <TaxEstimator
      defaultBirthDate={defaultBirthDate}
      defaultTaxYear={defaultTaxYear}
      mydataByYear={mydataByYear}
      cardSpendByYear={cardSpendByYear}
    />
  );
}
