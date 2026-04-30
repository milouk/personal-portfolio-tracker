import Link from "next/link";

export function DemoBanner() {
  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-center text-xs">
      <span className="font-medium text-amber-400">DEMO</span>
      <span className="ml-2 text-foreground/80">
        Read-only with synthetic data. No live prices, no sync, no edits.
      </span>
      <Link
        href="https://github.com/milouk/personal-portfolio-tracker"
        className="ml-3 underline hover:text-foreground"
      >
        View source / fork →
      </Link>
    </div>
  );
}
