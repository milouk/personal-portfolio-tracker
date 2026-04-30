"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";

type PrivacyContextValue = {
  hidden: boolean;
  toggle: () => void;
  set: (next: boolean) => void;
};

const PrivacyContext = createContext<PrivacyContextValue>({
  hidden: false,
  toggle: () => {},
  set: () => {},
});

const STORAGE_KEY = "portfolio.privacy.hidden";

const listeners = new Set<() => void>();
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function readSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(STORAGE_KEY) === "1";
}
function readServerSnapshot(): boolean {
  return false;
}
function writeHidden(next: boolean) {
  localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  document.documentElement.dataset.private = next ? "1" : "0";
  for (const l of listeners) l();
}

export function PrivacyProvider({ children }: { children: React.ReactNode }) {
  const hidden = useSyncExternalStore(subscribe, readSnapshot, readServerSnapshot);

  // Mirror to <html data-private> whenever the snapshot changes (e.g. after
  // an external update like another tab toggling localStorage).
  useEffect(() => {
    document.documentElement.dataset.private = hidden ? "1" : "0";
  }, [hidden]);

  const set = useCallback((next: boolean) => writeHidden(next), []);
  const toggle = useCallback(() => writeHidden(!readSnapshot()), []);

  // Allow toggling with `Cmd/Ctrl + .` for quick screenshots.
  useEffect(() => {
    function handle(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [toggle]);

  return (
    <PrivacyContext.Provider value={{ hidden, toggle, set }}>
      {children}
    </PrivacyContext.Provider>
  );
}

export function usePrivacy() {
  return useContext(PrivacyContext);
}
