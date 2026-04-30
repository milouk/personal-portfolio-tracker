"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";

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

export function PrivacyProvider({ children }: { children: React.ReactNode }) {
  const [hidden, setHidden] = useState(false);

  // Read persisted preference on mount; mirror to <html data-private="1|0">.
  useEffect(() => {
    const v = localStorage.getItem(STORAGE_KEY) === "1";
    setHidden(v);
    document.documentElement.dataset.private = v ? "1" : "0";
  }, []);

  const set = useCallback((next: boolean) => {
    setHidden(next);
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
    document.documentElement.dataset.private = next ? "1" : "0";
  }, []);

  const toggle = useCallback(() => set(!hidden), [hidden, set]);

  // Allow toggling with `Cmd/Ctrl + .` for quick screenshots.
  useEffect(() => {
    function handle(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        set(!hidden);
      }
    }
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [hidden, set]);

  return (
    <PrivacyContext.Provider value={{ hidden, toggle, set }}>
      {children}
    </PrivacyContext.Provider>
  );
}

export function usePrivacy() {
  return useContext(PrivacyContext);
}
