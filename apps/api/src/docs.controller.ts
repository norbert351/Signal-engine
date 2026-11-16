import { Controller, Get, Header } from "@nestjs/common";

const spec = {
  openapi: "3.0.3",
  info: {
    title: "Signal Engine API — Technical, News, Global Events & Event Trading Intelligence",
    version: "1.1.0",
    description:
      "Read-only market analysis, news intelligence, global events calendar, event-trading intelligence, and quantitative signal platform. Never executes trades or connects to exchange order endpoints."
  },
  servers: [{ url: "/api/v1" }],
  tags: [
    { name: "health", description: "Liveness and readiness" },
    { name: "signals", description: "Published technical signals and lifecycle" },
    { name: "instruments", description: "Tracked instruments and candles" },
    { name: "strategies", description: "Technical strategy configuration and approval" },
    { name: "backtests", description: "Technical backtest queue and results" },
    { name: "paper-trades", description: "Paper trade records and summary" },
    { name: "news", description: "Engine B: News Intelligence articles, sources, and deduplicated news events" },
    { name: "events", description: "Global Events Intelligence calendar, surprises, and asset mappings" },
    { name: "event-trading", description: "Engine C: Pre-event positioning, post-event momentum/reversal, and event backtests" },
    { name: "intelligence", description: "4-Layer Deep AI analyses, 7-dimension evidence fusion, and intelligence reports" },
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
        summary: "List published technical signals",
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
    "/signals/{id}": {
      get: {
        tags: ["signals"],
        summary: "Signal detail, events and paper trade",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }]
      }
    },
    "/instruments": { get: { tags: ["instruments"], summary: "List tracked instruments" } },
    "/instruments/{provider}/{symbol}/candles": {
      get: {
        tags: ["instruments"],
        summary: "Stored completed candles",
        parameters: [
          { name: "provider", in: "path", required: true, schema: { enum: ["binance_usdm", "twelve_data"] } },
          { name: "symbol", in: "path", required: true, schema: { type: "string" } },
          { name: "timeframe", in: "query", schema: { enum: ["1m", "5m", "15m", "1h", "4h", "1d"] } },
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 500 } },
          { name: "before", in: "query", schema: { type: "string", format: "date-time" } }
        ]
      }
    },
    "/strategies": {
      get: { tags: ["strategies"], summary: "List technical strategy versions" },
      post: { tags: ["strategies"], summary: "Create a new disabled, unapproved strategy version", security: [{ AdminApiKey: [] }] }
    },
    "/strategies/{id}": {
      get: {
        tags: ["strategies"],
        summary: "Strategy version detail",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }]
      }
    },
    "/strategies/{id}/approval": { patch: { tags: ["strategies"], summary: "Approve or reject a strategy after backtest review", security: [{ AdminApiKey: [] }] } },
    "/strategies/{id}/enabled": { patch: { tags: ["strategies"], summary: "Enable or disable an approved strategy", security: [{ AdminApiKey: [] }] } },
    "/backtests": {
      get: { tags: ["backtests"], summary: "List recent technical backtests" },
      post: { tags: ["backtests"], summary: "Queue a technical backtest", security: [{ AdminApiKey: [] }] }
    },
    "/paper-trades": { get: { tags: ["paper-trades"], summary: "List paper trades" } },
    "/paper-trades/summary": { get: { tags: ["paper-trades"], summary: "Aggregate paper performance and breakdowns" } },
    "/news": {
      get: { tags: ["news"], summary: "List normalized financial news articles" },
      post: { tags: ["news"], summary: "Ingest and analyze a financial news article", security: [{ AdminApiKey: [] }] }
    },
    "/news/sources": { get: { tags: ["news"], summary: "List registered news sources and credibility tiers" } },
    "/news/events": { get: { tags: ["news"], summary: "List deduplicated news events and affected assets" } },
    "/events": {
      get: { tags: ["events"], summary: "List global economic, unscheduled, and crypto events" },
      post: { tags: ["events"], summary: "Ingest a scheduled or verified unscheduled global event", security: [{ AdminApiKey: [] }] }
    },
    "/events/calendar": { get: { tags: ["events"], summary: "Filter economic events calendar by date range, country, and importance" } },
    "/events/impact": { get: { tags: ["events"], summary: "List configurable event-to-asset sensitivity mappings" } },
    "/event-signals": { get: { tags: ["event-trading"], summary: "List pre-event and post-event trading signals and validation states" } },
    "/event-signals/evaluate": { post: { tags: ["event-trading"], summary: "Evaluate a pre-event or post-event trading setup", security: [{ AdminApiKey: [] }] } },
    "/event-strategies": { get: { tags: ["event-trading"], summary: "List versioned event-trading strategy configurations" } },
    "/event-strategies/backtests": {
      get: { tags: ["event-trading"], summary: "List chronological event-strategy backtest runs" },
      post: { tags: ["event-trading"], summary: "Execute a chronological event-strategy backtest", security: [{ AdminApiKey: [] }] }
    },
    "/ai/analyses": { get: { tags: ["intelligence"], summary: "List 4-layer AI model runs, validations, provider statuses, and token/cost usage" } },
    "/intelligence": { get: { tags: ["intelligence"], summary: "Central intelligence overview, 7-dimension evidence spec, and signal fusion context" } },
    "/intelligence/reports": {
      get: { tags: ["intelligence"], summary: "List generated market and event intelligence reports" },
      post: { tags: ["intelligence"], summary: "Generate a market and event intelligence report", security: [{ AdminApiKey: [] }] }
    },
    "/intelligence/correlate": {
      post: { tags: ["intelligence"], summary: "Correlate a technical signal with active news and event risk without mutating prices", security: [{ AdminApiKey: [] }] }
    },
    "/system/health": { get: { tags: ["system"], summary: "Component health with healthy/degraded/unhealthy classification" } },
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
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Signal Engine — Market, News & Event Intelligence Dashboard</title>
  <style>
    :root { --bg:#0f172a; --card:#1e293b; --border:#334155; --text:#f8fafc; --muted:#94a3b8; --accent:#38bdf8; --ok:#22c55e; --warn:#f59e0b; --err:#ef4444; }
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 0; line-height: 1.5; }
    header { background: #020617; border-bottom: 1px solid var(--border); padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; }
    header h1 { margin: 0; font-size: 1.25rem; color: var(--accent); }
    .badge { display: inline-block; padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; background: var(--border); color: var(--text); }
    .badge.ok { background: rgba(34,197,94,0.2); color: var(--ok); }
    .badge.warn { background: rgba(245,158,11,0.2); color: var(--warn); }
    .badge.err { background: rgba(239,68,68,0.2); color: var(--err); }
    nav { background: var(--card); border-bottom: 1px solid var(--border); padding: 0.5rem 2rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }
    nav button { background: transparent; color: var(--muted); border: 1px solid transparent; padding: 0.45rem 0.85rem; border-radius: 6px; cursor: pointer; font-weight: 500; }
    nav button.active, nav button:hover { color: var(--text); border-color: var(--accent); background: rgba(56,189,248,0.1); }
    main { max-width: 1280px; margin: 1.5rem auto; padding: 0 1.5rem; }
    .section { display: none; }
    .section.active { display: block; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.25rem; }
    .card h3 { margin-top: 0; font-size: 0.95rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    th, td { border-bottom: 1px solid var(--border); padding: 0.55rem 0.5rem; text-align: left; }
    th { color: var(--muted); font-weight: 600; }
    code { background: #020617; padding: 0.1rem 0.35rem; border-radius: 4px; color: var(--accent); }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Signal Engine — Market, News & Event Intelligence</h1>
      <small style="color:var(--muted)">Read-only analysis & signal platform • No order execution • Schema: <a href="/api/v1/openapi.json" style="color:var(--accent)">openapi.json</a></small>
    </div>
    <div id="health-pill" class="badge">Checking health...</div>
  </header>
  <nav id="tabs">
    <button class="active" data-tab="overview">1. Overview</button>
    <button data-tab="news">2. News Intelligence</button>
    <button data-tab="calendar">3. Events Calendar</button>
    <button data-tab="event-trading">4. Event Trading</button>
    <button data-tab="technical">5. Technical Signals</button>
    <button data-tab="reports">6. Intelligence Reports</button>
    <button data-tab="performance">7. Performance & API</button>
  </nav>
  <main>
    <section id="overview" class="section active">
      <div class="grid">
        <div class="card"><h3>Platform Health</h3><div id="ov-health">Loading...</div></div>
        <div class="card"><h3>AI & News Providers</h3><div id="ov-ai">Loading...</div></div>
        <div class="card"><h3>Strategies Posture</h3><div id="ov-strategies">Loading...</div></div>
      </div>
    </section>
    <section id="news" class="section">
      <div class="card"><h3>News Intelligence Feed & Deduplicated Events</h3><div id="news-table">Loading...</div></div>
    </section>
    <section id="calendar" class="section">
      <div class="card"><h3>Global Economic & Crypto Events Calendar</h3><div id="calendar-table">Loading...</div></div>
    </section>
    <section id="event-trading" class="section">
      <div class="card"><h3>Pre-Event & Post-Event Trading Setups</h3><div id="event-signals-table">Loading...</div></div>
    </section>
    <section id="technical" class="section">
      <div class="card"><h3>Technical Signals & Central Intelligence Context</h3><div id="tech-signals-table">Loading...</div></div>
    </section>
    <section id="reports" class="section">
      <div class="card"><h3>Market & Event Intelligence Reports</h3><div id="reports-list">Loading...</div></div>
    </section>
    <section id="performance" class="section">
      <div class="card"><h3>OpenAPI Endpoints Reference</h3><table><thead><tr><th>Method</th><th>Path</th><th>Summary</th></tr></thead><tbody id="rows"></tbody></table></div>
    </section>
  </main>
  <script>
    const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    document.querySelectorAll('#tabs button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
      });
    });
    fetch('/api/v1/openapi.json').then(r=>r.json()).then(spec=>{
      const rows=document.getElementById('rows');
      for(const [path,methods] of Object.entries(spec.paths)){
        for(const [method,op] of Object.entries(methods)){
          const tr=document.createElement('tr');
          tr.innerHTML='<td><code>'+esc(method.toUpperCase())+'</code></td><td><code>'+esc(path)+'</code></td><td>'+esc(op.summary||'')+'</td>';
          rows.appendChild(tr);
        }
      }
    });
    fetch('/api/v1/system/health').then(r=>r.json()).then(h=>{
      const pill=document.getElementById('health-pill');
      pill.textContent='System: '+(h.healthState||h.status);
      pill.className='badge '+(h.status==='ok'?'ok':h.status==='degraded'?'warn':'err');
      document.getElementById('ov-health').innerHTML='<p>State: <b>'+esc(h.healthState||h.status)+'</b></p><p>Components tracked: '+esc((h.components||[]).length)+'</p>';
    }).catch(()=>{});
    fetch('/api/v1/intelligence').then(r=>r.json()).then(intel=>{
      document.getElementById('ov-ai').innerHTML=(intel.aiProviders||[]).map(p=>'<div><code>'+esc(p.key)+'</code>: <span class="badge '+(p.configured?'ok':'warn')+'">'+esc(p.healthStatus)+'</span></div>').join('');
    }).catch(()=>{});
    Promise.all([fetch('/api/v1/strategies').then(r=>r.json()), fetch('/api/v1/event-strategies').then(r=>r.json())]).then(([ts, es])=>{
      document.getElementById('ov-strategies').innerHTML='<p>Technical strategies: '+esc(ts.total)+' (all disabled/unapproved)</p><p>Event strategies: '+esc(es.total)+' (all disabled/unapproved)</p>';
    }).catch(()=>{});
    fetch('/api/v1/news?limit=25').then(r=>r.json()).then(res=>{
      const items=res.data||[];
      document.getElementById('news-table').innerHTML=items.length===0?'<p>No news articles ingested yet.</p>':'<table><thead><tr><th>Published</th><th>Category</th><th>Importance</th><th>Credibility</th><th>Title</th></tr></thead><tbody>'+items.map(a=>'<tr><td>'+esc(a.publishedAt)+'</td><td><code>'+esc(a.category)+'</code></td><td>'+esc(a.importance)+'</td><td>'+esc(a.credibilityScore)+'</td><td>'+esc(a.title)+'</td></tr>').join('')+'</tbody></table>';
    }).catch(()=>{});
    fetch('/api/v1/events/calendar?limit=25').then(r=>r.json()).then(res=>{
      const items=res.data||[];
      document.getElementById('calendar-table').innerHTML=items.length===0?'<p>No scheduled/global events recorded yet.</p>':'<table><thead><tr><th>Scheduled</th><th>Event</th><th>Currency</th><th>Consensus</th><th>Actual</th><th>Status</th></tr></thead><tbody>'+items.map(e=>'<tr><td>'+esc(e.scheduledAt||e.publishedAt)+'</td><td>'+esc(e.eventName)+'</td><td><code>'+esc(e.currency)+'</code></td><td>'+esc(e.consensusValue??'N/A')+'</td><td>'+esc(e.actualValue??'Pending')+'</td><td>'+esc(e.status)+'</td></tr>').join('')+'</tbody></table>';
    }).catch(()=>{});
    fetch('/api/v1/event-signals?limit=25').then(r=>r.json()).then(res=>{
      const items=res.data||[];
      document.getElementById('event-signals-table').innerHTML=items.length===0?'<p>No event trading setups evaluated yet.</p>':'<table><thead><tr><th>Symbol</th><th>Strategy</th><th>Action</th><th>Validation</th><th>Risk</th><th>Reason</th></tr></thead><tbody>'+items.map(s=>'<tr><td><code>'+esc(s.symbol)+'</code></td><td>'+esc(s.strategyKey)+'</td><td>'+esc(s.actionClassification)+'</td><td>'+esc(s.validationStatus)+'</td><td>'+esc(s.riskClassification)+'</td><td>'+esc(s.rejectionReason||'Approved (Pending Strategy Gate)')+'</td></tr>').join('')+'</tbody></table>';
    }).catch(()=>{});
    fetch('/api/v1/signals?limit=25').then(r=>r.json()).then(res=>{
      const items=res.data||[];
      document.getElementById('tech-signals-table').innerHTML=items.length===0?'<p>No published technical signals (all 6 strategies remain disabled/unapproved).</p>':'<table><thead><tr><th>Symbol</th><th>Timeframe</th><th>Direction</th><th>Strategy</th><th>Status</th></tr></thead><tbody>'+items.map(s=>'<tr><td><code>'+esc(s.symbol)+'</code></td><td>'+esc(s.timeframe)+'</td><td>'+esc(s.direction)+'</td><td>'+esc(s.strategyKey)+'</td><td>'+esc(s.status)+'</td></tr>').join('')+'</tbody></table>';
    }).catch(()=>{});
    fetch('/api/v1/intelligence/reports?limit=15').then(r=>r.json()).then(res=>{
      const items=res.data||[];
      document.getElementById('reports-list').innerHTML=items.length===0?'<p>No intelligence reports generated yet.</p>':'<table><thead><tr><th>Generated</th><th>Type</th><th>Regime</th><th>Summary</th></tr></thead><tbody>'+items.map(rp=>'<tr><td>'+esc(rp.generatedAt)+'</td><td><code>'+esc(rp.reportType)+'</code></td><td>'+esc(rp.marketRegime)+'</td><td>'+esc(rp.summary)+'</td></tr>').join('')+'</tbody></table>';
    }).catch(()=>{});
  </script>
</body>
</html>`;

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

  @Get("dashboard")
  @Header("content-type", "text/html; charset=utf-8")
  dashboard() {
    return html;
  }
}
