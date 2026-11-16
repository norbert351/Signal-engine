function envVar(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.[name];
}

export function deterministicHexHash(input: string): string {
  // Deterministic 256-bit (64 hex chars) multi-lane hash for pure-JS core portability
  const lanes = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0xfd7046c5];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    for (let l = 0; l < lanes.length; l++) {
      let h = lanes[l]! ^ (code + l * 31 + i);
      h = Math.imul(h, 0x01000193 + l * 2);
      h ^= h >>> 15;
      lanes[l] = h >>> 0;
    }
  }
  return lanes.map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

export const UNIVERSE_CRYPTO_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT", "LTCUSDT",
  "DOTUSDT", "TRXUSDT", "TONUSDT", "SUIUSDT", "NEARUSDT",
  "APTUSDT", "ARBUSDT", "OPUSDT", "UNIUSDT", "BCHUSDT"
] as const;

export const UNIVERSE_FOREX_SYMBOLS = [
  "EUR_USD", "GBP_USD", "USD_JPY", "EUR_JPY", "XAU_USD"
] as const;

export const ALL_UNIVERSE_SYMBOLS = new Set<string>([
  ...UNIVERSE_CRYPTO_SYMBOLS,
  ...UNIVERSE_FOREX_SYMBOLS
]);

export const SUPPORTED_NEWS_CATEGORIES = [
  "central_bank_decisions",
  "inflation_announcements",
  "employment_reports",
  "gdp_releases",
  "retail_sales",
  "manufacturing_services_pmi",
  "monetary_policy",
  "government_policy",
  "regulatory_announcements",
  "geopolitical_developments",
  "elections",
  "wars_and_sanctions",
  "banking_crises",
  "corporate_earnings",
  "mergers_and_acquisitions",
  "financial_institution_announcements",
  "commodity_supply_disruptions",
  "oil_and_energy",
  "crypto_protocol_upgrades",
  "token_unlocks",
  "exchange_listings_delistings",
  "etf_announcements",
  "blockchain_exploits",
  "governance_proposals",
  "crypto_institutional_developments",
  "general_market_news"
] as const;

export type NewsCategory = (typeof SUPPORTED_NEWS_CATEGORIES)[number] | string;
export type CredibilityTier = "official_primary" | "tier1_wire" | "tier2_financial" | "community_unverified";
export type ImportanceLevel = "low" | "medium" | "high" | "critical";
export type DirectionBias = "bullish" | "bearish" | "neutral" | "conflicting" | "uncertain";

export type NewsSourceConfig = {
  key: string;
  name: string;
  sourceType: "official_rss" | "official_announcement" | "rest_api" | "regulatory_feed";
  url?: string;
  credibilityTier: CredibilityTier;
  credibilityScore: number;
  enabled: boolean;
  requiresCredentials: boolean;
  credentialEnvVar?: string;
  providerStatus: "ready" | "awaiting_credentials" | "degraded" | "disabled";
};

export type RawNewsArticleInput = {
  sourceKey: string;
  externalId?: string;
  url: string;
  title: string;
  summary?: string;
  contentSnippet?: string;
  author?: string;
  publishedAt: string | number | Date;
  collectedAt?: string | number | Date;
  rawMetadata?: Record<string, unknown>;
};

export type ExtractedEntity = {
  entityType: "currency" | "crypto_token" | "commodity" | "central_bank" | "regulator" | "country" | "institution";
  canonicalName: string;
  code: string;
  role: "primary" | "mentioned";
  confidence: number;
};

export type ExtractedFact = {
  factType: "rate_decision" | "macro_print" | "regulatory_action" | "token_unlock_notice" | "exchange_listing" | "security_incident" | "statement";
  statement: string;
  numericValue?: number;
  unit?: string;
  exactQuantityVerified: boolean;
  sourceUrl: string;
};

export type AffectedInstrumentMapping = {
  symbol: string;
  market: "crypto_perpetual" | "forex";
  relationshipType: "direct" | "macro_driver" | "safe_haven" | "sector_spillover";
  directionHypothesis: DirectionBias;
  relevanceScore: number;
  tradable: boolean;
};

export type NormalizedNewsArticle = {
  sourceKey: string;
  externalId?: string;
  url: string;
  title: string;
  summary: string;
  contentSnippet: string;
  author?: string;
  publishedAt: Date;
  collectedAt: Date;
  contentHash: string;
  titleFingerprint: string;
  promptInjectionSanitized: boolean;
  category: NewsCategory;
  importance: ImportanceLevel;
  directionBias: DirectionBias;
  credibilityScore: number;
  relevanceScore: number;
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
  affectedInstruments: AffectedInstrumentMapping[];
};

