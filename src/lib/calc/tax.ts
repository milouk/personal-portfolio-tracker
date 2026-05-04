/**
 * Greek personal income-tax calculator (Law 5246/2025, effective 2026 income).
 *
 * Pure functions — no I/O, no React, fully unit-testable. The dashboard's
 * tax-estimator UI hands inputs in here and renders the breakdown back.
 *
 * Three things this models:
 *   1. The 2026 progressive bracket table (rates were cut 2 pp in the 10–60K
 *      range and a new 39 % bracket was carved between 40 K and 60 K).
 *   2. The under-30 benefit:
 *        - age ≤ 25 → 0 % on the first €20 K
 *        - age 26-30 → 9 % (instead of 20 %) on the €10 K-€20 K band
 *   3. Deductions: business expenses (έξοδα) + insurance contributions.
 *
 * Children-based tax credits live as a single `baseCredit` input so the caller
 * can vary it without this module needing to know the household composition.
 */

export type AgeBracket = "under-26" | "twentysix-thirty" | "standard";

export type Bracket = {
  /** Inclusive upper bound of this bracket in EUR. Use Infinity for the top. */
  upTo: number;
  /** Marginal rate as a decimal (e.g. 0.20 for 20 %). */
  rate: number;
};

/** Pre-2026 scale (Law 4646/2019). Used for tax years up to and including 2025. */
export const BRACKETS_2025: Bracket[] = [
  { upTo: 10_000, rate: 0.09 },
  { upTo: 20_000, rate: 0.22 },
  { upTo: 30_000, rate: 0.28 },
  { upTo: 40_000, rate: 0.36 },
  { upTo: Infinity, rate: 0.44 },
];

/** 2026+ scale (Law 5246/2025) — middle bands cut 2 pp + new 39 % band. */
export const BRACKETS_2026: Bracket[] = [
  { upTo: 10_000, rate: 0.09 },
  { upTo: 20_000, rate: 0.20 },
  { upTo: 30_000, rate: 0.26 },
  { upTo: 40_000, rate: 0.34 },
  { upTo: 60_000, rate: 0.39 },
  { upTo: Infinity, rate: 0.44 },
];

/** Pick the right scale for a given tax year. */
export function bracketsForYear(year: number): Bracket[] {
  return year >= 2026 ? BRACKETS_2026 : BRACKETS_2025;
}

/**
 * EFKA contribution classes for self-employed under Art. 39 L.4387/2016
 * (μη μισθωτών αυτοαπασχολουμένων), monthly amounts in EUR — one row per
 * class, including main pension + health + auxiliary + lump-sum where
 * applicable. The numbers below reflect the 2026 increase published by
 * the Ministry of Labour (~2.4 % yoy from the 2025 figures).
 *
 * Annual = monthly × 12. Override per-user if they're on a non-standard
 * regime (Art. 39 par. 9 partial-rate, νέοι ελεύθεροι 50 % discount, etc.).
 */
export type EfkaClass = 1 | 2 | 3 | 4 | 5 | 6;

export const EFKA_CONTRIBUTIONS_2026: Record<
  EfkaClass,
  { label: string; monthly: number }
> = {
  1: { label: "Class A (κατηγορία 1)", monthly: 246.42 },
  2: { label: "Class B (κατηγορία 2)", monthly: 295.79 },
  3: { label: "Class C (κατηγορία 3)", monthly: 354.59 },
  4: { label: "Class D (κατηγορία 4)", monthly: 437.62 },
  5: { label: "Class E (κατηγορία 5)", monthly: 519.11 },
  6: { label: "Class F (κατηγορία 6)", monthly: 800.65 },
};

export function efkaAnnual(efkaClass: EfkaClass, year: number = 2026): number {
  // Currently only 2026 is encoded; older years can be added when needed.
  void year;
  return Math.round(EFKA_CONTRIBUTIONS_2026[efkaClass].monthly * 12 * 100) / 100;
}

/**
 * Art. 39 §9 L.4387/2016 — employee-side EFKA rate for freelancers issuing
 * Δ.Π.Υ. (μπλοκάκι) to one or two clients. The client pays the
 * employer-side share separately; only the employee share comes out of
 * the freelancer's pocket and is what we deduct from gross income.
 *
 * Per the official EFKA circular:
 *   Main pension (κλάδος σύνταξης) ............... 6.67 %
 *   Health, in-kind benefits (υγεία, σε είδος) .... 2.15 %
 *   ─────────────────────────────────────────────
 *   Total employee rate ........................... 8.82 %
 *
 * (Auxiliary pension at 3.25 % and lump-sum at 4.00 % apply only if the
 * freelancer is enrolled in those funds; default off.)
 */
