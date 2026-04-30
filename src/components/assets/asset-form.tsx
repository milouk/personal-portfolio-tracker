"use client";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ASSET_TYPE_LABEL,
  SOURCE_LABEL,
  SOURCE_ORDER,
  type Asset,
  type AssetSource,
  type AssetType,
} from "@/lib/types";
import {
  createAssetAction,
  deleteAssetAction,
  updateAssetAction,
} from "@/lib/actions";
import { cn } from "@/lib/utils";

type FormData = Partial<Omit<Asset, "id" | "createdAt" | "updatedAt">>;

const TYPE_PRESETS: AssetType[] = [
  "etf",
  "stock",
  "crypto",
  "tbill",
  "bond",
  "interest_account",
  "deposit",
  "cash",
];

const TYPE_FIELDS: Record<AssetType, Set<keyof FormData>> = {
  etf: new Set(["ticker", "isin", "quantity", "costBasis", "manualPrice"]),
  stock: new Set(["ticker", "isin", "quantity", "costBasis", "manualPrice"]),
  crypto: new Set(["ticker", "coingeckoId", "quantity", "costBasis", "manualPrice"]),
  tbill: new Set([
    "faceValue",
    "purchasePrice",
    "issueDate",
    "maturityDate",
    "marketValueOverride",
  ]),
  bond: new Set([
    "faceValue",
    "purchasePrice",
    "couponRate",
    "couponFrequency",
    "issueDate",
    "maturityDate",
    "marketValueOverride",
  ]),
  interest_account: new Set(["amount", "rate", "rateSource"]),
  deposit: new Set(["amount"]),
  cash: new Set(["amount"]),
};

