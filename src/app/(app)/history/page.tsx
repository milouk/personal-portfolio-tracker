import { readEvents } from "@/lib/storage/portfolio";
import {
  readTrTransactions,
  summariseTransactions,
} from "@/lib/storage/transactions";
import { HistoryView } from "@/components/history/history-view";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const [events, trTxns] = await Promise.all([
    readEvents(),
    readTrTransactions(),
  ]);
  const trStats = summariseTransactions(trTxns);
  return <HistoryView events={events} trTxns={trTxns} trStats={trStats} />;
}