export const ART39_PAR9_2026 = {
  mainPension: 0.0667,
  healthInKind: 0.0215,
  // Optional — the user can opt into these via a higher rate if applicable.
  auxiliaryPension: 0.0325,
  lumpSum: 0.04,
};

export const ART39_PAR9_DEFAULT_EMPLOYEE_RATE =
  ART39_PAR9_2026.mainPension + ART39_PAR9_2026.healthInKind; // 0.0882

/**
 * Whole-year age as of `asOf`. Birth dates after `asOf` (impossible in
 * practice, but cheap to be safe) yield 0.
 */
export function computeAge(birthDate: string | Date, asOf: Date = new Date()): number {
  const b = typeof birthDate === "string" ? new Date(birthDate) : birthDate;
  if (Number.isNaN(b.getTime())) return 0;
  let age = asOf.getFullYear() - b.getFullYear();
  const monthDiff = asOf.getMonth() - b.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getDate() < b.getDate())) {
    age -= 1;
  }
  return Math.max(0, age);
}

/**
 * Age → bracket key. Boundaries match Law 5246/2025:
 *   age 25 or younger        → full exemption on first €20 K
 *   age 26 to 30 (inclusive) → 9 % on the 10–20 K band
 *   age 31+                  → no benefit
 */
export function getAgeBracket(age: number): AgeBracket {
  if (age <= 25) return "under-26";
  if (age <= 30) return "twentysix-thirty";
  return "standard";
}

/**
 * Apply the under-30 modifications to the standard scale. Returns a NEW
 * bracket array — never mutates the input.
 *
 * The under-30 benefits are part of Law 5246/2025 and only apply from tax
 * year 2026 onwards. For 2025 and earlier we just return the standard
 * brackets unchanged regardless of age.
 */
export function bracketsFor(ageBracket: AgeBracket, year: number): Bracket[] {
  const standard = bracketsForYear(year);
  if (year < 2026) return standard;
  if (ageBracket === "under-26") {
    // First €20 K is tax-free; standard rates resume above.
    return [
      { upTo: 20_000, rate: 0 },
      ...standard.filter((b) => b.upTo > 20_000),
    ];
  }
  if (ageBracket === "twentysix-thirty") {
    // 9 % on the 10–20 K band instead of 20 %.
    return [
      { upTo: 10_000, rate: 0.09 },
      { upTo: 20_000, rate: 0.09 },
      ...standard.filter((b) => b.upTo > 20_000),
    ];
  }
  return standard;
}

export type BracketSlice = {
  /** EUR floor of this slice. */
  from: number;
  /** EUR ceiling of this slice. */
  to: number;
  /** Marginal rate applied to this slice. */
  rate: number;
  /** Tax owed on this slice (slice width × rate). */
  tax: number;
};

/** Bracket-by-bracket waterfall over a taxable amount. */
export function applyBrackets(
  taxable: number,
  brackets: Bracket[]
): { slices: BracketSlice[]; total: number } {
  const slices: BracketSlice[] = [];
  let remaining = Math.max(0, taxable);
  let prevTo = 0;
  for (const b of brackets) {
    if (remaining <= 0) break;
    const sliceWidth = Math.min(remaining, b.upTo - prevTo);
    if (sliceWidth > 0) {
      slices.push({
        from: prevTo,
        to: prevTo + sliceWidth,
        rate: b.rate,
        tax: sliceWidth * b.rate,
      });
      remaining -= sliceWidth;
    }
    prevTo = b.upTo;
  }
  return {
    slices,
    total: slices.reduce((s, sl) => s + sl.tax, 0),
  };
}

