import { ExecutionContext, HttpException, HttpStatus, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  sqlTag: vi.fn(async () => [{ "?column?": 1 }])
}));

vi.mock("@signal-engine/database", () => ({
  sql: Object.assign(dbMocks.sqlTag, { end: vi.fn(async () => undefined) })
}));

import { AdminGuard } from "./admin.guard.js";
import { HealthController } from "./health.controller.js";
import { RateLimitGuard } from "./rate-limit.guard.js";
import { SafeExceptionFilter, redactSensitiveText, sanitizeErrorPayload, securityHeadersMiddleware } from "./security.js";
import { computeOverallSystemHealth } from "./system.controller.js";

function mockHttpContext(req: Record<string, unknown>, res: Record<string, unknown> = {}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res
    })
  } as unknown as ExecutionContext;
}

describe("Phase 5 API operational security, recovery, and health transitions", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    dbMocks.sqlTag.mockReset().mockResolvedValue([{ "?column?": 1 }]);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("reports API database unavailability with 503 and recovers when PostgreSQL returns", async () => {
    const controller = new HealthController();
    dbMocks.sqlTag.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
    await expect(controller.getHealth()).rejects.toBeInstanceOf(ServiceUnavailableException);

    const recovered = await controller.getHealth();
    expect(recovered.status).toBe("ok");
    expect(recovered.database).toBe("ok");
    expect(recovered.tradingExecution).toBe(false);
  });

  it("distinguishes healthy, degraded, and unhealthy system health states", () => {
    const now = Date.now();
    const fresh = new Date(now - 10_000);
    const staleDate = new Date(now - 2_000_000);

    expect(computeOverallSystemHealth([], now, 900_000)).toMatchObject({
      status: "degraded",
      healthState: "degraded",
      reason: "no_monitoring_records_yet"
    });

    const healthyRows = [
      { component: "database", status: "ok", checkedAt: fresh },
      { component: "redis", status: "ok", checkedAt: fresh },
      { component: "worker-heartbeats", status: "ok", checkedAt: fresh },
      { component: "scanner", status: "ok", checkedAt: fresh }
    ];
    expect(computeOverallSystemHealth(healthyRows, now, 900_000)).toMatchObject({
      status: "ok",
      healthState: "healthy"
    });

    const degradedRows = [
      ...healthyRows,
      { component: "provider:twelve_data", status: "degraded", checkedAt: fresh }
    ];
    expect(computeOverallSystemHealth(degradedRows, now, 900_000)).toMatchObject({
      status: "degraded",
      healthState: "degraded"
    });

    const staleCriticalRows = [
      { component: "database", status: "ok", checkedAt: fresh },
      { component: "redis", status: "ok", checkedAt: fresh },
      { component: "worker-heartbeats", status: "ok", checkedAt: staleDate }
    ];
    expect(computeOverallSystemHealth(staleCriticalRows, now, 900_000)).toMatchObject({
      status: "error",
      healthState: "unhealthy",
      reason: "critical_component_unhealthy_or_stale"
    });
  });

  it("enforces AdminGuard authorization and rejects missing, short, or wrong keys", () => {
    const guard = new AdminGuard();
    delete process.env.ADMIN_API_KEY;
    expect(() => guard.canActivate(mockHttpContext({ headers: {} }))).toThrow(UnauthorizedException);

    process.env.ADMIN_API_KEY = "too-short";
    expect(() => guard.canActivate(mockHttpContext({ headers: { "x-admin-api-key": "too-short" } }))).toThrow(
      /not configured securely/
    );

    process.env.ADMIN_API_KEY = "valid-admin-secret-key-at-least-16";
    expect(() => guard.canActivate(mockHttpContext({ headers: {} }))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(mockHttpContext({ headers: { "x-admin-api-key": "wrong-key-value-12345" } }))).toThrow(
      UnauthorizedException
    );
    expect(guard.canActivate(mockHttpContext({ headers: { "x-admin-api-key": "valid-admin-secret-key-at-least-16" } }))).toBe(true);
  });

  it("enforces rate limiting per client IP while exempting /api/v1/health", () => {
    const guard = new RateLimitGuard();
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    for (let i = 0; i < 120; i += 1) {
      expect(guard.canActivate(mockHttpContext({ ip, url: "/api/v1/signals", headers: {} }))).toBe(true);
    }
    expect(() => guard.canActivate(mockHttpContext({ ip, url: "/api/v1/signals", headers: {} }))).toThrow(HttpException);
    expect(guard.canActivate(mockHttpContext({ ip, url: "/api/v1/health", headers: {} }))).toBe(true);
  });

  it("redacts secrets, tokens, and database credentials and strips stack traces in error responses", () => {
    process.env.ADMIN_API_KEY = "super-secret-admin-key-9999";
    process.env.TWELVE_DATA_API_KEY = "td-live-secret-key-8888";
    process.env.TELEGRAM_BOT_TOKEN = "123456789:AAH_test_bot_token_secret_value";
    process.env.POSTGRES_PASSWORD = "pg-prod-password-7777";

    const raw =
      "Failed calling https://api.telegram.org/bot123456789:AAH_test_bot_token_secret_value/sendMessage and https://api.twelvedata.com/time_series?apikey=td-live-secret-key-8888 with postgresql://signal:pg-prod-password-7777@postgres:5432/signal_engine and admin=super-secret-admin-key-9999";
    const redacted = redactSensitiveText(raw);
    expect(redacted).not.toContain("AAH_test_bot_token_secret_value");
    expect(redacted).not.toContain("td-live-secret-key-8888");
    expect(redacted).not.toContain("pg-prod-password-7777");
    expect(redacted).not.toContain("super-secret-admin-key-9999");

    const sanitized = sanitizeErrorPayload({
      statusCode: 400,
      message: raw,
      stack: "Error: secret stack trace",
      sql: "SELECT * FROM secret"
    }) as Record<string, unknown>;
    expect(sanitized.stack).toBeUndefined();
    expect(sanitized.sql).toBeUndefined();
    expect(String(sanitized.message)).not.toContain("pg-prod-password-7777");

    let statusSet = 0;
    let bodySent: unknown;
    const headers: Record<string, string> = {};
    const filter = new SafeExceptionFilter();
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({
          setHeader: (k: string, v: string) => {
            headers[k] = v;
          },
          status: (code: number) => {
            statusSet = code;
            return {
              json: (body: unknown) => {
                bodySent = body;
              }
            };
          }
        })
      })
    };

    filter.catch(new Error(raw), host as never);
    expect(statusSet).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(bodySent).toEqual({
      statusCode: 500,
      error: "Internal Server Error",
      message: "Internal server error"
    });
  });

  it("applies hardening security headers to API responses", () => {
    const headers: Record<string, string> = {};
    let nextCalled = false;
    securityHeadersMiddleware(
      { url: "/api/v1/signals" },
      {
        setHeader: (name, value) => {
          headers[name] = value;
        }
      },
      () => {
        nextCalled = true;
      }
    );
    expect(nextCalled).toBe(true);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["Cache-Control"]).toBe("no-store");
  });
});

