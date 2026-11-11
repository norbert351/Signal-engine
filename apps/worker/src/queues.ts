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
