"use client";
import { useMemo, useState } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
  Camera,
  ArrowDownLeft,
  ArrowUpRight,
  Coins,
  CreditCard,
  Landmark,
  PiggyBank,
  Repeat,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency, formatNumber } from "@/lib/format";
import { Header } from "@/components/layout/header";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { Asset, PortfolioEvent } from "@/lib/types";
import type {
  TrTransaction,
  TrTransactionStats,
} from "@/lib/storage/transactions";
import { cn } from "@/lib/utils";

const ICONS: Record<PortfolioEvent["type"], React.ComponentType<{ className?: string }>> = {
  "asset.created": Plus,
  "asset.updated": Pencil,
  "asset.deleted": Trash2,
  "price.updated": RefreshCw,
  snapshot: Camera,
};

const LABELS: Record<PortfolioEvent["type"], string> = {
  "asset.created": "Asset created",
  "asset.updated": "Asset updated",
  "asset.deleted": "Asset deleted",
  "price.updated": "Price updated",
  snapshot: "Snapshot",
};

export function HistoryView({
  events,
  trTxns,
  trStats,
}: {
  events: PortfolioEvent[];
  trTxns: TrTransaction[];
  trStats: TrTransactionStats;
}) {
  const [tab, setTab] = useState<"portfolio" | "tr">(
    trTxns.length > 0 ? "tr" : "portfolio"
  );
  const sorted = [...events].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
  );
  const snapshots = useMemo(
    () =>
      events
        .filter((e): e is Extract<PortfolioEvent, { type: "snapshot" }> => e.type === "snapshot")
        .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
        .map((s) => ({
          at: s.at,
          date: new Date(s.at).toLocaleDateString("en-IE"),
          totalEur: s.totalEur,
        })),
    [events]
  );

  return (
    <div className="min-h-svh">
      <Header />
      <main className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="mb-5">
          <h1 className="text-2xl font-medium tracking-tight">History</h1>
          <p className="text-sm text-muted-foreground">
            Every change to your portfolio.
          </p>
        </div>

        {snapshots.length >= 2 && (
          <section className="mb-6 rounded-2xl border border-border/60 bg-card/40 p-5">
            <h2 className="mb-3 text-sm font-medium tracking-tight">
              Net worth over time
            </h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={snapshots}>
                  <defs>
                    <linearGradient id="nw" x1="0" y1="0" x2="0" y2="1">
                      <stop
                        offset="0%"
                        stopColor="var(--gain)"
                        stopOpacity={0.4}
                      />
                      <stop
                        offset="100%"
                        stopColor="var(--gain)"
                        stopOpacity={0}
                      />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="date"
                    fontSize={11}
                    stroke="var(--muted-foreground)"
                  />
                  <YAxis
                    tickFormatter={(v) => formatNumber(v as number, 0)}
                    fontSize={11}
                    stroke="var(--muted-foreground)"
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--popover)",
                      border: "1px solid var(--border)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(v) =>
                      formatCurrency(Number(v), "EUR", { decimals: 2 })
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="totalEur"
                    stroke="var(--gain)"
                    strokeWidth={2}
                    fill="url(#nw)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>
        )}

        {trTxns.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-3 text-sm font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Trade Republic — totals
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <StatTile
                label="Interest received"
                value={trStats.totalIncome.interest}
                tone="gain"
                icon={Coins}
              />
              <StatTile
                label="Dividends"
                value={trStats.totalIncome.dividend}
                tone="gain"
                icon={Landmark}
              />
              <StatTile
                label="Saveback earned"
                value={trStats.totalIncome.saveback}
                tone="gain"
                icon={Repeat}
              />
              <StatTile
                label="Savings-plan invested"
                value={trStats.totalInvested.savings_plan}
                tone="neutral"
                icon={PiggyBank}
              />
              <StatTile
                label="Card spend"
                value={trStats.totalCardSpend}
                tone="loss"
                icon={CreditCard}
              />
              <StatTile
                label="Net deposits"
                value={trStats.totalDeposits - trStats.totalWithdrawals}
                tone="neutral"
                icon={ArrowDownLeft}
              />
            </div>
          </section>
        )}

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Activity
            </h2>
            <Tabs value={tab} onValueChange={(v) => setTab(v as "portfolio" | "tr")}>
              <TabsList>
                <TabsTrigger value="tr" disabled={trTxns.length === 0}>
                  Trade Republic ({trTxns.length})
                </TabsTrigger>
                <TabsTrigger value="portfolio">
                  Portfolio events ({sorted.length})
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {tab === "portfolio" ? (
            sorted.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border/60 bg-card/30 px-6 py-12 text-center text-sm text-muted-foreground">
                No history yet. Add your first asset to start the log.
              </div>
            ) : (
              <ol className="relative ml-3 border-l border-border">
                {sorted.map((e, i) => (
                  <EventRow key={i} event={e} />
                ))}
              </ol>
            )
          ) : (
            <TrTransactionsList txns={trTxns} />
          )}
        </section>
      </main>
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string;
  value: number;
  tone: "gain" | "loss" | "neutral";
  icon: React.ComponentType<{ className?: string }>;
}) {
  const toneCls =
    tone === "gain"
      ? "text-[color:var(--gain)]"
      : tone === "loss"
        ? "text-[color:var(--loss)]"
        : "text-foreground";
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className={cn("mt-1.5 font-numeric text-lg font-medium tabular-nums", toneCls)}>
        {formatCurrency(value, "EUR", { decimals: value >= 1000 ? 0 : 2 })}
      </div>
    </div>
  );
}

