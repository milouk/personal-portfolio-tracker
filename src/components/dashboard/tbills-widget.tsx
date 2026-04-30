"use client";
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Calendar, ExternalLink, Landmark } from "lucide-react";
import { Input } from "@/components/ui/input";
import { formatCurrency, formatPercent } from "@/lib/format";
import type {
  AuctionResult,
  PdmaSnapshot,
  UpcomingAuction,
} from "@/lib/prices/pdma";

// Tenors are weeks-as-string (e.g. "13W"). Convert to days dynamically so
// new tenors (e.g. "4W") work without a code change.
function tenorToDays(tenor: string): number {
  const m = /^(\d+)\s*W$/i.exec(tenor.trim());
  if (m) return parseInt(m[1], 10) * 7;
  const months = /^(\d+)\s*M$/i.exec(tenor.trim());
  if (months) return Math.round(parseInt(months[1], 10) * 30.4375);
  return 0;
}


export function TbillsWidget({
  defaultAmount,
}: {
  defaultAmount: number;
}) {
  const [data, setData] = useState<PdmaSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [amountStr, setAmountStr] = useState<string>(String(defaultAmount));
  const amount = Number(amountStr.replace(/[^\d.]/g, "")) || 0;
  // Pinned `now` so daysUntil rendering is stable across re-renders. Refreshes
  // when the component remounts (page navigation / hard reload).
  const [now] = useState(() => Date.now());

  useEffect(() => {
    fetch("/api/tbills")
      .then((r) => r.json())
      .then((d) => setData(d as PdmaSnapshot))
      .catch(() =>
        setData({
          upcoming: [],
          latest: [],
          latestYieldByTenor: {},
          fetchedAt: new Date().toISOString(),
        })
      )
      .finally(() => setLoading(false));
  }, []);

  // Reference yield per tenor: prefer dedicated historical scrape, fall back
  // to whatever appears in the "latest results" table.
  const refYieldByTenor = useMemo(() => {
    const map: Record<string, number> = {};
    for (const r of data?.latest ?? []) {
      if (map[r.tenor] === undefined && r.yield !== undefined)
        map[r.tenor] = r.yield;
    }
    for (const [t, y] of Object.entries(data?.latestYieldByTenor ?? {})) {
      if (typeof y === "number") map[t] = y;
    }
    return map;
  }, [data]);

  const upcoming = data?.upcoming ?? [];

  return (
    <section className="rounded-2xl border border-border/60 bg-card/40 p-5">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Landmark className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium tracking-tight">
            Greek T-bills · ΟΔΔΗΧ
          </h2>
        </div>
        <a
          href="https://www.pdma.gr/en/debt-instruments-greek-government-bonds/issuance-calendar-a-syndication-and-auction-results/issuance-calendar"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          PDMA <ExternalLink className="h-3 w-3" />
        </a>
      </div>

      <div className="grid gap-5 md:grid-cols-[1.6fr_1fr]">
        <div>
          <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            Upcoming auctions
          </div>
          {loading && <div className="text-xs text-muted-foreground">Loading…</div>}
          {!loading && upcoming.length === 0 && (
            <div className="text-xs text-muted-foreground">
              No upcoming T-bill auctions on the calendar.
            </div>
          )}
          <ul className="flex flex-col gap-1.5">
            {upcoming.map((a, i) => (
              <UpcomingRow
                key={`${a.date}-${a.tenor}-${i}`}
                auction={a}
                refYield={refYieldByTenor[a.tenor]}
                amount={amount}
                now={now}
              />
            ))}
          </ul>
        </div>

        <div>
          <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            Latest results
          </div>
          <ul className="flex flex-col gap-2">
            {(data?.latest ?? []).slice(0, 3).map((r) => (
              <LatestResultRow key={r.auctionDate + r.tenor} result={r} />
            ))}
            {!loading && (data?.latest?.length ?? 0) === 0 && (
              <div className="text-xs text-muted-foreground">No data.</div>
            )}
          </ul>

          <div className="mt-4 rounded-lg border border-border/60 bg-secondary/30 p-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Profit calculator
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-sm">Invest</span>
              <Input
                type="text"
                inputMode="numeric"
                value={amountStr}
                onChange={(e) => {
                  // Strip non-digits, drop leading zeros (so "01500" → "1500"),
                  // but keep an empty string typeable.
                  const cleaned = e.target.value.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
                  setAmountStr(cleaned);
                }}
                onBlur={() => {
                  if (amountStr === "") setAmountStr("0");
                }}
                placeholder="amount"
                className="h-7 w-28 font-numeric text-sm tabular-nums"
              />
              <span className="text-sm text-muted-foreground">EUR</span>
            </div>
            <div className="mt-2 text-[11px] text-muted-foreground">
              Each upcoming row shows expected profit based on the most recent
              auction yield for that tenor.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function UpcomingRow({
  auction,
  refYield,
  amount,
  now,
}: {
  auction: UpcomingAuction;
  refYield?: number;
  amount: number;
  now: number;
}) {
  const days = tenorToDays(auction.tenor);
  const expectedProfit =
    refYield !== undefined ? amount * refYield * (days / 365) : undefined;
  const date = new Date(auction.date);
  const daysFromNow = Math.round(
    (date.getTime() - now) / (1000 * 60 * 60 * 24)
  );

  return (
    <li className="grid grid-cols-[80px_60px_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border/40 bg-background/30 px-3 py-2 hover:bg-secondary/30">
      <div>
        <div className="font-numeric text-sm tabular-nums">
          {date.toLocaleDateString("en-IE", { day: "2-digit", month: "short" })}
        </div>
        <div className="text-[10px] text-muted-foreground">
          in {daysFromNow}d
        </div>
      </div>
      <div className="rounded-md border border-border/60 bg-card/50 px-1.5 py-0.5 text-center text-[10px] font-medium uppercase tracking-wider">
        {auction.tenor}
      </div>
      <div className="min-w-0 text-xs text-muted-foreground">
        {auction.isin ? (
          <span className="font-numeric tracking-tight">{auction.isin}</span>
        ) : (
          <span>ISIN announced day before auction</span>
        )}
        {refYield !== undefined && (
          <span className="ml-2 inline-flex items-center gap-0.5 text-foreground/80">
            <ArrowUpRight className="h-2.5 w-2.5" />
            {formatPercent(refYield, 2)} ref.
          </span>
        )}
      </div>
      <div className="text-right">
        {expectedProfit !== undefined ? (
          <>
            <div className="font-numeric text-sm tabular-nums text-[color:var(--gain)]">
              +{formatCurrency(expectedProfit, "EUR", { decimals: 2 })}
            </div>
            <div className="text-[10px] text-muted-foreground">
              on {formatCurrency(amount, "EUR", { compact: true })} · {days}d
            </div>
          </>
        ) : (
          <div className="text-xs text-muted-foreground">—</div>
        )}
      </div>
    </li>
  );
}

function LatestResultRow({ result }: { result: AuctionResult }) {
  return (
    <li className="rounded-md border border-border/40 bg-background/30 px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="rounded-md border border-border/60 bg-card/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider">
            {result.tenor}
          </span>
          <span className="text-xs text-muted-foreground">
            {new Date(result.auctionDate).toLocaleDateString("en-IE", {
              day: "2-digit",
              month: "short",
            })}
          </span>
        </div>
        {result.yield !== undefined && (
          <span className="font-numeric text-sm tabular-nums text-[color:var(--gain)]">
            {formatPercent(result.yield, 2)}
          </span>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        {result.amountAcceptedM !== undefined && (
          <span>€{result.amountAcceptedM.toFixed(0)}M</span>
        )}
        {result.bidToCover !== undefined && (
          <>
            <span className="text-border">·</span>
            <span>{result.bidToCover.toFixed(2)}x cover</span>
          </>
        )}
        {result.maturityDate && (
          <>
            <span className="text-border">·</span>
            <span className="inline-flex items-center gap-0.5">
              <Calendar className="h-2.5 w-2.5" />
              matures{" "}
              {new Date(result.maturityDate).toLocaleDateString("en-IE", {
                day: "2-digit",
                month: "short",
              })}
            </span>
          </>
        )}
      </div>
    </li>
  );
}
