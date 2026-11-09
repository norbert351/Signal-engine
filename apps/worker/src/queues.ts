import { Queue } from "bullmq";
import IORedis from "ioredis";
export const connection=new IORedis(process.env.REDIS_URL??"redis://localhost:6379",{maxRetriesPerRequest:null});
export const scanQueue=new Queue("market-scan",{connection});
export const notificationQueue=new Queue("notification-delivery",{connection});
