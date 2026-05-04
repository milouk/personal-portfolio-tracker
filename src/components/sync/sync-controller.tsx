"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  RefreshCw,
  Loader2,
  AlertTriangle,
  Check,
  KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

type Source = "tr" | "nbg";
type AnySource = "tr" | "nbg" | "aade-card";
type Status = "idle" | "running" | "needs_otp" | "needs_setup" | "success" | "error";

type SourceState = {
  status: Status;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
};
type SyncState = {
  tr: SourceState;
  nbg: SourceState;
  "aade-card": SourceState;
};

const POLL_FAST_MS = 1500;
const POLL_SLOW_MS = 8000;

function isActive(s: Status): boolean {
  return s === "running" || s === "needs_otp";
}

export function SyncController() {
  const router = useRouter();
  const [state, setState] = useState<SyncState>({
    tr: { status: "idle" },
    nbg: { status: "idle" },
    "aade-card": { status: "idle" },
  });
  const [otpOpen, setOtpOpen] = useState(false);
  const [otpSource, setOtpSource] = useState<Source>("nbg");
  const [otpValue, setOtpValue] = useState("");
  const [submittingOtp, setSubmittingOtp] = useState(false);
  const [triggering, setTriggering] = useState(false);

  const lastFinishRef = useRef<Partial<Record<AnySource, string>>>({});
  // After a manual submit, suppress auto-reopen for a brief window so the
  // sync script has time to consume the OTP file and flip state to running.
  const otpSubmittedAtRef = useRef<number>(0);
  const SUBMIT_SUPPRESS_MS = 4000;
  // Track whether we've auto-triggered setup for the current `needs_setup`
  // streak. We reset this when the source moves to any other state, so the
  // next time it expires we'll trigger again.
  const autoSetupRef = useRef<{ tr: boolean; nbg: boolean }>({
    tr: false,
    nbg: false,
  });
  // One-shot guard so we only auto-sync on the first page load, not on every
  // re-render. Manual sync is wired through the button's `trigger()` callback.
  const autoSyncedRef = useRef(false);

  const triggerSetup = useCallback(
    async (source: Source) => {
      setTriggering(true);
      try {
        const res = await fetch("/api/sync/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ source }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
        };
        if (!res.ok) {
          toast.error(body.error ?? `Re-auth failed (${res.status})`);
        } else {
          toast(`${source.toUpperCase()} re-auth started`, {
            description: "TR is sending a code — watch for the OTP prompt.",
          });
        }
      } finally {
        setTriggering(false);
      }
    },
    []
  );

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/sync", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as SyncState;
      setState(data);
    } catch {
      /* swallow */
    }
  }, []);

  // Hold the latest fetchState in a ref so the polling effect doesn't
  // tear down/recreate the interval on every render.
  const fetchStateRef = useRef(fetchState);
  useEffect(() => {
    fetchStateRef.current = fetchState;
  }, [fetchState]);

  // Polling: fast while a sync is active, slow otherwise.
  const trStatus = state.tr.status;
  const nbgStatus = state.nbg.status;
  const aadeStatus = state["aade-card"].status;
  useEffect(() => {
    void fetchStateRef.current();
    const anyActive =
      isActive(trStatus) || isActive(nbgStatus) || isActive(aadeStatus);
    const interval = setInterval(
      () => void fetchStateRef.current(),
      anyActive ? POLL_FAST_MS : POLL_SLOW_MS
    );
    return () => clearInterval(interval);
  }, [trStatus, nbgStatus, aadeStatus]);

  // React to OTP / setup / completion transitions.
  useEffect(() => {
    const ask = (["tr", "nbg"] as Source[]).find(
      (s) => state[s].status === "needs_otp"
    );
    const sinceSubmit = Date.now() - otpSubmittedAtRef.current;
    const inGrace = sinceSubmit < SUBMIT_SUPPRESS_MS;
    if (ask && !otpOpen && !inGrace) {
      setOtpSource(ask);
      setOtpValue("");
      setOtpOpen(true);
    } else if (!ask && otpOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- legitimate sync with external sync state
      setOtpOpen(false);
    }

    for (const s of ["tr", "nbg"] as Source[]) {
      if (state[s].status === "needs_setup" && !autoSetupRef.current[s]) {
        autoSetupRef.current[s] = true;
        toast.message(`${s.toUpperCase()} session expired`, {
          description: "Reconnecting — check your phone for the code.",
        });
        void triggerSetup(s);
      } else if (state[s].status !== "needs_setup" && autoSetupRef.current[s]) {
        autoSetupRef.current[s] = false;
      }
    }

    for (const s of ["tr", "nbg", "aade-card"] as AnySource[]) {
      const f = state[s].finishedAt;
      if (!f || f === lastFinishRef.current[s]) continue;
      const wasUnset = lastFinishRef.current[s] === undefined;
      lastFinishRef.current[s] = f;
      if (wasUnset) {
        router.refresh();
        continue;
      }
      const label = s === "aade-card" ? "AADE card" : s.toUpperCase();
      if (state[s].status === "success") {
        toast.success(`${label} synced`, { description: state[s].message });
        if (s === "tr" && /re-auth complete/i.test(state[s].message ?? "")) {
          // After successful re-auth, automatically run the actual sync.
          setTimeout(() => {
            void fetch("/api/sync", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ source: "tr" }),
            });
          }, 500);
        }
      } else if (state[s].status === "error") {
        toast.error(`${label} sync failed`, { description: state[s].lastError });
      } else if (state[s].status === "needs_setup") {
        toast.warning(`${label} re-auth needed`, { description: state[s].message });
      }
      router.refresh();
    }
  }, [state, otpOpen, router, triggerSetup]);

  // Auto-sync on first page load if data is stale. Thresholds differ:
  //  - TR: 60s (silent / fast)
  //  - NBG: 5min (slower; triggers Viber OTP prompt — don't fire on every refresh)
  //  - AADE card: 12h (banks report monthly; TaxisNet login is plain
  //               username/password, no OTP, so re-syncs are silent)
  useEffect(() => {
    if (autoSyncedRef.current) return;
    autoSyncedRef.current = true;
    (async () => {
      try {
        const res = await fetch("/api/sync", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as SyncState;
        const isStale = (s: SourceState, thresholdMs: number) => {
          if (s.status === "running" || s.status === "needs_otp" || s.status === "needs_setup") {
            return false;
          }
          if (!s.finishedAt) return true;
          return Date.now() - new Date(s.finishedAt).getTime() > thresholdMs;
        };
        const trStale = isStale(data.tr, 60_000);
        const nbgStale = isStale(data.nbg, 5 * 60_000);
        const aadeStale = isStale(data["aade-card"], 12 * 60 * 60_000);
        if (!trStale && !nbgStale && !aadeStale) return;
        const stale: AnySource[] = [];
        if (trStale) stale.push("tr");
        if (nbgStale) stale.push("nbg");
        if (aadeStale) stale.push("aade-card");
        // Use "all" only when every source is stale; otherwise fire each one
        // individually so a fresh source isn't re-triggered redundantly.
        if (stale.length === 3) {
          await fetch("/api/sync", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ source: "all" }),
          });
        } else {
          await Promise.all(
            stale.map((source) =>
              fetch("/api/sync", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ source }),
              })
            )
          );
        }
        setTimeout(() => void fetchStateRef.current(), 500);
      } catch {
        /* swallow */
      }
    })();
  }, []);

  const trigger = useCallback(async () => {
    setTriggering(true);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "all" }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok) {
        toast.error(body.error ?? `Sync failed (${res.status})`);
      } else {
        toast("Sync started", { description: "Fetching live data…" });
        setTimeout(() => void fetchStateRef.current(), 500);
      }
    } finally {
      setTriggering(false);
    }
  }, []);

  const submitOtp = useCallback(async () => {
    if (!otpValue.trim()) return;
    setSubmittingOtp(true);
    try {
      const res = await fetch("/api/sync/otp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: otpSource, code: otpValue.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok) {
        toast.error(body.error ?? "Failed to submit OTP");
        return;
      }
      toast.success("OTP submitted");
      otpSubmittedAtRef.current = Date.now();
      setOtpOpen(false);
      setOtpValue("");
      setTimeout(() => void fetchStateRef.current(), 500);
    } finally {
      setSubmittingOtp(false);
    }
  }, [otpSource, otpValue]);

  const anyRunning =
    isActive(state.tr.status) ||
    isActive(state.nbg.status) ||
    isActive(state["aade-card"].status);
  const trNeedsSetup = state.tr.status === "needs_setup";
  const trErrored = state.tr.status === "error";
  const nbgErrorish = state.nbg.status === "error";

  let onClick = trigger;
  let label = "Sync";
  let variant: "default" | "destructive" = "default";
  let Icon: React.ComponentType<{ className?: string }> = RefreshCw;

  if (anyRunning) {
    Icon = Loader2;
    label = statusLabel(state) || "Syncing…";
  } else if (trNeedsSetup) {
    onClick = () => triggerSetup("tr");
    variant = "destructive";
    Icon = KeyRound;
    label = "Reconnect TR";
  } else if (trErrored || nbgErrorish) {
    variant = "destructive";
    Icon = AlertTriangle;
    label = "Retry";
  }

  return (
    <>
      <Button
        size="sm"
        variant={variant}
        onClick={onClick}
        disabled={triggering || anyRunning}
        title={
          trNeedsSetup
            ? "TR session expired — click to re-authenticate"
            : "Sync TR + NBG + AADE card-spend now"
        }
      >
        <Icon className={`h-3.5 w-3.5 ${anyRunning ? "animate-spin" : ""}`} />
        <span className="hidden sm:inline">{label}</span>
      </Button>

      <Dialog
        open={otpOpen}
        onOpenChange={(o) => {
          // Don't allow closing while the sync is still waiting for OTP —
          // closing would leave the sync hanging until its timeout.
          if (!o && state[otpSource].status === "needs_otp") return;
          setOtpOpen(o);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {otpSource === "nbg"
                ? "NBG — enter OTP"
                : "Trade Republic — enter code"}
            </DialogTitle>
            <DialogDescription>
              {otpSource === "nbg"
                ? "Open Viber on your phone for the 6-digit code, then paste it here."
                : "TR sent a 4-digit code to your phone (push or SMS). Paste it here."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Input
              autoFocus
              type="text"
              inputMode="numeric"
              pattern="\d*"
              autoComplete="one-time-code"
              maxLength={otpSource === "tr" ? 4 : 8}
              value={otpValue}
              onChange={(e) => setOtpValue(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitOtp();
              }}
              placeholder={otpSource === "tr" ? "1234" : "123456"}
              className="font-numeric text-center text-lg tracking-[0.4em]"
            />
            <div className="text-xs text-muted-foreground">
              {state[otpSource].message ?? "Waiting…"}
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submitOtp}
              disabled={
                submittingOtp ||
                otpValue.length < (otpSource === "tr" ? 4 : 6)
              }
            >
              {submittingOtp ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              Submit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function statusLabel(s: SyncState): string {
  if (s.tr.status === "needs_otp" || s.nbg.status === "needs_otp") return "OTP needed";
  if (
    s.tr.status === "running" ||
    s.nbg.status === "running" ||
    s["aade-card"].status === "running"
  )
    return "Syncing…";
  return "";
}
