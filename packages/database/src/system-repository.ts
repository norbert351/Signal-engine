import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne } from "drizzle-orm";
import { db, sql } from "./index.js";
import { notificationOutbox, signals, systemAlerts, systemHealth } from "./schema.js";

export type HealthStatus = "ok" | "degraded" | "error";

export async function recordHealth(component: string, status: HealthStatus, details: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(systemHealth)
    .values({ component, status, details, checkedAt: new Date() })
    .onConflictDoUpdate({
      target: systemHealth.component,
      set: { status, details, checkedAt: new Date() }
    })
    .returning();
  return row;
}

export async function listHealth() {
  return db.select().from(systemHealth).orderBy(systemHealth.component);
}

export async function upsertAlert(input: {
  component: string;
  severity?: "info" | "warning" | "critical";
  dedupeKey: string;
  message: string;
}): Promise<{ isNew: boolean; alert: typeof systemAlerts.$inferSelect }> {
  const now = new Date();
  const [existing] = await db.select().from(systemAlerts).where(eq(systemAlerts.dedupeKey, input.dedupeKey)).limit(1);
  if (!existing) {
    const [created] = await db
      .insert(systemAlerts)
      .values({
        component: input.component,
        severity: input.severity ?? "warning",
        dedupeKey: input.dedupeKey,
        message: input.message,
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now
      })
      .returning();
    if (!created) throw new Error("Unable to create alert");
    return { isNew: true, alert: created };
  }
  const reopened = existing.resolvedAt !== null;
  const [updated] = await db
    .update(systemAlerts)
    .set({
      message: input.message,
      severity: input.severity ?? existing.severity,
      lastSeenAt: now,
      ...(reopened ? { resolvedAt: null, firstSeenAt: now, count: 1 } : { count: existing.count + 1 })
    })
    .where(eq(systemAlerts.id, existing.id))
    .returning();
  return { isNew: reopened, alert: updated ?? existing };
}

export async function resolveAlert(dedupeKey: string): Promise<typeof systemAlerts.$inferSelect | undefined> {
  const [resolved] = await db
    .update(systemAlerts)
    .set({ resolvedAt: new Date() })
    .where(and(eq(systemAlerts.dedupeKey, dedupeKey), isNull(systemAlerts.resolvedAt)))
    .returning();
  return resolved;
}

export async function resolveStaleAlerts(component: string, activeKeys: string[]): Promise<Array<typeof systemAlerts.$inferSelect>> {
  const rows = await db
    .select()
    .from(systemAlerts)
    .where(and(eq(systemAlerts.component, component), isNull(systemAlerts.resolvedAt)));
  const resolved: Array<typeof systemAlerts.$inferSelect> = [];
  for (const row of rows) {
    if (activeKeys.includes(row.dedupeKey)) continue;
    const [updated] = await db.update(systemAlerts).set({ resolvedAt: new Date() }).where(eq(systemAlerts.id, row.id)).returning();
    if (updated) resolved.push(updated);
  }
  return resolved;
}

export async function listAlerts(limit = 100, includeResolved = false) {
  const bounded = Math.min(Math.max(limit, 1), 500);
  if (includeResolved) {
    return db.select().from(systemAlerts).orderBy(desc(systemAlerts.lastSeenAt)).limit(bounded);
  }
  return db
    .select()
    .from(systemAlerts)
    .where(isNull(systemAlerts.resolvedAt))
    .orderBy(desc(systemAlerts.lastSeenAt))
    .limit(bounded);
}

export async function candleFreshness() {
  return sql<
    Array<{ provider: string; symbol: string; market: string; timeframe: string; latest: Date | null; candles: number }>
  >`
    SELECT i.provider, i.symbol, i.market, tf.timeframe, max(c.close_time) AS latest, count(c.id)::int AS candles
    FROM instruments i
    CROSS JOIN (VALUES ('1m'),('5m'),('15m'),('1h'),('4h'),('1d')) AS tf(timeframe)
    LEFT JOIN market_candles c ON c.instrument_id = i.id AND c.timeframe = tf.timeframe AND c.is_complete = true
    WHERE i.enabled = true
    GROUP BY i.provider, i.symbol, i.market, tf.timeframe
    ORDER BY i.provider, i.symbol, tf.timeframe
  `;
}

export async function notificationBacklog() {
  const rows = await sql<Array<{ status: string; count: number }>>`
    SELECT status, count(*)::int AS count FROM notification_deliveries GROUP BY status
  `;
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = Number(row.count);
  return counts;
}

export async function backfillSummary(limit = 50) {
  const rows = await sql<Array<Record<string, unknown>>>`
    SELECT id, provider, symbol, timeframe, start_time, end_time, cursor_time, status,
           candles_seen, candles_written, last_error, updated_at
    FROM backfill_progress
    ORDER BY updated_at DESC
    LIMIT ${Math.min(Math.max(limit, 1), 500)}
  `;
  const counts = await sql<Array<{ status: string; count: number }>>`
    SELECT status, count(*)::int AS count FROM backfill_progress GROUP BY status
  `;
  return { data: rows, counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])) };
}

export async function latestComponentHealth(component: string) {
  const [row] = await db.select().from(systemHealth).where(eq(systemHealth.component, component)).limit(1);
  return row;
}

export async function applyRetention(options: { deliveredNotificationDays?: number; resolvedAlertDays?: number } = {}) {
  const deliveredDays = options.deliveredNotificationDays ?? 14;
  const alertDays = options.resolvedAlertDays ?? 30;
  const notificationCutoff = new Date(Date.now() - deliveredDays * 86_400_000);
  const alertCutoff = new Date(Date.now() - alertDays * 86_400_000);
  const deletedNotifications = await db
    .delete(notificationOutbox)
    .where(and(eq(notificationOutbox.status, "delivered"), lt(notificationOutbox.createdAt, notificationCutoff)))
    .returning({ id: notificationOutbox.id });
  const deletedAlerts = await db
    .delete(systemAlerts)
    .where(and(isNotNull(systemAlerts.resolvedAt), lt(systemAlerts.resolvedAt, alertCutoff)))
    .returning({ id: systemAlerts.id });
  return { deletedNotifications: deletedNotifications.length, deletedAlerts: deletedAlerts.length };
}

export async function openSignalConflicts(symbol: string, timeframe: string, direction: string, since: Date) {
  return db
    .select({ id: signals.id, direction: signals.direction, publishedAt: signals.publishedAt })
    .from(signals)
    .where(
      and(
        eq(signals.symbol, symbol),
        eq(signals.timeframe, timeframe),
        ne(signals.direction, direction),
        gte(signals.publishedAt, since),
        inArray(signals.status, ["PENDING", "ACTIVE", "PARTIALLY_FILLED", "TARGET_1_HIT"])
      )
    )
    .limit(1);
}
