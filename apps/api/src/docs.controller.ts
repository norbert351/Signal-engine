import { Controller, Get, Header } from "@nestjs/common";

const spec = {
  openapi: "3.0.3",
  info: {
    title: "Signal Engine API",
    version: "1.0.0",
    description: "Signal-only market scanner. This API never places orders and never touches exchange trading endpoints."
  },
  servers: [{ url: "/api/v1" }],
  tags: [
    { name: "health", description: "Liveness and readiness" },
    { name: "signals", description: "Published signals and lifecycle" },
    { name: "instruments", description: "Tracked instruments and candles" },
    { name: "strategies", description: "Strategy configuration and approval" },
    { name: "backtests", description: "Backtest queue and results" },
    { name: "paper-trades", description: "Paper trade records and summary" },
    { name: "system", description: "Operational health, alerts, backfill and retention" }
  ],
  components: {
    securitySchemes: { AdminApiKey: { type: "apiKey", in: "header", name: "x-admin-api-key" } }
  },
  paths: {
    "/health": { get: { tags: ["health"], summary: "API and database health" } },
    "/signals": {
      get: {
        tags: ["signals"],
        summary: "List published signals",
        parameters: [
          { name: "market", in: "query", schema: { enum: ["crypto_perpetual", "forex"] } },
          { name: "symbol", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string" } },
          { name: "direction", in: "query", schema: { enum: ["LONG", "SHORT"] } },
          { name: "strategyKey", in: "query", schema: { type: "string" } },
          { name: "timeframe", in: "query", schema: { enum: ["1m", "5m", "15m", "1h", "4h", "1d"] } },
          { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "cursor", in: "query", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } }
        ]
      }
    },
    "/signals/{id}": { get: { tags: ["signals"], summary: "Signal detail, events and paper trade", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }] } },
    "/instruments": { get: { tags: ["instruments"], summary: "List tracked instruments" } },
    "/instruments/{provider}/{symbol}/candles": {
      get: {
        tags: ["instruments"],
        summary: "Stored completed candles",
        parameters: [
          { name: "provider", in: "path", required: true, schema: { enum: ["binance_usdm", "oanda_v20"] } },
          { name: "symbol", in: "path", required: true, schema: { type: "string" } },
          { name: "timeframe", in: "query", schema: { enum: ["1m", "5m", "15m", "1h", "4h", "1d"] } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500 } },
          { name: "before", in: "query", schema: { type: "string", format: "date-time" } }
        ]
      }
    },
    "/strategies": {
      get: { tags: ["strategies"], summary: "List strategy versions" },
      post: { tags: ["strategies"], summary: "Create a new disabled, unapproved strategy version", security: [{ AdminApiKey: [] }] }
    },
    "/strategies/{id}": { get: { tags: ["strategies"], summary: "Strategy version detail", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }] } },
    "/strategies/{id}/approval": { patch: { tags: ["strategies"], summary: "Approve or reject a strategy after backtest review", security: [{ AdminApiKey: [] }] } },
    "/strategies/{id}/enabled": { patch: { tags: ["strategies"], summary: "Enable or disable an approved strategy", security: [{ AdminApiKey: [] }] } },
    "/backtests": {
      get: { tags: ["backtests"], summary: "List recent backtests" },
      post: { tags: ["backtests"], summary: "Queue a backtest", security: [{ AdminApiKey: [] }] }
    },
    "/paper-trades": { get: { tags: ["paper-trades"], summary: "List paper trades" } },
    "/paper-trades/summary": { get: { tags: ["paper-trades"], summary: "Aggregate paper performance and breakdowns" } },
    "/system/health": { get: { tags: ["system"], summary: "Component health with stale detection" } },
    "/system/alerts": { get: { tags: ["system"], summary: "Open or recent system alerts" } },
    "/system/candles": { get: { tags: ["system"], summary: "Per-instrument candle freshness" } },
    "/system/backfills": {
      get: { tags: ["system"], summary: "Backfill progress" },
      post: { tags: ["system"], summary: "Request a historical backfill", security: [{ AdminApiKey: [] }] }
    },
    "/system/backfills/{id}/reset": { post: { tags: ["system"], summary: "Reset a backfill job", security: [{ AdminApiKey: [] }] } },
    "/system/retention": { post: { tags: ["system"], summary: "Apply retention cleanup", security: [{ AdminApiKey: [] }] } }
  }
};

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal Engine API</title>
<style>body{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1f2933}code{background:#f1f5f9;padding:.1rem .3rem;border-radius:4px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e2e8f0;padding:.45rem;text-align:left}th{background:#f8fafc}</style></head>
<body><h1>Signal Engine API</h1>
<p>Signal-only scanner. No order execution endpoints exist. Interactive schema: <a href="/api/v1/openapi.json">openapi.json</a>.</p>
<p>Admin routes require the <code>x-admin-api-key</code> header.</p>
<h2>Endpoints</h2><table><thead><tr><th>Method</th><th>Path</th><th>Summary</th></tr></thead><tbody id="rows"></tbody></table>
<script>
fetch('/api/v1/openapi.json').then(r=>r.json()).then(spec=>{
  const rows=document.getElementById('rows');
  for(const [path,methods] of Object.entries(spec.paths)){
    for(const [method,op] of Object.entries(methods)){
      const tr=document.createElement('tr');
      tr.innerHTML='<td><code>'+method.toUpperCase()+'</code></td><td><code>'+path+'</code></td><td>'+(op.summary||'')+'</td>';
      rows.appendChild(tr);
    }
  }
});
</script></body></html>`;

@Controller()
export class DocsController {
  @Get("openapi.json")
  @Header("cache-control", "public, max-age=300")
  openapi() {
    return spec;
  }

  @Get("docs")
  @Header("content-type", "text/html; charset=utf-8")
  docs() {
    return html;
  }
}
