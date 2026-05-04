"use client";
import { useEffect, useMemo, useState } from "react";
import {
  Calculator,
  Cake,
  CreditCard,
  Database,
  Receipt,
  ShieldCheck,
  Undo2,
  Wallet,
} from "lucide-react";
import { Header } from "@/components/layout/header";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  ART39_PAR9_DEFAULT_EMPLOYEE_RATE,
  estimateTax,
  type AgeBracket,
  type TaxInput,
} from "@/lib/calc/tax";
import {
  requiredElectronicSpend,
  shortfallSurcharge,
  type CardSpendBreakdown,
} from "@/lib/calc/card-spend";
import type { MyDataYear } from "@/lib/storage/mydata";

const STORAGE_KEY = "portfolio.taxEstimator.v3";

// Estimator is opinionated for one taxpayer profile only:
//   - Greek freelancer (no wages, no mixed income)
//   - Art. 39 §9 L.4387/2016 ("μπλοκάκι") block-insurance setup, fixed at
//     8.82 % employee share (6.67 % main pension + 2.15 % health-in-kind)
//   - No €777 wage credit (freelancers don't get it)
//
// Inputs collapse to: birth date, tax year, gross income, εξοδα, withholding
// already paid. Everything else is computed.
type Inputs = {
  birthDate: string;
  taxYear: number;
  grossIncome: number | "";
  expenses: number | "";
  withholdingPaid: number | "";
};

function buildDefaults(birthDate: string, taxYear: number): Inputs {
  return {
    birthDate,
    taxYear,
    grossIncome: "",
    expenses: "",
    withholdingPaid: "",
  };
}

const AGE_BRACKET_LABEL: Record<AgeBracket, string> = {
  "under-26": "≤ 25 years — full exemption on first €20K",
  "twentysix-thirty": "26–30 years — 9% on €10K–€20K (instead of 20%)",
  standard: "31+ years — standard 2026 scale",
};

// Friendly label + side classification for the E3 form codes that show up in
// myDATA's RequestE3Info. The list is intentionally small — anything not
// listed renders as "—" with side derived from the prefix.
const E3_CODE_META: Record<
  string,
  { label: string; side: "income" | "expense"; deductible: boolean; note?: string }
> = {
  E3_561_001: {
    label: "Παροχή υπηρεσιών (services rendered)",
    side: "income",
    deductible: false,
  },
  E3_585_007: {
    label: "Έξοδα τηλεπικοινωνιών / διαδικτύου",
    side: "expense",
    deductible: true,
    note: "Statutory 50 % cap exists (Art. 22B) but is usually applied at filing time, not here.",
  },
  E3_585_009: {
    label: "Έξοδα προστασίας περιβάλλοντος",
    side: "expense",
    deductible: true,
  },
  E3_585_013: {
    label: "Πρόσθετα γενικά έξοδα",
    side: "expense",
    deductible: true,
  },
  E3_585_016: {
    label: "Διάφορα λειτουργικά έξοδα",
    side: "expense",
    deductible: true,
  },
  E3_587: {
    label: "Αποσβέσεις (annual depreciation)",
    side: "expense",
    deductible: false,
    note: "Excluded from this estimator's εξοδα default — accountant typically logs it on a separate E3 line.",
  },
  E3_882_001: {
    label: "Αγορά παγίων (asset purchase)",
    side: "expense",
    deductible: false,
    note: "Not a current-year expense — depreciated annually via E3_587.",
  },
};

function describeE3Code(code: string): {
  label: string;
  side: "income" | "expense" | "other";
  deductible: boolean;
  note?: string;
} {
  if (E3_CODE_META[code]) return E3_CODE_META[code];
  if (code.startsWith("E3_561") || code.startsWith("E3_881") || code.startsWith("E3_106")) {
    return { label: code, side: "income", deductible: false };
  }
  if (code.startsWith("E3_585")) {
    return { label: code, side: "expense", deductible: true };
  }
  if (code.startsWith("E3_5") || code.startsWith("E3_882")) {
    return { label: code, side: "expense", deductible: false };
  }
  return { label: code, side: "other", deductible: false };
}

