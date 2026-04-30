"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw, Loader2, AlertTriangle, Check } from "lucide-react";
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
type Status = "idle" | "running" | "needs_otp" | "needs_setup" | "success" | "error";

type SourceState = {
  status: Status;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  lastError?: string;
};
type SyncState = { tr: SourceState; nbg: SourceState };

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
  });
  const [otpOpen, setOtpOpen] = useState(false);
  const [otpSource, setOtpSource] = useState<Source>("nbg");
  const [otpValue, setOtpValue] = useState("");
  const [submittingOtp, setSubmittingOtp] = useState(false);
  const [triggering, setTriggering] = useState(false);

  const lastFinishRef = useRef<{ tr?: string; nbg?: string }>({});

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/sync", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as SyncState;
      setState(data);

      // When either source transitions to needs_otp, open the modal.
      const ask = (["tr", "nbg"] as Source[]).find((s) => data[s].status === "needs_otp");
      if (ask && !otpOpen) {
        setOtpSource(ask);
        setOtpValue("");
        setOtpOpen(true);
      }
      if (!ask && otpOpen) {
        // OTP no longer needed (sync moved on) — close.
        setOtpOpen(false);
      }

      // When a source transitions out of running/needs_otp, refresh server data.
      for (const s of ["tr", "nbg"] as Source[]) {
        const f = data[s].finishedAt;
        if (f && f !== lastFinishRef.current[s]) {
          lastFinishRef.current[s] = f;
          if (data[s].status === "success") {
            toast.success(`${s.toUpperCase()} synced`, { description: data[s].message });
          } else if (data[s].status === "error") {
            toast.error(`${s.toUpperCase()} sync failed`, { description: data[s].lastError });
          } else if (data[s].status === "needs_setup") {
            toast.warning(`${s.toUpperCase()} re-auth needed`, { description: data[s].message });
          }
          router.refresh();
        }
      }
    } catch {
      /* swallow */
    }
  }, [otpOpen, router]);

  useEffect(() => {
    fetchState();
    const anyActive = isActive(state.tr.status) || isActive(state.nbg.status);
    const interval = setInterval(fetchState, anyActive ? POLL_FAST_MS : POLL_SLOW_MS);
    return () => clearInterval(interval);
  }, [fetchState, state.tr.status, state.nbg.status]);

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
        // Force a state poll right away so the UI updates immediately.
        setTimeout(fetchState, 500);
      }
    } finally {
      setTriggering(false);
    }
  }, [fetchState]);

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
      setOtpOpen(false);
      setOtpValue("");
      setTimeout(fetchState, 500);
    } finally {
      setSubmittingOtp(false);
    }
  }, [otpSource, otpValue, fetchState]);

  const anyRunning = isActive(state.tr.status) || isActive(state.nbg.status);
  const trErrorish =
    state.tr.status === "error" || state.tr.status === "needs_setup";
  const nbgErrorish = state.nbg.status === "error";

  return (
    <>
      <Button
        size="sm"
        variant={trErrorish || nbgErrorish ? "destructive" : "default"}
        onClick={trigger}
        disabled={triggering || anyRunning}
        title="Sync TR + NBG now"
      >
        {anyRunning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : trErrorish || nbgErrorish ? (
          <AlertTriangle className="h-3.5 w-3.5" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        <span className="hidden sm:inline">
          {anyRunning ? statusLabel(state) : "Sync"}
        </span>
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
                : "Trade Republic — enter OTP"}
            </DialogTitle>
            <DialogDescription>
              {otpSource === "nbg"
                ? "Open Viber on your phone for the 6-digit code, then paste it here."
                : "TR sent a code to your phone — paste it here."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Input
              autoFocus
              type="text"
              inputMode="numeric"
              pattern="\d*"
              autoComplete="one-time-code"
              maxLength={8}
              value={otpValue}
              onChange={(e) => setOtpValue(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitOtp();
              }}
              placeholder="123456"
              className="font-numeric text-center text-lg tracking-[0.4em]"
            />
            <div className="text-xs text-muted-foreground">
              {state[otpSource].message ?? "Waiting…"}
            </div>
          </div>
          <DialogFooter>
            <Button onClick={submitOtp} disabled={submittingOtp || otpValue.length < 4}>
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
  if (s.tr.status === "running" || s.nbg.status === "running") return "Syncing…";
  return "";
}

// re-exported in case other components want to read state without polling
export type { SyncState, SourceState, Status, Source };
