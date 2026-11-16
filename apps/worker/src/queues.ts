import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const queueOptions = { connection, streams: { events: { maxLen: 1000 } } } as const;

export const ingestionQueue = new Queue("market-ingestion", queueOptions);
export const scanQueue = new Queue("market-scan", queueOptions);
export const paperQueue = new Queue("paper-tracking", queueOptions);
export const backtestQueue = new Queue("backtests", queueOptions);
export const notificationQueue = new Queue("notification-delivery", queueOptions);
export const monitorQueue = new Queue("monitoring", queueOptions);

const intelligenceQueueOptions = {
  connection,
  streams: { events: { maxLen: 1000 } },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 500
  }
};

export const newsIngestionQueue = new Queue("news-ingestion", intelligenceQueueOptions);
export const newsNormalizationQueue = new Queue("news-normalization", intelligenceQueueOptions);
export const newsAnalysisQueue = new Queue("news-analysis", intelligenceQueueOptions);
export const eventCalendarSyncQueue = new Queue("event-calendar-sync", intelligenceQueueOptions);
export const eventMonitoringQueue = new Queue("event-monitoring", intelligenceQueueOptions);
export const eventImpactAnalysisQueue = new Queue("event-impact-analysis", intelligenceQueueOptions);
export const eventTradingAnalysisQueue = new Queue("event-trading-analysis", intelligenceQueueOptions);
export const aiReasoningQueue = new Queue("ai-reasoning", intelligenceQueueOptions);
export const intelligenceReportingQueue = new Queue("intelligence-reporting", intelligenceQueueOptions);

export const ALL_INTELLIGENCE_QUEUES = [
  ["news-ingestion", newsIngestionQueue],
  ["news-normalization", newsNormalizationQueue],
  ["news-analysis", newsAnalysisQueue],
  ["event-calendar-sync", eventCalendarSyncQueue],
  ["event-monitoring", eventMonitoringQueue],
  ["event-impact-analysis", eventImpactAnalysisQueue],
  ["event-trading-analysis", eventTradingAnalysisQueue],
  ["ai-reasoning", aiReasoningQueue],
  ["intelligence-reporting", intelligenceReportingQueue]
] as const;
