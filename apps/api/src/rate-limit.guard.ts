import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";

type Bucket = { count: number; resetAt: number };

const WINDOW_MS = 60_000;
const LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE ?? "120");
const buckets = new Map<string, Bucket>();

function clientKey(request: { ip?: string; socket?: { remoteAddress?: string }; headers?: Record<string, string | string[] | undefined> }): string {
  const forwarded = request.headers?.["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return (first?.trim() || request.ip || request.socket?.remoteAddress || "unknown").slice(0, 64);
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (!Number.isFinite(LIMIT) || LIMIT <= 0) return true;
    const request = context.switchToHttp().getRequest<Parameters<typeof clientKey>[0] & { url?: string }>();
    if (request.url?.startsWith("/api/v1/health")) return true;
    const now = Date.now();
    if (buckets.size > 20_000) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
    }
    const key = clientKey(request);
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return true;
    }
    bucket.count += 1;
    if (bucket.count > LIMIT) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      throw new HttpException({ statusCode: HttpStatus.TOO_MANY_REQUESTS, message: "Too many requests", retryAfter }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
