"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  AssetInput,
  createAsset,
  deleteAsset,
  updateAsset,
} from "./storage/portfolio";
import { IS_DEMO } from "./storage/paths";
import type { Asset } from "./types";

function refuseInDemo() {
  if (IS_DEMO) {
    throw new Error("Demo mode is read-only — fork the repo to edit your own data.");
  }
}

const CurrencyEnum = z.enum(["EUR", "USD"]);
const TypeEnum = z.enum([
  "tbill",
  "bond",
  "etf",
  "stock",
  "crypto",
  "cash",
  "interest_account",
  "deposit",
  "card",
]);
const SourceEnum = z.enum([
  "greek-tbills",
  "trade-republic",
  "nbg",
  "interest",
  "cash",
  "other",
]);

const AssetSchema = z.object({
  name: z.string().min(1),
  type: TypeEnum,
  source: SourceEnum,
  currency: CurrencyEnum,
  ticker: z.string().optional(),
  coingeckoId: z.string().optional(),
  isin: z.string().optional(),
  iban: z.string().optional(),
  accountNumber: z.string().optional(),
  cardLast4: z.string().optional(),
  cardNetwork: z.enum(["visa", "mastercard", "maestro", "amex", "other"]).optional(),
  cardExpiry: z.string().optional(),
  cardActive: z.boolean().optional(),
  quantity: z.number().nonnegative().optional(),
  costBasis: z.number().nonnegative().optional(),
  amount: z.number().optional(),
  rate: z.number().optional(),
  rateSource: z.enum(["ecb-dfr"]).optional(),
  faceValue: z.number().optional(),
  purchasePrice: z.number().optional(),
  issueDate: z.string().optional(),
  maturityDate: z.string().optional(),
  couponRate: z.number().optional(),
  couponFrequency: z.number().optional(),
  marketValueOverride: z.number().optional(),
  manualPrice: z.number().optional(),
  notes: z.string().optional(),
});

function clean<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === "") continue;
    out[k] = v;
  }
  return out as T;
}

export async function createAssetAction(input: unknown) {
  refuseInDemo();
  const parsed = AssetSchema.parse(input);
  const cleaned = clean(parsed) as AssetInput;
  const created = await createAsset(cleaned);
  revalidatePath("/", "layout");
  return created;
}

export async function updateAssetAction(id: string, patch: unknown) {
  refuseInDemo();
  const parsed = AssetSchema.partial().parse(patch);
  const cleaned = clean(parsed) as Partial<Asset>;
  const updated = await updateAsset(id, cleaned);
  revalidatePath("/", "layout");
  return updated;
}

export async function deleteAssetAction(id: string) {
  refuseInDemo();
  const ok = await deleteAsset(id);
  revalidatePath("/", "layout");
  return ok;
}
