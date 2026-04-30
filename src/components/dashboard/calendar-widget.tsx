import { Calendar, Coins, Landmark, Sparkles } from "lucide-react";
import { formatCurrency, formatRelativeDays } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CalendarEvent, CalendarEventKind } from "@/lib/calendar";

const META: Record<
  CalendarEventKind,
  { label: string; icon: React.ComponentType<{ className?: string }>; tone: string }
> = {
  maturity: { label: "Matures", icon: Landmark, tone: "var(--gain)" },
  ex_dividend: { label: "Ex-dividend", icon: Sparkles, tone: "var(--chart-4)" },
  dividend_payment: { label: "Dividend", icon: Coins, tone: "var(--gain)" },
};

// Highlight events landing within this window so they jump out from regular ones.
const SOON_THRESHOLD_DAYS = 7;

export function CalendarWidget({ events }: { events: CalendarEvent[] }) {
  if (events.length === 0) return null;

  const last = events[events.length - 1];

  return (
    <section className="rounded-2xl border border-border/60 bg-card/40 p-5">
      <div className="mb-3 flex items-center gap-2">
        <Calendar className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium tracking-tight">Upcoming events</h2>
        <span className="text-xs text-muted-foreground">· next {last.daysUntil}d</span>
      </div>
      <ul className="flex flex-col gap-1.5">
        {events.map((e) => {
          const m = META[e.kind];
          const Icon = m.icon;
          const upcoming = e.daysUntil >= 0;
          const soon = upcoming && e.daysUntil <= SOON_THRESHOLD_DAYS;
          return (
            <li
              key={e.id}
              className={cn(
                "grid grid-cols-[88px_minmax(0,1fr)_auto] items-center gap-3 rounded-md border border-border/40 bg-background/30 px-3 py-2",
                soon && "border-[color:var(--chart-2)]/40"
              )}
            >
              <div>
                <div className="font-numeric text-sm tabular-nums">
                  {new Date(e.date).toLocaleDateString("en-IE", {
                    day: "2-digit",
                    month: "short",
                  })}
                </div>
                <div
                  className={cn(
                    "text-[10px] font-numeric tabular-nums",
                    soon
                      ? "text-[color:var(--chart-2)]"
                      : "text-muted-foreground"
                  )}
                >
                  {formatRelativeDays(e.daysUntil)}
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="grid h-5 w-5 shrink-0 place-items-center rounded-full"
                  style={{ background: `${m.tone}22`, color: m.tone }}
                >
                  <Icon className="h-3 w-3" />
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {e.assetName}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {m.label}
                    {e.detail && ` · ${e.detail}`}
                  </div>
                </div>
              </div>
              <div className="text-right">
                {e.amountEur !== undefined ? (
                  <span className="font-numeric text-sm tabular-nums">
                    {formatCurrency(e.amountEur, "EUR", { decimals: 2 })}
                  </span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">—</span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
