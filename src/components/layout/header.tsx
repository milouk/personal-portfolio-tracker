"use client";
import { Eye, EyeOff, Moon, Sun, Wallet, Plus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { usePrivacy } from "@/components/privacy-provider";
import { SyncController } from "@/components/sync/sync-controller";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/assets", label: "Assets" },
  { href: "/history", label: "History" },
];

// Detect hydration so the icon swap (Sun/Moon, Eye/EyeOff) doesn't mismatch
// on first render — server has no idea what the client's theme/privacy is.
const subscribeNoop = () => () => {};
const useMounted = () =>
  useSyncExternalStore(subscribeNoop, () => true, () => false);

export function Header({
  onAddAsset,
}: {
  onAddAsset?: () => void;
}) {
  const pathname = usePathname();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { hidden, toggle: togglePrivacy } = usePrivacy();
  const mounted = useMounted();
  const isDark = mounted ? (resolvedTheme ?? theme) === "dark" : true;
  const isDemo = process.env.NEXT_PUBLIC_DEMO === "1";

  return (
    <header className="sticky top-0 z-30 border-b border-border/60 bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-foreground text-background">
            <Wallet className="h-3.5 w-3.5" />
          </span>
          <span className="font-semibold tracking-tight">Net Worth</span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {NAV.map((n) => {
            const active =
              n.href === "/"
                ? pathname === "/"
                : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  active
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                )}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          {!isDemo && <SyncController />}
          <Button
            variant="ghost"
            size="icon"
            onClick={togglePrivacy}
            aria-label={hidden ? "Reveal numbers" : "Hide numbers"}
            title={hidden ? "Reveal numbers (⌘/Ctrl + .)" : "Hide numbers (⌘/Ctrl + .)"}
            suppressHydrationWarning
          >
            <span suppressHydrationWarning>
              {mounted ? (
                hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />
              ) : (
                <EyeOff className="h-4 w-4 opacity-0" />
              )}
            </span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(isDark ? "light" : "dark")}
            aria-label="Toggle theme"
            suppressHydrationWarning
          >
            <span suppressHydrationWarning>
              {mounted ? (
                isDark ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Moon className="h-4 w-4" />
                )
              ) : (
                <Sun className="h-4 w-4 opacity-0" />
              )}
            </span>
          </Button>
          {onAddAsset && !isDemo && (
            <Button size="sm" onClick={onAddAsset}>
              <Plus className="h-3.5 w-3.5" />
              Add asset
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