export type TaxInput = {
  /** Birth date (any string Date can parse). Used to compute the age bracket. */
  birthDate: string;
  /** Tax year — the calendar year the income was earned. Defaults to current. */
  taxYear?: number;
  /** Gross annual income (€). Salary + freelance + everything declared. */
  grossIncome: number;
  /** Deductible business expenses (έξοδα). */
  expenses?: number;
  /** Insurance contributions paid (ασφαλιστικές εισφορές). */
  insuranceContributions?: number;
  /**
   * Convenience: when set, the calculator multiplies grossIncome by this rate
   * to derive insurance contributions, IF `insuranceContributions` is left blank.
   * E.g. 0.0855 for the 8.55 % rate the user mentioned.
   */
  insuranceRate?: number;
  /**
   * Tax credit (μείωση φόρου) applied AFTER bracket math.
   *
   * IMPORTANT: this is the wages/pensions credit from Art. 16 Law 4172/2013
   * (€777 baseline, more with children). It applies ONLY to income from
   * salary or pension. Freelancers / self-employed do NOT get this credit —
   * they deduct actual business expenses (έξοδα) from gross income instead.
   *
   * For pure freelance income, leave this at 0 (the default). For wage /
   * pension income, set 777 (or higher per children).
   */
  baseCredit?: number;
  /**
   * Income tax already withheld by clients during the year (παρακράτηση
   * φόρου, Art. 64 Law 4172/2013). For Greek freelancers this is typically
   * 20 % of each net invoice — the client withholds and remits directly
   * to AADE on your behalf, then you deduct it from the final tax bill.
   * Surplus = refund (επιστροφή).
   */
  withholdingPaid?: number;
};

export type TaxBreakdown = {
  /** Resolved age in years on Dec 31 of the tax year (canonical reference). */
  age: number;
  ageBracket: AgeBracket;
  taxYear: number;
  grossIncome: number;
  expenses: number;
  insuranceContributions: number;
  /** Income after both deductions. Floor: 0. */
  taxableIncome: number;
  brackets: Bracket[];
  slices: BracketSlice[];
  /** Sum of slice taxes. */
  bracketTotal: number;
  baseCredit: number;
  /** bracketTotal − baseCredit (floored at 0). */
  netTax: number;
  /** netTax / grossIncome. NaN-safe (returns 0 for zero income). */
  effectiveRate: number;
  /** Marginal rate at the current taxable income. 0 if no slices. */
  marginalRate: number;
  /** Estimated monthly equivalent of netTax. */
  monthlyEquivalent: number;
  /** Income tax already withheld at source (subtracted from netTax for the final position). */
  withholdingPaid: number;
  /**
   * Final settlement vs AADE for the year:
   *   > 0 → still owe this much
   *   < 0 → AADE refunds you this much
   *   = 0 → exactly settled
   */
  finalPosition: number;
};

/**
 * The headline function. Takes raw input, applies all the rules, returns a
 * structured breakdown the UI can render slice by slice.
 *
 * Conventions:
 *   - Age is computed against Dec 31 of the tax year — that's how Greek tax
 *     law typically anchors age-based benefits (the taxpayer's age at the
 *     close of the year being declared).
 *   - If `insuranceContributions` is provided, it wins. Otherwise, if
 *     `insuranceRate` is provided, contributions = grossIncome × rate.
 *     Otherwise, 0.
 *   - `baseCredit` defaults to €777 (the no-children baseline for 2026).
 */
export function estimateTax(input: TaxInput): TaxBreakdown {
  const taxYear = input.taxYear ?? new Date().getFullYear();
  const ageRef = new Date(taxYear, 11, 31); // Dec 31 of the tax year
  const age = computeAge(input.birthDate, ageRef);
  const ageBracket = getAgeBracket(age);

  const grossIncome = Math.max(0, input.grossIncome || 0);
  const expenses = Math.max(0, input.expenses ?? 0);
  const insuranceContributions = Math.max(
    0,
    input.insuranceContributions ??
      (input.insuranceRate ? grossIncome * input.insuranceRate : 0)
  );

  const taxableIncome = Math.max(0, grossIncome - expenses - insuranceContributions);
  const brackets = bracketsFor(ageBracket, taxYear);
  const { slices, total: bracketTotal } = applyBrackets(taxableIncome, brackets);
  // Default 0 — caller must opt in to the wage/pension credit.
  const baseCredit = input.baseCredit ?? 0;
  const netTax = Math.max(0, bracketTotal - baseCredit);
  const effectiveRate = grossIncome > 0 ? netTax / grossIncome : 0;
  const marginalRate = slices.length > 0 ? slices[slices.length - 1].rate : 0;
  const withholdingPaid = Math.max(0, input.withholdingPaid ?? 0);
  const finalPosition = round2(netTax - withholdingPaid);

  return {
    age,
    ageBracket,
    taxYear,
    grossIncome,
    expenses,
    insuranceContributions,
    taxableIncome,
    brackets,
    slices,
    bracketTotal,
    baseCredit,
    netTax,
    effectiveRate,
    marginalRate,
    monthlyEquivalent: netTax / 12,
    withholdingPaid,
    finalPosition,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