const TR_TYPE_META: Record<
  string,
  {
    label: string;
    tone: "gain" | "loss" | "neutral";
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  buy: { label: "Buy", tone: "neutral", icon: ArrowDownLeft },
  sell: { label: "Sell", tone: "neutral", icon: ArrowUpRight },
  savings_plan: { label: "Savings plan", tone: "neutral", icon: PiggyBank },
  saveback: { label: "Saveback", tone: "gain", icon: Repeat },
  interest: { label: "Interest", tone: "gain", icon: Coins },
  dividend: { label: "Dividend", tone: "gain", icon: Landmark },
  deposit: { label: "Deposit", tone: "gain", icon: ArrowDownLeft },
  withdrawal: { label: "Withdrawal", tone: "loss", icon: ArrowUpRight },
  card: { label: "Card", tone: "loss", icon: CreditCard },
  card_refund: { label: "Card refund", tone: "gain", icon: CreditCard },
  card_verify: { label: "Card verify", tone: "neutral", icon: CreditCard },
  atm_withdrawal: { label: "ATM", tone: "loss", icon: ArrowUpRight },
  fee: { label: "Fee", tone: "loss", icon: CreditCard },
  cancelled: { label: "Cancelled", tone: "neutral", icon: Trash2 },
  document: { label: "Document", tone: "neutral", icon: Camera },
  stock_perk: { label: "Stock perk", tone: "gain", icon: Landmark },
  trade: { label: "Trade", tone: "neutral", icon: Repeat },
  admin: { label: "Admin", tone: "neutral", icon: Pencil },
  other: { label: "Other", tone: "neutral", icon: RefreshCw },
};

function TrTransactionsList({ txns }: { txns: TrTransaction[] }) {
  const [filter, setFilter] = useState<string>("all");
  const [limit, setLimit] = useState(100);

  const types = useMemo(() => {
    const set = new Set(txns.map((t) => t.type));
    return ["all", ...[...set].sort()];
  }, [txns]);

  const filtered = useMemo(() => {
    if (filter === "all") return txns;
    return txns.filter((t) => t.type === filter);
  }, [txns, filter]);

  const visible = filtered.slice(0, limit);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {types.map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={cn(
              "rounded-md border px-2.5 py-1 text-xs",
              filter === t
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary"
            )}
          >
            {t === "all" ? "All" : (TR_TYPE_META[t]?.label ?? t)}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-border/60 bg-card/40">
        {visible.map((t) => (
          <TrTxnRow key={t.id} txn={t} />
        ))}
        {visible.length === 0 && (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            No matching transactions.
          </div>
        )}
      </div>

      {filtered.length > visible.length && (
        <button
          onClick={() => setLimit((l) => l + 100)}
          className="self-center rounded-md border border-border bg-secondary/40 px-3 py-1.5 text-xs text-muted-foreground hover:bg-secondary"
        >
          Load more ({filtered.length - visible.length} remaining)
        </button>
      )}
    </div>
  );
}