export function AssetForm({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initial?: Asset;
}) {
  const editing = !!initial;
  const [pending, startTransition] = useTransition();
  const [data, setData] = useState<FormData>(() =>
    initial
      ? { ...initial }
      : {
          type: "etf",
          source: "trade-republic",
          currency: "EUR",
        }
  );

  useEffect(() => {
    if (open) {
      setData(
        initial
          ? { ...initial }
          : {
              type: "etf",
              source: "trade-republic",
              currency: "EUR",
            }
      );
    }
  }, [open, initial]);

  const fields = TYPE_FIELDS[data.type as AssetType] ?? new Set();
  const has = (k: keyof FormData) => fields.has(k);
  const setField = <K extends keyof FormData>(k: K, v: FormData[K]) =>
    setData((d) => ({ ...d, [k]: v }));

  function submit() {
    if (!data.name) {
      toast.error("Name is required");
      return;
    }
    startTransition(async () => {
      try {
        if (editing && initial) {
          await updateAssetAction(initial.id, data);
          toast.success("Asset updated");
        } else {
          await createAssetAction(data);
          toast.success("Asset added");
        }
        onOpenChange(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save");
      }
    });
  }

  function remove() {
    if (!initial) return;
    if (!confirm("Delete this asset?")) return;
    startTransition(async () => {
      await deleteAssetAction(initial.id);
      toast.success("Asset deleted");
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit asset" : "Add asset"}</DialogTitle>
          <DialogDescription>
            Live pricing pulls from Yahoo Finance (ETFs/stocks) and CoinGecko
            (crypto). Set a manual price to override.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <Field label="Type">
            <div className="flex flex-wrap gap-1.5">
              {TYPE_PRESETS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setField("type", t)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs",
                    data.type === t
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary"
                  )}
                >
                  {ASSET_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input
                value={data.name ?? ""}
                onChange={(e) => setField("name", e.target.value)}
                placeholder="e.g. iShares Core MSCI World"
              />
            </Field>
            <Field label="Source">
              <Select
                value={data.source}
                onValueChange={(v) => setField("source", v as AssetSource)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCE_ORDER.map((s) => (
                    <SelectItem key={s} value={s}>
                      {SOURCE_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Currency">
              <Tabs
                value={data.currency}
                onValueChange={(v) => setField("currency", v as "EUR" | "USD")}
              >
                <TabsList className="w-full">
                  <TabsTrigger value="EUR" className="flex-1">EUR</TabsTrigger>
                  <TabsTrigger value="USD" className="flex-1">USD</TabsTrigger>
                </TabsList>
              </Tabs>
            </Field>

            {has("ticker") && (
              <Field label="Ticker">
                <Input
                  value={data.ticker ?? ""}
                  onChange={(e) =>
                    setField("ticker", e.target.value.toUpperCase())
                  }
                  placeholder="VWCE.DE / BTC / AAPL"
                  className="font-numeric"
                />
              </Field>
            )}
          </div>

          {(has("isin") || has("coingeckoId")) && (
            <div className="grid grid-cols-2 gap-3">
              {has("isin") && (
                <Field label="ISIN" optional>
                  <Input
                    value={data.isin ?? ""}
                    onChange={(e) =>
                      setField("isin", e.target.value.toUpperCase())
                    }
                    placeholder="IE00BK5BQT80"
                    className="font-numeric"
                  />
                </Field>
              )}
              {has("coingeckoId") && (
                <Field label="CoinGecko ID" optional>
                  <Input
                    value={data.coingeckoId ?? ""}
                    onChange={(e) => setField("coingeckoId", e.target.value)}
                    placeholder="bitcoin (auto-resolved if empty)"
                  />
                </Field>
              )}
            </div>
          )}

          {(has("quantity") || has("costBasis")) && (
            <div className="grid grid-cols-2 gap-3">
              {has("quantity") && (
                <Field label="Quantity">
                  <Input
                    type="number"
                    step="any"
                    value={data.quantity ?? ""}
                    onChange={(e) =>
                      setField(
                        "quantity",
                        e.target.value === "" ? undefined : parseFloat(e.target.value)
                      )
                    }
                    className="font-numeric"
                  />
                </Field>
              )}
              {has("costBasis") && (
                <Field label="Total cost basis" optional>
                  <Input
                    type="number"
                    step="any"
                    value={data.costBasis ?? ""}
                    onChange={(e) =>
                      setField(
                        "costBasis",
                        e.target.value === "" ? undefined : parseFloat(e.target.value)
                      )
                    }
                    className="font-numeric"
                    placeholder="for P/L"
                  />
                </Field>
              )}
            </div>
          )}

          {has("manualPrice") && (
            <Field label="Manual price override" optional>
              <Input
                type="number"
                step="any"
                value={data.manualPrice ?? ""}
                onChange={(e) =>
                  setField(
                    "manualPrice",
                    e.target.value === "" ? undefined : parseFloat(e.target.value)
                  )
                }
                placeholder="leave empty to use live price"
                className="font-numeric"
              />
            </Field>
          )}

          {has("amount") && (
            <Field label="Amount">
              <Input
                type="number"
                step="any"
                value={data.amount ?? ""}
                onChange={(e) =>
                  setField(
                    "amount",
                    e.target.value === "" ? undefined : parseFloat(e.target.value)
                  )
                }
                className="font-numeric"
              />
            </Field>
          )}

          {has("rateSource") && (
            <Field label="Rate source">
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => setField("rateSource", undefined)}
                  className={cn(
                    "flex-1 rounded-md border px-2.5 py-1.5 text-xs",
                    !data.rateSource
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary"
                  )}
                >
                  Fixed rate
                </button>
                <button
                  type="button"
                  onClick={() => setField("rateSource", "ecb-dfr")}
                  className={cn(
                    "flex-1 rounded-md border px-2.5 py-1.5 text-xs",
                    data.rateSource === "ecb-dfr"
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-secondary/40 text-muted-foreground hover:bg-secondary"
                  )}
                >
                  Live · ECB Deposit Facility
                </button>
              </div>
            </Field>
          )}

          {has("rate") && data.rateSource !== "ecb-dfr" && (
            <Field label="Annual rate (decimal, 0.025 = 2.5%)">
              <Input
                type="number"
                step="any"
                value={data.rate ?? ""}
                onChange={(e) =>
                  setField(
                    "rate",
                    e.target.value === "" ? undefined : parseFloat(e.target.value)
                  )
                }
                className="font-numeric"
              />
            </Field>
          )}

          {(has("faceValue") || has("purchasePrice")) && (
            <div className="grid grid-cols-2 gap-3">
              {has("faceValue") && (
                <Field label="Face value">
                  <Input
                    type="number"
                    step="any"
                    value={data.faceValue ?? ""}
                    onChange={(e) =>
                      setField(
                        "faceValue",
                        e.target.value === "" ? undefined : parseFloat(e.target.value)
                      )
                    }
                    className="font-numeric"
                  />
                </Field>
              )}
              {has("purchasePrice") && (
                <Field label="Purchase price">
                  <Input
                    type="number"
                    step="any"
                    value={data.purchasePrice ?? ""}
                    onChange={(e) =>
                      setField(
                        "purchasePrice",
                        e.target.value === "" ? undefined : parseFloat(e.target.value)
                      )
                    }
                    className="font-numeric"
                  />
                </Field>
              )}
            </div>
          )}

          {has("couponRate") && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Coupon rate (decimal)">
                <Input
                  type="number"
                  step="any"
                  value={data.couponRate ?? ""}
                  onChange={(e) =>
                    setField(
                      "couponRate",
                      e.target.value === "" ? undefined : parseFloat(e.target.value)
                    )
                  }
                  className="font-numeric"
                />
              </Field>
              <Field label="Coupons / year" optional>
                <Input
                  type="number"
                  step="1"
                  value={data.couponFrequency ?? ""}
                  onChange={(e) =>
                    setField(
                      "couponFrequency",
                      e.target.value === "" ? undefined : parseFloat(e.target.value)
                    )
                  }
                  className="font-numeric"
                />
              </Field>
            </div>
          )}

          {(has("issueDate") || has("maturityDate")) && (
            <div className="grid grid-cols-2 gap-3">
              {has("issueDate") && (
                <Field label="Issue date" optional>
                  <Input
                    type="date"
                    value={data.issueDate ?? ""}
                    onChange={(e) => setField("issueDate", e.target.value)}
                  />
                </Field>
              )}
              {has("maturityDate") && (
                <Field label="Maturity date">
                  <Input
                    type="date"
                    value={data.maturityDate ?? ""}
                    onChange={(e) => setField("maturityDate", e.target.value)}
                  />
                </Field>
              )}
            </div>
          )}

          {has("marketValueOverride") && (
            <Field label="Market value override" optional>
              <Input
                type="number"
                step="any"
                value={data.marketValueOverride ?? ""}
                onChange={(e) =>
                  setField(
                    "marketValueOverride",
                    e.target.value === "" ? undefined : parseFloat(e.target.value)
                  )
                }
                placeholder="otherwise estimated"
                className="font-numeric"
              />
            </Field>
          )}
        </div>

        <DialogFooter className="flex justify-between sm:justify-between">
          <div>
            {editing && (
              <Button variant="ghost" onClick={remove} disabled={pending}>
                Delete
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button onClick={submit} disabled={pending}>
              {editing ? "Save changes" : "Add asset"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
  optional,
}: {
  label: string;
  children: React.ReactNode;
  optional?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
        {optional && (
          <span className="ml-1 text-muted-foreground/70">(optional)</span>
        )}
      </Label>
      {children}
    </div>
  );
}