const PROMPT_INJECTION_PATTERNS = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i,
  /system\s*prompt\s*:/i,
  /\[\s*system\s*\]/i,
  /###\s*(?:system|instruction)\b/i,
  /(?:developer|assistant)\s*:\s*override/i,
  /you\s+are\s+now\s+a/i,
  /execute\s+(?:market\s+)?order/i,
  /(?:disregard|override|bypass)\s+risk\s+controls/i,
  /<script\b[^>]*>[\s\S]*?<\/script>/i
];

export function sanitizeUntrustedArticleText(input: string): { text: string; sanitized: boolean } {
  let out = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, " ");
  let sanitized = false;
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, "gi");
    if (pattern.test(out)) {
      sanitized = true;
      out = out.replace(globalPattern, "[quarantined-untrusted-directive]");
    }
  }
  out = out.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { text: out.slice(0, 4000), sanitized };
}

export class NewsSourceRegistryService {
  private readonly sources = new Map<string, NewsSourceConfig>();

  constructor(initialSources: NewsSourceConfig[] = DEFAULT_NEWS_SOURCES) {
    for (const src of initialSources) {
      this.registerSource(src);
    }
  }

  registerSource(config: NewsSourceConfig): NewsSourceConfig {
    const hasCreds =
      !config.requiresCredentials ||
      Boolean(config.credentialEnvVar && envVar(config.credentialEnvVar)?.trim());
    const effectiveStatus: NewsSourceConfig["providerStatus"] = !config.enabled
      ? "disabled"
      : config.requiresCredentials && !hasCreds
        ? "awaiting_credentials"
        : "ready";
    const resolved: NewsSourceConfig = { ...config, providerStatus: effectiveStatus };
    this.sources.set(config.key, resolved);
    return resolved;
  }

  getSource(key: string): NewsSourceConfig | undefined {
    const existing = this.sources.get(key);
    if (!existing) return undefined;
    return this.registerSource(existing);
  }

  listSources(): NewsSourceConfig[] {
    return [...this.sources.keys()].map((key) => this.getSource(key)!);
  }
}

export const DEFAULT_NEWS_SOURCES: NewsSourceConfig[] = [
  {
    key: "federal_reserve_rss",
    name: "Federal Reserve Official Releases",
    sourceType: "official_rss",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    credibilityTier: "official_primary",
    credibilityScore: 98,
    enabled: true,
    requiresCredentials: false,
    providerStatus: "ready"
  },
  {
    key: "ecb_press_rss",
    name: "European Central Bank Press Releases",
    sourceType: "official_rss",
    url: "https://www.ecb.europa.eu/rss/press.html",
    credibilityTier: "official_primary",
    credibilityScore: 98,
    enabled: true,
    requiresCredentials: false,
    providerStatus: "ready"
  },
  {
    key: "sec_press_rss",
    name: "US SEC Official Press Releases",
    sourceType: "regulatory_feed",
    url: "https://www.sec.gov/news/pressreleases.rss",
    credibilityTier: "official_primary",
    credibilityScore: 97,
    enabled: true,
    requiresCredentials: false,
    providerStatus: "ready"
  },
  {
    key: "binance_announcements",
    name: "Binance Official Exchange Announcements",
    sourceType: "official_announcement",
    url: "https://www.binance.com/en/support/announcement",
    credibilityTier: "official_primary",
    credibilityScore: 92,
    enabled: true,
    requiresCredentials: false,
    providerStatus: "ready"
  },
  {
    key: "cryptopanic_api",
    name: "CryptoPanic News Aggregator API",
    sourceType: "rest_api",
    url: "https://cryptopanic.com/api/v1/posts/",
    credibilityTier: "tier2_financial",
    credibilityScore: 78,
    enabled: true,
    requiresCredentials: true,
    credentialEnvVar: "CRYPTOPANIC_API_KEY",
    providerStatus: "awaiting_credentials"
  },
  {
    key: "newsapi_financial",
    name: "NewsAPI Financial Wire Adapter",
    sourceType: "rest_api",
    url: "https://newsapi.org/v2/everything",
    credibilityTier: "tier1_wire",
    credibilityScore: 85,
    enabled: true,
    requiresCredentials: true,
    credentialEnvVar: "NEWS_API_KEY",
    providerStatus: "awaiting_credentials"
  }
];

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "over", "after",
  "before", "amid", "says", "said", "report", "reports", "update", "breaking", "news"
]);

