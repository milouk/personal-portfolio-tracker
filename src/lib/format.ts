export function formatCurrency(
  value: number,
  currency: "EUR" | "USD" = "EUR",
  opts: { compact?: boolean; decimals?: number } = {}
): string {
  const { compact = false, decimals = 2 } = opts;
  const fmt = new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency,
    notation: compact ? "compact" : "standard",
    maximumFractionDigits: compact ? 1 : decimals,
    minimumFractionDigits: compact ? 0 : decimals,
  });
  return fmt.format(value);
}

export function formatNumber(value: number, decimals = 2): string {
  return new Intl.NumberFormat("en-IE", {
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  }).format(value);
}

export function formatPercent(value: number, decimals = 2): string {
  return new Intl.NumberFormat("en-IE", {
    style: "percent",
    maximumFractionDigits: decimals,
    minimumFractionDigits: decimals,
  }).format(value);
}

export function formatRelativeDays(days: number): string {
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export function signed(value: number, formatter: (v: number) => string): string {
  if (value === 0) return formatter(0);
  return value > 0 ? `+${formatter(value)}` : formatter(value);
}