function TrTxnRow({ txn }: { txn: TrTransaction }) {
  const meta = TR_TYPE_META[txn.type] ?? TR_TYPE_META.other;
  const Icon = meta.icon;
  const date = new Date(txn.date);
  const amountTone =
    txn.amountEur === null
      ? "text-muted-foreground"
      : txn.amountEur > 0
        ? "text-[color:var(--gain)]"
        : txn.amountEur < 0
          ? "text-[color:var(--loss)]"
          : "text-muted-foreground";

  return (
    <div className="grid grid-cols-[100px_minmax(0,1fr)_auto] items-center gap-3 border-b border-border/40 px-4 py-2.5 text-sm last:border-0 hover:bg-secondary/30">
      <div className="text-xs text-muted-foreground">
        <div>{date.toLocaleDateString("en-IE", { day: "2-digit", month: "short", year: "2-digit" })}</div>
        <div className="text-[10px] uppercase tracking-wider">
          {date.toLocaleTimeString("en-IE", { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate font-medium">{txn.description || meta.label}</div>
          <div className="text-[11px] text-muted-foreground">{meta.label}</div>
        </div>
      </div>
      <div className={cn("font-numeric text-right text-sm tabular-nums", amountTone)}>
        {txn.amountEur === null
          ? "—"
          : `${txn.amountEur > 0 ? "+" : ""}${formatCurrency(txn.amountEur, "EUR", { decimals: 2 })}`}
      </div>
    </div>
  );
}

function EventRow({ event }: { event: PortfolioEvent }) {
  const Icon = ICONS[event.type];
  const date = new Date(event.at);
  const formatted = date.toLocaleString("en-IE", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  let title = LABELS[event.type];
  let subtitle = "";

  switch (event.type) {
    case "asset.created":
      title = `Added ${event.asset.name}`;
      subtitle = `${event.asset.type} · ${event.asset.source}`;
      break;
    case "asset.updated":
      title = `Updated ${describeAsset(event.assetId)}`;
      subtitle = describeDiff(event.before, event.after);
      break;
    case "asset.deleted":
      title = `Removed ${event.asset.name}`;
      break;
    case "price.updated":
      title = `Price updated`;
      subtitle = `${event.price} ${event.currency} · ${event.source}`;
      break;
    case "snapshot":
      title = `Snapshot taken`;
      subtitle = formatCurrency(event.totalEur, "EUR", { decimals: 2 });
      break;
  }

  return (
    <li className="relative ml-6 pb-5 last:pb-0">
      <span className="absolute -left-[31px] top-1 grid h-6 w-6 place-items-center rounded-full border border-border bg-card">
        <Icon className="h-3 w-3 text-muted-foreground" />
      </span>
      <div className="flex flex-col gap-0.5">
        <div className="text-sm font-medium">{title}</div>
        {subtitle && (
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        )}
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
          {formatted}
        </div>
      </div>
    </li>
  );
}

function describeAsset(id: string): string {
  return `asset ${id.slice(0, 6)}`;
}

function describeDiff(
  before: Partial<Asset>,
  after: Partial<Asset>
): string {
  const keys = Object.keys(after);
  if (keys.length === 0) return "";
  if (keys.length === 1) {
    const k = keys[0];
    return `${k}: ${stringify((before as Record<string, unknown>)[k])} → ${stringify(
      (after as Record<string, unknown>)[k]
    )}`;
  }
  return keys.map((k) => k).join(", ") + " changed";
}

function stringify(v: unknown): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "number") return formatNumber(v);
  return String(v);
}