import { DocsController } from "./docs.controller.js";

describe("Stage 8 — OpenAPI & 7-Section Market/Event Intelligence Dashboard", () => {
  it("exposes all News, Events, Event Trading, AI, and Central Intelligence routes in OpenAPI and renders the 7-section dashboard", () => {
    const docs = new DocsController();
    const spec = docs.openapi();
    expect(spec.paths["/news"]).toBeDefined();
    expect(spec.paths["/news/sources"]).toBeDefined();
    expect(spec.paths["/news/events"]).toBeDefined();
    expect(spec.paths["/events"]).toBeDefined();
    expect(spec.paths["/events/calendar"]).toBeDefined();
    expect(spec.paths["/events/impact"]).toBeDefined();
    expect(spec.paths["/event-signals"]).toBeDefined();
    expect(spec.paths["/event-strategies"]).toBeDefined();
    expect(spec.paths["/ai/analyses"]).toBeDefined();
    expect(spec.paths["/intelligence"]).toBeDefined();
    expect(spec.paths["/intelligence/reports"]).toBeDefined();

    const html = docs.dashboard();
    expect(html).toContain("1. Overview");
    expect(html).toContain("2. News Intelligence");
    expect(html).toContain("3. Events Calendar");
    expect(html).toContain("4. Event Trading");
    expect(html).toContain("5. Technical Signals");
    expect(html).toContain("6. Intelligence Reports");
    expect(html).toContain("7. Performance & API");
    expect(html).toContain("fetch('/api/v1/news?limit=25')");
    expect(html).toContain("fetch('/api/v1/events/calendar?limit=25')");
    expect(html).toContain("fetch('/api/v1/event-signals?limit=25')");
    expect(html).toContain("fetch('/api/v1/intelligence/reports?limit=15')");

    process.env.OPENAI_API_KEY = "sk-live-secret-openai-token";
    try {
      expect(redactSensitiveText("Error with sk-live-secret-openai-token")).toBe("Error with [redacted]");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});
