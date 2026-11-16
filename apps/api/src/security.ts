import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";

export function redactSensitiveText(value: string): string {
  let out = value
    .replace(/bot\d+:[A-Za-z0-9_-]{10,}/gi, "bot[redacted]")
    .replace(/([?&](?:apikey|api_key|token|password|secret|x-admin-api-key)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/((?:postgres(?:ql)?|redis|rediss):\/\/[^:\s/@]+:)[^@\s"']+(@)/gi, "$1[redacted]$2");
  const envSecrets = [
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.TWELVE_DATA_API_KEY,
    process.env.ADMIN_API_KEY,
    process.env.POSTGRES_PASSWORD
  ];
  for (const secret of envSecrets) {
    if (secret && secret.trim().length >= 4 && secret !== "replace-with-a-strong-password") {
      out = out.replaceAll(secret, "[redacted]");
    }
  }
  return out;
}

export function sanitizeErrorPayload(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeErrorPayload(item));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === "stack" || key === "sql" || key === "parameters") continue;
      out[key] = sanitizeErrorPayload(item);
    }
    return out;
  }
  return value;
}

@Catch()
export class SafeExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<{
      status?: (code: number) => { json?: (body: unknown) => void };
      setHeader?: (name: string, value: string) => void;
    }>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const body =
        typeof raw === "string"
          ? { statusCode: status, message: redactSensitiveText(raw) }
          : (sanitizeErrorPayload(raw) as Record<string, unknown>);
      if (status === HttpStatus.TOO_MANY_REQUESTS && typeof body.retryAfter === "number") {
        response.setHeader?.("Retry-After", String(body.retryAfter));
      }
      response.status?.(status)?.json?.(body);
      return;
    }

    const message = exception instanceof Error ? redactSensitiveText(exception.message) : "Unexpected error";
    console.error("Unhandled API exception:", message);
    response.status?.(HttpStatus.INTERNAL_SERVER_ERROR)?.json?.({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: "Internal Server Error",
      message: "Internal server error"
    });
  }
}

export function securityHeadersMiddleware(
  req: { url?: string },
  res: { setHeader?: (name: string, value: string) => void },
  next: () => void
) {
  res.setHeader?.("X-Content-Type-Options", "nosniff");
  res.setHeader?.("X-Frame-Options", "DENY");
  res.setHeader?.("Referrer-Policy", "no-referrer");
  res.setHeader?.("X-Permitted-Cross-Domain-Policies", "none");
  const url = req.url ?? "";
  if (!url.startsWith("/api/v1/openapi.json") && !url.startsWith("/api/v1/docs")) {
    res.setHeader?.("Cache-Control", "no-store");
  }
  next();
}