const OPPOSING_POLARITY_GROUPS: Array<[RegExp, RegExp]> = [
  [/\b(?:approves|approved|approval|greenlights)\b/i, /\b(?:rejects|rejected|rejection|delays|delayed|denies|denied)\b/i],
  [/\b(?:hike|hikes|hiked|raises|raised|increase|increases)\b/i, /\b(?:cut|cuts|lowers|lowered|pauses|paused|decrease|decreases)\b/i],
  [/\b(?:beats|beat|above|hotter|surges|rises|rose|climbs)\b/i, /\b(?:misses|missed|below|cooler|drops|falls|fell|plunges)\b/i],
  [/\b(?:lists|listing|launches)\b/i, /\b(?:delists|delisting|halts|suspends)\b/i]
];

function tokenizeHeadlinePreservingNumbers(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/(\d)\.(\d)/g, "$1dot$2")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/(\d)dot(\d)/g, "$1.$2")
    .split(/\s+/)
    .filter((tok) => (tok.length >= 3 || /\d/.test(tok)) && !STOP_WORDS.has(tok));
}

function extractExplicitNumbers(value: string): string[] {
  const matches = value.toLowerCase().match(/\b\d+(?:\.\d+)?%?\b/g);
  return matches ? [...new Set(matches)].sort() : [];
}

export class NewsDeduplicationService {
  static computeContentHash(sourceKey: string, title: string, summary: string, publishedAtIso: string): string {
    const normalized = `${sourceKey.toLowerCase()}|${title.toLowerCase().trim()}|${summary.toLowerCase().trim()}|${publishedAtIso.slice(0, 16)}`;
    return deterministicHexHash(normalized);
  }

  static computeTitleFingerprint(title: string): string {
    const tokens = tokenizeHeadlinePreservingNumbers(title);
    const uniqueSorted = [...new Set(tokens)].sort().slice(0, 14);
    return deterministicHexHash(uniqueSorted.join(" "));
  }

  static hasConflictingPolarityOrNumbers(titleA: string, titleB: string): boolean {
    const numsA = extractExplicitNumbers(titleA);
    const numsB = extractExplicitNumbers(titleB);
    if (numsA.length > 0 && numsB.length > 0 && numsA.join(",") !== numsB.join(",")) {
      return true;
    }
    for (const [pos, neg] of OPPOSING_POLARITY_GROUPS) {
      if ((pos.test(titleA) && neg.test(titleB)) || (neg.test(titleA) && pos.test(titleB))) {
        return true;
      }
    }
    return false;
  }