export function TaxEstimator({
  defaultBirthDate = "",
  defaultTaxYear,
  mydataByYear = {},
  cardSpendByYear = {},
}: {
  defaultBirthDate?: string;
  /** Most recent synced year (or current year if none). */
  defaultTaxYear?: number;
  mydataByYear?: Record<number, MyDataYear | null>;
  cardSpendByYear?: Record<number, CardSpendBreakdown>;
}) {
  const initialTaxYear = defaultTaxYear ?? new Date().getFullYear();
  const [inputs, setInputs] = useState<Inputs>(() =>
    buildDefaults(defaultBirthDate, initialTaxYear)
  );
  const [hydrated, setHydrated] = useState(false);
  // Track which fields the user has explicitly overridden, so myDATA values
  // don't keep stomping on their manual edits.
  const [overrides, setOverrides] = useState<Set<keyof Inputs>>(() => new Set());

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Inputs> & {
          _overrides?: string[];
        };
        // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot localStorage rehydration
        setInputs((prev) => ({
          ...prev,
          ...parsed,
          birthDate: parsed.birthDate || defaultBirthDate,
        }));
        if (Array.isArray(parsed._overrides)) {
          setOverrides(new Set(parsed._overrides as (keyof Inputs)[]));
        }
      }
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, [defaultBirthDate]);

  const myData = mydataByYear[inputs.taxYear] ?? null;
  const syncedYears = useMemo(
    () =>
      Object.keys(mydataByYear)
        .map((y) => parseInt(y, 10))
        .sort((a, b) => b - a),
    [mydataByYear]
  );

  // For εξοδα we prefer the E3-classified sum (what the accountant filed)
  // and fall back to the raw RequestMyExpenses figure on older snapshots
  // that pre-date the E3 sync. `null` means no snapshot at all for that year.
  const defaultExpenses =
    myData?.e3 != null ? myData.e3.deductibleE3585Total : myData?.expenses.netValue ?? null;

  useEffect(() => {
    if (!hydrated) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing inputs to a server-supplied prop is the legitimate use case
    setInputs((prev) => {
      const next = { ...prev };
      // For each myDATA-fillable field: if the user hasn't overridden it,
      //   - synced year → fill with the snapshot value
      //   - no-snapshot year → blank it (so 2023's UI doesn't keep showing
      //     2025's numbers when the user clicks an empty tab).
      if (!overrides.has("grossIncome")) {
        next.grossIncome = myData?.income.netValue ?? "";
      }
      if (!overrides.has("expenses")) {
        next.expenses = defaultExpenses ?? "";
      }
      if (!overrides.has("withholdingPaid")) {
        next.withholdingPaid = myData?.income.withheldAmount ?? "";
      }
      return next;
    });
  }, [hydrated, myData, inputs.taxYear, overrides, defaultExpenses]);

  // Persist inputs + override set together so both survive reloads.
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...inputs, _overrides: [...overrides] })
      );
    } catch {
      /* ignore */
    }
  }, [inputs, overrides, hydrated]);

  /** Set a field AND record that the user has manually overridden it. */
  function setUserField<K extends keyof Inputs>(key: K, value: Inputs[K]) {
    setInputs((p) => ({ ...p, [key]: value }));
    setOverrides((s) => {
      if (s.has(key)) return s;
      const next = new Set(s);
      next.add(key);
      return next;
    });
  }

  function resetToMyData() {
    setOverrides(new Set());
    if (myData) {
      setInputs((p) => ({
        ...p,
        grossIncome: myData.income.netValue,
        expenses: defaultExpenses ?? "",
        withholdingPaid: myData.income.withheldAmount,
      }));
    }
  }

  const result = useMemo(() => {
    const taxInput: TaxInput = {
      birthDate: inputs.birthDate,
      taxYear: inputs.taxYear,
      grossIncome: numberOr(inputs.grossIncome, 0),
      expenses: numberOr(inputs.expenses, 0),
      // Insurance: fixed Art. 39 §9 employee share. No editable knob.
      insuranceRate: ART39_PAR9_DEFAULT_EMPLOYEE_RATE,
      // Freelancer income — no €777 wage credit.
      baseCredit: 0,
      withholdingPaid: numberOr(inputs.withholdingPaid, 0),
    };
    return estimateTax(taxInput);
  }, [inputs]);

  const hasIncome = result.grossIncome > 0;
  const hasBirthDate = !!inputs.birthDate;

  return (
    <div className="min-h-svh">
      <Header />

      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <header className="mb-8">
          <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
            <Calculator className="h-3 w-3" /> Greek income tax estimator
          </div>
          <h1 className="mt-2 font-numeric text-3xl font-medium tracking-tight sm:text-4xl">
            Tax for {inputs.taxYear}
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Freelancer under Art. 39 §9 L.4387/2016 (μπλοκάκι). 2026 brackets
            from Law 5246/2025; under-30 benefit auto-applied from your birth
            date.
          </p>
        </header>

        <div className="grid gap-6 md:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
          <section className="rounded-2xl border border-border/60 bg-card/40 p-5">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium tracking-tight">Inputs</h2>
              {myData && (
                <button
                  type="button"
                  onClick={resetToMyData}
                  className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-secondary"
                  title={`Re-fetch values from ${inputs.taxYear}.json (last sync ${new Date(myData.fetchedAt).toLocaleString("en-IE")})`}
                >
                  <Database className="h-3 w-3" /> Reset to myDATA
                </button>
              )}
            </div>
            {myData ? (
              <div className="-mt-2 mb-3 rounded-md border border-border/40 bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">
                  myDATA · {inputs.taxYear}
                </span>
                {" — "}
                income €{myData.income.netValue.toFixed(2)} ({myData.income.count} inv){" · "}
                {myData.e3 ? (
                  <>
                    εξοδα <span className="text-foreground">€{myData.e3.deductibleE3585Total.toFixed(2)}</span>{" "}
                    <span className="text-muted-foreground/80">(E3_585_*)</span>
                  </>
                ) : (
                  <>expenses €{myData.expenses.netValue.toFixed(2)}</>
                )}
                {" · "}
                withheld €{myData.income.withheldAmount.toFixed(2)}
              </div>
            ) : (
              <div className="-mt-2 mb-3 rounded-md border border-dashed border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
                No <code>data/mydata/{inputs.taxYear}.json</code> yet — run{" "}
                <code className="text-foreground">npm run sync:mydata</code> on
                the server to pre-fill from AADE.
              </div>
            )}

            <div className="grid gap-4">
              <Field label="Birth date" icon={Cake}>
                <Input
                  type="date"
                  value={inputs.birthDate}
                  onChange={(e) =>
                    setInputs((p) => ({ ...p, birthDate: e.target.value }))
                  }
                />
              </Field>

              {syncedYears.length > 0 && (
                <Field label="Tax year">
                  <div
                    className="grid gap-1"
                    style={{
                      gridTemplateColumns: `repeat(${syncedYears.length}, minmax(0, 1fr))`,
                    }}
                  >
                    {syncedYears.map((y) => {
                      const active = inputs.taxYear === y;
                      const data = mydataByYear[y]!;
                      return (
                        <button
                          key={y}
                          type="button"
                          onClick={() => setInputs((p) => ({ ...p, taxYear: y }))}
                          className={cn(
                            "rounded-md border py-1.5 text-xs font-medium tabular-nums transition-colors",
                            active
                              ? "border-foreground bg-foreground text-background"
                              : "border-border bg-secondary/40 text-foreground hover:bg-secondary"
                          )}
                          title={`${data.income.count} income · ${data.expenses.count} expense entries`}
                        >
                          {y}
                        </button>
                      );
                    })}
                  </div>
                </Field>
              )}

              <Field
                label="Gross income (€)"
                icon={Wallet}
                badge={
                  myData && !overrides.has("grossIncome")
                    ? "myDATA"
                    : overrides.has("grossIncome")
                      ? "manual"
                      : undefined
                }
              >
                <Input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="20000"
                  value={inputs.grossIncome}
                  onChange={(e) =>
                    setUserField(
                      "grossIncome",
                      e.target.value === "" ? "" : parseFloat(e.target.value)
                    )
                  }
                />
              </Field>

              <Field
                label="Έξοδα (deductible expenses)"
                icon={Receipt}
                optional
                badge={
                  myData && !overrides.has("expenses")
                    ? myData.e3
                      ? "myDATA · E3"
                      : "myDATA"
                    : overrides.has("expenses")
                      ? "manual"
                      : undefined
                }
              >
                <Input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0"
                  value={inputs.expenses}
                  onChange={(e) =>
                    setUserField(
                      "expenses",
                      e.target.value === "" ? "" : parseFloat(e.target.value)
                    )
                  }
                />
                {myData?.e3 && !overrides.has("expenses") && (
                  <p className="-mt-1 text-[11px] text-muted-foreground">
                    Sum of E3_585_* lines in your accountant&apos;s
                    classifications. Excludes E3_882 (asset purchases) and
                    E3_587 (depreciation).
                  </p>
                )}
              </Field>

              <Field
                label="Withholding tax already paid (€)"
                icon={Undo2}
                optional
                badge={
                  myData && !overrides.has("withholdingPaid")
                    ? "myDATA"
                    : overrides.has("withholdingPaid")
                      ? "manual"
                      : undefined
                }
              >
                <Input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0"
                  value={inputs.withholdingPaid}
                  onChange={(e) =>
                    setUserField(
                      "withholdingPaid",
                      e.target.value === "" ? "" : parseFloat(e.target.value)
                    )
                  }
                />
                <p className="text-[11px] text-muted-foreground">
                  Παρακράτηση φόρου — typically 20 % of net invoices, withheld
                  by your client and remitted to AADE.
                </p>
              </Field>

              <div className="rounded-md border border-border/40 bg-secondary/30 px-3 py-2 text-[11px] text-muted-foreground">
                <ShieldCheck className="mr-1 inline h-3 w-3" />
                Art. 39 §9 employee share fixed at{" "}
                <span className="font-numeric font-medium text-foreground">
                  {(ART39_PAR9_DEFAULT_EMPLOYEE_RATE * 100).toFixed(2)}%
                </span>{" "}
                (6.67 % main pension + 2.15 % health). Annual ={" "}
                <span className="font-numeric font-medium text-foreground">
                  €
                  {(numberOr(inputs.grossIncome, 0) * ART39_PAR9_DEFAULT_EMPLOYEE_RATE).toFixed(2)}
                </span>
                .
              </div>
            </div>
          </section>

          <section className="grid gap-4">
            {hasIncome && cardSpendByYear[inputs.taxYear] && (
              <CardSpendCard
                year={inputs.taxYear}
                // 30 % rule basis is "πραγματικό εισόδημα" = net business
                // income (gross minus deductible expenses, E3 code 401),
                // NOT gross invoices.
                incomeBasis={Math.max(
                  numberOr(inputs.grossIncome, 0) -
                    numberOr(inputs.expenses, 0),
                  0
                )}
                breakdown={cardSpendByYear[inputs.taxYear]}
              />
            )}
            {!hasBirthDate || !hasIncome ? <EmptyState /> : <ResultCard result={result} />}
            {myData?.e3 && (
              <ClassificationAnalysis
                year={inputs.taxYear}
                e3={myData.e3}
              />
            )}
            {hasBirthDate && hasIncome && (
              <div className="rounded-md border border-dashed border-border/60 bg-secondary/20 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground">
                <strong className="font-medium text-foreground">Estimate, not a binding figure.</strong>
                {" "}
                The εξοδα default is the sum of <code>E3_585_*</code> lines
                from your accountant&apos;s classifications in myDATA. The
                final E3 the accountant files may differ — last-minute
                re-classifications, depreciation rolled into a different
                line, special deductions not in this model (charity, medical,
                ENFIA, alimony, large-family credit, etc.). Insurance is fixed
                at 8.82 % per Art. 39 §9 (employee share). Override any field
                manually and your edit sticks until you click{" "}
                <em>Reset to myDATA</em>.
              </div>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function ResultCard({ result }: { result: ReturnType<typeof estimateTax> }) {
  const refund = result.finalPosition < 0;
  const settled = result.finalPosition === 0;
  return (
    <>
      <div className="rounded-2xl border border-border/60 bg-card/40 p-6 sm:p-8">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-muted-foreground">
          Estimated tax · {result.taxYear}
        </div>
        <div className="mt-2 font-numeric text-5xl font-medium tracking-tight sm:text-6xl">
          {formatCurrency(result.netTax, "EUR", { decimals: 2 })}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>≈ {formatCurrency(result.monthlyEquivalent, "EUR", { decimals: 2 })} / month</span>
          <span className="text-border">·</span>
          <span>{formatPercent(result.effectiveRate, 2)} effective</span>
          <span className="text-border">·</span>
          <span>{formatPercent(result.marginalRate, 0)} marginal</span>
        </div>

        <div className="mt-4 inline-flex items-center gap-2 rounded-md border border-border/60 bg-secondary/40 px-3 py-1.5 text-xs">
          <Cake className="h-3 w-3 text-muted-foreground" />
          Age {result.age} ·{" "}
          <span className="text-foreground">{AGE_BRACKET_LABEL[result.ageBracket]}</span>
        </div>
      </div>

      {result.withholdingPaid > 0 && (
        <div
          className={cn(
            "rounded-2xl border p-5",
            refund
              ? "border-[color:var(--gain)]/50 bg-[color:var(--gain)]/5"
              : settled
                ? "border-border/60 bg-card/40"
                : "border-[color:var(--loss)]/50 bg-[color:var(--loss)]/5"
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground">
                {refund
                  ? "Refund expected from AADE"
                  : settled
                    ? "Settled — no balance due"
                    : "Still owed to AADE"}
              </div>
              <div
                className={cn(
                  "mt-1 font-numeric text-2xl font-medium tabular-nums",
                  refund && "text-[color:var(--gain)]",
                  !refund && !settled && "text-[color:var(--loss)]"
                )}
              >
                {refund ? "+" : !settled ? "−" : ""}
                {formatCurrency(Math.abs(result.finalPosition), "EUR", {
                  decimals: 2,
                })}
              </div>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <div>
                Calc tax: {formatCurrency(result.netTax, "EUR", { decimals: 2 })}
              </div>
              <div>
                − Withheld:{" "}
                {formatCurrency(result.withholdingPaid, "EUR", { decimals: 2 })}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-border/60 bg-card/40 p-5">
        <h2 className="mb-3 text-sm font-medium tracking-tight">Breakdown</h2>
        <Row label="Gross income" value={result.grossIncome} />
        <Row
          label="− Έξοδα"
          value={result.expenses}
          mute={result.expenses === 0}
        />
        <Row
          label="− Insurance contributions"
          value={result.insuranceContributions}
          mute={result.insuranceContributions === 0}
        />
        <div className="my-2 h-px bg-border" />
        <Row label="Taxable income" value={result.taxableIncome} bold />
        <div className="mt-3 grid gap-1.5">
          {result.slices.map((s, i) => (
            <SliceRow key={i} from={s.from} to={s.to} rate={s.rate} tax={s.tax} />
          ))}
          {result.slices.length === 0 && (
            <div className="text-sm text-muted-foreground">No taxable income.</div>
          )}
        </div>
        <div className="my-2 h-px bg-border" />
        <Row label="Bracket total" value={result.bracketTotal} />
        <div className="my-2 h-px bg-border" />
        <Row label="Net tax owed" value={result.netTax} bold />
        <Row
          label="− Withholding paid"
          value={result.withholdingPaid}
          mute={result.withholdingPaid === 0}
        />
        <div className="my-2 h-px bg-border" />
        <Row
          label={
            result.finalPosition < 0
              ? "Refund expected"
              : result.finalPosition === 0
                ? "Settled"
                : "Final balance owed"
          }
          value={Math.abs(result.finalPosition)}
          bold
          gain={result.finalPosition <= 0}
        />
      </div>
    </>
  );
}

const MONTH_LABEL = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function CardSpendCard({
  year,
  incomeBasis,
  breakdown,
}: {
  year: number;
  /** πραγματικό εισόδημα — net business income for a freelancer. */
  incomeBasis: number;
  breakdown: CardSpendBreakdown;
}) {
  const aadeTotal = breakdown.aade?.total ?? 0;
  const trTotal = breakdown.tr.total;
  // Greek freelancers add foreign-card spend (TR) to AADE manually — TR
  // doesn't propagate to the AADE feed, so the sum is the real figure.
  const actualTotal = aadeTotal + trTotal;
  const required = requiredElectronicSpend(incomeBasis);
  const { shortfall, surcharge } = shortfallSurcharge(required, actualTotal);
  const met = shortfall === 0 && required > 0;
  const monthlyMax = Math.max(
    1,
    ...Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      return (
        (breakdown.aade?.monthly[m] ?? 0) + (breakdown.tr.monthly[m] ?? 0)
      );
    })
  );

  return (
    <div
      className={cn(
        "rounded-2xl border p-5",
        met
          ? "border-[color:var(--gain)]/50 bg-[color:var(--gain)]/5"
          : required > 0
            ? "border-[color:var(--loss)]/50 bg-[color:var(--loss)]/5"
            : "border-border/60 bg-card/40"
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
          <h2 className="text-sm font-medium tracking-tight">
            Electronic spend · 30 % rule · {year}
          </h2>
        </div>
        <span
          className={cn(
            "rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider",
            met
              ? "bg-[color:var(--gain)]/15 text-[color:var(--gain)]"
              : required > 0
                ? "bg-[color:var(--loss)]/15 text-[color:var(--loss)]"
                : "bg-muted text-muted-foreground"
          )}
        >
          {required === 0 ? "n/a" : met ? "met" : "short"}
        </span>
      </div>

      {/* Target-fill bar — the centerpiece. Bar width is `required` (30 % of
          income, capped at €6k). Moves dynamically as income changes. */}
      {required > 0 ? (
        <TargetFillBar
          required={required}
          actual={actualTotal}
          incomeBasis={incomeBasis}
          aade={aadeTotal}
          tr={trTotal}
        />
      ) : (
        <div className="rounded-md border border-dashed border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
          Set a gross income (and εξοδα) above to see the required spend.
        </div>
      )}

      {shortfall > 0 && (
        <div className="mt-4 flex items-baseline justify-between rounded-md border border-[color:var(--loss)]/40 bg-[color:var(--loss)]/5 px-3 py-2 text-xs">
          <span className="text-muted-foreground">22 % surcharge on shortfall</span>
          <span className="font-numeric font-medium tabular-nums text-[color:var(--loss)]">
            {formatCurrency(surcharge, "EUR", { decimals: 2 })}
          </span>
        </div>
      )}

      <div className="mt-4 mb-2 text-[11px] text-muted-foreground">
        Monthly breakdown
      </div>
      <div className="grid grid-cols-12 gap-1">
        {Array.from({ length: 12 }, (_, i) => {
          const m = i + 1;
          const a = breakdown.aade?.monthly[m] ?? 0;
          const t = breakdown.tr.monthly[m] ?? 0;
          const total = a + t;
          return (
            <div
              key={m}
              className="flex flex-col items-center gap-1"
              title={`${MONTH_LABEL[i]} — AADE €${a.toFixed(2)} + TR €${t.toFixed(2)} = €${total.toFixed(2)}`}
            >
              <div className="flex h-12 w-full flex-col-reverse overflow-hidden rounded-sm bg-muted/40">
                <div
                  className="w-full bg-foreground/40"
                  style={{ height: `${(a / monthlyMax) * 100}%` }}
                />
                <div
                  className="w-full bg-[color:var(--gain)]"
                  style={{ height: `${(t / monthlyMax) * 100}%` }}
                />
              </div>
              <span className="text-[9px] uppercase text-muted-foreground">
                {MONTH_LABEL[i]}
              </span>
              <span className="font-numeric text-[9px] tabular-nums text-muted-foreground/80">
                €{total < 1000 ? total.toFixed(0) : `${(total / 1000).toFixed(1)}k`}
              </span>
            </div>
          );
        })}
      </div>

      {!breakdown.aade ? (
        <div className="mt-3 rounded-md border border-dashed border-border/40 px-3 py-2 text-[11px] text-muted-foreground">
          No <code>data/aade-card/{year}.json</code> yet — run{" "}
          <code className="text-foreground">npm run sync:aade-card -- --year {year}</code>{" "}
          to scrape monthly totals from TaxisNet. Showing TR-only spend until then.
        </div>
      ) : (
        <div className="mt-3 text-[10px] text-muted-foreground">
          AADE last sync{" "}
          {breakdown.aade.fetchedAt
            ? new Date(breakdown.aade.fetchedAt).toLocaleString("en-IE")
            : "—"}{" "}
          · TR card spend is added on top because foreign-issued cards
          (TR / Revolut / N26 / Wise) don&apos;t propagate to AADE&apos;s
          lottery feed and Greek freelancers must add them manually.
        </div>
      )}
    </div>
  );
}

function TargetFillBar({
  required,
  actual,
  incomeBasis,
  aade,
  tr,
}: {
  required: number;
  actual: number;
  /** πραγματικό εισόδημα (net business income) used as the 30 % basis. */
  incomeBasis: number;
  aade: number;
  tr: number;
}) {
  // Bar's full track represents the larger of (required, actual) so a surplus
  // is also visible. The required line is rendered as a vertical marker
  // wherever it falls in the track; AADE + TR are stacked segments inside the
  // filled portion so you can see the contribution of each source.
  const barMax = Math.max(required, actual, 1);
  const requiredPct = (required / barMax) * 100;
  const aadePct = (aade / barMax) * 100;
  const trPct = (tr / barMax) * 100;
  const met = actual >= required;
  const shortfall = Math.max(required - actual, 0);
  const cappedAt6k = required >= 6000;

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <div className="font-numeric text-2xl font-medium tabular-nums">
          €{actual.toFixed(0)}
          <span className="ml-2 text-sm text-muted-foreground">
            / €{required.toFixed(0)}
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground">
          {met
            ? `surplus €${(actual - required).toFixed(0)}`
            : `need €${shortfall.toFixed(0)} more`}
        </div>
      </div>

      <div className="relative h-7 w-full overflow-hidden rounded-md bg-muted/50">
        {/* AADE base segment */}
        <div
          className="absolute inset-y-0 left-0 bg-foreground/40"
          style={{ width: `${aadePct}%` }}
        />
        {/* TR segment stacked next to AADE */}
        <div
          className={cn(
            "absolute inset-y-0",
            met ? "bg-[color:var(--gain)]" : "bg-[color:var(--loss)]"
          )}
          style={{
            left: `${aadePct}%`,
            width: `${trPct}%`,
          }}
        />
        {/* Required-target marker line */}
        <div
          className="absolute inset-y-0 w-px bg-foreground"
          style={{ left: `${Math.min(requiredPct, 100)}%` }}
          aria-hidden
        />
        <div
          className="absolute -top-0.5 -translate-x-1/2 rounded-sm bg-foreground px-1 py-px text-[8px] font-medium uppercase tracking-wider text-background"
          style={{ left: `${Math.min(requiredPct, 100)}%` }}
        >
          target
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span>
          30 % of net €{incomeBasis.toFixed(0)} ={" "}
          <span className="font-numeric tabular-nums">
            €{(incomeBasis * 0.3).toFixed(0)}
          </span>
          {cappedAt6k && (
            <span className="ml-1 text-foreground/70">(capped at €6,000)</span>
          )}
        </span>
        <span className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-foreground/40" />
            AADE €{aade.toFixed(0)}
          </span>
          <span className="inline-flex items-center gap-1">
            <span
              className={cn(
                "h-2 w-2 rounded-sm",
                met ? "bg-[color:var(--gain)]" : "bg-[color:var(--loss)]"
              )}
            />
            TR €{tr.toFixed(0)}
          </span>
        </span>
      </div>
    </div>
  );
}

function ClassificationAnalysis({
  year,
  e3,
}: {
  year: number;
  e3: NonNullable<MyDataYear["e3"]>;
}) {
  const codes = Object.entries(e3.byCode)
    .map(([code, info]) => ({ code, ...info, ...describeE3Code(code) }))
    .sort((a, b) => b.sum - a.sum);

  const incomeTotal = codes
    .filter((c) => c.side === "income")
    .reduce((s, c) => s + c.sum, 0);
  const deductibleTotal = codes
    .filter((c) => c.deductible)
    .reduce((s, c) => s + c.sum, 0);
  const nonDeductibleExpense = codes
    .filter((c) => c.side === "expense" && !c.deductible)
    .reduce((s, c) => s + c.sum, 0);

  return (
    <div className="rounded-2xl border border-border/60 bg-card/40 p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-medium tracking-tight">
          Accountant&apos;s classifications · {year}
        </h2>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {e3.count} entries · myDATA E3
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Income" value={incomeTotal} tone="neutral" />
        <Stat label="Deductible (used)" value={deductibleTotal} tone="gain" />
        <Stat label="Non-deductible" value={nonDeductibleExpense} tone="loss" />
      </div>
      <div className="mt-4 flex flex-col gap-1.5">
        {codes.map((c) => (
          <div
            key={c.code}
            className={cn(
              "grid grid-cols-[minmax(0,1fr)_60px_minmax(0,110px)] items-baseline gap-3 rounded-md px-2 py-1.5 text-xs",
              c.deductible && "bg-[color:var(--gain)]/5"
            )}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-numeric text-[11px] tabular-nums text-muted-foreground">
                  {c.code}
                </span>
                <span
                  className={cn(
                    "rounded px-1 py-0.5 text-[9px] uppercase tracking-wider",
                    c.side === "income"
                      ? "bg-foreground/10 text-foreground"
                      : c.deductible
                        ? "bg-[color:var(--gain)]/15 text-[color:var(--gain)]"
                        : "bg-muted text-muted-foreground"
                  )}
                >
                  {c.side === "income" ? "income" : c.deductible ? "deductible" : "skipped"}
                </span>
              </div>
              <div className="mt-0.5 truncate text-[11px] text-foreground/80">
                {c.label}
              </div>
              {c.note && (
                <div className="mt-0.5 text-[10px] text-muted-foreground">
                  {c.note}
                </div>
              )}
            </div>
            <div className="text-right text-muted-foreground tabular-nums">
              {c.count}×
            </div>
            <div className="text-right font-numeric tabular-nums">
              {formatCurrency(c.sum, "EUR", { decimals: 2 })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "gain" | "loss" | "neutral";
}) {
  return (
    <div className="rounded-md border border-border/40 bg-secondary/30 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-numeric text-base font-medium tabular-nums",
          tone === "gain" && "text-[color:var(--gain)]",
          tone === "loss" && "text-[color:var(--loss)]"
        )}
      >
        {formatCurrency(value, "EUR", { decimals: 2 })}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full min-h-[340px] flex-col items-center justify-center rounded-2xl border border-dashed border-border/60 bg-card/30 p-10 text-center">
      <Calculator className="h-8 w-8 text-muted-foreground" />
      <p className="mt-3 max-w-sm text-sm text-muted-foreground">
        Punch in a birth date and gross income on the left to see your estimated
        tax for the year.
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  mute,
  gain,
}: {
  label: string;
  value: number;
  bold?: boolean;
  mute?: boolean;
  gain?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between text-sm",
        mute && "text-muted-foreground"
      )}
    >
      <span>{label}</span>
      <span
        className={cn(
          "font-numeric tabular-nums",
          bold && "font-medium",
          gain === false && "text-[color:var(--loss)]",
          gain === true && "text-[color:var(--gain)]"
        )}
      >
        {formatCurrency(value, "EUR", { decimals: 2 })}
      </span>
    </div>
  );
}

function SliceRow({
  from,
  to,
  rate,
  tax,
}: {
  from: number;
  to: number;
  rate: number;
  tax: number;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_60px_minmax(0,90px)] items-center gap-3 text-xs">
      <div className="font-numeric tabular-nums text-muted-foreground">
        {formatCurrency(from, "EUR", { decimals: 0 })} →{" "}
        {formatCurrency(to, "EUR", { decimals: 0 })}
      </div>
      <div className="text-right text-muted-foreground">
        × {formatPercent(rate, 0)}
      </div>
      <div className="text-right font-numeric tabular-nums">
        {formatCurrency(tax, "EUR", { decimals: 2 })}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
  optional,
  icon: Icon,
  badge,
}: {
  label: string;
  children: React.ReactNode;
  optional?: boolean;
  icon?: React.ComponentType<{ className?: string }>;
  badge?: "myDATA" | "myDATA · E3" | "manual";
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
        {Icon && <Icon className="h-3 w-3" />}
        {label}
        {optional && (
          <span className="ml-1 text-muted-foreground/60">(optional)</span>
        )}
        {badge && (
          <span
            className={cn(
              "ml-auto rounded-sm px-1.5 py-0.5 text-[9px] font-medium tracking-normal normal-case",
              badge.startsWith("myDATA")
                ? "bg-[color:var(--gain)]/10 text-[color:var(--gain)]"
                : "bg-muted text-muted-foreground"
            )}
          >
            {badge}
          </span>
        )}
      </Label>
      {children}
    </div>
  );
}

function numberOr(value: number | "", fallback: number): number {
  if (value === "" || Number.isNaN(value)) return fallback;
  return value;
}
