import { getDueNotifications, updateNotification } from "@signal-engine/database/scanner-repository";
import { db } from "@signal-engine/database";
import { eq } from "drizzle-orm";
import { signals } from "@signal-engine/database";
import { formatSignalMessage } from "./format.js";

const token = process.env.TELEGRAM_BOT_TOKEN;

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Telegram delivery error";
  return token ? raw.replaceAll(token, "[redacted]") : raw;
}

export async function deliverPending() {
  if (!token) return { delivered: 0, skipped: "TELEGRAM_BOT_TOKEN_missing" };
  const pending = await getDueNotifications();
  let delivered = 0;

  for (const item of pending) {
    let message = item.message;
    if (!message && item.signalId) {
      const [signal] = await db.select().from(signals).where(eq(signals.id, item.signalId)).limit(1);
      if (signal) {
        message = formatSignalMessage({
          symbol: signal.symbol,
          market: signal.market,
          direction: signal.direction,
          timeframe: signal.timeframe,
          tradingStyle: signal.tradingStyle,
          confirmationTimeframe: signal.confirmationTimeframe,
          strategyName: signal.strategyKey,
          entry: Number(signal.entryMin),
          stop: Number(signal.stopLoss),
          targets: signal.targets as Array<{ price: string; allocationPct?: number }>,
          rewardRisk: signal.rewardRisk,
          qualityScore: signal.qualityScore,
          rationale: signal.rationale as string[],
          invalidation: signal.invalidationConditions,
          expiresAt: signal.expiresAt
        });
      }
    }
    if (!message) {
      await updateNotification(item.id, { status: "failed", attempts: item.attempts + 1, lastError: "Notification has no message and no signal record" });
      continue;
    }

    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: item.destination, text: message, parse_mode: "HTML", disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000)
      });
      const payload = (await response.json()) as { ok: boolean; result?: { message_id: number }; description?: string };
      if (!response.ok || !payload.ok) throw new Error(payload.description ?? `Telegram HTTP ${response.status}`);
      await updateNotification(item.id, { status: "delivered", attempts: item.attempts + 1, deliveredAt: new Date(), providerMessageId: String(payload.result?.message_id ?? ""), message });
      delivered += 1;
    } catch (error) {
      const attempts = item.attempts + 1;
      const exhausted = attempts >= 8;
      const delay = Math.min(60 * 60_000, 2 ** attempts * 5000);
      await updateNotification(item.id, { status: exhausted ? "failed" : "pending", attempts, nextAttemptAt: new Date(Date.now() + delay), lastError: safeError(error), message });
    }
  }
  return { delivered, checked: pending.length };
}