  static tokenSimilarity(titleA: string, titleB: string): number {
    const setA = new Set(tokenizeHeadlinePreservingNumbers(titleA));
    const setB = new Set(tokenizeHeadlinePreservingNumbers(titleB));
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersection = 0;
    for (const tok of setA) {
      if (setB.has(tok)) intersection += 1;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  static checkDuplicate(
    candidate: { title: string; contentHash: string; titleFingerprint: string; publishedAt: Date },
    existingArticles: Array<{ id: string; title: string; contentHash: string; titleFingerprint: string; publishedAt: Date }>
  ): { isDuplicate: boolean; duplicateOfId?: string; isStoryUpdate: boolean; similarity: number } {
    for (const existing of existingArticles) {
      if (existing.contentHash === candidate.contentHash) {
        return { isDuplicate: true, duplicateOfId: existing.id, isStoryUpdate: false, similarity: 1 };
      }
      const conflict = this.hasConflictingPolarityOrNumbers(candidate.title, existing.title);
      if (existing.titleFingerprint === candidate.titleFingerprint && !conflict) {
        const ageDiffMs = Math.abs(candidate.publishedAt.getTime() - existing.publishedAt.getTime());
        if (ageDiffMs <= 6 * 3600_000) {
          return { isDuplicate: true, duplicateOfId: existing.id, isStoryUpdate: false, similarity: 0.95 };
        }
        return { isDuplicate: false, duplicateOfId: existing.id, isStoryUpdate: true, similarity: 0.9 };
      }
      const sim = this.tokenSimilarity(candidate.title, existing.title);
      if (sim >= 0.72 && !conflict) {
        const ageDiffMs = Math.abs(candidate.publishedAt.getTime() - existing.publishedAt.getTime());
        if (ageDiffMs <= 12 * 3600_000) {
          return { isDuplicate: true, duplicateOfId: existing.id, isStoryUpdate: false, similarity: sim };
        }
        return { isDuplicate: false, duplicateOfId: existing.id, isStoryUpdate: true, similarity: sim };
      }
      if (sim >= 0.55) {
        return { isDuplicate: false, duplicateOfId: existing.id, isStoryUpdate: true, similarity: sim };
      }
    }
    return { isDuplicate: false, isStoryUpdate: false, similarity: 0 };
  }
}

const TOKEN_PATTERNS: Array<{ code: string; name: string; regex: RegExp }> = [
  { code: "BTC", name: "Bitcoin", regex: /\b(?:bitcoin|btc|btcusdt)\b/i },
  { code: "ETH", name: "Ethereum", regex: /\b(?:ethereum|eth|ether|ethusdt)\b/i },
  { code: "BNB", name: "BNB", regex: /\b(?:bnb|binance coin|bnbusdt)\b/i },
  { code: "SOL", name: "Solana", regex: /\b(?:solana|sol|solusdt)\b/i },
  { code: "XRP", name: "XRP", regex: /\b(?:xrp|ripple|xrpusdt)\b/i },
  { code: "DOGE", name: "Dogecoin", regex: /\b(?:dogecoin|doge|dogeusdt)\b/i },
  { code: "ADA", name: "Cardano", regex: /\b(?:cardano|ada|adausdt)\b/i },
  { code: "LINK", name: "Chainlink", regex: /\b(?:chainlink|linkusdt)\b/i },
  { code: "AVAX", name: "Avalanche", regex: /\b(?:avalanche|avax|avaxusdt)\b/i },
  { code: "LTC", name: "Litecoin", regex: /\b(?:litecoin|ltc|ltcusdt)\b/i },
  { code: "DOT", name: "Polkadot", regex: /\b(?:polkadot|dotusdt)\b/i },
  { code: "TRX", name: "TRON", regex: /\b(?:tron|trx|trxusdt)\b/i },
  { code: "TON", name: "Toncoin", regex: /\b(?:toncoin|tonusdt)\b/i },
  { code: "SUI", name: "Sui", regex: /\b(?:sui\s+network|suiusdt|\bsui\b)/i },
  { code: "NEAR", name: "NEAR Protocol", regex: /\b(?:near\s+protocol|nearusdt)\b/i },
  { code: "APT", name: "Aptos", regex: /\b(?:aptos|aptusdt)\b/i },
  { code: "ARB", name: "Arbitrum", regex: /\b(?:arbitrum|arbusdt)\b/i },
  { code: "OP", name: "Optimism", regex: /\b(?:optimism|opusdt)\b/i },
  { code: "UNI", name: "Uniswap", regex: /\b(?:uniswap|uniusdt)\b/i },
  { code: "BCH", name: "Bitcoin Cash", regex: /\b(?:bitcoin cash|bch|bchusdt)\b/i }
];

const MACRO_ENTITIES: Array<{
  entityType: ExtractedEntity["entityType"];
  code: string;
  name: string;
  regex: RegExp;
}> = [
  { entityType: "central_bank", code: "FED", name: "Federal Reserve", regex: /\b(?:federal reserve|fomc|powell|\bfed\b)/i },
  { entityType: "central_bank", code: "ECB", name: "European Central Bank", regex: /\b(?:european central bank|\becb\b|lagarde)/i },
  { entityType: "central_bank", code: "BOE", name: "Bank of England", regex: /\b(?:bank of england|\bboe\b)/i },
  { entityType: "central_bank", code: "BOJ", name: "Bank of Japan", regex: /\b(?:bank of japan|\bboj\b|ueda)/i },
  { entityType: "regulator", code: "SEC", name: "US Securities and Exchange Commission", regex: /\b(?:securities and exchange commission|\bsec\b)/i },
  { entityType: "regulator", code: "CFTC", name: "Commodity Futures Trading Commission", regex: /\b(?:cftc)\b/i },
  { entityType: "currency", code: "USD", name: "US Dollar", regex: /\b(?:us dollar|u\.s\. dollar|\busd\b|greenback|treasury yields|us cpi|us nfp|fomc)/i },
  { entityType: "currency", code: "EUR", name: "Euro", regex: /\b(?:eurozone|\beuro\b|\beur\b)/i },
  { entityType: "currency", code: "GBP", name: "British Pound", regex: /\b(?:sterling|british pound|\bgbp\b)/i },
  { entityType: "currency", code: "JPY", name: "Japanese Yen", regex: /\b(?:japanese yen|\byen\b|\bjpy\b)/i },
  { entityType: "commodity", code: "XAU", name: "Gold", regex: /\b(?:gold|bullion|xau|xauusd|xau_usd)\b/i }
];

export class NewsEntityExtractionService {
  static extractEntities(title: string, body = ""): ExtractedEntity[] {
    const combined = `${title} ${body}`;
    const entities: ExtractedEntity[] = [];
    const seen = new Set<string>();

    for (const token of TOKEN_PATTERNS) {
      if (token.regex.test(combined)) {
        const inTitle = token.regex.test(title);
        const key = `crypto_token:${token.code}`;
        if (!seen.has(key)) {
          seen.add(key);
          entities.push({
            entityType: "crypto_token",
            canonicalName: token.name,
            code: token.code,
            role: inTitle ? "primary" : "mentioned",
            confidence: inTitle ? 95 : 82
          });
        }
      }
    }

    for (const item of MACRO_ENTITIES) {
      if (item.regex.test(combined)) {
        const inTitle = item.regex.test(title);
        const key = `${item.entityType}:${item.code}`;
        if (!seen.has(key)) {
          seen.add(key);
          entities.push({
            entityType: item.entityType,
            canonicalName: item.name,
            code: item.code,
            role: inTitle ? "primary" : "mentioned",
            confidence: inTitle ? 94 : 80
          });
        }
      }
    }
    return entities;
  }
}

const CATEGORY_RULES: Array<{ category: NewsCategory; importance: ImportanceLevel; regex: RegExp }> = [
  { category: "blockchain_exploits", importance: "critical", regex: /\b(?:exploit|hacked|drained|security breach|bridge hack|vulnerability|smart contract bug)\b/i },
  { category: "banking_crises", importance: "critical", regex: /\b(?:bank run|bank failure|insolvency|liquidity crisis|receivership|emergency lending)\b/i },
  { category: "wars_and_sanctions", importance: "high", regex: /\b(?:military strike|war|missile|sanctions|embargo|airstrike|ceasefire)\b/i },
  { category: "central_bank_decisions", importance: "high", regex: /\b(?:fomc|rate decision|interest rate|rate hike|rate cut|basis points|monetary policy statement)\b/i },
  { category: "inflation_announcements", importance: "high", regex: /\b(?:cpi|consumer price index|core inflation|pce|producer price index|ppi)\b/i },
  { category: "employment_reports", importance: "high", regex: /\b(?:non-farm payrolls|nonfarm payrolls|\bnfp\b|unemployment rate|jobless claims)\b/i },
  { category: "gdp_releases", importance: "high", regex: /\b(?:gdp|gross domestic product|economic growth rate)\b/i },
  { category: "retail_sales", importance: "medium", regex: /\b(?:retail sales|consumer spending)\b/i },
  { category: "manufacturing_services_pmi", importance: "medium", regex: /\b(?:pmi|purchasing managers index|ism manufacturing|ism services)\b/i },
  { category: "etf_announcements", importance: "high", regex: /\b(?:spot etf|bitcoin etf|ethereum etf|etf approval|etf filing|19b-4|s-1 filing)\b/i },
  { category: "exchange_listings_delistings", importance: "medium", regex: /\b(?:will list|delist|delisting|new trading pair|perpetual contract launch)\b/i },
  { category: "token_unlocks", importance: "medium", regex: /\b(?:token unlock|vesting release|cliff unlock)\b/i },
  { category: "crypto_protocol_upgrades", importance: "medium", regex: /\b(?:mainnet launch|hard fork|protocol upgrade|network upgrade|eip-)\b/i },
  { category: "governance_proposals", importance: "low", regex: /\b(?:governance proposal|dao vote|on-chain vote)\b/i },
  { category: "regulatory_announcements", importance: "high", regex: /\b(?:sec charges|enforcement action|regulatory approval|subpoena| Wells notice|lawsuit)\b/i },
  { category: "oil_and_energy", importance: "medium", regex: /\b(?:opec|crude oil|brent|wti|energy supply|refinery)\b/i },
  { category: "commodity_supply_disruptions", importance: "medium", regex: /\b(?:supply disruption|mine closure|export ban|shipping halt)\b/i },
  { category: "elections", importance: "medium", regex: /\b(?:presidential election|parliamentary election|ballot|referendum)\b/i },
  { category: "geopolitical_developments", importance: "medium", regex: /\b(?:geopolitical|diplomatic|tariff|trade war|summit)\b/i },
  { category: "corporate_earnings", importance: "low", regex: /\b(?:quarterly earnings|eps beat|revenue miss|q[1-4] results)\b/i },
  { category: "mergers_and_acquisitions", importance: "low", regex: /\b(?:acquisition|merger|buyout|takeover)\b/i },
  { category: "crypto_institutional_developments", importance: "medium", regex: /\b(?:institutional custody|treasury reserve|blackrock|fidelity|microstrategy)\b/i }
];

export class NewsClassificationService {
  static classify(title: string, summary = ""): { category: NewsCategory; importance: ImportanceLevel; directionBias: DirectionBias } {
    const text = `${title} ${summary}`;
    let matchedCategory: NewsCategory = "general_market_news";
    let importance: ImportanceLevel = "low";

    for (const rule of CATEGORY_RULES) {
      if (rule.regex.test(text)) {
        matchedCategory = rule.category;
        importance = rule.importance;
        break;
      }
    }

    const bullishMatch = /\b(?:approves|approved|surge|rally|rate cut| dovish|inflows|partnership|upgrade complete|beats expectations)\b/i.test(text);
    const bearishMatch = /\b(?:hack|exploit|delist|lawsuit|charges|rate hike|hawkish|outflows|insolvency|halted|sanctions|hotter than expected)\b/i.test(text);

    let directionBias: DirectionBias = "neutral";
    if (bullishMatch && bearishMatch) directionBias = "conflicting";
    else if (bullishMatch) directionBias = "bullish";
    else if (bearishMatch) directionBias = "bearish";

    return { category: matchedCategory, importance, directionBias };
  }
}

export class NewsCredibilityService {
  static evaluateCredibility(
    source: NewsSourceConfig | undefined,
    corroborationCount = 1,
    hasOfficialUrl = false,
    conflictingReports = false
  ): { score: number; tier: CredibilityTier; rationale: string } {
    const baseScore = source?.credibilityScore ?? 55;
    const tier: CredibilityTier = source?.credibilityTier ?? "community_unverified";
    const corroborationBonus = Math.min(10, Math.max(0, (corroborationCount - 1) * 4));
    const urlBonus = hasOfficialUrl ? 2 : 0;
    const conflictPenalty = conflictingReports ? 15 : 0;
    const finalScore = Math.max(0, Math.min(100, Math.round((baseScore + corroborationBonus + urlBonus - conflictPenalty) * 100) / 100));
    return {
      score: finalScore,
      tier,
      rationale: `Base ${baseScore} (${tier}), corroboration=${corroborationCount}, conflict=${conflictingReports}`
    };
  }
}

export class NewsFactExtractionService {
  /**
   * Extracts verifiable statements and explicit figures.
   * Never infers exact token unlock quantities from headlines unless explicitly stated with units.
   */
  static extractFacts(title: string, summary: string, url: string, category: NewsCategory): ExtractedFact[] {
    const facts: ExtractedFact[] = [];
    const combined = `${title}. ${summary}`.trim();

    if (category === "token_unlocks") {
      // Do not infer exact unlock quantities from headlines alone
      facts.push({
        factType: "token_unlock_notice",
        statement: title,
        exactQuantityVerified: false,
        sourceUrl: url
      });
      return facts;
    }

    const bpsMatch = combined.match(/\b(\d{1,3})\s*(?:basis points|bps)\b/i);
    if (bpsMatch) {
      facts.push({
        factType: "rate_decision",
        statement: title,
        numericValue: Number(bpsMatch[1]),
        unit: "bps",
        exactQuantityVerified: true,
        sourceUrl: url
      });
    }

    const pctMatch = combined.match(/\b(\d{1,2}\.\d{1,2})%\b/);
    if (pctMatch && (category === "inflation_announcements" || category === "employment_reports" || category === "gdp_releases")) {
      facts.push({
        factType: "macro_print",
        statement: title,
        numericValue: Number(pctMatch[1]),
        unit: "pct",
        exactQuantityVerified: true,
        sourceUrl: url
      });
    }

    if (facts.length === 0) {
      facts.push({
        factType: category === "blockchain_exploits" ? "security_incident" : "statement",
        statement: title,
        exactQuantityVerified: false,
        sourceUrl: url
      });
    }
    return facts;
  }
}

function invertBias(bias: DirectionBias): DirectionBias {
  if (bias === "bullish") return "bearish";
  if (bias === "bearish") return "bullish";
  return bias;
}

export class NewsImpactAnalysisService {
  static mapAffectedInstruments(
    entities: ExtractedEntity[],
    category: NewsCategory,
    directionBias: DirectionBias
  ): AffectedInstrumentMapping[] {
    const mappings = new Map<string, AffectedInstrumentMapping>();
    const addMapping = (
      symbol: string,
      market: "crypto_perpetual" | "forex",
      relationshipType: AffectedInstrumentMapping["relationshipType"],
      relevanceScore: number,
      bias: DirectionBias = directionBias
    ) => {
      if (!ALL_UNIVERSE_SYMBOLS.has(symbol)) return;
      const tradable = symbol !== "TONUSDT"; // TONUSDT observed in SETTLING status
      const existing = mappings.get(symbol);
      if (!existing || existing.relevanceScore < relevanceScore) {
        mappings.set(symbol, {
          symbol,
          market,
          relationshipType,
          directionHypothesis: bias,
          relevanceScore,
          tradable
        });
      }
    };

    for (const entity of entities) {
      if (entity.entityType === "crypto_token") {
        const symbol = `${entity.code}USDT`;
        addMapping(symbol, "crypto_perpetual", "direct", entity.role === "primary" ? 95 : 80, directionBias);
      } else if (entity.entityType === "commodity" && entity.code === "XAU") {
        addMapping("XAU_USD", "forex", "direct", 92, directionBias);
      } else if (entity.entityType === "currency" || entity.entityType === "central_bank") {
        if (entity.code === "USD" || entity.code === "FED") {
          // In NewsClassificationService, rate cuts/dovish = bullish (risk-on / weaker USD),
          // rate hikes/hawkish/hotter CPI = bearish (risk-off / stronger USD).
          // Therefore USD_JPY (where USD is base currency) moves opposite to EUR_USD/GBP_USD/XAU_USD/BTCUSDT.
          addMapping("EUR_USD", "forex", "macro_driver", 88, directionBias);
          addMapping("GBP_USD", "forex", "macro_driver", 85, directionBias);
          addMapping("USD_JPY", "forex", "macro_driver", 88, invertBias(directionBias));
          addMapping("XAU_USD", "forex", "macro_driver", 86, directionBias);
          addMapping("BTCUSDT", "crypto_perpetual", "macro_driver", 78, directionBias);
        }
        if (entity.code === "EUR" || entity.code === "ECB") {
          // For ECB, hawkish/rate hike is classified as "bearish" by general risk classifier, so invert for EUR base pairs
          const eurPairBias =
            category === "central_bank_decisions" || category === "inflation_announcements"
              ? invertBias(directionBias)
              : directionBias;
          addMapping("EUR_USD", "forex", "macro_driver", 90, eurPairBias);
          addMapping("EUR_JPY", "forex", "macro_driver", 86, eurPairBias);
        }
        if (entity.code === "GBP" || entity.code === "BOE") {
          const gbpPairBias =
            category === "central_bank_decisions" || category === "inflation_announcements"
              ? invertBias(directionBias)
              : directionBias;
          addMapping("GBP_USD", "forex", "macro_driver", 90, gbpPairBias);
        }
        if (entity.code === "JPY" || entity.code === "BOJ") {
          // For BOJ rate hike ("bearish" in risk classifier -> stronger JPY -> bearish USD_JPY & EUR_JPY)
          addMapping("USD_JPY", "forex", "macro_driver", 90, directionBias);
          addMapping("EUR_JPY", "forex", "macro_driver", 86, directionBias);
        }
      }
    }

    if (category === "wars_and_sanctions" || category === "geopolitical_developments") {
      addMapping("XAU_USD", "forex", "safe_haven", 85, "bullish");
      addMapping("BTCUSDT", "crypto_perpetual", "macro_driver", 70, "uncertain");
    }

    return [...mappings.values()].sort((a, b) => b.relevanceScore - a.relevanceScore);
  }
}

export class RssFeedParser {
  /**
   * Deterministic XML/RSS/Atom parser for public official feeds (Fed, ECB, SEC).
   * Treats all feed fields as untrusted external input.
   */
  static parseFeedXml(xmlText: string, sourceKey: string, collectedAt = new Date()): RawNewsArticleInput[] {
    const items: RawNewsArticleInput[] = [];
    const itemBlocks = [
      ...xmlText.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
      ...xmlText.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)
    ];

    const extractTag = (block: string, tag: string): string | undefined => {
      const m = block.match(new RegExp(`<${tag}\\b[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, "i"));
      const raw = (m?.[1] ?? m?.[2] ?? "").trim();
      return raw || undefined;
    };

    for (const match of itemBlocks) {
      const block = match[1] ?? "";
      const title = extractTag(block, "title");
      let url = extractTag(block, "link");
      if (!url) {
        const hrefMatch = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
        url = hrefMatch?.[1]?.trim();
      }
      const pubRaw =
        extractTag(block, "pubDate") ??
        extractTag(block, "published") ??
        extractTag(block, "updated") ??
        extractTag(block, "dc:date");
      const summary = extractTag(block, "description") ?? extractTag(block, "summary") ?? "";
      const guid = extractTag(block, "guid") ?? extractTag(block, "id");

      if (title && url && /^https?:\/\//i.test(url)) {
        const parsedPub = pubRaw ? new Date(pubRaw) : collectedAt;
        const publishedAt = Number.isFinite(parsedPub.getTime()) ? parsedPub : collectedAt;
        items.push({
          sourceKey,
          ...(guid ? { externalId: guid.slice(0, 180) } : {}),
          url,
          title,
          summary,
          publishedAt,
          collectedAt
        });
      }
    }
    return items;
  }
}

export class NewsIntelligenceService {
  constructor(private readonly registry = new NewsSourceRegistryService()) {}

  normalizeArticle(raw: RawNewsArticleInput): NormalizedNewsArticle {
    if (!raw.title || !raw.title.trim()) throw new Error("Article title is required");
    if (!raw.url || !/^https?:\/\//i.test(raw.url.trim())) throw new Error("Valid article URL is required");
    const rawPublishedAt = new Date(raw.publishedAt);
    const collectedAt = raw.collectedAt ? new Date(raw.collectedAt) : new Date();
    if (!Number.isFinite(rawPublishedAt.getTime()) || !Number.isFinite(collectedAt.getTime())) {
      throw new Error("Invalid article timestamp");
    }
    // Guard against future-spoofed publication timestamps exceeding collection time
    const publishedAt =
      rawPublishedAt.getTime() > collectedAt.getTime() + 5 * 60_000
        ? new Date(collectedAt.getTime())
        : rawPublishedAt;

    const cleanTitle = sanitizeUntrustedArticleText(raw.title);
    const cleanSummary = sanitizeUntrustedArticleText(raw.summary ?? "");
    const cleanSnippet = sanitizeUntrustedArticleText(raw.contentSnippet ?? "");
    const promptInjectionSanitized = cleanTitle.sanitized || cleanSummary.sanitized || cleanSnippet.sanitized;

    const source = this.registry.getSource(raw.sourceKey);
    const contentHash = NewsDeduplicationService.computeContentHash(
      raw.sourceKey,
      cleanTitle.text,
      cleanSummary.text,
      publishedAt.toISOString()
    );
    const titleFingerprint = NewsDeduplicationService.computeTitleFingerprint(cleanTitle.text);
    const entities = NewsEntityExtractionService.extractEntities(cleanTitle.text, `${cleanSummary.text} ${cleanSnippet.text}`);
    const classification = NewsClassificationService.classify(cleanTitle.text, cleanSummary.text);
    const credibility = NewsCredibilityService.evaluateCredibility(source, 1, true, classification.directionBias === "conflicting");
    const facts = NewsFactExtractionService.extractFacts(cleanTitle.text, cleanSummary.text, raw.url.trim(), classification.category);
    const affectedInstruments = NewsImpactAnalysisService.mapAffectedInstruments(
      entities,
      classification.category,
      classification.directionBias
    );
    const relevanceScore = affectedInstruments.length > 0 ? affectedInstruments[0]!.relevanceScore : 35;

    return {
      sourceKey: raw.sourceKey,
      ...(raw.externalId ? { externalId: raw.externalId } : {}),
      url: raw.url.trim(),
      title: cleanTitle.text,
      summary: cleanSummary.text,
      contentSnippet: cleanSnippet.text,
      ...(raw.author ? { author: raw.author.trim().slice(0, 120) } : {}),
      publishedAt,
      collectedAt,
      contentHash,
      titleFingerprint,
      promptInjectionSanitized,
      category: classification.category,
      importance: classification.importance,
      directionBias: classification.directionBias,
      credibilityScore: credibility.score,
      relevanceScore,
      entities,
      facts,
      affectedInstruments
    };
  }
}
