import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
export const ingestionQueue = new Queue("market-ingestion", { connection });
export const scanQueue = new Queue("market-scan", { connection });
export const paperQueue = new Queue("paper-tracking", { connection });
export const backtestQueue = new Queue("backtests", { connection });
export const notificationQueue = new Queue("notification-delivery", { connection });
export const monitorQueue = new Queue("monitoring", { connection });
