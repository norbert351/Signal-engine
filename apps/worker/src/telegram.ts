import { getDueNotifications, updateNotification } from "@signal-engine/database/scanner-repository";
import { db, notificationOutbox, signals } from "@signal-engine/database";
import { eq } from "drizzle-orm";
import { formatSignalMessage, redactSecretsFromText } from "./format.js";

export type TelegramFailureClassification =
  | "invalid_chat_id"
  | "bot_unauthorized"
  | "bad_request"
  | "rate_limit"
  | "timeout"
  | "server_error"
  | "network_error";

export function classifyTelegramFailure(
  error: unknown,
  statusCode?: number,
  retryAfterSeconds?: number
): {
  message: string;
  classification: TelegramFailureClassification;
  permanent: boolean;
  retryDelayMs: number;
} {
  const raw = error instanceof Error ? error.message : String(error ?? "Telegram delivery error");
  const message = redactSecretsFromText(raw).slice(0, 300);
  const lower = message.toLowerCase();

  if (statusCode === 401 || statusCode === 403 || /unauthorized|forbidden|bot was blocked|bot was kicked|user is deactivated/.test(lower)) {
    return { message, classification: "bot_unauthorized", permanent: true, retryDelayMs: 0 };
  }
  if (
    /chat not found|chat_id is empty|peer_id_invalid|group chat was upgraded|supergroup chat|channel not found/.test(lower)
  ) {
    return { message, classification: "invalid_chat_id", permanent: true, retryDelayMs: 0 };
  }
  if (statusCode === 400 || /can't parse entities|message is too long|message text is empty|bad request/.test(lower)) {
    return { message, classification: "bad_request", permanent: true, retryDelayMs: 0 };
  }
  if (statusCode === 429 || /too many requests|retry after/i.test(lower)) {
    const parsedRetry = retryAfterSeconds ?? Number(lower.match(/retry after (\d+)/)?.[1] ?? "30");
    const delayMs = Math.max(5_000, (Number.isFinite(parsedRetry) ? parsedRetry : 30) * 1000);
    return { message, classification: "rate_limit", permanent: false, retryDelayMs: delayMs };
  }
  if (/timeout|timed out|aborted|etimedout/.test(lower)) {
    return { message, classification: "timeout", permanent: false, retryDelayMs: 10_000 };
  }
  if ((statusCode !== undefined && statusCode >= 500) || /telegram http 5\d\d|bad gateway|service unavailable|gateway timeout/.test(lower)) {
    return { message, classification: "server_error", permanent: false, retryDelayMs: 15_000 };
  }
  return { message, classification: "network_error", permanent: false, retryDelayMs: 10_000 };
}

export function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Telegram delivery error";
  return redactSecretsFromText(raw);
}

export async function enqueuePrivateTestNotification(options: {
  testChatId?: string;
  eventKey?: string;
  label?: string;
} = {}) {
  const destination = (options.testChatId ?? process.env.TELEGRAM_TEST_CHAT_ID ?? "").trim();
  if (!destination) {
    return { enqueued: false as const, reason: "TELEGRAM_TEST_CHAT_ID_not_configured" };
  }
  const mainChats = (process.env.TELEGRAM_CHAT_IDS ?? process.env.TELEGRAM_CHAT_ID ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (mainChats.includes(destination)) {
    throw new Error("Refusing to send test notification to a configured main Telegram chat ID");
  }
  const eventKey = options.eventKey ?? `test:phase5:${Date.now()}:telegram:${destination}`;
  const text = `<b>[TEST ONLY — NOT A TRADING SIGNAL]</b>\nSignal Engine Phase 5 operational readiness test.\nLabel: ${options.label ?? "private-chat-verification"}\nTimestamp: ${new Date().toISOString()}`;
  const [inserted] = await db
    .insert(notificationOutbox)
    .values({
      destination,
      channel: "telegram",
      eventType: "TEST_NOTIFICATION",
      eventKey,
      message: text,
      status: "pending",
      nextAttemptAt: new Date()
    })
    .onConflictDoNothing()
    .returning({ id: notificationOutbox.id });
  return { enqueued: Boolean(inserted), id: inserted?.id ?? null, destination, eventKey };
}

export async function deliverPending() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) return { delivered: 0, failed: 0, retried: 0, skipped: "TELEGRAM_BOT_TOKEN_missing" };
  const pending = await getDueNotifications();
  let delivered = 0;
  let failed = 0;
  let retried = 0;

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
      await updateNotification(item.id, {
        status: "failed",
        attempts: item.attempts + 1,
        lastError: "[bad_request] Notification has no message and no signal record"
      });
      failed += 1;
      continue;
    }

    let statusCode: number | undefined;
    let retryAfterSeconds: number | undefined;
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: item.destination, text: message, parse_mode: "HTML", disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000)
      });
      statusCode = response.status;
      const payload = (await response.json().catch(() => ({ ok: false }))) as {
        ok?: boolean;
        result?: { message_id: number };
        description?: string;
        parameters?: { retry_after?: number };
      };
      retryAfterSeconds = payload.parameters?.retry_after;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.description ? `Telegram HTTP ${response.status}: ${payload.description}` : `Telegram HTTP ${response.status}`);
      }
      await updateNotification(item.id, {
        status: "delivered",
        attempts: item.attempts + 1,
        deliveredAt: new Date(),
        providerMessageId: String(payload.result?.message_id ?? ""),
        message
      });
      delivered += 1;
    } catch (error) {
      const attempts = item.attempts + 1;
      const classified = classifyTelegramFailure(error, statusCode, retryAfterSeconds);
      const exhausted = classified.permanent || attempts >= 8;
      const backoffMs =
        classified.classification === "rate_limit"
          ? classified.retryDelayMs
          : Math.min(60 * 60_000, Math.max(classified.retryDelayMs, 2 ** attempts * 5000));
      await updateNotification(item.id, {
        status: exhausted ? "failed" : "pending",
        attempts,
        nextAttemptAt: new Date(Date.now() + backoffMs),
        lastError: `[${classified.classification}] ${classified.message}`,
        message
      });
      if (exhausted) failed += 1;
      else retried += 1;
    }
  }
  return { delivered, failed, retried, checked: pending.length };
}
