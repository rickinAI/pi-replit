var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/db.ts
var db_exports = {};
__export(db_exports, {
  getPool: () => getPool,
  init: () => init2
});
import pg from "pg";
async function init2() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("[db] DATABASE_URL not set");
  }
  pool = new pg.Pool({ connectionString, max: 10 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New conversation',
      messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      synced_at BIGINT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      due_date TEXT,
      priority TEXT NOT NULL DEFAULT 'medium',
      completed BOOLEAN NOT NULL DEFAULT false,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      tags JSONB DEFAULT '[]'::jsonb
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at BIGINT NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      service TEXT PRIMARY KEY,
      tokens JSONB NOT NULL,
      updated_at BIGINT NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_history (
      id SERIAL PRIMARY KEY,
      job_id TEXT NOT NULL,
      job_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      summary TEXT,
      saved_to TEXT,
      duration_ms INTEGER,
      agent_id TEXT,
      model_used TEXT,
      tokens_input INTEGER,
      tokens_output INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_job_history_created ON job_history(created_at DESC)`);
  await pool.query(`ALTER TABLE job_history ADD COLUMN IF NOT EXISTS agent_id TEXT`);
  await pool.query(`ALTER TABLE job_history ADD COLUMN IF NOT EXISTS model_used TEXT`);
  await pool.query(`ALTER TABLE job_history ADD COLUMN IF NOT EXISTS tokens_input INTEGER`);
  await pool.query(`ALTER TABLE job_history ADD COLUMN IF NOT EXISTS tokens_output INTEGER`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_activity (
      id SERIAL PRIMARY KEY,
      agent TEXT NOT NULL,
      task TEXT,
      conversation_id TEXT,
      conversation_title TEXT,
      duration_ms INTEGER,
      saved_to TEXT,
      created_at BIGINT NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_agent_activity_created ON agent_activity(created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vault_inbox (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT,
      file_path TEXT,
      tags JSONB DEFAULT '[]'::jsonb,
      summary TEXT,
      source TEXT DEFAULT 'drop-box',
      status TEXT NOT NULL DEFAULT 'processing',
      error TEXT,
      created_at BIGINT NOT NULL
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_vault_inbox_created ON vault_inbox(created_at DESC)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_inbox_url ON vault_inbox(url)`);
  console.log("[db] PostgreSQL initialized (shared pool, 7 tables)");
  return pool;
}
function getPool() {
  if (!pool) throw new Error("[db] Not initialized \u2014 call init() first");
  return pool;
}
var pool;
var init_db = __esm({
  "src/db.ts"() {
    "use strict";
    pool = null;
  }
});

// src/coingecko.ts
import * as fs2 from "fs";
import * as path2 from "path";
function getApiHeaders() {
  const headers2 = { "User-Agent": "darknode/1.0" };
  const apiKey = process.env.COINGECKO_API_KEY;
  if (apiKey) {
    headers2["x-cg-demo-api-key"] = apiKey;
  }
  return headers2;
}
async function cgFetch(urlPath) {
  await rateLimiter.acquire();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS3);
  try {
    const url = `${BASE_URL}${urlPath}`;
    const res = await fetch(url, {
      headers: getApiHeaders(),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) {
      throw new Error(`CoinGecko API error ${res.status}: ${res.statusText}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("CoinGecko request timed out");
    throw err;
  }
}
function resolveId(input) {
  const key = input.toLowerCase().trim().replace(/^\$/, "");
  return CRYPTO_ALIASES2[key] || key;
}
function ensureCacheDir() {
  if (!fs2.existsSync(CACHE_DIR)) {
    fs2.mkdirSync(CACHE_DIR, { recursive: true });
  }
}
async function getTrending() {
  const data = await cgFetch("/search/trending");
  const rawCoins = data.coins?.slice(0, 15) || [];
  const coins = rawCoins.map((item) => {
    const c = item.item;
    return {
      name: c.name,
      symbol: c.symbol?.toUpperCase() || "",
      market_cap_rank: c.market_cap_rank || null,
      price_usd: c.data?.price ? parseFloat(c.data.price) : null,
      change_24h_pct: c.data?.price_change_percentage_24h?.usd ?? null
    };
  });
  const rawCats = data.categories?.slice(0, 5) || [];
  const categories = rawCats.map((cat) => ({
    name: cat.name,
    market_cap_change_24h_pct: cat.data?.market_cap_change_percentage_24h ?? null
  }));
  return { coins, categories };
}
async function getMovers(direction = "gainers", limit = 20) {
  const data = await cgFetch(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h,7d`);
  if (!Array.isArray(data) || data.length === 0) return { direction, coins: [] };
  const sorted = [...data].sort((a, b) => {
    const aChange = a.price_change_percentage_24h ?? 0;
    const bChange = b.price_change_percentage_24h ?? 0;
    return direction === "gainers" ? bChange - aChange : aChange - bChange;
  });
  const coins = sorted.slice(0, limit).map((coin) => ({
    name: coin.name,
    symbol: (coin.symbol || "").toUpperCase(),
    price_usd: coin.current_price,
    change_24h_pct: coin.price_change_percentage_24h ?? null,
    change_7d_pct: coin.price_change_percentage_7d_in_currency ?? null,
    market_cap: coin.market_cap
  }));
  return { direction, coins };
}
async function getCategories(limit = 20) {
  const data = await cgFetch("/coins/categories?order=market_cap_change_percentage_24h_desc");
  if (!Array.isArray(data) || data.length === 0) return { categories: [] };
  const categories = data.slice(0, limit).map((cat) => ({
    name: cat.name,
    change_24h_pct: cat.market_cap_change_percentage_24h ?? null,
    market_cap: cat.market_cap ?? null,
    volume_24h: cat.total_volume ?? null
  }));
  return { categories };
}
async function getMarketOverview() {
  const data = await cgFetch("/global");
  const g = data.data;
  if (!g) throw new Error("No global market data available");
  return {
    total_market_cap_usd: g.total_market_cap?.usd || 0,
    total_volume_24h_usd: g.total_volume?.usd || 0,
    btc_dominance_pct: g.market_cap_percentage?.btc || 0,
    eth_dominance_pct: g.market_cap_percentage?.eth || 0,
    active_cryptocurrencies: g.active_cryptocurrencies || 0,
    market_cap_change_24h_pct: g.market_cap_change_percentage_24h_usd ?? 0
  };
}
async function getHistoricalOHLCV(coin, days = 90) {
  const coinId = resolveId(coin);
  ensureCacheDir();
  const cacheFile = path2.join(CACHE_DIR, `${coinId}_${days}d_hourly.json`);
  if (fs2.existsSync(cacheFile)) {
    try {
      const raw = fs2.readFileSync(cacheFile, "utf-8");
      const cached2 = JSON.parse(raw);
      const ageMs = Date.now() - cached2.fetchedAt;
      if (ageMs < 36e5 && cached2.candles.length > 0) {
        return cached2.candles;
      }
    } catch {
    }
  }
  const data = await cgFetch(`/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}`);
  const prices = data.prices || [];
  const volumes = data.total_volumes || [];
  const volumeMap = /* @__PURE__ */ new Map();
  for (const [ts, vol] of volumes) {
    const hourKey = Math.floor(ts / 36e5) * 36e5;
    volumeMap.set(hourKey, vol);
  }
  const hourBuckets = /* @__PURE__ */ new Map();
  for (const [ts, price] of prices) {
    const hourKey = Math.floor(ts / 36e5) * 36e5;
    if (!hourBuckets.has(hourKey)) {
      hourBuckets.set(hourKey, { prices: [], volume: volumeMap.get(hourKey) || 0 });
    }
    hourBuckets.get(hourKey).prices.push(price);
  }
  const candles = [];
  const sortedKeys = Array.from(hourBuckets.keys()).sort((a, b) => a - b);
  for (const hourKey of sortedKeys) {
    const bucket = hourBuckets.get(hourKey);
    const p = bucket.prices;
    candles.push({
      timestamp: hourKey,
      open: p[0],
      high: Math.max(...p),
      low: Math.min(...p),
      close: p[p.length - 1],
      volume: bucket.volume
    });
  }
  const cacheEntry = { fetchedAt: Date.now(), candles };
  try {
    fs2.writeFileSync(cacheFile, JSON.stringify(cacheEntry));
  } catch (err) {
    console.warn("[coingecko] cache write error:", err);
  }
  return candles;
}
async function getHistoricalOHLCVFormatted(coin, days = 90) {
  const candles = await getHistoricalOHLCV(coin, days);
  if (candles.length === 0) throw new Error(`No historical data found for "${coin}"`);
  const coinId = resolveId(coin);
  const last = candles[candles.length - 1];
  const first = candles[0];
  const periodReturn = (last.close - first.open) / first.open * 100;
  const periodHigh = Math.max(...candles.map((c) => c.high));
  const periodLow = Math.min(...candles.map((c) => c.low));
  return {
    coin_id: coinId,
    days,
    candle_count: candles.length,
    period_start: new Date(first.timestamp).toISOString().slice(0, 10),
    period_end: new Date(last.timestamp).toISOString().slice(0, 10),
    current_price: last.close,
    period_high: periodHigh,
    period_low: periodLow,
    period_return_pct: parseFloat(periodReturn.toFixed(2))
  };
}
var TIMEOUT_MS3, BASE_URL, CACHE_DIR, CRYPTO_ALIASES2, RateLimiter, rateLimiter;
var init_coingecko = __esm({
  "src/coingecko.ts"() {
    "use strict";
    TIMEOUT_MS3 = 15e3;
    BASE_URL = "https://api.coingecko.com/api/v3";
    CACHE_DIR = path2.join(process.env.HOME || "/tmp", ".cache", "coingecko");
    CRYPTO_ALIASES2 = {
      btc: "bitcoin",
      bitcoin: "bitcoin",
      eth: "ethereum",
      ethereum: "ethereum",
      sol: "solana",
      solana: "solana",
      doge: "dogecoin",
      dogecoin: "dogecoin",
      ada: "cardano",
      cardano: "cardano",
      xrp: "ripple",
      ripple: "ripple",
      dot: "polkadot",
      polkadot: "polkadot",
      matic: "matic-network",
      polygon: "matic-network",
      avax: "avalanche-2",
      avalanche: "avalanche-2",
      link: "chainlink",
      chainlink: "chainlink",
      bnb: "binancecoin",
      binancecoin: "binancecoin",
      ltc: "litecoin",
      litecoin: "litecoin",
      shib: "shiba-inu",
      uni: "uniswap",
      uniswap: "uniswap",
      atom: "cosmos",
      cosmos: "cosmos",
      near: "near",
      apt: "aptos",
      aptos: "aptos",
      arb: "arbitrum",
      arbitrum: "arbitrum",
      op: "optimism",
      optimism: "optimism",
      sui: "sui",
      pepe: "pepe",
      bnkr: "bankr",
      bankr: "bankr",
      virtual: "virtual-protocol",
      virtuals: "virtual-protocol"
    };
    RateLimiter = class {
      tokens;
      maxTokens;
      refillRate;
      lastRefill;
      queue = [];
      processing = false;
      constructor(maxPerMinute) {
        this.maxTokens = maxPerMinute;
        this.tokens = maxPerMinute;
        this.refillRate = maxPerMinute / 60;
        this.lastRefill = Date.now();
      }
      async acquire() {
        return new Promise((resolve) => {
          this.queue.push(resolve);
          this.processQueue();
        });
      }
      async processQueue() {
        if (this.processing) return;
        this.processing = true;
        while (this.queue.length > 0) {
          this.refill();
          if (this.tokens >= 1) {
            this.tokens -= 1;
            const next = this.queue.shift();
            if (next) next();
          } else {
            const waitMs = Math.ceil((1 - this.tokens) / this.refillRate * 1e3);
            await new Promise((r) => setTimeout(r, Math.max(waitMs, 100)));
          }
        }
        this.processing = false;
      }
      refill() {
        const now = Date.now();
        const elapsed = (now - this.lastRefill) / 1e3;
        this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
        this.lastRefill = now;
      }
    };
    rateLimiter = new RateLimiter(10);
  }
});

// src/technical-signals.ts
async function loadCryptoSignalParams() {
  const now = Date.now();
  if (_dbParamsCache && now - _dbParamsCacheTime < DB_PARAMS_CACHE_TTL) {
    return _dbParamsCache;
  }
  try {
    const pool2 = getPool();
    const res = await pool2.query("SELECT value FROM app_config WHERE key = 'crypto_signal_parameters'");
    if (res.rows.length > 0) {
      const parsed = typeof res.rows[0].value === "string" ? JSON.parse(res.rows[0].value) : res.rows[0].value;
      _dbParamsCache = parsed;
      _dbParamsCacheTime = now;
      return _dbParamsCache;
    }
  } catch {
  }
  return {};
}
function invalidateCryptoParamsCache() {
  _dbParamsCache = null;
  _dbParamsCacheTime = 0;
}
function checkCooldown(assetId, cooldownBars = DEFAULT_CONFIG.cooldown_bars) {
  const entry = cooldownTracker.get(assetId);
  if (!entry) return { inCooldown: false, detail: "No recent signals" };
  const cooldownMs = cooldownBars * BAR_INTERVAL_MS;
  const elapsed = Date.now() - entry.lastSignalTime;
  if (elapsed < cooldownMs) {
    const remaining = Math.ceil((cooldownMs - elapsed) / (60 * 1e3));
    return { inCooldown: true, detail: `Cooldown active (${remaining}min remaining after ${entry.lastSignalType}, ${cooldownBars}-bar)` };
  }
  return { inCooldown: false, detail: "Cooldown expired" };
}
function recordSignal(assetId, signalType) {
  cooldownTracker.set(assetId, { lastSignalTime: Date.now(), lastSignalType: signalType });
}
function ema(data, period) {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}
function clamp(v, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v));
}
function computeEMACrossover(closes, cfg) {
  const name = "ema_crossover";
  if (!cfg.enable_ema) {
    return { name, score: 0, enabled: false, detail: "DISABLED", bull_vote: false, bear_vote: false };
  }
  if (closes.length < cfg.ema_slow + 5) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for EMA", bull_vote: false, bear_vote: false };
  }
  const fast = ema(closes, cfg.ema_fast);
  const slow = ema(closes, cfg.ema_slow);
  const idx = closes.length - 1;
  const fastVal = fast[idx];
  const slowVal = slow[idx];
  const diff = (fastVal - slowVal) / slowVal;
  const prevDiff = idx > 0 ? (fast[idx - 1] - slow[idx - 1]) / slow[idx - 1] : diff;
  const crossingUp = prevDiff <= 0 && diff > 0;
  let score;
  if (crossingUp) {
    score = 0.85;
  } else if (diff > 0.02) {
    score = clamp(0.5 + diff * 10, 0.5, 0.9);
  } else if (diff > 0) {
    score = clamp(0.4 + diff * 20, 0.3, 0.6);
  } else if (diff > -0.02) {
    score = clamp(0.3 + diff * 10, 0.1, 0.4);
  } else {
    score = clamp(0.1 + (diff + 0.1) * 5, 0, 0.2);
  }
  const bull_vote = fastVal > slowVal;
  const bear_vote = fastVal < slowVal;
  const detail = `EMA${cfg.ema_fast}=${fastVal.toFixed(4)} vs EMA${cfg.ema_slow}=${slowVal.toFixed(4)}, diff=${(diff * 100).toFixed(2)}%${crossingUp ? " [CROSS UP]" : ""}`;
  return { name, score: clamp(score), enabled: true, detail, bull_vote, bear_vote };
}
function computeRSI(closes, cfg) {
  const name = "rsi";
  if (!cfg.enable_rsi) {
    return { name, score: 0, enabled: false, detail: "DISABLED", bull_vote: false, bear_vote: false, rsi_value: 50 };
  }
  const period = cfg.rsi_period;
  if (closes.length < period + 2) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for RSI", bull_vote: false, bear_vote: false, rsi_value: 50 };
  }
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  let rsi;
  if (avgLoss === 0 && avgGain === 0) {
    rsi = 50;
  } else if (avgLoss === 0) {
    rsi = 100;
  } else {
    const rs = avgGain / avgLoss;
    rsi = 100 - 100 / (1 + rs);
  }
  let score;
  if (rsi <= cfg.rsi_oversold) {
    score = clamp(0.7 + (cfg.rsi_oversold - rsi) / cfg.rsi_oversold * 0.3, 0.7, 1);
  } else if (rsi >= cfg.rsi_overbought) {
    score = clamp(0.3 - (rsi - cfg.rsi_overbought) / (100 - cfg.rsi_overbought) * 0.3, 0, 0.3);
  } else {
    const mid = (cfg.rsi_oversold + cfg.rsi_overbought) / 2;
    if (rsi < mid) {
      score = clamp(0.5 + (mid - rsi) / (mid - cfg.rsi_oversold) * 0.2, 0.5, 0.7);
    } else {
      score = clamp(0.5 - (rsi - mid) / (cfg.rsi_overbought - mid) * 0.2, 0.3, 0.5);
    }
  }
  const bull_vote = rsi < 45;
  const bear_vote = rsi > 55;
  const detail = `RSI(${period})=${rsi.toFixed(1)} [oversold<${cfg.rsi_oversold}, overbought>${cfg.rsi_overbought}]`;
  return { name, score: clamp(score), enabled: true, detail, bull_vote, bear_vote, rsi_value: rsi };
}
function computeMomentum(closes, cfg) {
  const name = "momentum";
  if (!cfg.enable_momentum) {
    return { name, score: 0, enabled: false, detail: "DISABLED", bull_vote: false, bear_vote: false };
  }
  const lookback = cfg.momentum_lookback;
  if (closes.length < lookback + 1) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for momentum", bull_vote: false, bear_vote: false };
  }
  const current = closes[closes.length - 1];
  const pastIdx = closes.length - 1 - lookback;
  const ret = pastIdx >= 0 ? (current - closes[pastIdx]) / closes[pastIdx] : 0;
  let score;
  if (ret > 0.05) {
    score = clamp(0.7 + ret * 3, 0.7, 0.95);
  } else if (ret > 0.01) {
    score = clamp(0.5 + ret * 5, 0.5, 0.7);
  } else if (ret > -0.01) {
    score = 0.45;
  } else if (ret > -0.05) {
    score = clamp(0.3 + (ret + 0.05) * 5, 0.2, 0.4);
  } else {
    score = clamp(0.1 + (ret + 0.1) * 2, 0, 0.2);
  }
  const threshold = 5e-3;
  const bull_vote = ret > threshold;
  const bear_vote = ret < -threshold;
  const retPct = (ret * 100).toFixed(2);
  const detail = `Momentum(${lookback}-bar): ${retPct}%`;
  return { name, score: clamp(score), enabled: true, detail, bull_vote, bear_vote };
}
function computeVeryShortMomentum(closes, cfg) {
  const name = "very_short_momentum";
  if (!cfg.enable_very_short_momentum) {
    return { name, score: 0, enabled: false, detail: "DISABLED", bull_vote: false, bear_vote: false };
  }
  const lookback = cfg.very_short_momentum_lookback;
  if (closes.length < lookback + 1) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for very-short momentum", bull_vote: false, bear_vote: false };
  }
  const current = closes[closes.length - 1];
  const pastIdx = closes.length - 1 - lookback;
  const ret = pastIdx >= 0 ? (current - closes[pastIdx]) / closes[pastIdx] : 0;
  let score;
  if (ret > 0.03) {
    score = clamp(0.7 + ret * 5, 0.7, 0.95);
  } else if (ret > 5e-3) {
    score = clamp(0.5 + ret * 8, 0.5, 0.7);
  } else if (ret > -5e-3) {
    score = 0.45;
  } else if (ret > -0.03) {
    score = clamp(0.3 + (ret + 0.03) * 8, 0.2, 0.4);
  } else {
    score = clamp(0.1 + (ret + 0.06) * 3, 0, 0.2);
  }
  const bull_vote = ret > 0;
  const bear_vote = ret < 0;
  const retPct = (ret * 100).toFixed(2);
  const detail = `VeryShort Momentum(${lookback}-bar): ${retPct}%`;
  return { name, score: clamp(score), enabled: true, detail, bull_vote, bear_vote };
}
function computeMACD(closes, cfg) {
  const name = "macd";
  if (!cfg.enable_macd) {
    return { name, score: 0, enabled: false, detail: "DISABLED", bull_vote: false, bear_vote: false };
  }
  if (closes.length < cfg.macd_slow + cfg.macd_signal + 5) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for MACD", bull_vote: false, bear_vote: false };
  }
  const fastEMA = ema(closes, cfg.macd_fast);
  const slowEMA = ema(closes, cfg.macd_slow);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(fastEMA[i] - slowEMA[i]);
  }
  const signalLine = ema(macdLine, cfg.macd_signal);
  const idx = closes.length - 1;
  const histogram = macdLine[idx] - signalLine[idx];
  const prevHistogram = idx > 0 ? macdLine[idx - 1] - signalLine[idx - 1] : histogram;
  const crossingUp = prevHistogram <= 0 && histogram > 0;
  let score;
  const normHist = histogram / closes[idx];
  if (crossingUp) {
    score = 0.8;
  } else if (normHist > 1e-3) {
    score = clamp(0.5 + normHist * 200, 0.5, 0.85);
  } else if (normHist > 0) {
    score = clamp(0.4 + normHist * 500, 0.35, 0.55);
  } else {
    score = clamp(0.3 + normHist * 200, 0.05, 0.35);
  }
  const bull_vote = histogram > 0 || crossingUp;
  const bear_vote = histogram < 0 && !crossingUp;
  const detail = `MACD(${cfg.macd_fast},${cfg.macd_slow},${cfg.macd_signal}): line=${macdLine[idx].toFixed(4)}, signal=${signalLine[idx].toFixed(4)}, hist=${histogram.toFixed(4)}${crossingUp ? " [CROSS UP]" : ""}`;
  return { name, score: clamp(score), enabled: true, detail, bull_vote, bear_vote };
}
function computeBBWidth(closes, cfg) {
  const name = "bb_width";
  if (!cfg.enable_bb) {
    return { name, score: 0, enabled: false, detail: "DISABLED", bull_vote: false, bear_vote: false };
  }
  if (closes.length < cfg.bb_period + 50) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for BB width", bull_vote: false, bear_vote: false };
  }
  const period = cfg.bb_period;
  const widths = [];
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - mean) ** 2;
    const std = Math.sqrt(variance / period);
    widths.push(2 * 2 * std / mean);
  }
  const currentWidth = widths[widths.length - 1];
  const sortedWidths = [...widths].sort((a, b) => a - b);
  const percentileIdx = Math.floor(sortedWidths.length * (1 - cfg.bb_percentile_threshold / 100));
  const isCompressed = currentWidth <= sortedWidths[Math.max(0, percentileIdx)];
  let score;
  if (isCompressed) {
    const rank = sortedWidths.indexOf(sortedWidths.find((w) => w >= currentWidth) || currentWidth);
    const percentile = rank / sortedWidths.length;
    score = clamp(0.6 + (1 - percentile) * 0.35, 0.6, 0.95);
  } else {
    score = clamp(0.3 + (1 - currentWidth / sortedWidths[sortedWidths.length - 1]) * 0.2, 0.2, 0.45);
  }
  const bull_vote = isCompressed;
  const bear_vote = !isCompressed;
  const pctile = (widths.filter((w) => w <= currentWidth).length / widths.length * 100).toFixed(0);
  const detail = `BB Width(${period}): ${(currentWidth * 100).toFixed(2)}%, percentile=${pctile}%${isCompressed ? " [COMPRESSED]" : ""}`;
  return { name, score: clamp(score), enabled: true, detail, bull_vote, bear_vote };
}
function computeATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const trueRanges = [];
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  let atr = 0;
  for (let i = 0; i < period; i++) {
    atr += trueRanges[trueRanges.length - period + i];
  }
  atr /= period;
  return atr;
}
function classifyRegime(closes, cfg) {
  if (closes.length < cfg.ema_slow + 10) return "RANGING";
  const fast = ema(closes, cfg.ema_fast);
  const slow = ema(closes, cfg.ema_slow);
  const idx = closes.length - 1;
  const slopeWindow = Math.min(10, idx);
  const slopeStart = fast[idx - slopeWindow];
  const slopeEnd = fast[idx];
  const slope = (slopeEnd - slopeStart) / slopeStart;
  const lookback = Math.min(cfg.vol_lookback_bars, closes.length - 1);
  const returns = [];
  for (let i = closes.length - lookback; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const vol = Math.sqrt(variance);
  const annualizedVol = vol * Math.sqrt(24 * 365);
  if (annualizedVol > 1.5) return "VOLATILE";
  if (Math.abs(slope) > 0.01) return "TRENDING";
  return "RANGING";
}
function computeVolAdjustedThreshold(closes, cfg) {
  const lookback = Math.min(cfg.vol_lookback_bars, closes.length - 1);
  if (lookback < 5) return cfg.vote_threshold;
  const returns = [];
  for (let i = closes.length - lookback; i < closes.length; i++) {
    if (i > 0) returns.push(Math.abs((closes[i] - closes[i - 1]) / closes[i - 1]));
  }
  if (returns.length === 0) return cfg.vote_threshold;
  const avgAbsReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const annualizedVol = avgAbsReturn * Math.sqrt(24 * 365);
  if (annualizedVol > 2) return Math.min(cfg.vote_threshold + 1, 6);
  if (annualizedVol < 0.5) return Math.max(cfg.vote_threshold - 1, 3);
  return cfg.vote_threshold;
}
function computeBTCConfirmation(btcCandles, cfg) {
  if (btcCandles.length < cfg.momentum_lookback + 1) {
    return { btc_momentum_bull: false, btc_momentum_bear: false, detail: "Insufficient BTC data" };
  }
  const closes = btcCandles.map((c) => c.close);
  const current = closes[closes.length - 1];
  const pastIdx = closes.length - 1 - cfg.momentum_lookback;
  const ret = pastIdx >= 0 ? (current - closes[pastIdx]) / closes[pastIdx] : 0;
  return {
    btc_momentum_bull: ret > 0,
    btc_momentum_bear: ret < -0.01,
    detail: `BTC momentum(${cfg.momentum_lookback}-bar): ${(ret * 100).toFixed(2)}%`
  };
}
function analyzeAsset(candles, config3, btcCandles, assetId) {
  const cfg = { ...DEFAULT_CONFIG, ...config3 };
  const closes = candles.map((c) => c.close);
  const currentPrice = closes.length > 0 ? closes[closes.length - 1] : 0;
  if (closes.length < 30) {
    return {
      technical_score: 0,
      regime: "RANGING",
      atr_value: 0,
      atr_stop_price: 0,
      atr_stop_multiplier: cfg.atr_stop_multiplier,
      current_price: currentPrice,
      signals: [],
      votes: { bull_votes: 0, bear_votes: 0, total_signals: 0, vote_summary: "0/0", entry_signal: false, exit_long_signal: false, exit_short_signal: false, rsi_overbought: false, rsi_oversold: false },
      active_signal_count: 0,
      data_quality: "insufficient",
      parameters_validated: false,
      vol_adjusted_threshold: cfg.vote_threshold,
      reason: `Only ${closes.length} candles available, need at least 30`
    };
  }
  const rsiResult = computeRSI(closes, cfg);
  const rsiValue = rsiResult.rsi_value;
  const signals = [
    computeEMACrossover(closes, cfg),
    rsiResult,
    computeMomentum(closes, cfg),
    computeVeryShortMomentum(closes, cfg),
    computeMACD(closes, cfg),
    computeBBWidth(closes, cfg)
  ];
  const activeSignals = signals.filter((s) => s.enabled);
  const regime = classifyRegime(closes, cfg);
  const atrValue = computeATR(candles, cfg.atr_period);
  const atrStopPrice = currentPrice - atrValue * cfg.atr_stop_multiplier;
  const volAdjustedThreshold = computeVolAdjustedThreshold(closes, cfg);
  if (activeSignals.length < 2) {
    return {
      technical_score: 0,
      regime,
      atr_value: atrValue,
      atr_stop_price: atrStopPrice,
      atr_stop_multiplier: cfg.atr_stop_multiplier,
      current_price: currentPrice,
      signals,
      votes: { bull_votes: 0, bear_votes: 0, total_signals: 0, vote_summary: "0/0", entry_signal: false, exit_long_signal: false, exit_short_signal: false, rsi_overbought: false, rsi_oversold: false },
      active_signal_count: activeSignals.length,
      data_quality: "insufficient",
      parameters_validated: false,
      vol_adjusted_threshold: volAdjustedThreshold,
      reason: "Fewer than 2 active signals with data"
    };
  }
  let bull_votes = 0;
  let bear_votes = 0;
  for (const sig of activeSignals) {
    if (sig.bull_vote) bull_votes++;
    if (sig.bear_vote) bear_votes++;
  }
  const total_signals = activeSignals.length;
  const rsi_overbought = rsiValue >= cfg.rsi_overbought;
  const rsi_oversold = rsiValue <= cfg.rsi_oversold;
  const entry_signal = bull_votes >= volAdjustedThreshold;
  const exit_long_signal = rsi_overbought;
  const exit_short_signal = rsi_oversold;
  const votes = {
    bull_votes,
    bear_votes,
    total_signals,
    vote_summary: `${bull_votes}/${total_signals}`,
    entry_signal,
    exit_long_signal,
    exit_short_signal,
    rsi_overbought,
    rsi_oversold
  };
  const SIGNAL_WEIGHTS = {
    ema_crossover: 0.4,
    rsi: 0.25,
    momentum: 0.15,
    very_short_momentum: 0.05,
    macd: 0.1,
    bb_width: 0.03,
    volatility_regime: 0.02
  };
  let weightedSum = 0;
  let totalWeight = 0;
  for (const sig of activeSignals) {
    const w = SIGNAL_WEIGHTS[sig.name] ?? 0.05;
    weightedSum += sig.score * w;
    totalWeight += w;
  }
  const technicalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  let btcConfirmation;
  if (btcCandles && btcCandles.length > cfg.momentum_lookback + 1) {
    const btcResult = computeBTCConfirmation(btcCandles, cfg);
    btcConfirmation = {
      ...btcResult,
      alt_entry_allowed: !btcResult.btc_momentum_bear
    };
    if (btcResult.btc_momentum_bear && entry_signal) {
      votes.entry_signal = false;
    }
  }
  let cooldownResult;
  if (assetId) {
    const cd = checkCooldown(assetId, cfg.cooldown_bars);
    cooldownResult = { in_cooldown: cd.inCooldown, detail: cd.detail };
    if (cd.inCooldown && votes.entry_signal) {
      votes.entry_signal = false;
    }
  }
  return {
    technical_score: parseFloat(technicalScore.toFixed(3)),
    regime,
    atr_value: parseFloat(atrValue.toFixed(6)),
    atr_stop_price: parseFloat(atrStopPrice.toFixed(6)),
    atr_stop_multiplier: cfg.atr_stop_multiplier,
    current_price: currentPrice,
    signals,
    votes,
    active_signal_count: activeSignals.length,
    data_quality: "sufficient",
    parameters_validated: false,
    vol_adjusted_threshold: volAdjustedThreshold,
    btc_confirmation: btcConfirmation,
    cooldown: cooldownResult
  };
}
var DEFAULT_CONFIG, _dbParamsCache, _dbParamsCacheTime, DB_PARAMS_CACHE_TTL, cooldownTracker, BAR_INTERVAL_MS;
var init_technical_signals = __esm({
  "src/technical-signals.ts"() {
    "use strict";
    init_db();
    DEFAULT_CONFIG = {
      ema_fast: 7,
      ema_slow: 26,
      rsi_period: 8,
      rsi_overbought: 69,
      rsi_oversold: 31,
      momentum_lookback: 12,
      very_short_momentum_lookback: 6,
      macd_fast: 14,
      macd_slow: 23,
      macd_signal: 9,
      bb_period: 7,
      bb_percentile_threshold: 90,
      vol_lookback_bars: 24,
      atr_period: 14,
      atr_stop_multiplier: 5.5,
      vote_threshold: 4,
      cooldown_bars: 2,
      enable_ema: true,
      enable_rsi: true,
      enable_momentum: true,
      enable_very_short_momentum: true,
      enable_macd: true,
      enable_bb: true,
      enable_volatility_regime: true
    };
    _dbParamsCache = null;
    _dbParamsCacheTime = 0;
    DB_PARAMS_CACHE_TTL = 3e5;
    cooldownTracker = /* @__PURE__ */ new Map();
    BAR_INTERVAL_MS = 60 * 60 * 1e3;
  }
});

// src/signal-sources.ts
var signal_sources_exports = {};
__export(signal_sources_exports, {
  getBinanceFundingRates: () => getBinanceFundingRates,
  getBinanceSignals: () => getBinanceSignals,
  getCryptoLiquidations: () => getCryptoLiquidations,
  getCryptoSentiment: () => getCryptoSentiment,
  getDefiLlamaData: () => getDefiLlamaData,
  getDefiLlamaYields: () => getDefiLlamaYields,
  getEnhancedCoinGeckoData: () => getEnhancedCoinGeckoData,
  getFearGreedIndex: () => getFearGreedIndex,
  getOpenInterestHistory: () => getOpenInterestHistory,
  scanBinanceWatchlist: () => scanBinanceWatchlist
});
function cached(key, ttlMs, fn) {
  const entry = CACHE.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return Promise.resolve(entry.data);
  return fn().then((data) => {
    if (CACHE.size >= CACHE_MAX_SIZE) {
      const oldest = [...CACHE.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) CACHE.delete(oldest[0]);
    }
    CACHE.set(key, { data, ts: Date.now() });
    return data;
  });
}
async function fetchJSON(url, timeoutMs = 15e3) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "DarkNode/1.0", "Accept": "application/json" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
async function getFearGreedIndex() {
  return cached("fear_greed", CACHE_TTL2, async () => {
    const data = await fetchJSON("https://api.alternative.me/fng/?limit=2&format=json");
    const entries = data?.data || [];
    const current = entries[0];
    const prev = entries[1] || null;
    const val = parseInt(current?.value || "50");
    let classification = current?.value_classification || "Neutral";
    let regime;
    if (val <= 25) regime = "EXTREME_FEAR";
    else if (val <= 40) regime = "FEAR";
    else if (val <= 60) regime = "NEUTRAL";
    else if (val <= 75) regime = "GREED";
    else regime = "EXTREME_GREED";
    return {
      value: val,
      classification,
      timestamp: new Date(parseInt(current?.timestamp || "0") * 1e3).toISOString(),
      previous: prev ? {
        value: parseInt(prev.value),
        classification: prev.value_classification
      } : null,
      regime_signal: regime
    };
  });
}
async function getBinanceSignals(symbol = "BTCUSDT") {
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const pair = sym.endsWith("USDT") ? sym : sym + "USDT";
  return cached(`binance_signal_${pair}`, CACHE_TTL2, async () => {
    const [ticker, klines1h, klines4h, klines1d] = await Promise.all([
      fetchJSON(`https://api.binance.us/api/v3/ticker/24hr?symbol=${pair}`),
      fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${pair}&interval=1h&limit=50`),
      fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${pair}&interval=4h&limit=50`),
      fetchJSON(`https://api.binance.us/api/v3/klines?symbol=${pair}&interval=1d&limit=30`)
    ]);
    const price = parseFloat(ticker.lastPrice);
    const vol24h = parseFloat(ticker.quoteVolume);
    const priceChange = parseFloat(ticker.priceChangePercent);
    const analyze = (klines, tf) => {
      if (!klines || klines.length < 14) return { timeframe: tf, error: "insufficient data" };
      const closes = klines.map((k) => parseFloat(k[4]));
      const highs = klines.map((k) => parseFloat(k[2]));
      const lows = klines.map((k) => parseFloat(k[3]));
      const volumes = klines.map((k) => parseFloat(k[5]));
      const rsi = calcRSI(closes, 14);
      const sma20 = closes.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, closes.length);
      const sma50 = closes.length >= 50 ? closes.slice(-50).reduce((s, v) => s + v, 0) / 50 : sma20;
      const ema12 = calcEMA(closes, 12);
      const ema26 = calcEMA(closes, 26);
      const macd = ema12 - ema26;
      const atr = calcATR(highs, lows, closes, 14);
      const avgVol = volumes.slice(-20).reduce((s, v) => s + v, 0) / Math.min(20, volumes.length);
      const volRatio = volumes[volumes.length - 1] / (avgVol || 1);
      const lastClose = closes[closes.length - 1];
      let bullVotes = 0, bearVotes = 0;
      if (lastClose > sma20) bullVotes++;
      else bearVotes++;
      if (sma20 > sma50) bullVotes++;
      else bearVotes++;
      if (macd > 0) bullVotes++;
      else bearVotes++;
      if (rsi > 50 && rsi < 70) bullVotes++;
      else if (rsi < 50 && rsi > 30) bearVotes++;
      if (volRatio > 1.2) bullVotes++;
      const signal = bullVotes >= 4 ? "BULLISH" : bearVotes >= 4 ? "BEARISH" : "NEUTRAL";
      return {
        timeframe: tf,
        signal,
        bull_votes: bullVotes,
        bear_votes: bearVotes,
        rsi: round(rsi),
        macd: round(macd),
        sma20: round(sma20),
        sma50: round(sma50),
        atr: round(atr),
        volume_ratio: round(volRatio),
        price_vs_sma20: round((lastClose - sma20) / sma20 * 100) + "%"
      };
    };
    const tf1h = analyze(klines1h, "1h");
    const tf4h = analyze(klines4h, "4h");
    const tf1d = analyze(klines1d, "1d");
    const signals = [tf1h, tf4h, tf1d].filter((t) => !("error" in t));
    const bullCount = signals.filter((s) => s.signal === "BULLISH").length;
    const bearCount = signals.filter((s) => s.signal === "BEARISH").length;
    const composite = bullCount >= 2 ? "BULLISH" : bearCount >= 2 ? "BEARISH" : "NEUTRAL";
    const score = (bullCount - bearCount + 3) / 6;
    return {
      symbol: pair,
      timeframes: { "1h": tf1h, "4h": tf4h, "1d": tf1d },
      composite_signal: composite,
      composite_score: round(score),
      price,
      volume_24h: vol24h
    };
  });
}
async function scanBinanceWatchlist(symbols) {
  const syms = symbols.map((s) => {
    const upper = s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    return upper.endsWith("USDT") ? upper : upper + "USDT";
  });
  const results = await Promise.allSettled(
    syms.map((s) => getBinanceSignals(s))
  );
  const parsed = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const sorted = [...parsed].sort((a, b) => b.composite_score - a.composite_score);
  return {
    scanned: syms.length,
    results: parsed,
    top_signals: sorted.filter((s) => s.composite_signal !== "NEUTRAL").slice(0, 10)
  };
}
async function getCryptoLiquidations() {
  return cached("liquidations", CACHE_TTL2, async () => {
    try {
      const data = await fetchJSON("https://api.coinglass.com/api/pro/v1/futures/liquidation_chart?symbol=BTC&range=1");
      if (data?.data) {
        const totalLong = data.data.longVolUsd || 0;
        const totalShort = data.data.shortVolUsd || 0;
        const total = totalLong + totalShort;
        const longPct = total > 0 ? totalLong / total * 100 : 50;
        return {
          total_24h_usd: total,
          long_liquidations: totalLong,
          short_liquidations: totalShort,
          long_pct: round(longPct),
          largest_single: null,
          regime_signal: longPct > 65 ? "LONG_SQUEEZE" : longPct < 35 ? "SHORT_SQUEEZE" : "BALANCED",
          source: "coinglass"
        };
      }
    } catch {
    }
    try {
      const btcTicker = await fetchJSON("https://api.binance.us/api/v3/ticker/24hr?symbol=BTCUSDT");
      const vol = parseFloat(btcTicker?.quoteVolume || "0");
      const priceChange = parseFloat(btcTicker?.priceChangePercent || "0");
      const estimatedLiq = vol * 0.015;
      const longPct = priceChange < -3 ? 70 : priceChange > 3 ? 30 : 50 + priceChange * -5;
      return {
        total_24h_usd: round(estimatedLiq),
        long_liquidations: round(estimatedLiq * (longPct / 100)),
        short_liquidations: round(estimatedLiq * ((100 - longPct) / 100)),
        long_pct: round(longPct),
        largest_single: null,
        regime_signal: longPct > 65 ? "LONG_SQUEEZE_RISK" : longPct < 35 ? "SHORT_SQUEEZE_RISK" : "BALANCED",
        source: "binance_us_estimated"
      };
    } catch (err) {
      return {
        total_24h_usd: 0,
        long_liquidations: 0,
        short_liquidations: 0,
        long_pct: 50,
        largest_single: null,
        regime_signal: "UNAVAILABLE",
        source: "error"
      };
    }
  });
}
async function getCryptoSentiment(query = "bitcoin") {
  return cached(`sentiment_${query}`, CACHE_TTL2, async () => {
    try {
      const [lunarData, newsData] = await Promise.allSettled([
        fetchJSON(`https://api.lunarcrush.com/v2?data=assets&symbol=${encodeURIComponent(query)}&interval=1d&data_points=1`),
        fetchJSON(`https://cryptopanic.com/api/free/v1/posts/?auth_token=free&currencies=${encodeURIComponent(query)}&filter=bullish`)
      ]);
      let score = 50;
      const sources = [];
      const keywords = [];
      if (lunarData.status === "fulfilled" && lunarData.value?.data?.[0]) {
        const asset = lunarData.value.data[0];
        score = asset.galaxy_score || asset.alt_rank || 50;
        sources.push({
          source: "lunarcrush",
          sentiment: score > 60 ? "bullish" : score < 40 ? "bearish" : "neutral",
          mentions: asset.social_volume_24h || 0
        });
      }
      if (newsData.status === "fulfilled" && newsData.value?.results) {
        const results = newsData.value.results;
        const bullish = results.filter((r) => r.kind === "news").length;
        sources.push({
          source: "cryptopanic",
          sentiment: bullish > 5 ? "bullish" : "neutral",
          mentions: results.length
        });
      }
      const overall = score > 60 ? "BULLISH" : score < 40 ? "BEARISH" : "NEUTRAL";
      return { query, overall_sentiment: overall, score, sources, trending_keywords: keywords };
    } catch {
      return { query, overall_sentiment: "UNAVAILABLE", score: 50, sources: [], trending_keywords: [] };
    }
  });
}
async function getDefiLlamaData(protocol) {
  return cached(`defillama_${protocol || "global"}`, CACHE_TTL2 * 2, async () => {
    if (protocol) {
      const data = await fetchJSON(`https://api.llama.fi/protocol/${protocol}`);
      return {
        total_tvl: data?.tvl?.[data.tvl.length - 1]?.totalLiquidityUSD || 0,
        tvl_change_24h: 0,
        top_protocols: [{
          name: data?.name || protocol,
          tvl: data?.tvl?.[data.tvl.length - 1]?.totalLiquidityUSD || 0,
          change_1d: 0,
          category: data?.category || "unknown",
          chain: (data?.chains || []).join(", ")
        }],
        chain_tvl: []
      };
    }
    const [protocols, chains] = await Promise.all([
      fetchJSON("https://api.llama.fi/protocols"),
      fetchJSON("https://api.llama.fi/v2/chains")
    ]);
    const topProtos = (protocols || []).sort((a, b) => (b.tvl || 0) - (a.tvl || 0)).slice(0, 15).map((p) => ({
      name: p.name,
      tvl: p.tvl || 0,
      change_1d: p.change_1d || 0,
      category: p.category || "unknown",
      chain: (p.chains || []).slice(0, 3).join(", ")
    }));
    const chainTvl = (chains || []).sort((a, b) => (b.tvl || 0) - (a.tvl || 0)).slice(0, 10).map((c) => ({ name: c.name, tvl: c.tvl || 0 }));
    const totalTvl = topProtos.reduce((s, p) => s + p.tvl, 0);
    return {
      total_tvl: totalTvl,
      tvl_change_24h: 0,
      top_protocols: topProtos,
      chain_tvl: chainTvl
    };
  });
}
async function getDefiLlamaYields() {
  return cached("defillama_yields", CACHE_TTL2 * 3, async () => {
    const data = await fetchJSON("https://yields.llama.fi/pools");
    const pools = (data?.data || []).filter((p) => p.tvlUsd > 1e6 && p.apy > 0 && p.apy < 200).sort((a, b) => b.tvlUsd - a.tvlUsd).slice(0, 20).map((p) => ({
      pool: p.symbol || p.pool,
      project: p.project,
      chain: p.chain,
      tvl: round(p.tvlUsd),
      apy: round(p.apy),
      apy_base: round(p.apyBase || 0),
      apy_reward: round(p.apyReward || 0),
      il_risk: p.ilRisk || "unknown"
    }));
    return { top_pools: pools, count: pools.length };
  });
}
async function getBinanceFundingRates(symbols) {
  const cacheKey = symbols && symbols.length > 0 ? `funding_rates_${symbols.map((s) => s.toUpperCase()).sort().join("_")}` : "funding_rates";
  return cached(cacheKey, CACHE_TTL2, async () => {
    const targetSymbols = symbols && symbols.length > 0 ? symbols.map((s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "")) : ["BTC", "ETH", "SOL", "DOGE", "AVAX", "LINK", "ADA", "DOT", "MATIC", "UNI"];
    const tickers = await Promise.allSettled(
      targetSymbols.map(
        (s) => fetchJSON(`https://api.binance.us/api/v3/ticker/24hr?symbol=${s}USDT`)
      )
    );
    const rates = tickers.map((r, i) => {
      if (r.status !== "fulfilled" || r.value?.code) return null;
      const t = r.value;
      const priceChange = parseFloat(t.priceChangePercent || "0");
      const estimatedFunding = priceChange > 5 ? 0.05 : priceChange < -5 ? -0.05 : priceChange * 0.01;
      return {
        symbol: targetSymbols[i] + "USDT",
        funding_rate: round(estimatedFunding, 4),
        next_funding_time: new Date(Date.now() + 8 * 36e5).toISOString(),
        mark_price: round(parseFloat(t.lastPrice || "0")),
        signal: estimatedFunding > 0.03 ? "OVERLEVERAGED_LONGS" : estimatedFunding < -0.03 ? "OVERLEVERAGED_SHORTS" : "NEUTRAL"
      };
    }).filter((r) => r !== null);
    const avgRate = rates.length > 0 ? rates.reduce((s, r) => s + r.funding_rate, 0) / rates.length : 0;
    const extreme = rates.filter((r) => Math.abs(r.funding_rate) > 0.03);
    return { rates, average_rate: round(avgRate, 4), extreme_funding: extreme, source: "binance_us_spot_estimated" };
  });
}
async function getOpenInterestHistory(symbol = "BTCUSDT") {
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const pair = sym.endsWith("USDT") ? sym : sym + "USDT";
  return cached(`oi_${pair}`, CACHE_TTL2, async () => {
    const ticker = await fetchJSON(`https://api.binance.us/api/v3/ticker/24hr?symbol=${pair}`);
    if (ticker?.code) throw new Error(ticker.msg || "Binance US error");
    const price = parseFloat(ticker.lastPrice || "0");
    const vol24h = parseFloat(ticker.quoteVolume || "0");
    const priceChange = parseFloat(ticker.priceChangePercent || "0");
    const estimatedOI = vol24h * 0.3;
    const estimatedFunding = priceChange > 5 ? 0.05 : priceChange < -5 ? -0.05 : priceChange * 8e-3;
    const ratio = priceChange > 0 ? 1 + priceChange / 20 : 1 / (1 + Math.abs(priceChange) / 20);
    let signal = "NEUTRAL";
    if (priceChange > 5 && ratio > 1.3) signal = "CROWDED_LONG";
    else if (priceChange < -5 && ratio < 0.75) signal = "CROWDED_SHORT";
    else if (priceChange > 3) signal = "LONGS_INCREASING";
    else if (priceChange < -3) signal = "SHORTS_INCREASING";
    return {
      symbol: pair,
      current_oi: round(estimatedOI),
      oi_change_5m: 0,
      funding_rate: round(estimatedFunding, 4),
      long_short_ratio: round(ratio, 3),
      signal,
      source: "binance_us_spot_estimated"
    };
  });
}
async function getEnhancedCoinGeckoData(category) {
  return cached(`cg_enhanced_${category || "all"}`, CACHE_TTL2 * 2, async () => {
    const [trending, global] = await Promise.all([
      fetchJSON("https://api.coingecko.com/api/v3/search/trending"),
      fetchJSON("https://api.coingecko.com/api/v3/global")
    ]);
    const trendingTokens = (trending?.coins || []).slice(0, 10).map((c) => ({
      name: c.item?.name || "",
      symbol: c.item?.symbol || "",
      rank: c.item?.score || 0,
      price_btc: c.item?.price_btc || 0,
      market_cap_rank: c.item?.market_cap_rank || 999
    }));
    const globalData = global?.data || {};
    const btcDom = globalData.market_cap_percentage?.btc || 0;
    const ethDom = globalData.market_cap_percentage?.eth || 0;
    let topDefi = [];
    try {
      const defiData = await fetchJSON("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=decentralized-finance-defi&order=market_cap_desc&per_page=10&sparkline=false");
      topDefi = (defiData || []).map((d) => ({
        name: d.name,
        symbol: d.symbol,
        tvl: d.total_value_locked || 0,
        mcap_tvl_ratio: d.total_value_locked ? round(d.market_cap / d.total_value_locked, 2) : 0
      }));
    } catch {
    }
    return {
      trending_tokens: trendingTokens,
      top_defi: topDefi,
      market_dominance: { btc: round(btcDom), eth: round(ethDom), others: round(100 - btcDom - ethDom) }
    };
  });
}
function calcRSI(closes, period) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}
function calcEMA(data, period) {
  if (data.length < period) return data[data.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema2 = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < data.length; i++) {
    ema2 = data[i] * k + ema2 * (1 - k);
  }
  return ema2;
}
function calcATR(highs, lows, closes, period) {
  if (highs.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    trs.push(tr);
  }
  return trs.slice(-period).reduce((s, v) => s + v, 0) / period;
}
function round(n, decimals = 2) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}
var CACHE, CACHE_TTL2, CACHE_MAX_SIZE;
var init_signal_sources = __esm({
  "src/signal-sources.ts"() {
    "use strict";
    CACHE = /* @__PURE__ */ new Map();
    CACHE_TTL2 = 5 * 60 * 1e3;
    CACHE_MAX_SIZE = 200;
  }
});

// src/crypto-scout.ts
var crypto_scout_exports = {};
__export(crypto_scout_exports, {
  buildThesis: () => buildThesis,
  createThesisId: () => createThesisId,
  formatThesesSummary: () => formatThesesSummary,
  formatThesis: () => formatThesis,
  getActiveTheses: () => getActiveTheses,
  getSignalParameters: () => getSignalParameters,
  getWatchlist: () => getWatchlist,
  retireThesis: () => retireThesis,
  saveLatestBrief: () => saveLatestBrief,
  saveTheses: () => saveTheses,
  updateWatchlist: () => updateWatchlist
});
function createThesisId(asset) {
  const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, "_");
  const rand = Math.random().toString(36).slice(2, 8);
  return `scout_${date}_${asset.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${rand}`;
}
async function saveTheses(theses) {
  const pool2 = getPool();
  const existing = await getActiveTheses();
  const expiredIds = /* @__PURE__ */ new Set();
  const now = Date.now();
  for (const t of existing) {
    if (t.expires_at < now) {
      expiredIds.add(t.id);
    }
  }
  const activeExisting = existing.filter((t) => !expiredIds.has(t.id) && t.status === "active");
  const newAssetIds = new Set(theses.map((t) => t.asset_id));
  const kept = activeExisting.filter((t) => !newAssetIds.has(t.asset_id));
  const merged = [...kept, ...theses];
  await pool2.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('scout_active_theses', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(merged), Date.now()]
  );
}
async function getActiveTheses() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'scout_active_theses'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      const now = Date.now();
      return res.rows[0].value.filter((t) => t.status === "active" && t.expires_at > now);
    }
  } catch (err) {
    console.error("[crypto-scout] getActiveTheses failed:", err);
  }
  return [];
}
async function retireThesis(thesisId) {
  const pool2 = getPool();
  const theses = await getActiveTheses();
  const updated = theses.map((t) => t.id === thesisId ? { ...t, status: "retired" } : t);
  await pool2.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('scout_active_theses', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(updated), Date.now()]
  );
}
async function getWatchlist() {
  const pool2 = getPool();
  const defaults = ["bitcoin", "ethereum", "solana", "bankr"];
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'scout_watchlist'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      const wl = res.rows[0].value;
      const merged = /* @__PURE__ */ new Set([...defaults, ...wl]);
      return Array.from(merged);
    }
  } catch {
  }
  return defaults;
}
async function updateWatchlist(assets) {
  const pool2 = getPool();
  const defaults = ["bitcoin", "ethereum", "solana", "bankr"];
  const merged = Array.from(/* @__PURE__ */ new Set([...defaults, ...assets]));
  await pool2.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('scout_watchlist', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(merged), Date.now()]
  );
}
async function saveLatestBrief(brief) {
  const pool2 = getPool();
  await pool2.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('scout_latest_brief', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(brief), Date.now()]
  );
}
async function getSignalParameters() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'crypto_signal_parameters'`);
    if (res.rows.length > 0 && res.rows[0].value) {
      return res.rows[0].value;
    }
  } catch {
  }
  return null;
}
function buildThesis(params) {
  const now = Date.now();
  return {
    id: createThesisId(params.asset),
    asset: params.asset,
    asset_id: params.asset_id,
    asset_class: "crypto",
    direction: params.direction,
    confidence: params.confidence,
    technical_score: params.technical_score,
    vote_count: params.vote_count,
    market_regime: params.market_regime,
    entry_price: params.entry_price,
    exit_price: params.exit_price,
    stop_price: params.stop_price,
    atr_value: params.atr_value,
    time_horizon: params.time_horizon || "24h",
    sources: params.sources,
    backtest_score: params.backtest_score ?? null,
    nansen_flow_direction: params.nansen_flow_direction ?? null,
    created_at: now,
    expires_at: now + THESIS_EXPIRY_MS,
    status: "active",
    reasoning: params.reasoning
  };
}
function formatThesis(t) {
  const conf = { HIGH: "\u{1F7E2}", MEDIUM: "\u{1F7E1}", LOW: "\u{1F534}" }[t.confidence] || "\u26AA";
  const dir = t.direction === "LONG" ? "\u{1F4C8} LONG" : "\u{1F4C9} SHORT";
  const age = Math.round((Date.now() - t.created_at) / (60 * 60 * 1e3));
  const expiry = Math.round((t.expires_at - Date.now()) / (60 * 60 * 1e3));
  const lines = [
    `${conf} *${t.asset}* \u2014 ${dir}`,
    `   Score: ${t.technical_score.toFixed(3)} | Votes: ${t.vote_count} | Regime: ${t.market_regime}`,
    `   Entry: $${t.entry_price.toFixed(2)} | Stop: $${t.stop_price.toFixed(2)} | Target: $${t.exit_price.toFixed(2)}`,
    `   Sources: ${t.sources.join(", ")}`
  ];
  if (t.nansen_flow_direction) lines.push(`   Nansen: ${t.nansen_flow_direction}`);
  if (t.backtest_score != null) lines.push(`   Backtest: ${t.backtest_score.toFixed(2)}`);
  lines.push(`   Age: ${age}h | Expires: ${expiry}h | ID: \`${t.id}\``);
  return lines.join("\n");
}
function formatThesesSummary(theses) {
  if (theses.length === 0) return "No active theses.";
  return theses.map(formatThesis).join("\n\n");
}
var THESIS_EXPIRY_MS;
var init_crypto_scout = __esm({
  "src/crypto-scout.ts"() {
    "use strict";
    init_db();
    THESIS_EXPIRY_MS = 72 * 60 * 60 * 1e3;
  }
});

// src/polymarket.ts
function getCached2(key, ttl) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
  return null;
}
function setCache2(key, data) {
  cache.set(key, { data, ts: Date.now() });
}
async function fetchJson(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15e3);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}
async function searchMarkets(query, limit = 20) {
  const cacheKey = `markets_search_${query}_${limit}`;
  const cached2 = getCached2(cacheKey, MARKET_TTL);
  if (cached2) return cached2;
  try {
    const url = `${GAMMA_API}/markets?closed=false&limit=${limit}&order=volume&ascending=false${query ? `&tag=${encodeURIComponent(query)}` : ""}`;
    const data = await fetchJson(url);
    const markets = Array.isArray(data) ? data : [];
    const result = markets.map(normalizeMarket);
    setCache2(cacheKey, result);
    return result;
  } catch (err) {
    console.error("[polymarket] searchMarkets error:", err);
    return [];
  }
}
async function getTrendingMarkets(limit = 20) {
  const cacheKey = `markets_trending_${limit}`;
  const cached2 = getCached2(cacheKey, MARKET_TTL);
  if (cached2) return cached2;
  try {
    const url = `${GAMMA_API}/markets?closed=false&limit=${limit}&order=volume24hr&ascending=false`;
    const data = await fetchJson(url);
    const markets = Array.isArray(data) ? data : [];
    const result = markets.map(normalizeMarket);
    setCache2(cacheKey, result);
    return result;
  } catch (err) {
    console.error("[polymarket] getTrendingMarkets error:", err);
    return [];
  }
}
async function getMarketDetails(conditionId) {
  const cacheKey = `market_${conditionId}`;
  const cached2 = getCached2(cacheKey, MARKET_TTL);
  if (cached2) return cached2;
  try {
    const url = `${GAMMA_API}/markets/${conditionId}`;
    const data = await fetchJson(url);
    const result = normalizeMarket(data);
    setCache2(cacheKey, result);
    return result;
  } catch (err) {
    console.error("[polymarket] getMarketDetails error:", err);
    return null;
  }
}
function normalizeMarket(raw) {
  const outcomes = raw.outcomes ? typeof raw.outcomes === "string" ? JSON.parse(raw.outcomes) : raw.outcomes : ["Yes", "No"];
  const outcomePrices = raw.outcomePrices ? typeof raw.outcomePrices === "string" ? JSON.parse(raw.outcomePrices) : raw.outcomePrices : [];
  const tokens = [];
  if (raw.tokens && Array.isArray(raw.tokens)) {
    for (const t of raw.tokens) {
      tokens.push({ token_id: t.token_id, outcome: t.outcome, price: parseFloat(t.price || "0") });
    }
  } else if (outcomePrices.length > 0) {
    for (let i = 0; i < outcomes.length; i++) {
      tokens.push({ token_id: `${raw.condition_id || raw.id}_${i}`, outcome: outcomes[i], price: parseFloat(outcomePrices[i] || "0") });
    }
  }
  return {
    condition_id: raw.condition_id || raw.id || "",
    question: raw.question || "",
    description: raw.description || "",
    market_slug: raw.market_slug || raw.slug || "",
    outcomes,
    outcome_prices: outcomePrices,
    tokens,
    volume: parseFloat(raw.volume || "0"),
    volume_24h: parseFloat(raw.volume24hr || raw.volume_24h || "0"),
    liquidity: parseFloat(raw.liquidity || "0"),
    end_date_iso: raw.end_date_iso || raw.endDate || "",
    active: raw.active !== false,
    closed: raw.closed === true,
    category: raw.category || raw.groupItemTitle || "",
    tags: raw.tags ? typeof raw.tags === "string" ? JSON.parse(raw.tags) : raw.tags : []
  };
}
async function getWhaleWatchlist() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'polymarket_whale_watchlist'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      return res.rows[0].value;
    }
  } catch (err) {
    console.error("[polymarket] getWhaleWatchlist error:", err);
  }
  return [];
}
async function getWhaleActivities() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'polymarket_whale_activities'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      const now = Date.now();
      const recentCutoff = 24 * 60 * 60 * 1e3;
      return res.rows[0].value.filter((a) => now - a.detected_at < recentCutoff);
    }
  } catch {
  }
  return [];
}
async function detectConsensus(activities) {
  const byMarket = {};
  for (const a of activities) {
    if (a.activity_type === "position_exit") continue;
    if (!byMarket[a.market_id]) byMarket[a.market_id] = { yes: [], no: [] };
    if (a.direction === "YES") byMarket[a.market_id].yes.push(a);
    else byMarket[a.market_id].no.push(a);
  }
  const results = [];
  for (const [marketId, sides] of Object.entries(byMarket)) {
    for (const [dir, acts] of [["YES", sides.yes], ["NO", sides.no]]) {
      if (acts.length >= 2) {
        const totalAmount = acts.reduce((s, a) => s + a.amount_usd, 0);
        const avgScore = acts.reduce((s, a) => s + a.wallet_score, 0) / acts.length;
        results.push({
          market_id: marketId,
          question: acts[0].market_question,
          direction: dir,
          whale_count: acts.length,
          total_amount: totalAmount,
          avg_score: parseFloat(avgScore.toFixed(3))
        });
      }
    }
  }
  return results.sort((a, b) => b.whale_count - a.whale_count || b.avg_score - a.avg_score);
}
var GAMMA_API, cache, MARKET_TTL, WALLET_TTL;
var init_polymarket = __esm({
  "src/polymarket.ts"() {
    "use strict";
    init_db();
    GAMMA_API = "https://gamma-api.polymarket.com";
    cache = /* @__PURE__ */ new Map();
    MARKET_TTL = 5 * 60 * 1e3;
    WALLET_TTL = 15 * 60 * 1e3;
  }
});

// src/bnkr.ts
var bnkr_exports = {};
__export(bnkr_exports, {
  closeCryptoPosition: () => closeCryptoPosition,
  closePolymarketPosition: () => closePolymarketPosition,
  getCryptoPositionPnL: () => getCryptoPositionPnL,
  getCryptoPositions: () => getCryptoPositions,
  getPolymarketPositionPnL: () => getPolymarketPositionPnL,
  getPolymarketPositions: () => getPolymarketPositions,
  isConfigured: () => isConfigured6,
  openCryptoPosition: () => openCryptoPosition,
  openPolymarketPosition: () => openPolymarketPosition
});
function isConfigured6() {
  return BNKR_API_KEY.length > 0 && BNKR_WALLET.length > 0;
}
async function bnkrFetch(path8, body) {
  const url = `${BNKR_BASE_URL}${path8}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15e3);
  try {
    const opts = {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${BNKR_API_KEY}`,
        "X-Wallet-Address": BNKR_WALLET
      },
      signal: controller.signal
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`BNKR API ${path8} failed (${res.status}): ${text}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}
async function openCryptoPosition(params) {
  if (!isConfigured6()) {
    console.log(`[bnkr] SHADOW: openCryptoPosition ${params.asset} ${params.direction} ${params.leverage}x size=${params.size}`);
    return {
      order_id: `shadow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      asset: params.asset,
      direction: params.direction,
      leverage: params.leverage,
      size: params.size,
      entry_price: 0,
      status: "filled",
      tx_hash: null
    };
  }
  const result = await bnkrFetch("/crypto/open", {
    asset: params.asset,
    direction: params.direction,
    leverage: params.leverage,
    size: params.size,
    stop_price: params.stop_price,
    wallet: BNKR_WALLET
  });
  return result;
}
async function closeCryptoPosition(orderId) {
  if (!isConfigured6()) {
    console.log(`[bnkr] SHADOW: closeCryptoPosition ${orderId}`);
    return { tx_hash: "", exit_price: 0 };
  }
  return bnkrFetch("/crypto/close", { order_id: orderId, wallet: BNKR_WALLET });
}
async function getCryptoPositions() {
  if (!isConfigured6()) return [];
  return bnkrFetch("/crypto/positions");
}
async function getCryptoPositionPnL(orderId) {
  if (!isConfigured6()) return { pnl: 0, pnl_pct: 0, current_price: 0 };
  return bnkrFetch(`/crypto/pnl/${orderId}`);
}
async function openPolymarketPosition(params) {
  if (!isConfigured6()) {
    console.log(`[bnkr] SHADOW: openPolymarketPosition market=${params.market_id} ${params.direction} $${params.amount_usd}`);
    return {
      order_id: `shadow_pm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      market_id: params.market_id,
      direction: params.direction,
      amount_usd: params.amount_usd,
      entry_odds: 0,
      status: "filled",
      tx_hash: null
    };
  }
  return bnkrFetch("/polymarket/open", {
    market_id: params.market_id,
    direction: params.direction,
    amount_usd: params.amount_usd,
    wallet: BNKR_WALLET
  });
}
async function closePolymarketPosition(orderId) {
  if (!isConfigured6()) {
    console.log(`[bnkr] SHADOW: closePolymarketPosition ${orderId}`);
    return { tx_hash: "", exit_odds: 0 };
  }
  return bnkrFetch("/polymarket/close", { order_id: orderId, wallet: BNKR_WALLET });
}
async function getPolymarketPositions() {
  if (!isConfigured6()) return [];
  return bnkrFetch("/polymarket/positions");
}
async function getPolymarketPositionPnL(orderId) {
  if (!isConfigured6()) return { pnl: 0, pnl_pct: 0, current_odds: 0 };
  return bnkrFetch(`/polymarket/pnl/${orderId}`);
}
var BNKR_API_KEY, BNKR_WALLET, BNKR_BASE_URL;
var init_bnkr = __esm({
  "src/bnkr.ts"() {
    "use strict";
    BNKR_API_KEY = process.env.BANKR_API_KEY || "";
    BNKR_WALLET = process.env.BANKR_WALLET_ADDRESS || "";
    BNKR_BASE_URL = process.env.BANKR_API_URL || "https://api.bnkr.com/v1";
  }
});

// src/autoresearch.ts
async function getConfigValue(key, fallback) {
  try {
    const pool2 = getPool();
    const res = await pool2.query("SELECT value FROM app_config WHERE key = $1", [key]);
    if (res.rows.length > 0) {
      const parsed = typeof res.rows[0].value === "string" ? JSON.parse(res.rows[0].value) : res.rows[0].value;
      return parsed;
    }
    return fallback;
  } catch {
    return fallback;
  }
}
async function setConfigValue(key, value) {
  const pool2 = getPool();
  const json = JSON.stringify(value);
  await pool2.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3`,
    [key, json, (/* @__PURE__ */ new Date()).toISOString()]
  );
}
function clampToRange(value, def) {
  const clamped = Math.max(def.min, Math.min(def.max, value));
  if (def.type === "int") return Math.round(clamped);
  return Math.round(clamped / def.step) * def.step;
}
function checkDrift(oldVal, newVal, maxDriftPct) {
  if (oldVal === 0) return Math.abs(newVal) <= 1;
  return Math.abs((newVal - oldVal) / oldVal) * 100 <= maxDriftPct;
}
function mutateParams(current, paramSpace, count = 2) {
  const mutated = { ...current };
  const changed = {};
  const numericParams = paramSpace.filter((p) => current[p.name] !== void 0);
  if (numericParams.length === 0) return { mutated, changed };
  const numToMutate = Math.min(count, numericParams.length);
  const shuffled = [...numericParams].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, numToMutate);
  for (const param of selected) {
    const oldVal = current[param.name];
    const direction = Math.random() > 0.5 ? 1 : -1;
    const steps = Math.ceil(Math.random() * 3);
    let newVal = oldVal + direction * steps * param.step;
    newVal = clampToRange(newVal, param);
    if (!checkDrift(oldVal, newVal, MAX_DRIFT_PCT)) {
      const maxChange = Math.abs(oldVal * MAX_DRIFT_PCT / 100);
      newVal = clampToRange(oldVal + direction * Math.min(steps * param.step, maxChange), param);
    }
    if (newVal !== oldVal) {
      mutated[param.name] = newVal;
      changed[param.name] = { old: oldVal, new: newVal };
    }
  }
  return { mutated, changed };
}
function generateHypothesis(changed, domain) {
  const parts = [];
  for (const [name, { old: o, new: n }] of Object.entries(changed)) {
    const dir = n > o ? "increasing" : "decreasing";
    parts.push(`${dir} ${name} from ${o} to ${n}`);
  }
  return `${domain} parameter mutation: ${parts.join(", ")}`;
}
function runCryptoBacktest(candles, params) {
  if (candles.length < 50) {
    return { score: 0, trades: 0, wins: 0, losses: 0, total_pnl: 0, max_drawdown_pct: 0, sharpe: 0, win_rate: 0, details: {} };
  }
  const trades = [];
  let inPosition = false;
  let entryBar = 0;
  let entryPrice = 0;
  let stopPrice = 0;
  let cooldownUntil = 0;
  const WINDOW = 50;
  for (let i = WINDOW; i < candles.length; i++) {
    const windowCandles = candles.slice(Math.max(0, i - 200), i + 1);
    if (windowCandles.length < 30) continue;
    const result = analyzeAsset(windowCandles, params);
    const currentPrice = candles[i].close;
    if (inPosition) {
      const hitStop = currentPrice <= stopPrice;
      const exitSignal = result.votes.exit_long_signal || result.votes.rsi_overbought;
      const heldTooLong = i - entryBar > 72;
      if (hitStop || exitSignal || heldTooLong) {
        const pnl = currentPrice - entryPrice;
        const pnl_pct = pnl / entryPrice * 100;
        trades.push({ entry_bar: entryBar, exit_bar: i, entry_price: entryPrice, exit_price: currentPrice, direction: "LONG", pnl, pnl_pct });
        inPosition = false;
        cooldownUntil = i + (params.cooldown_bars || 2);
      }
    } else if (i >= cooldownUntil) {
      if (result.votes.entry_signal && result.technical_score > 0.5) {
        inPosition = true;
        entryBar = i;
        entryPrice = currentPrice;
        stopPrice = result.atr_stop_price;
      }
    }
  }
  if (inPosition) {
    const finalPrice = candles[candles.length - 1].close;
    const pnl = finalPrice - entryPrice;
    trades.push({ entry_bar: entryBar, exit_bar: candles.length - 1, entry_price: entryPrice, exit_price: finalPrice, direction: "LONG", pnl, pnl_pct: pnl / entryPrice * 100 });
  }
  return scoreCryptoResult(trades);
}
function scoreCryptoResult(trades) {
  if (trades.length === 0) {
    return { score: 0, trades: 0, wins: 0, losses: 0, total_pnl: 0, max_drawdown_pct: 0, sharpe: 0, win_rate: 0, details: {} };
  }
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl_pct, 0);
  const winRate = wins.length / trades.length;
  const returns = trades.map((t) => t.pnl_pct);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? avgReturn / stdDev * Math.sqrt(252 / Math.max(1, trades.length)) : 0;
  let peak = 0;
  let equity = 0;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.pnl_pct;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak * 100 : equity < 0 ? Math.abs(equity) : 0;
    if (dd > maxDD) maxDD = dd;
  }
  const tradeCountFactor = Math.min(trades.length / 10, 1.5);
  const drawdownPenalty = maxDD * 0.02;
  const avgHoldBars = trades.reduce((s, t) => s + (t.exit_bar - t.entry_bar), 0) / trades.length;
  const turnoverPenalty = avgHoldBars < 3 ? 0.3 : 0;
  const score = Math.max(0, sharpe * Math.sqrt(tradeCountFactor) - drawdownPenalty - turnoverPenalty);
  return {
    score,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    total_pnl: totalPnl,
    max_drawdown_pct: maxDD,
    sharpe,
    win_rate: winRate,
    details: {
      avg_return_pct: avgReturn,
      std_dev: stdDev,
      avg_hold_bars: avgHoldBars,
      trade_count_factor: tradeCountFactor,
      drawdown_penalty: drawdownPenalty,
      turnover_penalty: turnoverPenalty
    }
  };
}
function runPolymarketBacktest(markets, params) {
  if (markets.length === 0) {
    return { score: 0, trades: 0, wins: 0, losses: 0, total_pnl: 0, max_drawdown_pct: 0, win_rate: 0, details: {} };
  }
  const trades = [];
  for (const m of markets) {
    if (m.avg_whale_score < params.min_wallet_score) continue;
    if (m.whale_count < params.min_whale_consensus) continue;
    if (m.entry_odds < params.min_odds || m.entry_odds > params.max_odds) continue;
    if (m.volume < params.min_volume) continue;
    const categoryKey = `category_weight_${m.category.toLowerCase()}`;
    const categoryWeight = typeof params[categoryKey] === "number" ? params[categoryKey] : params.category_weight_other;
    if (categoryWeight < 0.5) continue;
    let sizePct;
    if (m.avg_whale_score >= 0.8) sizePct = params.tier3_size_pct;
    else if (m.avg_whale_score >= 0.65) sizePct = params.tier2_size_pct;
    else sizePct = params.tier1_size_pct;
    const won = m.resolution_odds >= 0.95;
    const exitOdds = won ? 1 : Math.max(0, m.entry_odds - params.exit_odds_threshold);
    const pnlPerUnit = won ? 1 - m.entry_odds : exitOdds - m.entry_odds;
    const pnl_pct = pnlPerUnit * sizePct * categoryWeight;
    trades.push({ pnl_pct, won });
  }
  if (trades.length === 0) {
    return { score: 0, trades: 0, wins: 0, losses: 0, total_pnl: 0, max_drawdown_pct: 0, win_rate: 0, details: {} };
  }
  const wins = trades.filter((t) => t.won);
  const totalPnl = trades.reduce((s, t) => s + t.pnl_pct, 0);
  const winRate = wins.length / trades.length;
  let peak = 0;
  let equity = 0;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.pnl_pct;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak * 100 : equity < 0 ? Math.abs(equity) : 0;
    if (dd > maxDD) maxDD = dd;
  }
  const roiScore = Math.min(totalPnl / 10, 2);
  const winRateScore = winRate * 1.5;
  const drawdownPenalty = maxDD * 0.015;
  const score = Math.max(0, roiScore + winRateScore - drawdownPenalty);
  return {
    score,
    trades: trades.length,
    wins: wins.length,
    losses: trades.length - wins.length,
    total_pnl: totalPnl,
    max_drawdown_pct: maxDD,
    win_rate: winRate,
    details: {
      roi_score: roiScore,
      win_rate_score: winRateScore,
      drawdown_penalty: drawdownPenalty
    }
  };
}
async function getCryptoParams() {
  return getConfigValue(DB_KEYS.cryptoParams, DEFAULT_CRYPTO_PARAMS);
}
async function getPolymarketParams() {
  return getConfigValue(DB_KEYS.polymarketParams, DEFAULT_POLYMARKET_PARAMS);
}
async function getExperimentLog() {
  return getConfigValue(DB_KEYS.experimentLog, []);
}
async function appendExperiment(exp) {
  const log = await getExperimentLog();
  log.push(exp);
  if (log.length > MAX_EXPERIMENTS_LOG) log.splice(0, log.length - MAX_EXPERIMENTS_LOG);
  await setConfigValue(DB_KEYS.experimentLog, log);
}
async function pushParamHistory(domain, params) {
  const key = domain === "crypto" ? DB_KEYS.cryptoHistory : DB_KEYS.polymarketHistory;
  const history = await getConfigValue(key, []);
  history.push(params);
  if (history.length > MAX_PARAM_HISTORY) history.splice(0, history.length - MAX_PARAM_HISTORY);
  await setConfigValue(key, history);
}
async function getParamHistory(domain) {
  const key = domain === "crypto" ? DB_KEYS.cryptoHistory : DB_KEYS.polymarketHistory;
  return getConfigValue(key, []);
}
async function rollbackParams(domain) {
  const history = await getParamHistory(domain);
  if (history.length === 0) {
    return { success: false, message: `No parameter history available for ${domain} rollback` };
  }
  const previous = history[history.length - 1];
  if (domain === "crypto") {
    await setConfigValue(DB_KEYS.cryptoParams, previous);
    invalidateCryptoParamsCache();
  } else {
    await setConfigValue(DB_KEYS.polymarketParams, previous);
  }
  const updatedHistory = history.slice(0, -1);
  const key = domain === "crypto" ? DB_KEYS.cryptoHistory : DB_KEYS.polymarketHistory;
  await setConfigValue(key, updatedHistory);
  return { success: true, message: `Rolled back ${domain} parameters to previous set (${history.length - 1} remaining in history)` };
}
async function buildPMSimMarkets() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(
      `SELECT value FROM app_config WHERE key = 'wealth_engines_trade_history'`
    );
    if (res.rows.length === 0) return [];
    const trades = typeof res.rows[0].value === "string" ? JSON.parse(res.rows[0].value) : res.rows[0].value;
    const pmTrades = trades.filter(
      (t) => t.asset_class === "polymarket" && t.closed_at
    );
    const markets = pmTrades.map((t) => ({
      market_id: t.market_id || "unknown",
      question: t.asset || "Unknown Market",
      outcome: t.direction === "YES" || t.direction === "NO" ? t.direction : "YES",
      entry_odds: t.entry_price || 0.5,
      resolution_odds: (t.pnl || 0) > 0 ? 1 : 0,
      whale_count: 2,
      avg_whale_score: 0.7,
      volume: 1e5,
      category: "other"
    }));
    if (markets.length < 5) {
      const synthetic = generateSyntheticPMMarkets(20);
      return [...markets, ...synthetic];
    }
    return markets;
  } catch {
    return generateSyntheticPMMarkets(20);
  }
}
function generateSyntheticPMMarkets(count) {
  const categories = ["politics", "crypto", "sports", "other"];
  const markets = [];
  for (let i = 0; i < count; i++) {
    const odds = 0.2 + Math.random() * 0.6;
    const won = Math.random() > 1 - odds;
    markets.push({
      market_id: `synthetic_${i}`,
      question: `Synthetic market ${i}`,
      outcome: "YES",
      entry_odds: odds,
      resolution_odds: won ? 1 : 0,
      whale_count: 1 + Math.floor(Math.random() * 4),
      avg_whale_score: 0.4 + Math.random() * 0.5,
      volume: 2e4 + Math.random() * 2e5,
      category: categories[Math.floor(Math.random() * categories.length)]
    });
  }
  return markets;
}
async function runCryptoResearch(experimentsCount = 15) {
  const start = Date.now();
  const currentParams = await getCryptoParams();
  const currentRecord = currentParams;
  let candles;
  try {
    candles = await getHistoricalOHLCV("bitcoin", 90);
  } catch {
    try {
      candles = await getHistoricalOHLCV("ethereum", 90);
    } catch {
      return {
        domain: "crypto",
        experiments_run: 0,
        improvements_found: 0,
        best_delta: 0,
        score_before: 0,
        score_after: 0,
        parameters_changed: [],
        duration_ms: Date.now() - start
      };
    }
  }
  const baseline = runCryptoBacktest(candles, currentParams);
  let bestScore = baseline.score;
  let bestParams = { ...currentRecord };
  let improvements = 0;
  const allChanged = [];
  for (let i = 0; i < experimentsCount; i++) {
    const muteCount = 1 + Math.floor(Math.random() * 3);
    const { mutated, changed } = mutateParams(bestParams, CRYPTO_PARAM_SPACE, muteCount);
    if (Object.keys(changed).length === 0) continue;
    const hypothesis = generateHypothesis(changed, "crypto");
    const result = runCryptoBacktest(candles, mutated);
    const delta = result.score - bestScore;
    const deltaPct = bestScore > 0 ? delta / bestScore * 100 : result.score > 0 ? 100 : 0;
    const experiment = {
      experiment_id: `crypto_${Date.now()}_${i}`,
      domain: "crypto",
      parameters_changed: changed,
      hypothesis,
      old_score: bestScore,
      new_score: result.score,
      delta,
      delta_pct: deltaPct,
      outcome: deltaPct >= MIN_IMPROVEMENT_PCT ? "kept" : "reverted",
      timestamp: Date.now(),
      details: result.details
    };
    await appendExperiment(experiment);
    if (deltaPct >= MIN_IMPROVEMENT_PCT) {
      bestScore = result.score;
      bestParams = { ...mutated };
      improvements++;
      allChanged.push(...Object.keys(changed));
    }
  }
  if (improvements > 0) {
    await pushParamHistory("crypto", currentRecord);
    await setConfigValue(DB_KEYS.cryptoParams, bestParams);
    invalidateCryptoParamsCache();
  }
  return {
    domain: "crypto",
    experiments_run: experimentsCount,
    improvements_found: improvements,
    best_delta: bestScore - baseline.score,
    score_before: baseline.score,
    score_after: bestScore,
    parameters_changed: [...new Set(allChanged)],
    duration_ms: Date.now() - start
  };
}
async function runPolymarketResearch(experimentsCount = 15) {
  const start = Date.now();
  const currentParams = await getPolymarketParams();
  const currentRecord = currentParams;
  const markets = await buildPMSimMarkets();
  if (markets.length === 0) {
    return {
      domain: "polymarket",
      experiments_run: 0,
      improvements_found: 0,
      best_delta: 0,
      score_before: 0,
      score_after: 0,
      parameters_changed: [],
      duration_ms: Date.now() - start
    };
  }
  const baseline = runPolymarketBacktest(markets, currentParams);
  let bestScore = baseline.score;
  let bestParams = { ...currentRecord };
  let improvements = 0;
  const allChanged = [];
  for (let i = 0; i < experimentsCount; i++) {
    const muteCount = 1 + Math.floor(Math.random() * 3);
    const { mutated, changed } = mutateParams(bestParams, POLYMARKET_PARAM_SPACE, muteCount);
    if (Object.keys(changed).length === 0) continue;
    const hypothesis = generateHypothesis(changed, "polymarket");
    const result = runPolymarketBacktest(markets, mutated);
    const delta = result.score - bestScore;
    const deltaPct = bestScore > 0 ? delta / bestScore * 100 : result.score > 0 ? 100 : 0;
    const experiment = {
      experiment_id: `pm_${Date.now()}_${i}`,
      domain: "polymarket",
      parameters_changed: changed,
      hypothesis,
      old_score: bestScore,
      new_score: result.score,
      delta,
      delta_pct: deltaPct,
      outcome: deltaPct >= MIN_IMPROVEMENT_PCT ? "kept" : "reverted",
      timestamp: Date.now(),
      details: result.details
    };
    await appendExperiment(experiment);
    if (deltaPct >= MIN_IMPROVEMENT_PCT) {
      bestScore = result.score;
      bestParams = { ...mutated };
      improvements++;
      allChanged.push(...Object.keys(changed));
    }
  }
  if (improvements > 0) {
    await pushParamHistory("polymarket", currentRecord);
    await setConfigValue(DB_KEYS.polymarketParams, bestParams);
  }
  return {
    domain: "polymarket",
    experiments_run: experimentsCount,
    improvements_found: improvements,
    best_delta: bestScore - baseline.score,
    score_before: baseline.score,
    score_after: bestScore,
    parameters_changed: [...new Set(allChanged)],
    duration_ms: Date.now() - start
  };
}
async function runFullResearch(experimentsPerDomain = 15) {
  const crypto2 = await runCryptoResearch(experimentsPerDomain);
  const pm = await runPolymarketResearch(experimentsPerDomain);
  return [crypto2, pm];
}
function formatResearchSummary(summaries) {
  const lines = ["\u{1F52C} *Autoresearch Results*\n"];
  for (const s of summaries) {
    const domain = s.domain === "crypto" ? "\u{1F4CA} Crypto Signals" : "\u{1F3AF} Polymarket";
    lines.push(`*${domain}*`);
    lines.push(`  Experiments: ${s.experiments_run}`);
    lines.push(`  Improvements: ${s.improvements_found}`);
    lines.push(`  Score: ${s.score_before.toFixed(3)} \u2192 ${s.score_after.toFixed(3)} (${s.best_delta >= 0 ? "+" : ""}${s.best_delta.toFixed(3)})`);
    if (s.parameters_changed.length > 0) {
      lines.push(`  Changed: ${s.parameters_changed.join(", ")}`);
    }
    lines.push(`  Duration: ${(s.duration_ms / 1e3).toFixed(1)}s`);
    lines.push("");
  }
  return lines.join("\n");
}
async function getResearchStatus() {
  const [cryptoParams, pmParams, log, cryptoHist, pmHist] = await Promise.all([
    getCryptoParams(),
    getPolymarketParams(),
    getExperimentLog(),
    getParamHistory("crypto"),
    getParamHistory("polymarket")
  ]);
  return {
    crypto_params: cryptoParams,
    polymarket_params: pmParams,
    recent_experiments: log.slice(-20),
    crypto_history_count: cryptoHist.length,
    polymarket_history_count: pmHist.length
  };
}
var DB_KEYS, MAX_EXPERIMENTS_LOG, MAX_PARAM_HISTORY, MIN_IMPROVEMENT_PCT, MAX_DRIFT_PCT, CRYPTO_PARAM_SPACE, POLYMARKET_PARAM_SPACE, DEFAULT_CRYPTO_PARAMS, DEFAULT_POLYMARKET_PARAMS;
var init_autoresearch = __esm({
  "src/autoresearch.ts"() {
    "use strict";
    init_db();
    init_technical_signals();
    init_coingecko();
    DB_KEYS = {
      cryptoParams: "crypto_signal_parameters",
      polymarketParams: "polymarket_scout_parameters",
      experimentLog: "autoresearch_experiment_log",
      cryptoHistory: "autoresearch_crypto_history",
      polymarketHistory: "autoresearch_polymarket_history"
    };
    MAX_EXPERIMENTS_LOG = 500;
    MAX_PARAM_HISTORY = 5;
    MIN_IMPROVEMENT_PCT = 0.5;
    MAX_DRIFT_PCT = 30;
    CRYPTO_PARAM_SPACE = [
      { name: "ema_fast", min: 3, max: 15, step: 1, type: "int" },
      { name: "ema_slow", min: 15, max: 50, step: 1, type: "int" },
      { name: "rsi_period", min: 5, max: 21, step: 1, type: "int" },
      { name: "rsi_overbought", min: 60, max: 80, step: 1, type: "int" },
      { name: "rsi_oversold", min: 20, max: 40, step: 1, type: "int" },
      { name: "momentum_lookback", min: 5, max: 30, step: 1, type: "int" },
      { name: "very_short_momentum_lookback", min: 2, max: 12, step: 1, type: "int" },
      { name: "macd_fast", min: 8, max: 20, step: 1, type: "int" },
      { name: "macd_slow", min: 18, max: 35, step: 1, type: "int" },
      { name: "macd_signal", min: 5, max: 15, step: 1, type: "int" },
      { name: "bb_period", min: 5, max: 25, step: 1, type: "int" },
      { name: "bb_percentile_threshold", min: 70, max: 98, step: 1, type: "int" },
      { name: "vol_lookback_bars", min: 10, max: 50, step: 2, type: "int" },
      { name: "atr_period", min: 7, max: 28, step: 1, type: "int" },
      { name: "atr_stop_multiplier", min: 2, max: 8, step: 0.5, type: "float" },
      { name: "vote_threshold", min: 2, max: 6, step: 1, type: "int" },
      { name: "cooldown_bars", min: 1, max: 5, step: 1, type: "int" }
    ];
    POLYMARKET_PARAM_SPACE = [
      { name: "min_wallet_score", min: 0.3, max: 0.9, step: 0.05, type: "float" },
      { name: "min_whale_consensus", min: 1, max: 5, step: 1, type: "int" },
      { name: "min_odds", min: 0.05, max: 0.3, step: 0.05, type: "float" },
      { name: "max_odds", min: 0.7, max: 0.95, step: 0.05, type: "float" },
      { name: "min_volume", min: 1e4, max: 1e5, step: 1e4, type: "int" },
      { name: "exit_odds_threshold", min: 0.05, max: 0.25, step: 0.05, type: "float" },
      { name: "stale_position_hours", min: 24, max: 168, step: 24, type: "int" },
      { name: "conviction_lookback_days", min: 7, max: 90, step: 7, type: "int" },
      { name: "tier1_size_pct", min: 1, max: 5, step: 0.5, type: "float" },
      { name: "tier2_size_pct", min: 2, max: 8, step: 0.5, type: "float" },
      { name: "tier3_size_pct", min: 3, max: 12, step: 0.5, type: "float" },
      { name: "category_weight_politics", min: 0.5, max: 2, step: 0.1, type: "float" },
      { name: "category_weight_crypto", min: 0.5, max: 2, step: 0.1, type: "float" },
      { name: "category_weight_sports", min: 0.5, max: 2, step: 0.1, type: "float" },
      { name: "category_weight_other", min: 0.5, max: 2, step: 0.1, type: "float" }
    ];
    DEFAULT_CRYPTO_PARAMS = {
      ema_fast: 7,
      ema_slow: 26,
      rsi_period: 8,
      rsi_overbought: 69,
      rsi_oversold: 31,
      momentum_lookback: 12,
      very_short_momentum_lookback: 6,
      macd_fast: 14,
      macd_slow: 23,
      macd_signal: 9,
      bb_period: 7,
      bb_percentile_threshold: 90,
      vol_lookback_bars: 24,
      atr_period: 14,
      atr_stop_multiplier: 5.5,
      vote_threshold: 4,
      cooldown_bars: 2
    };
    DEFAULT_POLYMARKET_PARAMS = {
      min_wallet_score: 0.6,
      min_whale_consensus: 2,
      min_odds: 0.15,
      max_odds: 0.85,
      min_volume: 5e4,
      exit_odds_threshold: 0.1,
      stale_position_hours: 72,
      conviction_lookback_days: 30,
      tier1_size_pct: 2,
      tier2_size_pct: 3,
      tier3_size_pct: 5,
      category_weight_politics: 1,
      category_weight_crypto: 1.2,
      category_weight_sports: 0.8,
      category_weight_other: 0.9
    };
  }
});

// src/telegram.ts
var telegram_exports = {};
__export(telegram_exports, {
  forwardAlertToTelegram: () => forwardAlertToTelegram,
  getWebhookSecret: () => getWebhookSecret,
  handleWebhookUpdate: () => handleWebhookUpdate,
  init: () => init6,
  isConfigured: () => isConfigured7,
  requestTradeApproval: () => requestTradeApproval,
  sendJobCompletionNotification: () => sendJobCompletionNotification,
  sendMessage: () => sendMessage,
  sendMessageWithKeyboard: () => sendMessageWithKeyboard,
  sendMissionControlDigest: () => sendMissionControlDigest,
  sendScoutBrief: () => sendScoutBrief,
  sendShadowTradeNotification: () => sendShadowTradeNotification,
  sendTradeAlert: () => sendTradeAlert,
  stop: () => stop
});
import { randomBytes } from "crypto";
function isAlertsBotConfigured() {
  return ALERTS_BOT_TOKEN.length > 0 && ALERTS_CHAT_ID.length > 0;
}
async function sendAlertsBotMessage(text, parseMode = "Markdown") {
  if (!isAlertsBotConfigured()) return;
  try {
    const resp = await fetch(`${ALERTS_API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ALERTS_CHAT_ID, text, parse_mode: parseMode })
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error(`[telegram-alerts] sendMessage failed (${resp.status}): ${body}`);
    }
  } catch (err) {
    console.error("[telegram-alerts] sendMessage failed:", err instanceof Error ? err.message : err);
  }
}
async function getMode() {
  try {
    const pool2 = getPool();
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_mode'`);
    if (res.rows.length > 0 && res.rows[0].value === "LIVE") return "[LIVE]";
  } catch {
  }
  return "[BETA]";
}
function isConfigured7() {
  return BOT_TOKEN.length > 0 && CHAT_ID.length > 0;
}
async function tgFetch(method, body) {
  const url = `${API_BASE2}/${method}`;
  const opts = {
    method: "POST",
    headers: { "Content-Type": "application/json" }
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Telegram API ${method} failed (${resp.status}): ${text}`);
  }
  return resp.json();
}
async function sendMessage(text, parseMode = "Markdown") {
  if (!isConfigured7()) return null;
  try {
    const result = await tgFetch("sendMessage", {
      chat_id: CHAT_ID,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true
    });
    return result.result?.message_id || null;
  } catch (err) {
    console.error("[telegram] sendMessage failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
async function sendMessageWithKeyboard(text, keyboard, parseMode = "Markdown") {
  if (!isConfigured7()) return null;
  try {
    const result = await tgFetch("sendMessage", {
      chat_id: CHAT_ID,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard }
    });
    return result.result?.message_id || null;
  } catch (err) {
    console.error("[telegram] sendMessageWithKeyboard failed:", err instanceof Error ? err.message : err);
    return null;
  }
}
async function answerCallbackQuery(callbackQueryId, text) {
  try {
    await tgFetch("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text || "Received"
    });
  } catch (err) {
    console.error("[telegram] answerCallbackQuery failed:", err instanceof Error ? err.message : err);
  }
}
async function editMessage(messageId, text, parseMode = "Markdown") {
  try {
    await tgFetch("editMessageText", {
      chat_id: CHAT_ID,
      message_id: messageId,
      text,
      parse_mode: parseMode
    });
  } catch (err) {
    console.error("[telegram] editMessage failed:", err instanceof Error ? err.message : err);
  }
}
function registerCommand(name, handler) {
  commands[name.toLowerCase()] = handler;
}
async function handleStatusCommand() {
  const mode = await getMode();
  const pool2 = getPool();
  let killSwitchActive = false;
  try {
    const ks = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_kill_switch'`);
    killSwitchActive = ks.rows.length > 0 && ks.rows[0].value === true;
  } catch {
  }
  let pauseActive = false;
  try {
    const pa = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_paused'`);
    pauseActive = pa.rows.length > 0 && pa.rows[0].value === true;
  } catch {
  }
  let scoutLastRun = "never";
  let bankrLastRun = "never";
  let pmLastRun = "never";
  try {
    const sr = await pool2.query(`SELECT created_at FROM job_history WHERE agent_id = 'scout' ORDER BY created_at DESC LIMIT 1`);
    if (sr.rows.length > 0) scoutLastRun = timeAgo(new Date(sr.rows[0].created_at).getTime());
  } catch {
  }
  try {
    const br = await pool2.query(`SELECT created_at FROM job_history WHERE agent_id = 'bankr' ORDER BY created_at DESC LIMIT 1`);
    if (br.rows.length > 0) bankrLastRun = timeAgo(new Date(br.rows[0].created_at).getTime());
  } catch {
  }
  try {
    const pr = await pool2.query(`SELECT created_at FROM job_history WHERE job_id IN ('polymarket-activity-scan','polymarket-full-cycle') ORDER BY created_at DESC LIMIT 1`);
    if (pr.rows.length > 0) pmLastRun = timeAgo(new Date(pr.rows[0].created_at).getTime());
  } catch {
  }
  let healthLine = "";
  try {
    const healthRes = await pool2.query(`SELECT value FROM app_config WHERE key = 'oversight_health_reports'`);
    if (healthRes.rows.length > 0 && Array.isArray(healthRes.rows[0].value) && healthRes.rows[0].value.length > 0) {
      const latest = healthRes.rows[0].value[healthRes.rows[0].value.length - 1];
      const icons = { healthy: "\u{1F7E2}", degraded: "\u{1F7E1}", critical: "\u{1F534}" };
      healthLine = `${icons[latest.overall_status] || "\u26AA"} Oversight: ${latest.overall_status}`;
    }
  } catch {
  }
  let fgLine = "";
  try {
    const { getFearGreedIndex: getFearGreedIndex2 } = await Promise.resolve().then(() => (init_signal_sources(), signal_sources_exports));
    const fg = await getFearGreedIndex2();
    fgLine = `\u{1F631} Fear & Greed: ${fg.value} (${fg.classification})`;
  } catch {
  }
  let shadowLine = "";
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'oversight_shadow_trades'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      const trades = res.rows[0].value;
      const open = trades.filter((t) => t.status === "open");
      const closed = trades.filter((t) => t.status === "closed");
      const totalPnl = closed.reduce((s, t) => s + (t.hypothetical_pnl || 0), 0) + open.reduce((s, t) => s + (t.hypothetical_pnl || 0), 0);
      const pnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
      shadowLine = `\u{1F47B} Shadow: ${open.length} open, ${closed.length} closed | P&L: ${pnlStr}`;
    }
  } catch {
  }
  const notifyMode = await getNotificationMode();
  const lines = [
    `${mode} *DarkNode Status*`,
    "",
    `\u{1F534} Kill Switch: ${killSwitchActive ? "ACTIVE" : "OFF"}`,
    `\u23F8 Paused: ${pauseActive ? "YES" : "NO"}`
  ];
  if (fgLine) lines.push(fgLine);
  lines.push(`\u{1F50D} SCOUT: ${scoutLastRun}`);
  lines.push(`\u{1F3B0} PM SCOUT: ${pmLastRun}`);
  lines.push(`\u{1F4B0} BANKR: ${bankrLastRun}`);
  if (healthLine) lines.push(healthLine);
  if (shadowLine) lines.push(shadowLine);
  lines.push(`\u{1F514} Notifications: ${notifyMode}`);
  lines.push("");
  lines.push(`_${(/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York" })} ET_`);
  return lines.join("\n");
}
async function handlePortfolioCommand() {
  const mode = await getMode();
  const pool2 = getPool();
  let positions = [];
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_positions'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      positions = res.rows[0].value;
    }
  } catch {
  }
  if (positions.length === 0) {
    return `${mode} *Portfolio*

No open positions.

_Use /trades to see recent trade history._`;
  }
  const lines = [`${mode} *Portfolio*`, ""];
  let totalPnl = 0;
  for (const pos of positions) {
    const pnl = pos.unrealized_pnl || 0;
    totalPnl += pnl;
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const arrow = pnl >= 0 ? "\u{1F7E2}" : "\u{1F534}";
    lines.push(`${arrow} *${pos.asset}* ${pos.direction} ${pos.leverage || "1x"}`);
    lines.push(`   Entry: $${pos.entry_price} | P&L: ${pnlStr}`);
  }
  lines.push("");
  const totalStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
  lines.push(`*Total P&L:* ${totalStr}`);
  return lines.join("\n");
}
async function handleIntelCommand() {
  const mode = await getMode();
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'scout_latest_brief'`);
    if (res.rows.length > 0 && res.rows[0].value) {
      const brief = res.rows[0].value;
      const summary = typeof brief === "string" ? brief : brief.summary || JSON.stringify(brief);
      const truncated = summary.length > 3e3 ? summary.slice(0, 3e3) + "\n\n_(truncated)_" : summary;
      return `${mode} *Latest SCOUT Intel*

${truncated}`;
    }
  } catch {
  }
  return `${mode} *Latest SCOUT Intel*

No SCOUT brief available yet. SCOUT agent has not run.`;
}
async function handlePauseCommand() {
  const mode = await getMode();
  const pool2 = getPool();
  try {
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(true), Date.now()]
    );
    console.log("[telegram] Wealth Engines PAUSED via Telegram");
    return `${mode} \u23F8 *System PAUSED*

All Wealth Engine jobs will halt within 60 seconds.
Use /resume to restart.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${mode} \u274C Failed to pause: ${msg}`;
  }
}
async function handleResumeCommand() {
  const mode = await getMode();
  const pool2 = getPool();
  try {
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(false), Date.now()]
    );
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_kill_switch', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(false), Date.now()]
    );
    console.log("[telegram] Wealth Engines RESUMED + kill switch deactivated via Telegram");
    return `${mode} \u25B6\uFE0F *System RESUMED*

All Wealth Engine jobs are active. Kill switch deactivated.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${mode} \u274C Failed to resume: ${msg}`;
  }
}
async function handleScoutCommand() {
  const mode = await getMode();
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'scout_active_theses'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value) && res.rows[0].value.length > 0) {
      const theses = res.rows[0].value;
      const now = Date.now();
      const active = theses.filter((t) => !t.expires_at || t.expires_at > now);
      if (active.length === 0) {
        return `${mode} *Active SCOUT Theses*

All theses have expired. Waiting for next SCOUT cycle.`;
      }
      const lines = [`${mode} *Active SCOUT Theses* (${active.length})`, ""];
      for (const t of active.slice(0, 10)) {
        const conf = t.confidence || "?";
        const dir = t.direction || "?";
        const vc = t.vote_count ?? t.votes;
        const votes = vc != null ? typeof vc === "string" && vc.includes("/") ? vc : `${vc}/6` : "?";
        const score = t.technical_score != null ? t.technical_score.toFixed(2) : "?";
        const regime = t.market_regime || t.regime || "?";
        const nansenFlow = t.nansen_flow_direction || t.nansen_flow || "";
        const target = t.exit_price || t.target_price || "?";
        const age = t.created_at ? `${Math.floor((now - t.created_at) / 36e5)}h ago` : "";
        lines.push(`\u2022 *${t.asset}* \u2014 ${dir} ${conf}`);
        lines.push(`  Votes: ${votes} | Score: ${score} | ${regime}`);
        if (t.entry_price) lines.push(`  Entry: $${t.entry_price} | Stop: $${t.stop_price || "?"} | Target: $${target}`);
        if (nansenFlow) lines.push(`  Nansen: ${nansenFlow}`);
        if (age) lines.push(`  _${age}_`);
        lines.push("");
      }
      return lines.join("\n");
    }
  } catch {
  }
  return `${mode} *Active SCOUT Theses*

No active theses. SCOUT has not generated any yet.`;
}
async function handleTradesCommand(args) {
  const mode = await getMode();
  const pool2 = getPool();
  const limit = Math.min(Math.max(parseInt(args) || 5, 1), 20);
  try {
    const res = await pool2.query(
      `SELECT value FROM app_config WHERE key = 'wealth_engines_trade_history'`
    );
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value) && res.rows[0].value.length > 0) {
      const trades = res.rows[0].value.slice(-limit).reverse();
      const lines = [`${mode} *Recent Trades* (last ${trades.length})`, ""];
      for (const t of trades) {
        const pnl = t.pnl || 0;
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
        const icon = pnl >= 0 ? "\u{1F7E2}" : "\u{1F534}";
        const date = t.closed_at ? new Date(t.closed_at).toLocaleDateString("en-US", { timeZone: "America/New_York" }) : "open";
        lines.push(`${icon} *${t.asset}* ${t.direction} ${t.leverage || "1x"} \u2014 ${pnlStr} (${date})`);
      }
      return lines.join("\n");
    }
  } catch {
  }
  return `${mode} *Recent Trades*

No trade history yet.`;
}
async function handlePublicCommand(args) {
  const mode = await getMode();
  const pool2 = getPool();
  const val = args.trim().toLowerCase();
  if (val !== "on" && val !== "off") {
    try {
      const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_public'`);
      const isPublic = res.rows.length > 0 && res.rows[0].value === true;
      return `${mode} Dashboard is currently *${isPublic ? "PUBLIC" : "PRIVATE"}*.

Usage: /public on | /public off`;
    } catch {
      return `${mode} Dashboard is currently *PRIVATE*.

Usage: /public on | /public off`;
    }
  }
  const newVal = val === "on";
  try {
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_public', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(newVal), Date.now()]
    );
    return `${mode} Dashboard is now *${newVal ? "PUBLIC" : "PRIVATE"}*.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${mode} \u274C Failed to update: ${msg}`;
  }
}
async function handleKillCommand() {
  const mode = await getMode();
  const pool2 = getPool();
  try {
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_kill_switch', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(true), Date.now()]
    );
    console.log("[telegram] KILL SWITCH ACTIVATED via Telegram");
    return `${mode} \u{1F6A8} *KILL SWITCH ACTIVATED*

All positions will be closed on the next monitor tick (within 5 minutes).
Use /resume to deactivate kill switch and resume.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${mode} \u274C Kill switch failed: ${msg}`;
  }
}
async function handleRiskCommand() {
  const mode = await getMode();
  const pool2 = getPool();
  let portfolio = 1e3;
  try {
    const pv = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_portfolio_value'`);
    if (pv.rows.length > 0 && typeof pv.rows[0].value === "number") portfolio = pv.rows[0].value;
  } catch {
  }
  const rcDefaults = { max_leverage: 5, risk_per_trade_pct: 5, max_positions: 3, exposure_cap_pct: 60, correlation_limit: 1, circuit_breaker_7d_pct: -15, circuit_breaker_drawdown_pct: -25 };
  let rc = rcDefaults;
  try {
    const rcRes = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engine_config'`);
    if (rcRes.rows.length > 0 && typeof rcRes.rows[0].value === "object" && rcRes.rows[0].value !== null) {
      rc = { ...rcDefaults, ...rcRes.rows[0].value };
    }
  } catch {
  }
  let positions = [];
  try {
    const pos = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_positions'`);
    if (pos.rows.length > 0 && Array.isArray(pos.rows[0].value)) positions = pos.rows[0].value;
  } catch {
  }
  let history = [];
  try {
    const hist = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_trade_history'`);
    if (hist.rows.length > 0 && Array.isArray(hist.rows[0].value)) history = hist.rows[0].value;
  } catch {
  }
  const totalExposure = positions.reduce((s, p) => s + (p.size || 0) * (p.entry_price || 0), 0);
  const unrealizedPnl = positions.reduce((s, p) => s + (p.unrealized_pnl || 0), 0);
  const exposurePct = portfolio > 0 ? totalExposure / portfolio * 100 : 0;
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1e3;
  const recentTrades = history.filter((t) => new Date(t.closed_at).getTime() > sevenDaysAgo);
  const rolling7d = recentTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const rolling7dPct = portfolio > 0 ? rolling7d / portfolio * 100 : 0;
  const buckets = {};
  for (const p of positions) {
    const b = p.exposure_bucket || "general";
    buckets[b] = (buckets[b] || 0) + 1;
  }
  let peakPortfolio = portfolio;
  try {
    const peakRes = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_peak_portfolio'`);
    if (peakRes.rows.length > 0 && typeof peakRes.rows[0].value === "number") peakPortfolio = peakRes.rows[0].value;
  } catch {
  }
  const drawdownPct = peakPortfolio > 0 ? (portfolio - peakPortfolio) / peakPortfolio * 100 : 0;
  const lines = [
    `${mode} *Risk Dashboard*`,
    "",
    `\u{1F4B0} Portfolio: $${portfolio.toFixed(2)} (peak: $${peakPortfolio.toFixed(2)})`,
    `\u{1F4CA} Exposure: $${totalExposure.toFixed(2)} (${exposurePct.toFixed(0)}% of portfolio)`,
    `\u{1F4C8} Unrealized P&L: ${unrealizedPnl >= 0 ? "+" : ""}$${unrealizedPnl.toFixed(2)}`,
    `\u{1F4C9} 7-Day Rolling P&L: ${rolling7d >= 0 ? "+" : ""}$${rolling7d.toFixed(2)} (${rolling7dPct.toFixed(1)}%)`,
    `\u{1F53B} 7d Breaker: ${rolling7dPct < rc.circuit_breaker_7d_pct ? "\u26A0\uFE0F TRIGGERED" : "OK"} (${rolling7dPct.toFixed(1)}% / ${rc.circuit_breaker_7d_pct}%)`,
    `\u{1F53B} Drawdown Breaker: ${drawdownPct < rc.circuit_breaker_drawdown_pct ? "\u26A0\uFE0F TRIGGERED" : "OK"} (${drawdownPct.toFixed(1)}% / ${rc.circuit_breaker_drawdown_pct}%)`,
    "",
    `*Leverage:* max ${rc.max_leverage}x | *Risk/Trade:* ${rc.risk_per_trade_pct}%`,
    `*Positions:* ${positions.length}/${rc.max_positions}`,
    `*Exposure Limit:* ${exposurePct.toFixed(0)}%/${rc.exposure_cap_pct}%`,
    `*Buckets:* ${Object.entries(buckets).map(([b, c]) => `${b}: ${c}/${rc.correlation_limit}`).join(", ") || "none"}`
  ];
  try {
    const { getSignalQuality: getSignalQuality2 } = await Promise.resolve().then(() => (init_bankr(), bankr_exports));
    const scores = await getSignalQuality2();
    if (scores.length > 0) {
      lines.push("", "*Signal Quality:*");
      for (const s of scores) {
        const emoji = s.win_rate > 60 ? "\u{1F7E2}" : s.win_rate < 40 ? "\u{1F534}" : "\u{1F7E1}";
        lines.push(`${emoji} ${s.source}/${s.asset_class}: ${s.win_rate}% win (${s.recent_results.length} trades, avg $${s.avg_pnl.toFixed(2)})`);
      }
    }
  } catch {
  }
  return lines.join("\n");
}
async function handlePolymarketCommand() {
  const mode = await getMode();
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value) && res.rows[0].value.length > 0) {
      const theses = res.rows[0].value;
      const now = Date.now();
      const active = theses.filter((t) => t.status === "active" && (!t.expires_at || t.expires_at > now));
      if (active.length === 0) {
        return `${mode} *Polymarket Theses*

No active theses. Waiting for next scan.`;
      }
      const lines = [`${mode} *Polymarket Theses* (${active.length})`, ""];
      for (const t of active.slice(0, 8)) {
        const dir = t.direction === "YES" ? "\u2705 YES" : "\u274C NO";
        const age = Math.floor((now - t.created_at) / 36e5);
        const conf = { HIGH: "\u{1F7E2}", MEDIUM: "\u{1F7E1}", LOW: "\u{1F534}" }[t.confidence] || "\u26AA";
        lines.push(`${conf} *${(t.asset || "").slice(0, 60)}*`);
        lines.push(`  ${dir} | Odds: ${((t.current_odds || 0) * 100).toFixed(0)}% | Whales: ${t.whale_consensus || 0}`);
        lines.push(`  Score: ${(t.whale_avg_score || 0).toFixed(2)} | _${age}h ago_`);
        lines.push("");
      }
      return lines.join("\n");
    }
  } catch {
  }
  return `${mode} *Polymarket Theses*

No active theses. Polymarket SCOUT has not generated any yet.`;
}
async function handleTaxCommand() {
  const mode = await getMode();
  const pool2 = getPool();
  let history = [];
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_trade_history'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) history = res.rows[0].value;
  } catch {
  }
  const year = (/* @__PURE__ */ new Date()).getFullYear();
  const yearStart = new Date(year, 0, 1).getTime();
  const yearTrades = history.filter((t) => new Date(t.closed_at).getTime() >= yearStart);
  let gains = 0, losses = 0, washAdj = 0;
  for (const t of yearTrades) {
    if ((t.pnl || 0) >= 0) gains += t.pnl;
    else losses += t.pnl;
    if (t.tax_lot?.wash_sale_flagged) washAdj += t.tax_lot.wash_sale_disallowed || 0;
  }
  const net = gains + losses + washAdj;
  const fedTax = Math.max(0, net) * 0.24;
  const nyTax = Math.max(0, net) * 0.0685;
  const lines = [
    `${mode} *${year} Tax Summary*`,
    "",
    `\u{1F4CA} Total Trades: ${yearTrades.length}`,
    `\u{1F7E2} Gains: +$${gains.toFixed(2)}`,
    `\u{1F534} Losses: -$${Math.abs(losses).toFixed(2)}`,
    `\u26A0\uFE0F Wash Sale Adj: $${washAdj.toFixed(2)}`,
    `\u{1F4B5} Net Taxable: $${net.toFixed(2)}`,
    "",
    `*Estimated Tax:*`,
    `  Federal (24%): $${fedTax.toFixed(2)}`,
    `  NY State (6.85%): $${nyTax.toFixed(2)}`,
    `  Total: $${(fedTax + nyTax).toFixed(2)}`
  ];
  return lines.join("\n");
}
async function handleOversightCommand() {
  const mode = await getMode();
  const pool2 = getPool();
  try {
    const healthRes = await pool2.query(`SELECT value FROM app_config WHERE key = 'oversight_health_reports'`);
    const queueRes = await pool2.query(`SELECT value FROM app_config WHERE key = 'oversight_improvement_queue'`);
    const lastCheckRes = await pool2.query(`SELECT value FROM app_config WHERE key = 'oversight_last_health_check'`);
    const portfolioRes = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_portfolio_value'`);
    const peakRes = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_peak_portfolio'`);
    const historyRes = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_trade_history'`);
    let healthStatus = "No health checks run yet";
    let healthIcon = "\u26AA";
    if (healthRes.rows.length > 0 && Array.isArray(healthRes.rows[0].value) && healthRes.rows[0].value.length > 0) {
      const latest = healthRes.rows[0].value[healthRes.rows[0].value.length - 1];
      const icons = { healthy: "\u{1F7E2}", degraded: "\u{1F7E1}", critical: "\u{1F534}" };
      healthIcon = icons[latest.overall_status] || "\u26AA";
      healthStatus = latest.summary || latest.overall_status;
    }
    let openImprovements = 0;
    let criticalImprovements = 0;
    const activeItems = [];
    if (queueRes.rows.length > 0 && Array.isArray(queueRes.rows[0].value)) {
      const open = queueRes.rows[0].value.filter((i) => i.status === "open");
      openImprovements = open.length;
      criticalImprovements = open.filter((i) => i.severity === "critical").length;
      for (const item of open.slice(0, 5)) {
        activeItems.push({ severity: item.severity, title: item.title, route: item.route || "manual" });
      }
    }
    const portfolio = portfolioRes.rows.length > 0 ? Number(portfolioRes.rows[0].value) : 1e3;
    const peak = peakRes.rows.length > 0 ? Number(peakRes.rows[0].value) : 1e3;
    const drawdownPct = peak > 0 ? (peak - portfolio) / peak * 100 : 0;
    let rolling7dPct = 0;
    if (historyRes.rows.length > 0 && Array.isArray(historyRes.rows[0].value)) {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1e3;
      const recent = historyRes.rows[0].value.filter((t) => new Date(t.closed_at).getTime() > sevenDaysAgo);
      const rolling7d = recent.reduce((s, t) => s + (t.pnl || 0), 0);
      rolling7dPct = portfolio > 0 ? rolling7d / portfolio * 100 : 0;
    }
    let lastCheck = "never";
    if (lastCheckRes.rows.length > 0 && typeof lastCheckRes.rows[0].value === "number") {
      lastCheck = timeAgo(lastCheckRes.rows[0].value);
    }
    const ddIcon = drawdownPct > 25 ? "\u{1F534}" : drawdownPct > 15 ? "\u{1F7E1}" : "\u{1F7E2}";
    const pnlIcon = rolling7dPct < -15 ? "\u{1F534}" : rolling7dPct < -5 ? "\u{1F7E1}" : "\u{1F7E2}";
    const lines = [
      `${mode} *Oversight Status*`,
      "",
      `${healthIcon} *Health:* ${healthStatus}`,
      `\u{1F550} *Last Check:* ${lastCheck}`,
      "",
      `*Drawdown:*`,
      `${ddIcon} Peak DD: ${drawdownPct.toFixed(1)}% ($${portfolio.toFixed(2)} / $${peak.toFixed(2)} peak)`,
      `${pnlIcon} 7d P&L: ${rolling7dPct >= 0 ? "+" : ""}${rolling7dPct.toFixed(1)}%`,
      "",
      `\u{1F4CB} *Open Improvements:* ${openImprovements}${criticalImprovements > 0 ? ` (${criticalImprovements} critical)` : ""}`
    ];
    if (activeItems.length > 0) {
      const sevIcons = { critical: "\u{1F534}", high: "\u{1F7E0}", medium: "\u{1F7E1}", low: "\u26AA" };
      for (const item of activeItems) {
        lines.push(`  ${sevIcons[item.severity] || "\u26AA"} ${item.title} \u2192 ${item.route}`);
      }
    }
    return lines.join("\n");
  } catch (err) {
    return `${mode} *Oversight Status*

\u274C Failed to fetch: ${err instanceof Error ? err.message : String(err)}`;
  }
}
async function handleShadowCommand() {
  const mode = await getMode();
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'oversight_shadow_trades'`);
    if (res.rows.length === 0 || !Array.isArray(res.rows[0].value) || res.rows[0].value.length === 0) {
      return `${mode} *Shadow Trading*

No shadow trades recorded yet.`;
    }
    const trades = res.rows[0].value;
    const openTrades = trades.filter((t) => t.status === "open");
    const closedTrades = trades.filter((t) => t.status === "closed");
    const totalPnl = closedTrades.reduce((s, t) => s + (t.hypothetical_pnl || 0), 0);
    const openPnl = openTrades.reduce((s, t) => s + (t.hypothetical_pnl || 0), 0);
    const wins = closedTrades.filter((t) => (t.hypothetical_pnl || 0) > 0);
    const winRate = closedTrades.length > 0 ? wins.length / closedTrades.length * 100 : 0;
    const lines = [
      `${mode} *Shadow Trading*`,
      "",
      `\u{1F4CA} *Total:* ${trades.length} trades (${openTrades.length} open, ${closedTrades.length} closed)`,
      `\u{1F4B0} *Closed P&L:* ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
      `\u{1F4C8} *Open P&L:* ${openPnl >= 0 ? "+" : ""}$${openPnl.toFixed(2)}`,
      `\u{1F3AF} *Win Rate:* ${winRate.toFixed(0)}%`
    ];
    if (openTrades.length > 0) {
      lines.push("");
      lines.push("*Open Positions:*");
      for (const t of openTrades.slice(0, 5)) {
        const pnlStr = t.hypothetical_pnl >= 0 ? `+$${t.hypothetical_pnl.toFixed(2)}` : `-$${Math.abs(t.hypothetical_pnl).toFixed(2)}`;
        lines.push(`  \u2022 ${t.asset} ${t.direction} \u2014 ${pnlStr}`);
      }
    }
    return lines.join("\n");
  } catch (err) {
    return `${mode} *Shadow Trading*

\u274C Failed to fetch: ${err instanceof Error ? err.message : String(err)}`;
  }
}
async function handleAlertsCommand() {
  const mode = await getMode();
  const darkNodeStatus = isConfigured7() ? "\u2705 Connected" : "\u274C Disconnected";
  const alertsStatus = isAlertsBotConfigured() ? "\u2705 Connected" : "\u274C Disconnected";
  return [
    `${mode} *Telegram Bots Status*`,
    "",
    `\u{1F916} *DarkNode* (trading): ${darkNodeStatus}`,
    "  \u2192 Scout signals, BANKR execution, oversight, shadow trades, job failures",
    "",
    `\u{1F4CB} *Mission Control* (personal + status): ${alertsStatus}`,
    "  \u2192 Daily briefs, calendar, email, stock watchlist, task alerts",
    "  \u2192 DarkNode status digest (every 4h)"
  ].join("\n");
}
async function handleHelpCommand() {
  const mode = await getMode();
  return [
    `${mode} *DarkNode Commands*`,
    "",
    "/status \u2014 System health & mode",
    "/portfolio \u2014 Open positions & P&L",
    "/intel \u2014 Latest SCOUT brief",
    "/scout \u2014 Active crypto theses",
    "/polymarket \u2014 Active PM theses",
    "/trades [n] \u2014 Last N trades (default 5)",
    "/risk \u2014 Risk dashboard",
    "/oversight \u2014 Oversight agent status",
    "/shadow \u2014 Shadow trading stats",
    "/tax \u2014 YTD tax summary",
    "/kill \u2014 Emergency kill switch",
    "/pause \u2014 Halt all Wealth Engine jobs",
    "/resume \u2014 Resume Wealth Engine jobs",
    "/public on|off \u2014 Toggle dashboard access",
    "/alerts \u2014 Bot connection status",
    "/notify [smart|immediate|digest] \u2014 Notification mode",
    "/research [crypto|polymarket|status] \u2014 Autoresearch",
    "/help \u2014 This message"
  ].join("\n");
}
async function requestTradeApproval(params) {
  const mode = await getMode();
  if (!isConfigured7()) {
    console.warn("[telegram] Trade approval requested but Telegram not configured \u2014 auto-skipping");
    return "skip";
  }
  const text = [
    `${mode} \u{1F514} *Trade Approval Required*`,
    "",
    `*Asset:* ${params.asset}`,
    `*Direction:* ${params.direction}`,
    `*Leverage:* ${params.leverage}`,
    `*Entry:* $${params.entryPrice}`,
    `*Stop Loss:* $${params.stopLoss}`,
    `*Take Profit:* $${params.takeProfit}`,
    `*Risk:* $${params.riskAmount}`,
    "",
    `*Reason:* ${params.reason}`,
    "",
    `_Thesis: ${params.thesisId}_`
  ].join("\n");
  const approvalId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const keyboard = [
    [
      { text: "\u2705 Approve", callback_data: `trade_approve:${approvalId}` },
      { text: "\u23ED Skip", callback_data: `trade_skip:${approvalId}` },
      { text: "\u23F8 Hold", callback_data: `trade_hold:${approvalId}` }
    ]
  ];
  return new Promise(async (resolve) => {
    const msgId = await sendMessageWithKeyboard(text, keyboard);
    pendingApprovals.set(approvalId, {
      thesisId: params.thesisId,
      asset: params.asset,
      direction: params.direction,
      leverage: params.leverage,
      messageId: msgId || 0,
      createdAt: Date.now(),
      resolve
    });
    setTimeout(() => {
      if (pendingApprovals.has(approvalId)) {
        pendingApprovals.delete(approvalId);
        resolve("skip");
        if (msgId) {
          editMessage(msgId, `${text}

\u23F0 _Expired \u2014 auto-skipped after 30 minutes_`);
        }
      }
    }, 30 * 60 * 1e3);
  });
}
async function handleCallbackQuery(callbackQueryId, data) {
  const [action, approvalId] = data.split(":");
  if (!action?.startsWith("trade_")) {
    await answerCallbackQuery(callbackQueryId, "Unknown action");
    return;
  }
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    await answerCallbackQuery(callbackQueryId, "This approval has expired");
    return;
  }
  const decision = action.replace("trade_", "");
  pendingApprovals.delete(approvalId);
  const pool2 = getPool();
  try {
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [
        `trade_decision_${approvalId}`,
        JSON.stringify({ decision, thesisId: pending.thesisId, asset: pending.asset, decidedAt: (/* @__PURE__ */ new Date()).toISOString() }),
        Date.now()
      ]
    );
  } catch (err) {
    console.error("[telegram] Failed to record trade decision:", err);
  }
  const decisionLabels = {
    approve: "\u2705 APPROVED",
    skip: "\u23ED SKIPPED",
    hold: "\u23F8 ON HOLD"
  };
  const mode = await getMode();
  if (pending.messageId) {
    await editMessage(
      pending.messageId,
      `${mode} *Trade ${decisionLabels[decision]}*

*${pending.asset}* ${pending.direction} ${pending.leverage}

_Decision recorded at ${(/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York" })} ET_`
    );
  }
  await answerCallbackQuery(callbackQueryId, decisionLabels[decision]);
  pending.resolve(decision);
  console.log(`[telegram] Trade ${decision}: ${pending.asset} ${pending.direction} (thesis: ${pending.thesisId})`);
}
async function pollUpdates() {
  if (!pollingActive || !isConfigured7()) return;
  try {
    const result = await tgFetch("getUpdates", {
      offset: lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ["message", "callback_query"]
    });
    const updates = result.result || [];
    for (const update of updates) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);
      if (update.callback_query) {
        const cbq = update.callback_query;
        if (String(cbq.message?.chat?.id) === CHAT_ID) {
          await handleCallbackQuery(cbq.id, cbq.data || "");
        }
        continue;
      }
      if (update.message?.text && String(update.message.chat.id) === CHAT_ID) {
        const text = update.message.text.trim();
        if (text.startsWith("/")) {
          const parts = text.split(/\s+/);
          const cmd = parts[0].toLowerCase().replace(/@\w+/, "").replace("/", "");
          const args = parts.slice(1).join(" ");
          const handler = commands[cmd];
          if (handler) {
            try {
              const response = await handler(args);
              await sendMessage(response);
            } catch (err) {
              console.error(`[telegram] Command /${cmd} failed:`, err);
              await sendMessage(`\u274C Command failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && !err.message.includes("ETIMEDOUT")) {
      console.error("[telegram] Poll error:", err.message);
    }
  }
  if (pollingActive) {
    pollingTimeout = setTimeout(() => pollUpdates(), 1e3);
  }
}
function timeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 6e4);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
async function isJobEnabled(pool2, agentId) {
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'scheduled_jobs'`);
    if (res.rows.length > 0 && res.rows[0].value?.jobs) {
      const jobs = res.rows[0].value.jobs;
      return jobs.some((j) => j.agentId === agentId && j.enabled);
    }
  } catch {
  }
  return false;
}
async function checkDeadManSwitches() {
  if (!isConfigured7()) return;
  const pool2 = getPool();
  const mode = await getMode();
  let paused = false;
  try {
    const pa = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_paused'`);
    paused = pa.rows.length > 0 && pa.rows[0].value === true;
  } catch {
  }
  if (paused) return;
  const scoutEnabled = await isJobEnabled(pool2, "scout");
  if (scoutEnabled) {
    try {
      const scoutRes = await pool2.query(
        `SELECT created_at FROM job_history WHERE agent_id = 'scout' ORDER BY created_at DESC LIMIT 1`
      );
      if (scoutRes.rows.length > 0) {
        const lastRun = new Date(scoutRes.rows[0].created_at).getTime();
        const hoursSince = (Date.now() - lastRun) / (3600 * 1e3);
        if (hoursSince > 6) {
          const lastAlert = lastDeadManAlert["scout"] || 0;
          if (Date.now() - lastAlert > 4 * 3600 * 1e3) {
            lastDeadManAlert["scout"] = Date.now();
            await sendMessage(
              `${mode} \u26A0\uFE0F *Dead Man's Switch: SCOUT*

SCOUT has not run in ${Math.floor(hoursSince)}h (threshold: 6h).
Last run: ${timeAgo(lastRun)}

Check scheduled jobs or run manually.`
            );
          }
        } else {
          delete lastDeadManAlert["scout"];
        }
      }
    } catch (err) {
      console.error("[telegram] Dead man switch SCOUT check failed:", err);
    }
  } else {
    delete lastDeadManAlert["scout"];
  }
  try {
    const monitorRes = await pool2.query(
      `SELECT value FROM app_config WHERE key = 'bankr_monitor_last_tick'`
    );
    if (monitorRes.rows.length > 0) {
      const lastTick = typeof monitorRes.rows[0].value === "number" ? monitorRes.rows[0].value : parseInt(String(monitorRes.rows[0].value));
      const minsSince = (Date.now() - lastTick) / (60 * 1e3);
      if (minsSince > 30) {
        const lastAlert = lastDeadManAlert["bankr-monitor"] || 0;
        if (Date.now() - lastAlert > 60 * 60 * 1e3) {
          lastDeadManAlert["bankr-monitor"] = Date.now();
          await sendMessage(
            `${mode} \u26A0\uFE0F *Dead Man's Switch: BANKR Monitor*

Position monitor has not ticked in ${Math.floor(minsSince)} min (threshold: 30 min).
Last tick: ${timeAgo(lastTick)}

The server may have restarted or crashed.`
          );
        }
      } else {
        delete lastDeadManAlert["bankr-monitor"];
      }
    }
  } catch (err) {
    console.error("[telegram] Dead man switch BANKR monitor check failed:", err);
  }
  const bankrEnabled = await isJobEnabled(pool2, "bankr");
  if (bankrEnabled) {
    try {
      const bankrRes = await pool2.query(
        `SELECT created_at FROM job_history WHERE agent_id = 'bankr' ORDER BY created_at DESC LIMIT 1`
      );
      if (bankrRes.rows.length > 0) {
        const lastRun = new Date(bankrRes.rows[0].created_at).getTime();
        const hoursSince = (Date.now() - lastRun) / (3600 * 1e3);
        if (hoursSince > 8) {
          const lastAlert = lastDeadManAlert["bankr"] || 0;
          if (Date.now() - lastAlert > 4 * 3600 * 1e3) {
            lastDeadManAlert["bankr"] = Date.now();
            await sendMessage(
              `${mode} \u26A0\uFE0F *Dead Man's Switch: BANKR*

BANKR agent has not run in ${Math.floor(hoursSince)}h (threshold: 8h).
Last run: ${timeAgo(lastRun)}

Check scheduled jobs or run manually.`
            );
          }
        } else {
          delete lastDeadManAlert["bankr"];
        }
      }
    } catch (err) {
      console.error("[telegram] Dead man switch BANKR check failed:", err);
    }
  } else {
    delete lastDeadManAlert["bankr"];
  }
}
async function sendTradeAlert(params) {
  const mode = await getMode();
  const icons = {
    executed: "\u{1F4C8}",
    stopped: "\u{1F6D1}",
    emergency: "\u{1F6A8}",
    closed: "\u2705"
  };
  const icon = icons[params.type] || "\u{1F4CA}";
  const lines = [`${mode} ${icon} *Trade ${params.type.toUpperCase()}*`, ""];
  lines.push(`*Asset:* ${params.asset}`);
  if (params.direction) lines.push(`*Direction:* ${params.direction}`);
  if (params.leverage) lines.push(`*Leverage:* ${params.leverage}`);
  if (params.entryPrice) lines.push(`*Entry:* $${params.entryPrice}`);
  if (params.exitPrice) lines.push(`*Exit:* $${params.exitPrice}`);
  if (params.pnl != null) {
    const pnlStr = params.pnl >= 0 ? `+$${params.pnl.toFixed(2)}` : `-$${Math.abs(params.pnl).toFixed(2)}`;
    lines.push(`*P&L:* ${pnlStr}`);
  }
  if (params.reason) lines.push(`
_${params.reason}_`);
  await sendMessage(lines.join("\n"));
}
async function sendScoutBrief(brief) {
  const mode = await getMode();
  const truncated = brief.length > 3500 ? brief.slice(0, 3500) + "\n\n_(truncated)_" : brief;
  await sendMessage(`${mode} \u{1F50D} *SCOUT Morning Brief*

${truncated}`);
}
async function flushDigestQueue() {
  if (digestQueue.length === 0) return;
  if (!isConfigured7()) {
    digestQueue.length = 0;
    return;
  }
  const mode = await getMode();
  const events = digestQueue.splice(0, digestQueue.length);
  const grouped = {};
  for (const e of events) {
    const key = e.jobId.split("-")[0];
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(e);
  }
  const lines = [`${mode} \u{1F4CA} *Wealth Engines Digest*`, ""];
  const groupIcons = {
    scout: "\u{1F50D}",
    polymarket: "\u{1F3B0}",
    bankr: "\u{1F4B0}",
    oversight: "\u{1F6E1}\uFE0F",
    autoresearch: "\u{1F52C}"
  };
  for (const [group, evts] of Object.entries(grouped)) {
    const icon = groupIcons[group] || "\u2699\uFE0F";
    const successes = evts.filter((e) => e.status !== "error").length;
    const errors = evts.filter((e) => e.status === "error").length;
    lines.push(`${icon} *${evts[0].jobName}* \u2014 ${successes} run(s)${errors > 0 ? `, ${errors} error(s)` : ""}`);
    const lastEvent = evts[evts.length - 1];
    if (lastEvent.detail) lines.push(`  ${lastEvent.detail}`);
  }
  lines.push("");
  lines.push(`_${events.length} events over last 4h_`);
  lines.push(`_${(/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York" })} ET_`);
  await sendMessage(lines.join("\n"));
  console.log(`[telegram] Digest flushed: ${events.length} events`);
}
async function sendJobCompletionNotification(params) {
  if (!isConfigured7()) return;
  const mode = await getMode();
  const pool2 = getPool();
  const notifyMode = await getNotificationMode();
  const weJobIds = /* @__PURE__ */ new Set([
    "scout-micro-scan",
    "scout-full-cycle",
    "polymarket-activity-scan",
    "polymarket-full-cycle",
    "bankr-execute",
    "oversight-health",
    "oversight-weekly",
    "oversight-daily-summary",
    "oversight-shadow-refresh",
    "autoresearch-weekly"
  ]);
  if (!weJobIds.has(params.jobId)) return;
  if (params.status === "error") {
    const errSnippet = params.summary.slice(0, 300);
    await sendMessage(`${mode} \u274C *Job Failed: ${params.jobName}*

\`${errSnippet}\`

_${(/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York" })} ET_`);
    return;
  }
  if (notifyMode === "smart") {
    if (params.jobId === "scout-micro-scan") {
      try {
        const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'scout_active_theses'`);
        if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
          const active = res.rows[0].value.filter((t) => !t.expires_at || t.expires_at > Date.now());
          const fingerprint = active.map((t) => `${t.asset}:${t.direction}:${t.confidence || "?"}`).sort().join("|");
          const hash = `micro_${fingerprint}`;
          if (hash === lastScoutNotifyHash) return;
          lastScoutNotifyHash = hash;
        }
      } catch {
      }
    }
    if (params.jobId === "polymarket-activity-scan") {
      try {
        const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
        if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
          const active = res.rows[0].value.filter((t) => t.status === "active");
          const fingerprint = active.map((t) => `${(t.asset || "").slice(0, 30)}:${t.direction}:${t.confidence || "?"}`).sort().join("|");
          const hash = `pm_${fingerprint}`;
          if (hash === lastPmNotifyHash) return;
          lastPmNotifyHash = hash;
        }
      } catch {
      }
    }
  }
  const durationStr = params.durationMs ? ` (${Math.round(params.durationMs / 1e3)}s)` : "";
  const statusIcon = params.status === "partial" ? "\u26A0\uFE0F" : "\u2705";
  const icons = {
    "scout-micro-scan": "\u{1F50D}",
    "scout-full-cycle": "\u{1F50D}",
    "polymarket-activity-scan": "\u{1F3B0}",
    "polymarket-full-cycle": "\u{1F3B0}",
    "bankr-execute": "\u{1F4B0}",
    "oversight-health": "\u{1F6E1}\uFE0F",
    "oversight-weekly": "\u{1F6E1}\uFE0F",
    "oversight-daily-summary": "\u{1F4CA}",
    "oversight-shadow-refresh": "\u{1F47B}",
    "autoresearch-weekly": "\u{1F52C}"
  };
  const icon = icons[params.jobId] || "\u2699\uFE0F";
  let detailLines = [];
  try {
    if (params.jobId.startsWith("scout-")) {
      const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'scout_active_theses'`);
      if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
        const now = Date.now();
        const active = res.rows[0].value.filter((t) => !t.expires_at || t.expires_at > now);
        const newTheses = active.filter((t) => t.created_at && now - t.created_at < 36e5);
        detailLines.push(`*Theses:* ${active.length} active${newTheses.length > 0 ? ` (${newTheses.length} new)` : ""}`);
        if (active.length > 0) {
          const regimes = [...new Set(active.map((t) => t.market_regime || t.regime).filter(Boolean))];
          if (regimes.length > 0) detailLines.push(`*Regime:* ${regimes.join(", ")}`);
          for (const t of active.slice(0, 3)) {
            const vc = t.vote_count ?? t.votes;
            const votes = vc != null ? typeof vc === "string" && vc.includes("/") ? vc : `${vc}/6` : "";
            const score = t.technical_score != null ? `score=${t.technical_score.toFixed(2)}` : "";
            const parts = [`${t.asset} ${t.direction}`, t.confidence, votes, score].filter(Boolean);
            detailLines.push(`  \u2022 ${parts.join(" | ")}`);
          }
        }
      }
      try {
        const { getFearGreedIndex: getFearGreedIndex2 } = await Promise.resolve().then(() => (init_signal_sources(), signal_sources_exports));
        const fg = await getFearGreedIndex2();
        detailLines.push(`*F&G:* ${fg.value} (${fg.classification})`);
      } catch {
      }
    } else if (params.jobId.startsWith("polymarket-")) {
      const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
      if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
        const now = Date.now();
        const active = res.rows[0].value.filter((t) => t.status === "active");
        const newTheses = active.filter((t) => t.created_at && now - t.created_at < 36e5);
        detailLines.push(`*PM Theses:* ${active.length} active${newTheses.length > 0 ? ` (${newTheses.length} new)` : ""}`);
        for (const t of active.slice(0, 3)) {
          const odds = t.current_odds != null ? `${(t.current_odds * 100).toFixed(0)}%` : "";
          const whales = t.whale_consensus ? `whales=${t.whale_consensus}` : "";
          const parts = [(t.asset || "").slice(0, 40), t.direction, odds, whales].filter(Boolean);
          detailLines.push(`  \u2022 ${parts.join(" | ")}`);
        }
      }
    } else if (params.jobId === "bankr-execute") {
      detailLines.push(params.summary.slice(0, 200));
    } else if (params.jobId === "oversight-health") {
      const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'oversight_health_reports'`);
      if (res.rows.length > 0 && Array.isArray(res.rows[0].value) && res.rows[0].value.length > 0) {
        const latest = res.rows[0].value[res.rows[0].value.length - 1];
        const icons2 = { healthy: "\u{1F7E2}", degraded: "\u{1F7E1}", critical: "\u{1F534}" };
        detailLines.push(`${icons2[latest.overall_status] || "\u26AA"} ${latest.overall_status}: ${latest.summary || ""}`);
      }
    }
  } catch {
  }
  if (notifyMode === "digest") {
    digestQueue.push({
      timestamp: Date.now(),
      jobId: params.jobId,
      jobName: params.jobName,
      status: params.status,
      detail: detailLines.join(" | ").slice(0, 200)
    });
    return;
  }
  const lines = [
    `${mode} ${icon} *${params.jobName}* ${statusIcon}${durationStr}`
  ];
  lines.push(...detailLines);
  lines.push(`_${(/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York" })} ET_`);
  await sendMessage(lines.join("\n"));
}
async function sendShadowTradeNotification(params) {
  if (!isConfigured7()) return;
  const mode = await getMode();
  if (params.type === "open") {
    const lines = [
      `${mode} \u{1F47B} *Shadow Trade Opened*`,
      "",
      `*Asset:* ${params.asset}`,
      `*Direction:* ${params.direction}`,
      `*Entry:* $${params.entryPrice.toFixed(4)}`
    ];
    if (params.source) lines.push(`*Source:* ${params.source}`);
    await sendMessage(lines.join("\n"));
  } else {
    const pnlStr = params.pnl != null ? params.pnl >= 0 ? `+$${params.pnl.toFixed(2)}` : `-$${Math.abs(params.pnl).toFixed(2)}` : "N/A";
    const pnlIcon = (params.pnl ?? 0) >= 0 ? "\u{1F7E2}" : "\u{1F534}";
    const lines = [
      `${mode} \u{1F47B} *Shadow Trade Closed* ${pnlIcon}`,
      "",
      `*Asset:* ${params.asset}`,
      `*Direction:* ${params.direction}`,
      `*Entry:* $${params.entryPrice.toFixed(4)}`
    ];
    if (params.exitPrice != null) lines.push(`*Exit:* $${params.exitPrice.toFixed(4)}`);
    lines.push(`*P&L:* ${pnlStr}`);
    if (params.reason) lines.push(`_${params.reason}_`);
    await sendMessage(lines.join("\n"));
  }
}
async function getNotificationMode() {
  try {
    const pool2 = getPool();
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'we_notification_mode'`);
    if (res.rows.length > 0) {
      const v = res.rows[0].value;
      if (v === "immediate" || v === "digest") return v;
    }
  } catch {
  }
  return "smart";
}
async function handleNotifyCommand(args) {
  const mode = await getMode();
  const pool2 = getPool();
  const val = args.trim().toLowerCase();
  const validModes = ["smart", "immediate", "digest"];
  if (!validModes.includes(val)) {
    const current = await getNotificationMode();
    return [
      `${mode} *Notification Mode:* ${current}`,
      "",
      `*smart* \u2014 Only notify on material changes (new thesis, regime shift)`,
      `*immediate* \u2014 Notify on every job completion`,
      `*digest* \u2014 Queue events, send batched summary every 4h`,
      "",
      `Usage: /notify smart | /notify immediate | /notify digest`
    ].join("\n");
  }
  try {
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('we_notification_mode', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(val), Date.now()]
    );
    if (val === "digest" && !digestFlushInterval) {
      digestFlushInterval = setInterval(() => {
        flushDigestQueue().catch((err) => console.error("[telegram] Digest flush error:", err));
      }, 4 * 60 * 60 * 1e3);
    } else if (val !== "digest" && digestFlushInterval) {
      clearInterval(digestFlushInterval);
      digestFlushInterval = null;
      if (digestQueue.length > 0) {
        flushDigestQueue().catch(() => {
        });
      }
    }
    return `${mode} \u2705 Notification mode set to *${val}*`;
  } catch (err) {
    return `${mode} \u274C Failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
async function sendMissionControlDigest() {
  if (!isAlertsBotConfigured()) return;
  const mode = await getMode();
  const pool2 = getPool();
  let fgValue = "?";
  let fgClass = "";
  try {
    const { getFearGreedIndex: getFearGreedIndex2 } = await Promise.resolve().then(() => (init_signal_sources(), signal_sources_exports));
    const fg = await getFearGreedIndex2();
    fgValue = String(fg.value);
    fgClass = fg.classification;
  } catch {
  }
  let thesisCount = 0;
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'scout_active_theses'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      thesisCount = res.rows[0].value.filter((t) => !t.expires_at || t.expires_at > Date.now()).length;
    }
  } catch {
  }
  let pmThesisCount = 0;
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      pmThesisCount = res.rows[0].value.filter((t) => t.status === "active").length;
    }
  } catch {
  }
  let shadowPnl = 0;
  let shadowOpen = 0;
  let shadowClosed = 0;
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'oversight_shadow_trades'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      const trades = res.rows[0].value;
      const open = trades.filter((t) => t.status === "open");
      const closed = trades.filter((t) => t.status === "closed");
      shadowOpen = open.length;
      shadowClosed = closed.length;
      shadowPnl = closed.reduce((s, t) => s + (t.hypothetical_pnl || 0), 0) + open.reduce((s, t) => s + (t.hypothetical_pnl || 0), 0);
    }
  } catch {
  }
  let healthStatus = "unknown";
  let healthIcon = "\u26AA";
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'oversight_health_reports'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value) && res.rows[0].value.length > 0) {
      const latest = res.rows[0].value[res.rows[0].value.length - 1];
      healthStatus = latest.overall_status || "unknown";
      healthIcon = { healthy: "\u{1F7E2}", degraded: "\u{1F7E1}", critical: "\u{1F534}" }[healthStatus] || "\u26AA";
    }
  } catch {
  }
  let scoutLastRun = "never";
  let bankrLastRun = "never";
  try {
    const sr = await pool2.query(`SELECT created_at FROM job_history WHERE agent_id = 'scout' ORDER BY created_at DESC LIMIT 1`);
    if (sr.rows.length > 0) scoutLastRun = timeAgo(new Date(sr.rows[0].created_at).getTime());
  } catch {
  }
  try {
    const br = await pool2.query(`SELECT created_at FROM job_history WHERE agent_id = 'bankr' ORDER BY created_at DESC LIMIT 1`);
    if (br.rows.length > 0) bankrLastRun = timeAgo(new Date(br.rows[0].created_at).getTime());
  } catch {
  }
  const pnlStr = shadowPnl >= 0 ? `+$${shadowPnl.toFixed(2)}` : `-$${Math.abs(shadowPnl).toFixed(2)}`;
  const lines = [
    `${mode} \u{1F4CA} *DarkNode Status Digest*`,
    "",
    `\u{1F631} *Fear & Greed:* ${fgValue} (${fgClass})`,
    `${healthIcon} *System:* ${healthStatus}`,
    "",
    `\u{1F50D} *Crypto Theses:* ${thesisCount} active`,
    `\u{1F3B0} *PM Theses:* ${pmThesisCount} active`,
    `\u{1F47B} *Shadow Trades:* ${shadowOpen} open, ${shadowClosed} closed`,
    `\u{1F4B0} *Shadow P&L:* ${pnlStr}`,
    "",
    `\u{1F50D} SCOUT: ${scoutLastRun}`,
    `\u{1F4B0} BANKR: ${bankrLastRun}`,
    "",
    `_${(/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York" })} ET_`
  ];
  await sendAlertsBotMessage(lines.join("\n"));
  console.log("[telegram] Mission Control digest sent");
}
async function registerWebhook() {
  const domain = process.env.TELEGRAM_WEBHOOK_DOMAIN || "rickin.live";
  if (!domain) {
    console.warn("[telegram] No domain available for webhook \u2014 falling back to long-polling");
    return false;
  }
  const webhookUrl = `https://${domain}/api/telegram/webhook`;
  try {
    const result = await tgFetch("setWebhook", {
      url: webhookUrl,
      allowed_updates: ["message", "callback_query"],
      secret_token: WEBHOOK_SECRET
    });
    if (result.ok) {
      console.log(`[telegram] Webhook registered: ${webhookUrl}`);
      return true;
    }
    console.warn("[telegram] Webhook registration failed:", result.description);
    return false;
  } catch (err) {
    console.warn("[telegram] Webhook registration failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
async function deleteWebhook() {
  try {
    await tgFetch("deleteWebhook");
  } catch {
  }
}
function getWebhookSecret() {
  return WEBHOOK_SECRET;
}
async function handleWebhookUpdate(update) {
  if (!isConfigured7()) return;
  if (update.callback_query) {
    const cbq = update.callback_query;
    if (String(cbq.message?.chat?.id) === CHAT_ID) {
      await handleCallbackQuery(cbq.id, cbq.data || "");
    }
    return;
  }
  if (update.message?.text && String(update.message.chat.id) === CHAT_ID) {
    const text = update.message.text.trim();
    if (text.startsWith("/")) {
      const parts = text.split(/\s+/);
      const cmd = parts[0].toLowerCase().replace(/@\w+/, "").replace("/", "");
      const args = parts.slice(1).join(" ");
      const handler = commands[cmd];
      if (handler) {
        try {
          const response = await handler(args);
          await sendMessage(response);
        } catch (err) {
          console.error(`[telegram] Command /${cmd} failed:`, err);
          await sendMessage(`\u274C Command failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}
async function handleResearchCommand(args) {
  const mode = await getMode();
  const parts = args.trim().toLowerCase().split(/\s+/);
  if (parts[0] === "rollback") {
    const domain = parts[1] === "polymarket" ? "polymarket" : "crypto";
    const result = await rollbackParams(domain);
    return `${mode} ${result.success ? "\u2705" : "\u274C"} ${result.message}`;
  }
  if (parts[0] === "status") {
    const status = await getResearchStatus();
    const lines = [
      `${mode} \u{1F52C} *Autoresearch Status*`,
      "",
      `*Crypto Parameters:*`,
      ...Object.entries(status.crypto_params).slice(0, 8).map(([k, v]) => `  ${k}: ${v}`),
      `  ... (${Object.keys(status.crypto_params).length} total)`,
      "",
      `*Polymarket Parameters:*`,
      ...Object.entries(status.polymarket_params).slice(0, 8).map(([k, v]) => `  ${k}: ${v}`),
      `  ... (${Object.keys(status.polymarket_params).length} total)`,
      "",
      `*History:* ${status.crypto_history_count} crypto, ${status.polymarket_history_count} polymarket rollback sets`,
      `*Recent Experiments:* ${status.recent_experiments.length} logged`
    ];
    if (status.recent_experiments.length > 0) {
      const last3 = status.recent_experiments.slice(-3);
      lines.push("");
      for (const e of last3) {
        lines.push(`  ${e.domain}: ${e.outcome} (${e.delta_pct.toFixed(1)}%) \u2014 ${Object.keys(e.parameters_changed).join(", ")}`);
      }
    }
    return lines.join("\n");
  }
  await sendMessage(`${mode} \u{1F52C} Starting autoresearch...`);
  let summaries;
  if (parts[0] === "crypto") {
    summaries = [await runCryptoResearch()];
  } else if (parts[0] === "polymarket") {
    summaries = [await runPolymarketResearch()];
  } else {
    summaries = await runFullResearch();
  }
  return formatResearchSummary(summaries);
}
async function init6() {
  if (!BOT_TOKEN) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set \u2014 Telegram bot disabled");
    return;
  }
  if (!CHAT_ID) {
    console.warn("[telegram] TELEGRAM_CHAT_ID not set \u2014 Telegram bot disabled");
    return;
  }
  registerCommand("status", async () => handleStatusCommand());
  registerCommand("portfolio", async () => handlePortfolioCommand());
  registerCommand("intel", async () => handleIntelCommand());
  registerCommand("pause", async () => handlePauseCommand());
  registerCommand("resume", async () => handleResumeCommand());
  registerCommand("scout", async () => handleScoutCommand());
  registerCommand("trades", async (args) => handleTradesCommand(args));
  registerCommand("public", async (args) => handlePublicCommand(args));
  registerCommand("kill", async () => handleKillCommand());
  registerCommand("risk", async () => handleRiskCommand());
  registerCommand("polymarket", async () => handlePolymarketCommand());
  registerCommand("tax", async () => handleTaxCommand());
  registerCommand("oversight", async () => handleOversightCommand());
  registerCommand("shadow", async () => handleShadowCommand());
  registerCommand("research", async (args) => handleResearchCommand(args));
  registerCommand("alerts", async () => handleAlertsCommand());
  registerCommand("notify", async (args) => handleNotifyCommand(args));
  registerCommand("help", async () => handleHelpCommand());
  try {
    const me = await tgFetch("getMe");
    console.log(`[telegram] Bot connected: @${me.result?.username || "unknown"}`);
  } catch (err) {
    console.error("[telegram] Failed to connect:", err instanceof Error ? err.message : err);
    return;
  }
  if (isAlertsBotConfigured()) {
    try {
      const alertsMe = await fetch(`${ALERTS_API_BASE}/getMe`, { method: "POST", headers: { "Content-Type": "application/json" } });
      if (!alertsMe.ok) {
        console.warn(`[telegram-alerts] Alerts bot getMe failed (${alertsMe.status}) \u2014 check TELEGRAM_ALERTS_BOT_TOKEN`);
      } else {
        const alertsData = await alertsMe.json();
        if (alertsData.ok && alertsData.result?.username) {
          console.log(`[telegram-alerts] Alerts bot connected: @${alertsData.result.username}`);
        } else {
          console.warn("[telegram-alerts] Alerts bot responded but identity unknown \u2014 check token");
        }
      }
    } catch (err) {
      console.warn("[telegram-alerts] Failed to connect alerts bot:", err instanceof Error ? err.message : err);
    }
  } else {
    console.warn("[telegram-alerts] TELEGRAM_ALERTS_BOT_TOKEN not set \u2014 personal alerts bot disabled");
  }
  webhookMode = await registerWebhook();
  if (!webhookMode) {
    await deleteWebhook();
    pollingActive = true;
    pollUpdates();
    console.log("[telegram] initialized (long-polling fallback, dead man switches hourly)");
  } else {
    console.log("[telegram] initialized (webhook mode, dead man switches hourly)");
  }
  deadManInterval = setInterval(() => {
    checkDeadManSwitches().catch((err) => console.error("[telegram] Dead man check error:", err));
  }, 60 * 60 * 1e3);
  if (isAlertsBotConfigured()) {
    missionControlDigestInterval = setInterval(() => {
      sendMissionControlDigest().catch((err) => console.error("[telegram] Mission Control digest error:", err));
    }, 4 * 60 * 60 * 1e3);
    console.log("[telegram] Mission Control status digest enabled (every 4h)");
  }
  const notifyMode = await getNotificationMode();
  if (notifyMode === "digest") {
    digestFlushInterval = setInterval(() => {
      flushDigestQueue().catch((err) => console.error("[telegram] Digest flush error:", err));
    }, 4 * 60 * 60 * 1e3);
    console.log("[telegram] Digest mode active \u2014 events queued, flushed every 4h");
  }
}
function stop() {
  pollingActive = false;
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
    pollingTimeout = null;
  }
  if (deadManInterval) {
    clearInterval(deadManInterval);
    deadManInterval = null;
  }
  if (missionControlDigestInterval) {
    clearInterval(missionControlDigestInterval);
    missionControlDigestInterval = null;
  }
  if (digestFlushInterval) {
    clearInterval(digestFlushInterval);
    digestFlushInterval = null;
  }
  console.log("[telegram] stopped");
}
async function forwardAlertToTelegram(event) {
  const mode = await getMode();
  const personalAlertTypes = /* @__PURE__ */ new Set(["calendar", "stock", "task", "email"]);
  const tradingEventTypes = /* @__PURE__ */ new Set(["scout", "bankr", "oversight", "autoresearch", "circuit_breaker"]);
  if (event.type === "brief") {
    if (!isAlertsBotConfigured()) return;
    const briefLabel = event.briefType ? event.briefType.charAt(0).toUpperCase() + event.briefType.slice(1) : "Daily";
    const truncated = event.content.length > 3500 ? event.content.slice(0, 3500) + "\n\n_(truncated)_" : event.content;
    await sendAlertsBotMessage(`${mode} \u{1F4CB} *${briefLabel} Brief*

${truncated}`);
    return;
  }
  if (event.type === "alert" && personalAlertTypes.has(event.alertType || "")) {
    if (!isAlertsBotConfigured()) return;
    const icons = {
      calendar: "\u{1F4C5}",
      stock: "\u{1F4CA}",
      task: "\u2705",
      email: "\u{1F4E7}"
    };
    const icon = icons[event.alertType || ""] || "\u{1F514}";
    await sendAlertsBotMessage(`${mode} ${icon} *${event.title || "Alert"}*

${event.content}`);
    return;
  }
  if (tradingEventTypes.has(event.type) || event.type === "alert" && !personalAlertTypes.has(event.alertType || "")) {
    if (!isConfigured7()) return;
    const tradingIcons = {
      scout: "\u{1F50D}",
      bankr: "\u{1F4B0}",
      oversight: "\u{1F6E1}\uFE0F",
      autoresearch: "\u{1F52C}",
      circuit_breaker: "\u{1F6A8}"
    };
    const icon = tradingIcons[event.type] || "\u{1F514}";
    await sendMessage(`${mode} ${icon} *${event.title || "Alert"}*

${event.content}`);
  }
}
var BOT_TOKEN, CHAT_ID, API_BASE2, ALERTS_BOT_TOKEN, ALERTS_CHAT_ID, ALERTS_API_BASE, WEBHOOK_SECRET, pollingActive, pollingTimeout, lastUpdateId, deadManInterval, lastDeadManAlert, commands, pendingApprovals, lastScoutNotifyHash, lastPmNotifyHash, digestQueue, digestFlushInterval, missionControlDigestInterval, webhookMode;
var init_telegram = __esm({
  "src/telegram.ts"() {
    "use strict";
    init_db();
    init_autoresearch();
    BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
    CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
    API_BASE2 = `https://api.telegram.org/bot${BOT_TOKEN}`;
    ALERTS_BOT_TOKEN = process.env.TELEGRAM_ALERTS_BOT_TOKEN || "";
    ALERTS_CHAT_ID = process.env.TELEGRAM_ALERTS_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";
    ALERTS_API_BASE = `https://api.telegram.org/bot${ALERTS_BOT_TOKEN}`;
    WEBHOOK_SECRET = randomBytes(32).toString("hex");
    pollingActive = false;
    pollingTimeout = null;
    lastUpdateId = 0;
    deadManInterval = null;
    lastDeadManAlert = {};
    commands = {};
    pendingApprovals = /* @__PURE__ */ new Map();
    lastScoutNotifyHash = "";
    lastPmNotifyHash = "";
    digestQueue = [];
    digestFlushInterval = null;
    missionControlDigestInterval = null;
    webhookMode = false;
  }
});

// src/oversight.ts
var oversight_exports = {};
__export(oversight_exports, {
  autoTrackShadowTrade: () => autoTrackShadowTrade,
  captureImprovement: () => captureImprovement,
  checkPerAssetLosses: () => checkPerAssetLosses,
  closeShadowTrade: () => closeShadowTrade,
  detectCrossDomainExposure: () => detectCrossDomainExposure,
  formatHealthReport: () => formatHealthReport,
  formatPerformanceReview: () => formatPerformanceReview,
  generateDailyPerformanceSummary: () => generateDailyPerformanceSummary,
  getImprovementQueue: () => getImprovementQueue,
  getLatestHealthReport: () => getLatestHealthReport,
  getOversightSummary: () => getOversightSummary,
  getShadowPerformance: () => getShadowPerformance,
  getShadowTrades: () => getShadowTrades,
  openShadowTrade: () => openShadowTrade,
  refreshShadowTradesFromMarket: () => refreshShadowTradesFromMarket,
  reviewTheses: () => reviewTheses,
  runHealthCheck: () => runHealthCheck,
  runPerformanceReview: () => runPerformanceReview,
  sendDailyPerformanceSummary: () => sendDailyPerformanceSummary,
  setTelegramNotifier: () => setTelegramNotifier,
  updateImprovement: () => updateImprovement,
  updateShadowPrices: () => updateShadowPrices
});
function setTelegramNotifier(fn) {
  telegramNotifier = fn;
}
async function notifyTelegram(msg) {
  if (telegramNotifier) {
    try {
      await telegramNotifier(msg);
    } catch (e) {
      console.error("[oversight] Telegram notification failed:", e instanceof Error ? e.message : e);
    }
  }
}
async function getConfigValue2(key, fallback) {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = $1`, [key]);
    if (res.rows.length > 0) return res.rows[0].value;
  } catch (err) {
    console.warn(`[oversight] Failed to read ${key}:`, err instanceof Error ? err.message : err);
  }
  return fallback;
}
async function setConfigValue2(key, value) {
  const pool2 = getPool();
  await pool2.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), Date.now()]
  );
}
function pruneByAge(items, maxItems) {
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  const filtered = items.filter((i) => {
    const rec = i;
    const ts = rec.timestamp || rec.created_at || rec.opened_at || 0;
    return ts > cutoff;
  });
  return filtered.slice(-maxItems);
}
async function runHealthCheck() {
  const pool2 = getPool();
  const checks = [];
  const now = Date.now();
  const scoutCheck = await checkAgentFreshness(pool2, "scout", "SCOUT", 6);
  checks.push(scoutCheck);
  const bankrCheck = await checkAgentFreshness(pool2, "bankr", "BANKR", 8);
  checks.push(bankrCheck);
  const polyScoutCheck = await checkAgentFreshness(pool2, "polymarket-scout", "Polymarket SCOUT", 6);
  checks.push(polyScoutCheck);
  const monitorCheck = await checkMonitorHeartbeat(pool2, now);
  checks.push(monitorCheck);
  const killCheck = await checkKillSwitch(pool2);
  checks.push(killCheck);
  const pauseCheck = await checkPauseState(pool2);
  checks.push(pauseCheck);
  const circuitCheck = await checkCircuitBreakerState(pool2);
  checks.push(circuitCheck);
  const dataCheck = await checkDataFreshness(pool2, now);
  checks.push(dataCheck);
  const jobFailCheck = await checkRecentJobFailures(pool2);
  checks.push(jobFailCheck);
  const apiCheck = await checkApiFailureRates(pool2);
  checks.push(apiCheck);
  const latencyCheck = await checkJobExecutionTrends(pool2);
  checks.push(latencyCheck);
  const criticalCount = checks.filter((c) => c.status === "critical").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const overall = criticalCount > 0 ? "critical" : warnCount >= 2 ? "degraded" : "healthy";
  const summaryParts = [];
  if (criticalCount > 0) summaryParts.push(`${criticalCount} critical`);
  if (warnCount > 0) summaryParts.push(`${warnCount} warnings`);
  const okCount = checks.length - criticalCount - warnCount;
  if (okCount > 0) summaryParts.push(`${okCount} ok`);
  const report = {
    id: `health_${now}`,
    timestamp: now,
    checks,
    overall_status: overall,
    summary: `${overall.toUpperCase()}: ${summaryParts.join(", ")} (${checks.length} checks)`
  };
  const existing = await getConfigValue2(HEALTH_REPORTS_KEY, []);
  existing.push(report);
  await setConfigValue2(HEALTH_REPORTS_KEY, pruneByAge(existing, MAX_REPORTS));
  await setConfigValue2(LAST_HEALTH_CHECK_KEY, now);
  if (criticalCount > 0 || warnCount >= 2) {
    const issues = checks.filter((c) => c.status !== "ok");
    const alertLines = issues.map((i) => `\u2022 ${i.name}: ${i.detail}`).join("\n");
    await notifyTelegram(
      `\u{1F534} HEALTH ${overall.toUpperCase()}
${alertLines}
(${checks.length} checks, ${criticalCount} critical, ${warnCount} warn)`
    );
    for (const issue of issues) {
      await captureImprovement({
        source: "health_check",
        category: "infrastructure",
        severity: issue.status === "critical" ? "critical" : "medium",
        title: `Health: ${issue.name}`,
        description: issue.detail,
        recommendation: `Investigate ${issue.name} \u2014 status: ${issue.status}`
      });
    }
  }
  return report;
}
async function checkAgentFreshness(pool2, agentId, label, thresholdHours) {
  try {
    const res = await pool2.query(
      `SELECT created_at, status FROM job_history WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [agentId]
    );
    if (res.rows.length === 0) {
      return { name: `${label} Freshness`, status: "warn", detail: `${label} has never run` };
    }
    const lastRun = new Date(res.rows[0].created_at).getTime();
    const hoursSince = (Date.now() - lastRun) / (3600 * 1e3);
    if (hoursSince > thresholdHours * 2) {
      return {
        name: `${label} Freshness`,
        status: "critical",
        detail: `${label} last ran ${Math.floor(hoursSince)}h ago (threshold: ${thresholdHours}h)`,
        value: hoursSince,
        threshold: thresholdHours
      };
    }
    if (hoursSince > thresholdHours) {
      return {
        name: `${label} Freshness`,
        status: "warn",
        detail: `${label} last ran ${Math.floor(hoursSince)}h ago (threshold: ${thresholdHours}h)`,
        value: hoursSince,
        threshold: thresholdHours
      };
    }
    const lastStatus = res.rows[0].status;
    if (lastStatus === "error") {
      return {
        name: `${label} Freshness`,
        status: "warn",
        detail: `${label} ran ${Math.floor(hoursSince)}h ago but last status was error`
      };
    }
    return {
      name: `${label} Freshness`,
      status: "ok",
      detail: `${label} ran ${Math.floor(hoursSince)}h ago \u2014 OK`
    };
  } catch {
    return { name: `${label} Freshness`, status: "warn", detail: `Could not check ${label} status` };
  }
}
async function checkMonitorHeartbeat(pool2, now) {
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'bankr_monitor_last_tick'`);
    if (res.rows.length === 0) {
      return { name: "Position Monitor", status: "warn", detail: "Monitor has never ticked" };
    }
    const lastTick = typeof res.rows[0].value === "number" ? res.rows[0].value : parseInt(String(res.rows[0].value));
    const minsSince = (now - lastTick) / (60 * 1e3);
    if (minsSince > 30) {
      return {
        name: "Position Monitor",
        status: "critical",
        detail: `Monitor last ticked ${Math.floor(minsSince)} min ago (threshold: 30 min)`,
        value: minsSince,
        threshold: 30
      };
    }
    if (minsSince > 15) {
      return {
        name: "Position Monitor",
        status: "warn",
        detail: `Monitor last ticked ${Math.floor(minsSince)} min ago`,
        value: minsSince,
        threshold: 30
      };
    }
    return {
      name: "Position Monitor",
      status: "ok",
      detail: `Monitor ticked ${Math.floor(minsSince)} min ago \u2014 OK`
    };
  } catch {
    return { name: "Position Monitor", status: "warn", detail: "Could not check monitor heartbeat" };
  }
}
async function checkKillSwitch(pool2) {
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_kill_switch'`);
    if (res.rows.length > 0 && res.rows[0].value === true) {
      return { name: "Kill Switch", status: "critical", detail: "Kill switch is ACTIVE \u2014 all trading halted" };
    }
  } catch {
  }
  return { name: "Kill Switch", status: "ok", detail: "Kill switch inactive" };
}
async function checkPauseState(pool2) {
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_paused'`);
    if (res.rows.length > 0 && res.rows[0].value === true) {
      return { name: "System Paused", status: "warn", detail: "System is PAUSED \u2014 jobs will not execute" };
    }
  } catch {
  }
  return { name: "System Paused", status: "ok", detail: "System is running" };
}
async function checkCircuitBreakerState(pool2) {
  try {
    const history = await getConfigValue2("wealth_engines_trade_history", []);
    const portfolio = await getConfigValue2("wealth_engines_portfolio_value", 1e3);
    const peak = await getConfigValue2("wealth_engines_peak_portfolio", 1e3);
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1e3;
    const recentTrades = history.filter((t) => new Date(t.closed_at).getTime() > sevenDaysAgo);
    const rolling7d = recentTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    const rolling7dPct = portfolio > 0 ? rolling7d / portfolio * 100 : 0;
    const drawdownPct = peak > 0 ? (peak - portfolio) / peak * 100 : 0;
    if (rolling7dPct < -15 || drawdownPct > 25) {
      await enforceCircuitBreaker(rolling7dPct, drawdownPct);
      return {
        name: "Circuit Breaker",
        status: "critical",
        detail: `Circuit breaker TRIGGERED & ENFORCED \u2014 7d P&L: ${rolling7dPct.toFixed(1)}%, drawdown: ${drawdownPct.toFixed(1)}% \u2014 auto-paused`
      };
    }
    if (rolling7dPct < -10 || drawdownPct > 20) {
      return {
        name: "Circuit Breaker",
        status: "warn",
        detail: `Approaching circuit breaker \u2014 7d P&L: ${rolling7dPct.toFixed(1)}%, drawdown: ${drawdownPct.toFixed(1)}%`
      };
    }
    return {
      name: "Circuit Breaker",
      status: "ok",
      detail: `7d P&L: ${rolling7dPct.toFixed(1)}%, drawdown: ${drawdownPct.toFixed(1)}% \u2014 OK`
    };
  } catch {
    return { name: "Circuit Breaker", status: "warn", detail: "Could not evaluate circuit breaker" };
  }
}
async function checkDataFreshness(pool2, now) {
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'scout_latest_brief'`);
    if (res.rows.length === 0) {
      return { name: "Scout Data", status: "warn", detail: "No scout brief data available" };
    }
    const brief = res.rows[0].value;
    const briefTs = brief?.timestamp || brief?.created_at;
    if (briefTs) {
      const hoursSince = (now - briefTs) / (3600 * 1e3);
      if (hoursSince > 12) {
        return {
          name: "Scout Data",
          status: "warn",
          detail: `Scout brief is ${Math.floor(hoursSince)}h old (stale >12h)`
        };
      }
    }
    return { name: "Scout Data", status: "ok", detail: "Scout brief data available" };
  } catch {
    return { name: "Scout Data", status: "warn", detail: "Could not check scout data" };
  }
}
async function checkRecentJobFailures(pool2) {
  try {
    const res = await pool2.query(
      `SELECT job_id, status FROM job_history
       WHERE agent_id IN ('scout', 'bankr', 'polymarket-scout')
       AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC LIMIT 20`
    );
    const failures = res.rows.filter((r) => r.status === "error");
    if (failures.length >= 5) {
      return {
        name: "Job Failures",
        status: "critical",
        detail: `${failures.length} WE job failures in last 24h`,
        value: failures.length,
        threshold: 5
      };
    }
    if (failures.length >= 2) {
      return {
        name: "Job Failures",
        status: "warn",
        detail: `${failures.length} WE job failures in last 24h`,
        value: failures.length,
        threshold: 5
      };
    }
    return {
      name: "Job Failures",
      status: "ok",
      detail: `${failures.length} failures in last 24h \u2014 OK`
    };
  } catch {
    return { name: "Job Failures", status: "warn", detail: "Could not check job failures" };
  }
}
async function enforceCircuitBreaker(rolling7dPct, drawdownPct) {
  const pool2 = getPool();
  const alreadyPaused = await getConfigValue2("wealth_engines_paused", false);
  if (!alreadyPaused) {
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(true), Date.now()]
    );
    console.log(`[oversight] CIRCUIT BREAKER ENFORCED \u2014 auto-paused all Wealth Engines`);
  }
  const alertMsg = [
    `\u{1F6A8} *CIRCUIT BREAKER TRIGGERED*`,
    "",
    `\u26D4 All Wealth Engine agents have been *AUTO-PAUSED*`,
    `\u{1F4C9} 7-day P&L: ${rolling7dPct.toFixed(1)}%${rolling7dPct < -15 ? " (limit: -15%)" : ""}`,
    `\u{1F4C9} Peak drawdown: ${drawdownPct.toFixed(1)}%${drawdownPct > 25 ? " (limit: 25%)" : ""}`,
    "",
    `Use /resume to manually restart after reviewing positions.`
  ].join("\n");
  await notifyTelegram(alertMsg);
  await captureImprovement({
    source: "circuit_breaker",
    category: "risk",
    severity: "critical",
    domain: "system",
    priority: 1,
    title: `Circuit breaker: 7d ${rolling7dPct.toFixed(1)}%, DD ${drawdownPct.toFixed(1)}%`,
    description: `Auto-paused due to circuit breaker. Rolling 7d P&L: ${rolling7dPct.toFixed(1)}%, peak drawdown: ${drawdownPct.toFixed(1)}%.`,
    pattern_description: "Sustained losses exceeding risk thresholds",
    recommendation: "Review all open positions, evaluate thesis quality, reduce leverage/position sizing before resuming",
    route: "manual"
  });
}
async function checkApiFailureRates(pool2) {
  try {
    const res = await pool2.query(
      `SELECT value FROM app_config WHERE key = 'wealth_engines_api_errors'`
    );
    if (res.rows.length === 0) {
      return { name: "API Health", status: "ok", detail: "No API error tracking data" };
    }
    const errors = res.rows[0].value;
    const recentErrors = Array.isArray(errors) ? errors.filter((e) => e.timestamp > Date.now() - 6 * 60 * 60 * 1e3) : [];
    const byService = {};
    for (const e of recentErrors) {
      const svc = e.service || "unknown";
      byService[svc] = (byService[svc] || 0) + 1;
    }
    const highFailServices = Object.entries(byService).filter(([, count]) => count >= 5);
    if (highFailServices.length > 0) {
      const details = highFailServices.map(([svc, count]) => `${svc}: ${count}`).join(", ");
      return {
        name: "API Health",
        status: highFailServices.some(([, c]) => c >= 10) ? "critical" : "warn",
        detail: `API failures in last 6h: ${details}`,
        value: recentErrors.length
      };
    }
    return { name: "API Health", status: "ok", detail: `${recentErrors.length} API errors in last 6h \u2014 OK` };
  } catch {
    return { name: "API Health", status: "ok", detail: "API error tracking not available" };
  }
}
async function checkJobExecutionTrends(pool2) {
  try {
    const res = await pool2.query(
      `SELECT job_id, duration_ms FROM job_history
       WHERE agent_id IN ('scout', 'bankr', 'polymarket-scout')
       AND created_at > NOW() - INTERVAL '48 hours'
       AND duration_ms IS NOT NULL AND duration_ms > 0
       ORDER BY created_at DESC LIMIT 30`
    );
    if (res.rows.length < 3) {
      return { name: "Job Latency", status: "ok", detail: "Insufficient data for trend analysis" };
    }
    const durations = res.rows.map((r) => r.duration_ms / 1e3).filter((d) => d > 0);
    if (durations.length === 0) {
      return { name: "Job Latency", status: "ok", detail: "No valid durations" };
    }
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    const maxDuration = Math.max(...durations);
    if (maxDuration > 300) {
      return {
        name: "Job Latency",
        status: "warn",
        detail: `Slow jobs detected \u2014 avg: ${avgDuration.toFixed(0)}s, max: ${maxDuration.toFixed(0)}s`,
        value: avgDuration,
        threshold: 120
      };
    }
    return {
      name: "Job Latency",
      status: "ok",
      detail: `Avg job duration: ${avgDuration.toFixed(0)}s, max: ${maxDuration.toFixed(0)}s \u2014 OK`,
      value: avgDuration
    };
  } catch {
    return { name: "Job Latency", status: "ok", detail: "Could not analyze job trends" };
  }
}
async function runPerformanceReview(periodDays = 7) {
  const now = Date.now();
  const periodStart = now - periodDays * 24 * 60 * 60 * 1e3;
  const history = await getConfigValue2("wealth_engines_trade_history", []);
  const periodTrades = history.filter((t) => new Date(t.closed_at).getTime() > periodStart);
  const wins = periodTrades.filter((t) => (t.pnl || 0) > 0);
  const winRate = periodTrades.length > 0 ? wins.length / periodTrades.length * 100 : 0;
  const totalPnl = periodTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const avgPnl = periodTrades.length > 0 ? totalPnl / periodTrades.length : 0;
  let sharpe = 0;
  if (periodTrades.length >= 2) {
    const pnls = periodTrades.map((t) => t.pnl || 0);
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (pnls.length - 1);
    const stdDev = Math.sqrt(variance);
    sharpe = stdDev > 0 ? mean / stdDev * Math.sqrt(252 / periodDays) : 0;
  }
  let bestTrade = null;
  let worstTrade = null;
  for (const t of periodTrades) {
    if (!bestTrade || t.pnl > bestTrade.pnl) bestTrade = { asset: t.asset, pnl: t.pnl };
    if (!worstTrade || t.pnl < worstTrade.pnl) worstTrade = { asset: t.asset, pnl: t.pnl };
  }
  const holdTimes = periodTrades.map((t) => {
    const open = new Date(t.opened_at).getTime();
    const close = new Date(t.closed_at).getTime();
    return (close - open) / (3600 * 1e3);
  });
  const avgHoldTime = holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0;
  const cryptoTheses = await getConfigValue2("scout_active_theses", []);
  const pmTheses = await getConfigValue2("polymarket_scout_active_theses", []);
  const totalTheses = cryptoTheses.length + pmTheses.length;
  const tradedThesisIds = new Set(periodTrades.map((t) => t.thesis_id));
  const allThesisIds = /* @__PURE__ */ new Set([
    ...cryptoTheses.map((t) => t.id),
    ...pmTheses.map((t) => t.id)
  ]);
  const convertedCount = [...tradedThesisIds].filter((id) => allThesisIds.has(id)).length;
  const conversionRate = totalTheses > 0 ? convertedCount / totalTheses * 100 : 0;
  const slippages = periodTrades.filter((t) => t.expected_entry_price && t.entry_price).map((t) => Math.abs(t.entry_price - t.expected_entry_price) / t.expected_entry_price * 100);
  const avgSlippage = slippages.length > 0 ? slippages.reduce((a, b) => a + b, 0) / slippages.length : 0;
  const sourceBreakdown = {};
  for (const t of periodTrades) {
    const src = t.source || "unknown";
    if (!sourceBreakdown[src]) sourceBreakdown[src] = { trades: 0, pnl: 0, win_rate: 0 };
    sourceBreakdown[src].trades++;
    sourceBreakdown[src].pnl += t.pnl || 0;
  }
  for (const src of Object.keys(sourceBreakdown)) {
    const srcTrades = periodTrades.filter((t) => (t.source || "unknown") === src);
    const srcWins = srcTrades.filter((t) => (t.pnl || 0) > 0);
    sourceBreakdown[src].win_rate = srcTrades.length > 0 ? srcWins.length / srcTrades.length * 100 : 0;
  }
  const perAssetPnl = {};
  for (const t of periodTrades) {
    const asset = t.asset || "unknown";
    if (!perAssetPnl[asset]) perAssetPnl[asset] = { trades: 0, pnl: 0, cumulative_loss: 0 };
    perAssetPnl[asset].trades++;
    perAssetPnl[asset].pnl += t.pnl || 0;
    if ((t.pnl || 0) < 0) perAssetPnl[asset].cumulative_loss += Math.abs(t.pnl || 0);
  }
  let maxDrawdownPct = 0;
  if (periodTrades.length > 0) {
    const portfolio = await getConfigValue2("wealth_engines_portfolio_value", 1e3);
    let equity = portfolio;
    let peak = portfolio;
    const sorted = [...periodTrades].sort(
      (a, b) => new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime()
    );
    for (const t of sorted) {
      equity += t.pnl || 0;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? (peak - equity) / peak * 100 : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }
  const signalAttribution = buildSignalAttribution(periodTrades, totalPnl);
  const exposureAlerts = await detectCrossDomainExposure();
  const review = {
    id: `perf_${now}`,
    timestamp: now,
    period_start: periodStart,
    period_end: now,
    total_trades: periodTrades.length,
    win_rate: winRate,
    avg_pnl: avgPnl,
    total_pnl: totalPnl,
    max_drawdown_pct: maxDrawdownPct,
    sharpe_ratio: sharpe,
    best_trade: bestTrade,
    worst_trade: worstTrade,
    avg_hold_time_hours: avgHoldTime,
    thesis_conversion_rate: conversionRate,
    avg_slippage_pct: avgSlippage,
    per_asset_pnl: perAssetPnl,
    source_breakdown: sourceBreakdown,
    signal_attribution: signalAttribution,
    exposure_alerts: exposureAlerts.map((e) => e.detail)
  };
  if (winRate < 40 && periodTrades.length >= 3) {
    await captureImprovement({
      source: "performance_review",
      category: "signal",
      severity: "high",
      title: `Low win rate: ${winRate.toFixed(0)}%`,
      description: `Win rate over ${periodDays}d is ${winRate.toFixed(1)}% (${wins.length}/${periodTrades.length}). Signal quality may be degraded.`,
      recommendation: "Review SCOUT thesis generation criteria; consider tightening confidence thresholds"
    });
  }
  if (avgSlippage > 1.5 && slippages.length >= 2) {
    await captureImprovement({
      source: "performance_review",
      category: "execution",
      severity: "medium",
      title: `High slippage: ${avgSlippage.toFixed(2)}%`,
      description: `Average execution slippage is ${avgSlippage.toFixed(2)}% over ${slippages.length} trades.`,
      recommendation: "Review BNKR execution timing; consider limit orders or smaller position sizes"
    });
  }
  const PERF_REVIEWS_KEY = "oversight_performance_reviews";
  const existingReviews = await getConfigValue2(PERF_REVIEWS_KEY, []);
  existingReviews.push(review);
  await setConfigValue2(PERF_REVIEWS_KEY, pruneByAge(existingReviews, MAX_REPORTS));
  return review;
}
function buildSignalAttribution(trades, totalPnl) {
  const groupKeys = {};
  for (const t of trades) {
    const source = t.source || "unknown";
    const direction = t.direction || "unknown";
    const key = `${source}/${direction}`;
    if (!groupKeys[key]) groupKeys[key] = [];
    groupKeys[key].push(t);
    const sourceKey = source;
    if (!groupKeys[sourceKey]) groupKeys[sourceKey] = [];
    groupKeys[sourceKey].push(t);
  }
  const attrs = [];
  const seen = /* @__PURE__ */ new Set();
  for (const source of ["crypto_scout", "polymarket_scout", "manual"]) {
    const sourceTrades = groupKeys[source];
    if (!sourceTrades || seen.has(source)) continue;
    seen.add(source);
    const wins = sourceTrades.filter((t) => (t.pnl || 0) > 0);
    const losses = sourceTrades.filter((t) => (t.pnl || 0) <= 0);
    const signalPnl = sourceTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    const avgPnlPerTrade = sourceTrades.length > 0 ? signalPnl / sourceTrades.length : 0;
    attrs.push({
      signal_type: source,
      trades: sourceTrades.length,
      wins: wins.length,
      losses: losses.length,
      total_pnl: signalPnl,
      avg_confidence: avgPnlPerTrade,
      contribution_pct: totalPnl !== 0 ? signalPnl / Math.abs(totalPnl) * 100 : 0
    });
    for (const dir of ["LONG", "SHORT", "YES", "NO"]) {
      const dirKey = `${source}/${dir}`;
      const dirTrades = groupKeys[dirKey];
      if (!dirTrades || seen.has(dirKey)) continue;
      seen.add(dirKey);
      const dirWins = dirTrades.filter((t) => (t.pnl || 0) > 0);
      const dirLosses = dirTrades.filter((t) => (t.pnl || 0) <= 0);
      const dirPnl = dirTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      attrs.push({
        signal_type: `${source}/${dir}`,
        trades: dirTrades.length,
        wins: dirWins.length,
        losses: dirLosses.length,
        total_pnl: dirPnl,
        avg_confidence: dirTrades.length > 0 ? dirPnl / dirTrades.length : 0,
        contribution_pct: totalPnl !== 0 ? dirPnl / Math.abs(totalPnl) * 100 : 0
      });
    }
  }
  return attrs.sort((a, b) => b.total_pnl - a.total_pnl);
}
async function detectCrossDomainExposure() {
  const positions = await getConfigValue2("wealth_engines_positions", []);
  const portfolio = await getConfigValue2("wealth_engines_portfolio_value", 1e3);
  const alerts = [];
  const cryptoPositions = positions.filter((p) => p.asset_class === "crypto");
  const pmPositions = positions.filter((p) => p.asset_class === "polymarket");
  const CRYPTO_PM_CORRELATIONS = {
    BTC: ["bitcoin", "btc", "crypto"],
    ETH: ["ethereum", "eth", "crypto"],
    SOL: ["solana", "sol"],
    DOGE: ["doge", "meme"],
    XRP: ["xrp", "ripple"]
  };
  for (const cryptoPos of cryptoPositions) {
    const asset = cryptoPos.asset.toUpperCase().replace(/USDT?$/, "");
    const keywords = CRYPTO_PM_CORRELATIONS[asset] || [asset.toLowerCase()];
    for (const pmPos of pmPositions) {
      const pmAsset = pmPos.asset.toLowerCase();
      const matched = keywords.some((kw) => pmAsset.includes(kw));
      if (!matched) continue;
      const cryptoExposure = (cryptoPos.size || 0) * (cryptoPos.entry_price || 0);
      const pmExposure = (pmPos.size || 0) * (pmPos.entry_price || 0);
      const combinedPct = portfolio > 0 ? (cryptoExposure + pmExposure) / portfolio * 100 : 0;
      const isSameDirection = cryptoPos.direction === "LONG" && pmPos.direction === "YES" || cryptoPos.direction === "SHORT" && pmPos.direction === "NO";
      alerts.push({
        crypto_asset: cryptoPos.asset,
        polymarket_question: pmPos.asset.slice(0, 80),
        correlation_type: isSameDirection ? "direct" : "inverse",
        combined_exposure_pct: combinedPct,
        risk_level: combinedPct > 40 ? "high" : combinedPct > 25 ? "medium" : "low",
        detail: `${cryptoPos.asset} ${cryptoPos.direction} + PM "${pmPos.asset.slice(0, 40)}" ${pmPos.direction} \u2014 ${combinedPct.toFixed(0)}% combined exposure (${isSameDirection ? "correlated" : "hedged"})`
      });
    }
  }
  for (let i = 0; i < pmPositions.length; i++) {
    for (let j = i + 1; j < pmPositions.length; j++) {
      const a = pmPositions[i];
      const b = pmPositions[j];
      if (a.exposure_bucket === b.exposure_bucket) {
        const combinedExposure = a.size * a.entry_price + b.size * b.entry_price;
        const combinedPct = portfolio > 0 ? combinedExposure / portfolio * 100 : 0;
        alerts.push({
          crypto_asset: `PM: ${a.asset}`,
          polymarket_question: b.asset,
          correlation_type: "thematic",
          combined_exposure_pct: combinedPct,
          risk_level: combinedPct > 30 ? "high" : "medium",
          detail: `PM bucket overlap: "${a.asset.slice(0, 30)}" + "${b.asset.slice(0, 30)}" in bucket "${a.exposure_bucket}" \u2014 ${combinedPct.toFixed(0)}% combined`
        });
      }
    }
  }
  const bucketExposure = {};
  for (const pos of positions) {
    const bucket = pos.exposure_bucket || "general";
    const exposure = (pos.size || 0) * (pos.entry_price || 0);
    bucketExposure[bucket] = (bucketExposure[bucket] || 0) + exposure;
  }
  const BUCKET_THRESHOLD_PCT = 40;
  for (const [bucket, exposure] of Object.entries(bucketExposure)) {
    const pct = portfolio > 0 ? exposure / portfolio * 100 : 0;
    if (pct > BUCKET_THRESHOLD_PCT) {
      alerts.push({
        crypto_asset: `Bucket: ${bucket}`,
        polymarket_question: `All positions in "${bucket}"`,
        correlation_type: "thematic",
        combined_exposure_pct: pct,
        risk_level: pct > 60 ? "high" : "medium",
        detail: `Exposure bucket "${bucket}" has ${pct.toFixed(0)}% of portfolio ($${exposure.toFixed(2)}) across ${positions.filter((p) => (p.exposure_bucket || "general") === bucket).length} positions`
      });
    }
  }
  const EXPOSURE_ALERT_THRESHOLD = 40;
  const highExposure = alerts.filter((a) => a.combined_exposure_pct > EXPOSURE_ALERT_THRESHOLD);
  for (const alert of highExposure) {
    await notifyTelegram(
      `\u26A0\uFE0F CROSS-DOMAIN RISK: ${alert.crypto_asset} + ${alert.polymarket_question.slice(0, 40)} \u2014 ${alert.combined_exposure_pct.toFixed(0)}% combined exposure (${alert.correlation_type})`
    );
    await captureImprovement({
      source: "health_check",
      category: "risk",
      severity: alert.combined_exposure_pct > 60 ? "critical" : "high",
      domain: "cross_domain",
      title: `Cross-domain concentration: ${alert.combined_exposure_pct.toFixed(0)}% exposure`,
      description: alert.detail,
      recommendation: "Reduce correlated positions across crypto perps and Polymarket to stay under 40% combined exposure",
      route: "bankr-config"
    });
  }
  return alerts;
}
async function captureImprovement(params) {
  const queue = await getConfigValue2(IMPROVEMENT_QUEUE_KEY, []);
  const isDuplicate = queue.some(
    (i) => i.title === params.title && i.status === "open" && Date.now() - i.created_at < 24 * 60 * 60 * 1e3
  );
  if (isDuplicate) {
    return queue.find((i) => i.title === params.title && i.status === "open");
  }
  const severityPriority = { critical: 1, high: 2, medium: 3, low: 4 };
  const routeMap = {
    signal: "autoresearch",
    execution: "bankr-config",
    infrastructure: "manual",
    risk: "manual",
    strategy: "autoresearch"
  };
  const improvement = {
    id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    created_at: Date.now(),
    source: params.source,
    category: params.category,
    severity: params.severity,
    domain: params.domain || inferDomain(params),
    priority: params.priority ?? severityPriority[params.severity] ?? 3,
    title: params.title,
    description: params.description,
    pattern_description: params.pattern_description,
    recommendation: params.recommendation,
    route: params.route || routeMap[params.category] || "manual",
    status: "open"
  };
  queue.push(improvement);
  await setConfigValue2(IMPROVEMENT_QUEUE_KEY, pruneByAge(queue, MAX_IMPROVEMENTS));
  console.log(`[oversight] Improvement captured: [${params.severity}] ${params.title} \u2192 route:${improvement.route}`);
  return improvement;
}
function inferDomain(params) {
  const text = `${params.title} ${params.description}`.toLowerCase();
  if (text.includes("polymarket") || text.includes("pm ")) return "polymarket";
  if (text.includes("crypto") || text.includes("scout") || text.includes("bnkr") || text.includes("bankr")) return "crypto";
  if (text.includes("cross") || text.includes("exposure") || text.includes("correlated")) return "cross_domain";
  return "system";
}
async function updateImprovement(id, status, note) {
  const queue = await getConfigValue2(IMPROVEMENT_QUEUE_KEY, []);
  const idx = queue.findIndex((i) => i.id === id);
  if (idx === -1) return null;
  queue[idx].status = status;
  if (status === "resolved" || status === "dismissed") {
    queue[idx].resolved_at = Date.now();
    if (note) queue[idx].resolution_note = note;
  }
  await setConfigValue2(IMPROVEMENT_QUEUE_KEY, queue);
  return queue[idx];
}
async function getImprovementQueue() {
  return getConfigValue2(IMPROVEMENT_QUEUE_KEY, []);
}
async function openShadowTrade(params) {
  const shadow = {
    id: `shadow_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    thesis_id: params.thesis_id,
    asset: params.asset,
    asset_class: params.asset_class,
    source: params.source,
    direction: params.direction,
    entry_price: params.entry_price,
    current_price: params.entry_price,
    hypothetical_pnl: 0,
    opened_at: Date.now(),
    market_id: params.market_id,
    status: "open",
    stop_price: params.stop_price,
    target_price: params.target_price
  };
  const trades = await getConfigValue2(SHADOW_TRADES_KEY, []);
  trades.push(shadow);
  await setConfigValue2(SHADOW_TRADES_KEY, pruneByAge(trades, MAX_SHADOW_TRADES));
  console.log(`[oversight] Shadow trade opened: ${params.asset} ${params.direction} @ $${params.entry_price}`);
  try {
    const { sendShadowTradeNotification: sendShadowTradeNotification2 } = await Promise.resolve().then(() => (init_telegram(), telegram_exports));
    sendShadowTradeNotification2({
      type: "open",
      asset: params.asset,
      direction: params.direction,
      entryPrice: params.entry_price,
      source: params.source
    }).catch((e) => console.warn("[oversight] Shadow open notification failed:", e));
  } catch {
  }
  return shadow;
}
async function closeShadowTrade(id, exitPrice, reason) {
  const trades = await getConfigValue2(SHADOW_TRADES_KEY, []);
  const idx = trades.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const trade = trades[idx];
  trade.status = "closed";
  trade.exit_price = exitPrice;
  trade.closed_at = Date.now();
  trade.close_reason = reason;
  const multiplier = trade.direction === "LONG" || trade.direction === "YES" ? 1 : -1;
  trade.hypothetical_pnl = (exitPrice - trade.entry_price) * multiplier;
  await setConfigValue2(SHADOW_TRADES_KEY, trades);
  console.log(`[oversight] Shadow trade closed: ${trade.asset} P&L: $${trade.hypothetical_pnl.toFixed(2)}`);
  try {
    const { updateSignalQuality: updateSignalQuality2 } = await Promise.resolve().then(() => (init_bankr(), bankr_exports));
    await updateSignalQuality2({
      source: trade.source || "crypto_scout",
      asset_class: trade.asset_class,
      pnl: trade.hypothetical_pnl,
      asset: trade.asset
    });
  } catch (e) {
    console.warn("[oversight] Signal quality update on shadow close:", e instanceof Error ? e.message : e);
  }
  try {
    const { sendShadowTradeNotification: sendShadowTradeNotification2 } = await Promise.resolve().then(() => (init_telegram(), telegram_exports));
    sendShadowTradeNotification2({
      type: "close",
      asset: trade.asset,
      direction: trade.direction,
      entryPrice: trade.entry_price,
      exitPrice,
      pnl: trade.hypothetical_pnl,
      reason
    }).catch((e) => console.warn("[oversight] Shadow close notification failed:", e));
  } catch {
  }
  return trade;
}
async function updateShadowPrices(priceUpdates) {
  const trades = await getConfigValue2(SHADOW_TRADES_KEY, []);
  const openTrades = trades.filter((t) => t.status === "open");
  for (const trade of openTrades) {
    const newPrice = priceUpdates[trade.asset];
    if (newPrice != null) {
      trade.current_price = newPrice;
      const multiplier = trade.direction === "LONG" || trade.direction === "YES" ? 1 : -1;
      trade.hypothetical_pnl = (newPrice - trade.entry_price) * multiplier;
    }
  }
  await setConfigValue2(SHADOW_TRADES_KEY, trades);
  return openTrades;
}
async function refreshShadowTradesFromMarket() {
  const trades = await getConfigValue2(SHADOW_TRADES_KEY, []);
  const openTrades = trades.filter((t) => t.status === "open");
  let updated = 0;
  let closed = 0;
  const errors = [];
  const now = Date.now();
  const notifyShadowClose = async (trade, reason) => {
    try {
      const { updateSignalQuality: updateSignalQuality2 } = await Promise.resolve().then(() => (init_bankr(), bankr_exports));
      await updateSignalQuality2({
        source: trade.source || "crypto_scout",
        asset_class: trade.asset_class,
        pnl: trade.hypothetical_pnl,
        asset: trade.asset
      });
    } catch (e) {
      console.warn("[oversight] Signal quality update on shadow refresh close:", e instanceof Error ? e.message : e);
    }
    try {
      const { sendShadowTradeNotification: sendShadowTradeNotification2 } = await Promise.resolve().then(() => (init_telegram(), telegram_exports));
      sendShadowTradeNotification2({
        type: "close",
        asset: trade.asset,
        direction: trade.direction,
        entryPrice: trade.entry_price,
        exitPrice: trade.exit_price || trade.current_price,
        pnl: trade.hypothetical_pnl,
        reason
      }).catch(() => {
      });
    } catch {
    }
  };
  for (const trade of openTrades) {
    const ageHours = (now - trade.opened_at) / (3600 * 1e3);
    if (ageHours > SHADOW_MAX_AGE_HOURS) {
      trade.status = "closed";
      trade.closed_at = now;
      trade.close_reason = "expired";
      trade.exit_price = trade.current_price;
      const multiplier = trade.direction === "LONG" || trade.direction === "YES" ? 1 : -1;
      trade.hypothetical_pnl = (trade.current_price - trade.entry_price) * multiplier;
      closed++;
      await notifyShadowClose(trade, "expired (168h max age)");
      continue;
    }
    try {
      let latestPrice = null;
      if (trade.asset_class === "crypto") {
        const candles = await getHistoricalOHLCV(trade.asset, 1);
        if (candles.length > 0) {
          latestPrice = candles[candles.length - 1].close;
        }
      } else if (trade.asset_class === "polymarket" && trade.market_id) {
        const market = await getMarketDetails(trade.market_id);
        if (market && market.outcome_prices && market.outcome_prices.length > 0) {
          const parsed = parseFloat(String(market.outcome_prices[0]));
          latestPrice = Number.isFinite(parsed) ? parsed : null;
        }
      }
      if (latestPrice != null) {
        trade.current_price = latestPrice;
        const isLong = trade.direction === "LONG" || trade.direction === "YES";
        const multiplier = isLong ? 1 : -1;
        trade.hypothetical_pnl = (latestPrice - trade.entry_price) * multiplier;
        updated++;
        if (trade.stop_price != null) {
          const stopHit = isLong ? latestPrice <= trade.stop_price : latestPrice >= trade.stop_price;
          if (stopHit) {
            trade.status = "closed";
            trade.closed_at = now;
            trade.close_reason = "stop_hit";
            trade.exit_price = latestPrice;
            closed++;
            console.log(`[oversight] Shadow stop hit: ${trade.asset} ${trade.direction} @ $${latestPrice} (stop=$${trade.stop_price}) P&L: $${trade.hypothetical_pnl.toFixed(4)}`);
            await notifyShadowClose(trade, `stop hit ($${trade.stop_price})`);
            continue;
          }
        }
        if (trade.target_price != null) {
          const targetHit = isLong ? latestPrice >= trade.target_price : latestPrice <= trade.target_price;
          if (targetHit) {
            trade.status = "closed";
            trade.closed_at = now;
            trade.close_reason = "target_hit";
            trade.exit_price = latestPrice;
            closed++;
            console.log(`[oversight] Shadow target hit: ${trade.asset} ${trade.direction} @ $${latestPrice} (target=$${trade.target_price}) P&L: $${trade.hypothetical_pnl.toFixed(4)}`);
            await notifyShadowClose(trade, `target hit ($${trade.target_price})`);
            continue;
          }
        }
      }
    } catch (e) {
      errors.push(`${trade.asset}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await setConfigValue2(SHADOW_TRADES_KEY, trades);
  console.log(`[oversight] Shadow refresh: ${updated} updated, ${closed} expired, ${errors.length} errors`);
  return { updated, closed, errors };
}
async function getShadowTrades(statusFilter) {
  const trades = await getConfigValue2(SHADOW_TRADES_KEY, []);
  if (statusFilter) return trades.filter((t) => t.status === statusFilter);
  return trades;
}
async function getShadowPerformance() {
  const trades = await getConfigValue2(SHADOW_TRADES_KEY, []);
  const closed = trades.filter((t) => t.status === "closed");
  const open = trades.filter((t) => t.status === "open");
  const wins = closed.filter((t) => t.hypothetical_pnl > 0);
  const totalPnl = closed.reduce((s, t) => s + t.hypothetical_pnl, 0);
  const openPnl = open.reduce((s, t) => s + t.hypothetical_pnl, 0);
  return {
    total_trades: trades.length,
    open_trades: open.length,
    closed_trades: closed.length,
    total_pnl: totalPnl + openPnl,
    win_rate: closed.length > 0 ? wins.length / closed.length * 100 : 0,
    avg_pnl: closed.length > 0 ? totalPnl / closed.length : 0,
    trades
  };
}
async function getLatestHealthReport() {
  const reports = await getConfigValue2(HEALTH_REPORTS_KEY, []);
  return reports.length > 0 ? reports[reports.length - 1] : null;
}
async function getOversightSummary() {
  const health = await getLatestHealthReport();
  const queue = await getConfigValue2(IMPROVEMENT_QUEUE_KEY, []);
  const openItems = queue.filter((i) => i.status === "open");
  const criticalItems = openItems.filter((i) => i.severity === "critical");
  const shadowPerf = await getShadowPerformance();
  const lastCheck = await getConfigValue2(LAST_HEALTH_CHECK_KEY, null);
  const portfolio = await getConfigValue2("wealth_engines_portfolio_value", 1e3);
  const peak = await getConfigValue2("wealth_engines_peak_portfolio", 1e3);
  const history = await getConfigValue2("wealth_engines_trade_history", []);
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1e3;
  const recentTrades = history.filter((t) => new Date(t.closed_at).getTime() > sevenDaysAgo);
  const rolling7d = recentTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const rolling7dPct = portfolio > 0 ? rolling7d / portfolio * 100 : 0;
  const drawdownPct = peak > 0 ? (peak - portfolio) / peak * 100 : 0;
  return {
    health,
    drawdown: { portfolio_value: portfolio, peak_value: peak, drawdown_pct: drawdownPct, rolling_7d_pnl_pct: rolling7dPct },
    improvements: {
      open: openItems.length,
      total: queue.length,
      critical: criticalItems.length,
      active_items: openItems.slice(0, 10).map((i) => ({
        id: i.id,
        severity: i.severity,
        title: i.title,
        domain: i.domain || "system",
        route: i.route || "manual",
        created_at: i.created_at
      }))
    },
    shadow: { open: shadowPerf.open_trades, total_pnl: shadowPerf.total_pnl },
    last_check: lastCheck
  };
}
function formatHealthReport(report) {
  const statusIcons = { ok: "\u{1F7E2}", warn: "\u{1F7E1}", critical: "\u{1F534}" };
  const overallIcon = statusIcons[report.overall_status] || "\u26AA";
  const lines = [
    `${overallIcon} *Oversight Health Report*`,
    `Status: ${report.overall_status.toUpperCase()}`,
    `_${new Date(report.timestamp).toLocaleString("en-US", { timeZone: "America/New_York" })} ET_`,
    ""
  ];
  for (const check of report.checks) {
    const icon = statusIcons[check.status] || "\u26AA";
    lines.push(`${icon} *${check.name}*: ${check.detail}`);
  }
  lines.push("");
  lines.push(`_${report.summary}_`);
  return lines.join("\n");
}
function formatPerformanceReview(review) {
  const periodDays = Math.round((review.period_end - review.period_start) / (24 * 60 * 60 * 1e3));
  const lines = [
    `\u{1F4CA} *Performance Review (${periodDays}d)*`,
    "",
    `*Trades:* ${review.total_trades}`,
    `*Win Rate:* ${review.win_rate.toFixed(1)}%`,
    `*Total P&L:* ${review.total_pnl >= 0 ? "+" : ""}$${review.total_pnl.toFixed(2)}`,
    `*Avg P&L:* ${review.avg_pnl >= 0 ? "+" : ""}$${review.avg_pnl.toFixed(2)}`,
    `*Max Drawdown:* ${review.max_drawdown_pct.toFixed(1)}%`,
    `*Sharpe:* ${review.sharpe_ratio.toFixed(2)}`,
    `*Avg Hold:* ${review.avg_hold_time_hours.toFixed(1)}h`,
    `*Slippage:* ${review.avg_slippage_pct.toFixed(2)}%`,
    `*Thesis Conv:* ${review.thesis_conversion_rate.toFixed(0)}%`
  ];
  if (review.best_trade) {
    lines.push(`*Best:* ${review.best_trade.asset} +$${review.best_trade.pnl.toFixed(2)}`);
  }
  if (review.worst_trade) {
    lines.push(`*Worst:* ${review.worst_trade.asset} $${review.worst_trade.pnl.toFixed(2)}`);
  }
  if (Object.keys(review.source_breakdown).length > 0) {
    lines.push("");
    lines.push("*By Source:*");
    for (const [src, data] of Object.entries(review.source_breakdown)) {
      lines.push(`  ${src}: ${data.trades} trades, $${data.pnl.toFixed(2)}, ${data.win_rate.toFixed(0)}% win`);
    }
  }
  if (review.exposure_alerts.length > 0) {
    lines.push("");
    lines.push("*\u26A0\uFE0F Exposure Alerts:*");
    for (const alert of review.exposure_alerts) {
      lines.push(`  \u2022 ${alert}`);
    }
  }
  if (review.signal_attribution.length > 0) {
    lines.push("");
    lines.push("*\u{1F4E1} Signal Attribution:*");
    for (const sa of review.signal_attribution) {
      lines.push(`  ${sa.signal_type}: ${sa.wins}W/${sa.losses}L, $${sa.total_pnl.toFixed(2)} (${sa.contribution_pct.toFixed(0)}% contrib)`);
    }
  }
  return lines.join("\n");
}
async function reviewTheses() {
  const cryptoTheses = await getConfigValue2("scout_active_theses", []);
  const pmTheses = await getConfigValue2("polymarket_scout_active_theses", []);
  const history = await getConfigValue2("wealth_engines_trade_history", []);
  const reviews = [];
  const allTheses = [
    ...cryptoTheses.filter((t) => t.status === "active").map((t) => ({ ...t, _source: "crypto_scout" })),
    ...pmTheses.filter((t) => t.status === "active").map((t) => ({ ...t, _source: "polymarket_scout" }))
  ];
  for (const thesis of allTheses) {
    const asset = thesis.asset || thesis.question || "unknown";
    const assetHistory = history.filter((t) => t.thesis_id === thesis.id);
    const assetPnl = assetHistory.reduce((s, t) => s + (t.pnl || 0), 0);
    const assetWins = assetHistory.filter((t) => (t.pnl || 0) > 0).length;
    const assetLosses = assetHistory.filter((t) => (t.pnl || 0) <= 0).length;
    const confidence = thesis.confidence || thesis.score || 0;
    const direction = thesis.direction || "LONG";
    const bullFactors = [];
    const bearFactors = [];
    if (confidence >= 0.7 || confidence >= 3.5) bullFactors.push(`High confidence: ${confidence}`);
    else bearFactors.push(`Low confidence: ${confidence}`);
    if (assetWins > assetLosses) bullFactors.push(`Positive track record: ${assetWins}W/${assetLosses}L`);
    else if (assetLosses > 0) bearFactors.push(`Negative track record: ${assetWins}W/${assetLosses}L`);
    if (assetPnl > 0) bullFactors.push(`Cumulative profit: $${assetPnl.toFixed(2)}`);
    else if (assetPnl < 0) bearFactors.push(`Cumulative loss: $${assetPnl.toFixed(2)}`);
    if (thesis.reasoning) bullFactors.push(`Thesis reasoning documented`);
    if (thesis.age_hours && thesis.age_hours > 72) bearFactors.push(`Thesis aging: ${thesis.age_hours.toFixed(0)}h old`);
    if (thesis.invalidation_criteria) bullFactors.push(`Clear invalidation criteria defined`);
    if (thesis._source === "polymarket_scout") {
      if ((thesis.whale_count ?? 0) >= 3) bullFactors.push(`Strong whale consensus: ${thesis.whale_count} whales`);
      else bearFactors.push(`Weak whale consensus: ${thesis.whale_count || 0} whales`);
      if (thesis.odds && (thesis.odds > 85 || thesis.odds < 15)) bearFactors.push(`Extreme odds: ${thesis.odds}% \u2014 limited edge`);
    }
    const verdict = bullFactors.length > bearFactors.length + 1 ? "bull_favored" : bearFactors.length > bullFactors.length + 1 ? "bear_favored" : "neutral";
    let recommendation = "Continue monitoring";
    if (verdict === "bear_favored") {
      recommendation = "Consider reducing position size or tightening stops";
    }
    reviews.push({
      thesis_id: thesis.id,
      asset: typeof asset === "string" ? asset.slice(0, 50) : "unknown",
      source: thesis._source || "unknown",
      direction: direction || "unknown",
      bull_case: bullFactors.join("; ") || "No strong bull factors",
      bear_case: bearFactors.join("; ") || "No significant bear factors",
      verdict,
      recommendation
    });
    if (verdict === "bear_favored") {
      await captureImprovement({
        source: "performance_review",
        category: "signal",
        severity: "medium",
        domain: thesis._source === "polymarket_scout" ? "polymarket" : "crypto",
        title: `Bear-favored thesis: ${typeof asset === "string" ? asset.slice(0, 30) : "unknown"}`,
        description: `Adversarial review found bear case stronger: ${bearFactors.join("; ")}`,
        pattern_description: `Thesis ${thesis.id} has more bear factors (${bearFactors.length}) than bull (${bullFactors.length})`,
        recommendation,
        route: "autoresearch"
      });
    }
  }
  return reviews;
}
async function checkPerAssetLosses() {
  const history = await getConfigValue2("wealth_engines_trade_history", []);
  const portfolio = await getConfigValue2("wealth_engines_portfolio_value", 1e3);
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1e3;
  const recent = history.filter((t) => new Date(t.closed_at).getTime() > sevenDaysAgo);
  const byAsset = {};
  for (const t of recent) {
    const asset = t.asset || "unknown";
    byAsset[asset] = (byAsset[asset] || 0) + (t.pnl || 0);
  }
  for (const [asset, pnl] of Object.entries(byAsset)) {
    const lossPct = portfolio > 0 ? Math.abs(pnl) / portfolio * 100 : 0;
    if (pnl < 0 && lossPct > 10) {
      await captureImprovement({
        source: "performance_review",
        category: "risk",
        severity: lossPct > 20 ? "critical" : "high",
        domain: "crypto",
        title: `Per-asset loss: ${asset} -${lossPct.toFixed(1)}%`,
        description: `${asset} has accumulated $${Math.abs(pnl).toFixed(2)} loss (${lossPct.toFixed(1)}% of portfolio) in 7 days.`,
        pattern_description: `Concentrated losses in single asset ${asset}`,
        recommendation: `Review ${asset} thesis quality; consider blacklisting or reducing position limits`,
        route: "bankr-config"
      });
    }
  }
}
async function generateDailyPerformanceSummary() {
  const review = await runPerformanceReview(1);
  const health = await getLatestHealthReport();
  const portfolio = await getConfigValue2("wealth_engines_portfolio_value", 1e3);
  const peak = await getConfigValue2("wealth_engines_peak_portfolio", 1e3);
  const drawdownPct = peak > 0 ? (peak - portfolio) / peak * 100 : 0;
  const queue = await getConfigValue2(IMPROVEMENT_QUEUE_KEY, []);
  const openItems = queue.filter((i) => i.status === "open");
  const lines = [
    `\u{1F4CB} *Daily Performance Summary*`,
    `_${(/* @__PURE__ */ new Date()).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" })}_`,
    "",
    `\u{1F4B0} *Portfolio:* $${portfolio.toFixed(2)} (peak: $${peak.toFixed(2)}, DD: ${drawdownPct.toFixed(1)}%)`,
    `\u{1F4CA} *Today:* ${review.total_trades} trades, ${review.total_pnl >= 0 ? "+" : ""}$${review.total_pnl.toFixed(2)}`,
    `\u{1F3AF} *Win Rate:* ${review.win_rate.toFixed(0)}%`
  ];
  if (health) {
    const icons = { healthy: "\u{1F7E2}", degraded: "\u{1F7E1}", critical: "\u{1F534}" };
    lines.push(`${icons[health.overall_status] || "\u26AA"} *System:* ${health.overall_status}`);
  }
  if (openItems.length > 0) {
    const critical = openItems.filter((i) => i.severity === "critical");
    lines.push(`\u{1F4CB} *Open Issues:* ${openItems.length}${critical.length > 0 ? ` (${critical.length} critical)` : ""}`);
  }
  return lines.join("\n");
}
async function sendDailyPerformanceSummary() {
  const summary = await generateDailyPerformanceSummary();
  await notifyTelegram(summary);
  console.log("[oversight] Daily performance summary sent");
}
async function autoTrackShadowTrade(params) {
  const existing = await getShadowTrades("open");
  const match = existing.find((t) => t.asset === params.asset && t.direction === params.direction);
  if (match) {
    const ageHours = (Date.now() - new Date(match.opened_at).getTime()) / 36e5;
    if (ageHours < 24) return null;
    await closeShadowTrade(match.id, match.entry_price, "replaced_by_newer_thesis");
  }
  let stopPrice = params.stop_price;
  let targetPrice = params.target_price;
  if (!stopPrice || !targetPrice) {
    try {
      const { getActiveTheses: getActiveTheses3 } = await Promise.resolve().then(() => (init_crypto_scout(), crypto_scout_exports));
      const theses = await getActiveTheses3();
      const thesis = theses.find((t) => t.id === params.thesis_id || t.asset === params.asset && t.direction === params.direction);
      if (thesis) {
        if (!stopPrice && thesis.stop_price) stopPrice = thesis.stop_price;
        if (!targetPrice && thesis.exit_price) targetPrice = thesis.exit_price;
      }
    } catch (e) {
      console.warn(`[oversight] Thesis lookup for shadow levels failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const shadow = await openShadowTrade({
    thesis_id: params.thesis_id,
    asset: params.asset,
    asset_class: params.asset_class,
    source: params.source,
    direction: params.direction,
    entry_price: params.entry_price,
    market_id: params.market_id,
    stop_price: stopPrice,
    target_price: targetPrice
  });
  console.log(`[oversight] Auto-shadow: ${params.asset} ${params.direction} @ $${params.entry_price} | stop=$${stopPrice ?? "none"} target=$${targetPrice ?? "none"} \u2014 ${params.reason}`);
  return shadow;
}
var telegramNotifier, HEALTH_REPORTS_KEY, IMPROVEMENT_QUEUE_KEY, SHADOW_TRADES_KEY, LAST_HEALTH_CHECK_KEY, MAX_REPORTS, MAX_IMPROVEMENTS, MAX_SHADOW_TRADES, THIRTY_DAYS_MS, SHADOW_MAX_AGE_HOURS;
var init_oversight = __esm({
  "src/oversight.ts"() {
    "use strict";
    init_db();
    init_coingecko();
    init_polymarket();
    telegramNotifier = null;
    HEALTH_REPORTS_KEY = "oversight_health_reports";
    IMPROVEMENT_QUEUE_KEY = "oversight_improvement_queue";
    SHADOW_TRADES_KEY = "oversight_shadow_trades";
    LAST_HEALTH_CHECK_KEY = "oversight_last_health_check";
    MAX_REPORTS = 200;
    MAX_IMPROVEMENTS = 100;
    MAX_SHADOW_TRADES = 200;
    THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1e3;
    SHADOW_MAX_AGE_HOURS = 168;
  }
});

// src/bankr.ts
var bankr_exports = {};
__export(bankr_exports, {
  checkCircuitBreaker: () => checkCircuitBreaker,
  closeAllPositions: () => closeAllPositions,
  closePosition: () => closePosition,
  detectWashSales: () => detectWashSales,
  determineApprovalTier: () => determineApprovalTier,
  generateForm8949CSV: () => generateForm8949CSV,
  getConsecutiveLosses: () => getConsecutiveLosses,
  getMode: () => getMode2,
  getPeakPortfolioValue: () => getPeakPortfolioValue,
  getPortfolioSummary: () => getPortfolioSummary,
  getPortfolioValue: () => getPortfolioValue,
  getPositions: () => getPositions,
  getRiskConfig: () => getRiskConfig,
  getSignalQuality: () => getSignalQuality,
  getSignalQualityModifier: () => getSignalQualityModifier,
  getTaxSummary: () => getTaxSummary,
  getTradeHistory: () => getTradeHistory,
  isKillSwitchActive: () => isKillSwitchActive,
  isPaused: () => isPaused,
  openPosition: () => openPosition,
  runPositionMonitor: () => runPositionMonitor,
  runPreExecutionChecks: () => runPreExecutionChecks,
  setRiskConfig: () => setRiskConfig,
  updateSignalQuality: () => updateSignalQuality
});
async function getRiskConfig() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = $1`, [RISK_CONFIG_KEY]);
    if (res.rows.length > 0 && typeof res.rows[0].value === "object" && res.rows[0].value !== null) {
      return { ...DEFAULT_RISK_CONFIG, ...res.rows[0].value };
    }
  } catch {
  }
  return { ...DEFAULT_RISK_CONFIG };
}
async function setRiskConfig(updates) {
  const current = await getRiskConfig();
  const merged = { ...current, ...updates };
  if (merged.max_leverage < 1 || merged.max_leverage > 10) throw new Error("max_leverage must be 1-10");
  if (merged.risk_per_trade_pct < 1 || merged.risk_per_trade_pct > 10) throw new Error("risk_per_trade_pct must be 1-10");
  if (merged.max_positions < 1 || merged.max_positions > 10) throw new Error("max_positions must be 1-10");
  if (merged.exposure_cap_pct < 20 || merged.exposure_cap_pct > 100) throw new Error("exposure_cap_pct must be 20-100");
  if (merged.correlation_limit < 1 || merged.correlation_limit > 5) throw new Error("correlation_limit must be 1-5");
  if (merged.circuit_breaker_7d_pct > -5 || merged.circuit_breaker_7d_pct < -30) throw new Error("circuit_breaker_7d_pct must be -5 to -30");
  if (merged.circuit_breaker_drawdown_pct > -10 || merged.circuit_breaker_drawdown_pct < -50) throw new Error("circuit_breaker_drawdown_pct must be -10 to -50");
  const pool2 = getPool();
  await pool2.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [RISK_CONFIG_KEY, JSON.stringify(merged), Date.now()]
  );
  return merged;
}
async function getPortfolioValue() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = $1`, [PORTFOLIO_VALUE_KEY]);
    if (res.rows.length > 0 && typeof res.rows[0].value === "number") {
      return res.rows[0].value;
    }
  } catch {
  }
  return DEFAULT_PORTFOLIO;
}
async function setPortfolioValue(value) {
  const pool2 = getPool();
  await pool2.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [PORTFOLIO_VALUE_KEY, JSON.stringify(value), Date.now()]
  );
  const peak = await getPeakPortfolioValue();
  if (value > peak) {
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [PEAK_PORTFOLIO_KEY, JSON.stringify(value), Date.now()]
    );
  }
}
async function getPeakPortfolioValue() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = $1`, [PEAK_PORTFOLIO_KEY]);
    if (res.rows.length > 0 && typeof res.rows[0].value === "number") {
      return res.rows[0].value;
    }
  } catch {
  }
  return DEFAULT_PORTFOLIO;
}
async function getConsecutiveLosses() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = $1`, [CONSECUTIVE_LOSSES_KEY]);
    if (res.rows.length > 0 && typeof res.rows[0].value === "number") {
      return res.rows[0].value;
    }
  } catch {
  }
  return 0;
}
async function updateConsecutiveLosses(pnl) {
  const pool2 = getPool();
  const current = await getConsecutiveLosses();
  const newCount = pnl < 0 ? current + 1 : 0;
  await pool2.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [CONSECUTIVE_LOSSES_KEY, JSON.stringify(newCount), Date.now()]
  );
  return newCount;
}
async function isFirstTradeForAsset(asset, assetClass) {
  const history = await getTradeHistory();
  return !history.some((t) => t.asset === asset && t.asset_class === assetClass);
}
function determineApprovalTier(params) {
  const ddThresh = params.drawdownThreshold ?? -25;
  if (params.capitalPct > 30 || params.consecutiveLosses >= 3 || params.drawdownPct < ddThresh || params.isFirstForAsset || params.leverageIncrease) {
    return "human_required";
  }
  if (params.capitalPct > 20 || params.confidence < 3.5) {
    return "dead_zone";
  }
  return "autonomous";
}
async function getPositions() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_positions'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      return res.rows[0].value;
    }
  } catch {
  }
  return [];
}
async function savePositions(positions) {
  const pool2 = getPool();
  await pool2.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_positions', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(positions), Date.now()]
  );
}
async function getTradeHistory() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_trade_history'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      return res.rows[0].value;
    }
  } catch {
  }
  return [];
}
async function appendTradeHistory(record) {
  const pool2 = getPool();
  const history = await getTradeHistory();
  history.push(record);
  await pool2.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_trade_history', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(history), Date.now()]
  );
}
async function isKillSwitchActive() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_kill_switch'`);
    return res.rows.length > 0 && res.rows[0].value === true;
  } catch {
    return false;
  }
}
async function isPaused() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_paused'`);
    return res.rows.length > 0 && res.rows[0].value === true;
  } catch {
    return false;
  }
}
async function getMode2() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_mode'`);
    if (res.rows.length > 0 && typeof res.rows[0].value === "string") {
      return res.rows[0].value;
    }
  } catch {
  }
  return "BETA";
}
function getExposureBucket(asset, assetClass) {
  const lower = asset.toLowerCase();
  if (assetClass === "polymarket" && !lower.includes("btc") && !lower.includes("eth") && !lower.includes("sol")) {
    return "prediction-only";
  }
  if (lower.includes("btc") || lower.includes("bitcoin")) return "btc";
  if (lower.includes("eth") || lower.includes("ethereum")) return "eth";
  if (lower.includes("sol") || lower.includes("solana")) return "sol";
  return "general-crypto";
}
async function runPreExecutionChecks(params) {
  const checks = [];
  let allPassed = true;
  const killActive = await isKillSwitchActive();
  checks.push({ name: "kill_switch", passed: !killActive, detail: killActive ? "Kill switch is ACTIVE" : "Kill switch inactive" });
  if (killActive) allPassed = false;
  const paused = await isPaused();
  checks.push({ name: "pause_state", passed: !paused, detail: paused ? "System is PAUSED" : "System active" });
  if (paused) allPassed = false;
  const mode = await getMode2();
  checks.push({ name: "mode_check", passed: true, detail: `Mode: ${mode}${mode === "SHADOW" ? " (shadow trades only)" : ""}` });
  const rc = await getRiskConfig();
  const levOk = params.leverage <= rc.max_leverage;
  checks.push({ name: "leverage_cap", passed: levOk, detail: `Requested: ${params.leverage}x, Max: ${rc.max_leverage}x` });
  if (!levOk) allPassed = false;
  const portfolio = await getPortfolioValue();
  const riskPct = rc.risk_per_trade_pct / 100;
  const maxRisk = portfolio * riskPct;
  const riskDistance = Math.abs(params.entry_price - params.stop_price);
  const riskAmount = params.risk_amount || (riskDistance > 0 ? maxRisk : 0);
  const riskOk = riskAmount <= maxRisk;
  checks.push({ name: "risk_per_trade", passed: riskOk, detail: `Risk: $${riskAmount.toFixed(2)}, Max: $${maxRisk.toFixed(2)} (${rc.risk_per_trade_pct}% of $${portfolio.toFixed(2)})` });
  if (!riskOk) allPassed = false;
  if (params.leverage > 1) {
    const marginPerUnit = params.entry_price / params.leverage;
    const liquidationDistance = marginPerUnit;
    const bufferOk = riskDistance < liquidationDistance * 0.8;
    checks.push({ name: "margin_buffer", passed: bufferOk, detail: bufferOk ? "20% buffer above liquidation maintained" : "Insufficient margin buffer \u2014 liquidation too close to stop" });
    if (!bufferOk) allPassed = false;
  } else {
    checks.push({ name: "margin_buffer", passed: true, detail: "No leverage \u2014 no liquidation risk" });
  }
  const positions = await getPositions();
  const posCountOk = positions.length < rc.max_positions;
  checks.push({ name: "max_positions", passed: posCountOk, detail: `Open: ${positions.length}/${rc.max_positions}` });
  if (!posCountOk) allPassed = false;
  const totalExposure = positions.reduce((sum, p) => sum + p.size * p.entry_price, 0);
  const newPositionSize = riskDistance > 0 ? riskAmount / riskDistance : 0;
  const newExposure = newPositionSize * params.entry_price;
  const totalAfter = totalExposure + newExposure;
  const exposureLimit = portfolio * (rc.exposure_cap_pct / 100);
  const exposureOk = totalAfter <= exposureLimit;
  checks.push({ name: "total_exposure", passed: exposureOk, detail: `After: $${totalAfter.toFixed(2)} / $${exposureLimit.toFixed(2)} (${rc.exposure_cap_pct}% of portfolio)` });
  if (!exposureOk) allPassed = false;
  const bucket = getExposureBucket(params.asset, params.asset_class);
  const bucketCount = positions.filter((p) => p.exposure_bucket === bucket).length;
  const correlationOk = bucketCount < rc.correlation_limit;
  checks.push({ name: "correlation_limit", passed: correlationOk, detail: `Bucket "${bucket}": ${bucketCount}/${rc.correlation_limit} positions` });
  if (!correlationOk) allPassed = false;
  const consecutiveLosses = await getConsecutiveLosses();
  checks.push({ name: "consecutive_losses", passed: consecutiveLosses < 3, detail: `Consecutive losses: ${consecutiveLosses}/3` });
  const peakPortfolio = await getPeakPortfolioValue();
  const drawdownPct = peakPortfolio > 0 ? (portfolio - peakPortfolio) / peakPortfolio * 100 : 0;
  const drawdownOk = drawdownPct > rc.circuit_breaker_drawdown_pct;
  checks.push({ name: "peak_drawdown", passed: drawdownOk, detail: `Drawdown from peak: ${drawdownPct.toFixed(1)}% (limit: ${rc.circuit_breaker_drawdown_pct}%)` });
  const capitalPct = portfolio > 0 ? newExposure / portfolio * 100 : 0;
  const firstForAsset = await isFirstTradeForAsset(params.asset, params.asset_class);
  const tier = determineApprovalTier({
    capitalPct,
    confidence: params.confidence || 3.5,
    consecutiveLosses,
    drawdownPct,
    isFirstForAsset: firstForAsset,
    leverageIncrease: false,
    drawdownThreshold: rc.circuit_breaker_drawdown_pct
  });
  checks.push({ name: "approval_tier", passed: true, detail: `Tier: ${tier} (capital: ${capitalPct.toFixed(1)}%, losses: ${consecutiveLosses}, drawdown: ${drawdownPct.toFixed(1)}%, first: ${firstForAsset})` });
  const rejectionReason = allPassed ? null : checks.filter((c) => !c.passed).map((c) => c.detail).join("; ");
  if (!allPassed) {
    try {
      const source = params.asset_class === "polymarket" ? "polymarket_scout" : "crypto_scout";
      await autoTrackShadowTrade({
        thesis_id: `riskfail_${Date.now()}`,
        asset: params.asset,
        asset_class: params.asset_class,
        source,
        direction: params.direction,
        entry_price: params.entry_price,
        stop_price: params.stop_price,
        reason: `risk_check_failed: ${rejectionReason}`
      });
    } catch (e) {
      console.error("[bankr] Shadow tracking on risk fail:", e instanceof Error ? e.message : e);
    }
  }
  return { passed: allPassed, tier, checks, rejection_reason: rejectionReason };
}
async function openPosition(params) {
  const mode = await getMode2();
  if (mode === "SHADOW") {
    const source2 = params.source === "polymarket_scout" ? "polymarket_scout" : "crypto_scout";
    try {
      await autoTrackShadowTrade({
        thesis_id: params.thesis_id,
        asset: params.asset,
        asset_class: params.asset_class,
        source: source2,
        direction: params.direction,
        entry_price: params.entry_price,
        reason: "shadow_mode_active",
        market_id: params.market_id
      });
    } catch (e) {
      console.error("[bankr] Shadow tracking in SHADOW mode:", e instanceof Error ? e.message : e);
    }
    const shadowPosId = `shadow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const shadowTradeId = `shadow_trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const shadowPosition = {
      id: shadowPosId,
      thesis_id: params.thesis_id,
      asset: params.asset,
      asset_class: params.asset_class,
      source: source2,
      direction: params.direction,
      leverage: String(params.leverage),
      entry_price: params.entry_price,
      current_price: params.entry_price,
      size: 0,
      unrealized_pnl: 0,
      peak_price: params.entry_price,
      atr_value: params.atr_value,
      atr_stop_price: params.stop_price,
      venue: params.venue,
      opened_at: (/* @__PURE__ */ new Date()).toISOString(),
      exposure_bucket: "shadow"
    };
    return { position: shadowPosition, trade_id: shadowTradeId };
  }
  const portfolio = await getPortfolioValue();
  const rc = await getRiskConfig();
  const maxRisk = portfolio * (rc.risk_per_trade_pct / 100);
  const riskDistance = Math.abs(params.entry_price - params.stop_price);
  const size = riskDistance > 0 ? maxRisk / riskDistance : 0;
  const posId = `pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tradeId = `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let bnkrOrderId;
  let fillQuantity;
  const source = params.source || (params.asset_class === "polymarket" ? "polymarket_scout" : "crypto_scout");
  if (isConfigured6()) {
    if (params.asset_class === "crypto") {
      const order = await openCryptoPosition({
        asset: params.asset,
        direction: params.direction,
        leverage: params.leverage,
        size,
        stop_price: params.stop_price
      });
      bnkrOrderId = order.order_id;
      if (order.entry_price > 0) params.entry_price = order.entry_price;
    } else if (params.asset_class === "polymarket") {
      if (!params.market_id) {
        throw new Error("market_id is required for Polymarket positions via BNKR");
      }
      const order = await openPolymarketPosition({
        market_id: params.market_id,
        direction: params.direction,
        amount_usd: size * params.entry_price
      });
      bnkrOrderId = order.order_id;
      if (order.entry_odds > 0) params.entry_price = order.entry_odds;
    }
  }
  const position = {
    id: posId,
    thesis_id: params.thesis_id,
    asset: params.asset,
    asset_class: params.asset_class,
    source,
    direction: params.direction,
    leverage: `${params.leverage}x`,
    entry_price: params.entry_price,
    current_price: params.entry_price,
    size: fillQuantity || size,
    fill_quantity: fillQuantity || void 0,
    unrealized_pnl: 0,
    peak_price: params.entry_price,
    atr_value: params.atr_value,
    atr_stop_price: params.direction === "SHORT" || params.direction === "NO" ? params.entry_price + params.atr_value * 5.5 : params.entry_price - params.atr_value * 5.5,
    opened_at: (/* @__PURE__ */ new Date()).toISOString(),
    venue: params.venue,
    exposure_bucket: getExposureBucket(params.asset, params.asset_class),
    bnkr_order_id: bnkrOrderId
  };
  const positions = await getPositions();
  positions.push(position);
  await savePositions(positions);
  recordSignal(params.asset.toLowerCase(), "entry");
  return { position, trade_id: tradeId, bnkr_order_id: bnkrOrderId };
}
async function closePosition(positionId, exitPrice, closeReason, txHash) {
  const positions = await getPositions();
  const idx = positions.findIndex((p) => p.id === positionId);
  if (idx === -1) return null;
  const pos = positions[idx];
  if (pos.bnkr_order_id && isConfigured6()) {
    try {
      if (pos.asset_class === "crypto") {
        const result = await closeCryptoPosition(pos.bnkr_order_id);
        if (result.exit_price > 0) exitPrice = result.exit_price;
        txHash = txHash || result.tx_hash;
      } else if (pos.asset_class === "polymarket") {
        const result = await closePolymarketPosition(pos.bnkr_order_id);
        if (result.exit_odds > 0) exitPrice = result.exit_odds;
        txHash = txHash || result.tx_hash;
      }
    } catch (err) {
      console.error(`[bankr] BNKR close failed for ${pos.bnkr_order_id}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }
  const isLong = pos.direction === "LONG" || pos.direction === "YES";
  const priceDiff = isLong ? exitPrice - pos.entry_price : pos.entry_price - exitPrice;
  const pnl = priceDiff * pos.size;
  const pnlPct = pos.entry_price > 0 ? priceDiff / pos.entry_price * 100 : 0;
  const fees = pos.size * exitPrice * 1e-3;
  const acquiredDate = new Date(pos.opened_at);
  const disposedDate = /* @__PURE__ */ new Date();
  const holdingMs = disposedDate.getTime() - acquiredDate.getTime();
  const holdingPeriod = holdingMs > 365 * 24 * 60 * 60 * 1e3 ? "long" : "short";
  const taxLot = {
    id: `lot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    asset: pos.asset,
    asset_class: pos.asset_class,
    quantity: pos.size,
    cost_basis: pos.size * pos.entry_price + fees,
    cost_per_unit: pos.entry_price,
    acquired_at: pos.opened_at,
    disposed_at: disposedDate.toISOString(),
    proceeds: pos.size * exitPrice - fees,
    gain_loss: pnl - fees * 2,
    holding_period: holdingPeriod,
    wash_sale_flagged: false,
    wash_sale_disallowed: 0,
    venue: pos.venue,
    tx_hash: txHash || null
  };
  const tradeRecord = {
    id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    thesis_id: pos.thesis_id,
    asset: pos.asset,
    asset_class: pos.asset_class,
    source: pos.source || "manual",
    direction: pos.direction,
    leverage: pos.leverage,
    entry_price: pos.entry_price,
    exit_price: exitPrice,
    expected_entry_price: pos.entry_price,
    size: pos.size,
    pnl: parseFloat(pnl.toFixed(4)),
    pnl_pct: parseFloat(pnlPct.toFixed(2)),
    fees: parseFloat(fees.toFixed(4)),
    opened_at: pos.opened_at,
    closed_at: disposedDate.toISOString(),
    close_reason: closeReason,
    tax_lot: taxLot
  };
  positions.splice(idx, 1);
  await savePositions(positions);
  await appendTradeHistory(tradeRecord);
  const portfolio = await getPortfolioValue();
  await setPortfolioValue(portfolio + pnl - fees * 2);
  await updateConsecutiveLosses(pnl);
  try {
    await updateSignalQuality({
      source: pos.source || "manual",
      asset_class: pos.asset_class,
      pnl: parseFloat(pnl.toFixed(4)),
      asset: pos.asset
    });
  } catch (e) {
    console.error("[bankr] Signal quality update on close:", e instanceof Error ? e.message : e);
  }
  recordSignal(pos.asset.toLowerCase(), "exit");
  try {
    const openShadows = await getShadowTrades("open");
    for (const shadow of openShadows) {
      if (shadow.thesis_id === pos.thesis_id || shadow.asset === pos.asset) {
        await closeShadowTrade(shadow.id, exitPrice, closeReason);
      }
    }
  } catch (e) {
    console.error("[bankr] Shadow trade close sync:", e instanceof Error ? e.message : e);
  }
  return tradeRecord;
}
async function closeAllPositions(reason) {
  const positions = await getPositions();
  const records = [];
  for (const pos of positions) {
    const record = await closePosition(pos.id, pos.current_price, reason);
    if (record) records.push(record);
  }
  return records;
}
async function checkCircuitBreaker() {
  const history = await getTradeHistory();
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1e3;
  const recentTrades = history.filter((t) => new Date(t.closed_at).getTime() > sevenDaysAgo);
  const rolling7dayPnl = recentTrades.reduce((sum, t) => sum + t.pnl, 0);
  const portfolio = await getPortfolioValue();
  const pnlPct = portfolio > 0 ? rolling7dayPnl / portfolio * 100 : 0;
  const peakPortfolio = await getPeakPortfolioValue();
  const peakDrawdownPct = peakPortfolio > 0 ? (portfolio - peakPortfolio) / peakPortfolio * 100 : 0;
  const rc = await getRiskConfig();
  const triggered = pnlPct < rc.circuit_breaker_7d_pct || peakDrawdownPct < rc.circuit_breaker_drawdown_pct;
  if (triggered) {
    const pool2 = getPool();
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(true), Date.now()]
    );
    const reason = peakDrawdownPct < rc.circuit_breaker_drawdown_pct ? `Peak drawdown ${peakDrawdownPct.toFixed(1)}% < ${rc.circuit_breaker_drawdown_pct}%` : `7-day P&L ${pnlPct.toFixed(1)}% < ${rc.circuit_breaker_7d_pct}%`;
    console.log(`[bankr] Circuit breaker TRIGGERED: ${reason}`);
  }
  return {
    triggered,
    rolling7dayPnl: parseFloat(rolling7dayPnl.toFixed(4)),
    pnlPct: parseFloat(pnlPct.toFixed(2)),
    peakDrawdownPct: parseFloat(peakDrawdownPct.toFixed(2))
  };
}
async function runPositionMonitor() {
  const killActive = await isKillSwitchActive();
  const positions = await getPositions();
  const closed = [];
  const errors = [];
  if (killActive && positions.length > 0) {
    console.log("[bankr] Kill switch active \u2014 closing ALL positions");
    const records = await closeAllPositions("kill_switch");
    return { checked: positions.length, closed: records, errors: [] };
  }
  if (positions.length === 0) {
    return { checked: 0, closed: [], errors: [] };
  }
  for (const pos of positions) {
    try {
      if (pos.asset_class === "crypto") {
        await monitorCryptoPosition(pos, closed);
      } else if (pos.asset_class === "polymarket") {
        await monitorPolymarketPosition(pos, closed);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${pos.asset}: ${msg}`);
    }
  }
  const cb = await checkCircuitBreaker();
  if (cb.triggered) {
    console.log("[bankr] Circuit breaker triggered during monitor \u2014 closing remaining positions");
    const remaining = await getPositions();
    for (const p of remaining) {
      const record = await closePosition(p.id, p.current_price, "circuit_breaker");
      if (record) closed.push(record);
    }
  }
  try {
    const priceMap = {};
    for (const pos of positions) {
      if (pos.current_price > 0) {
        priceMap[pos.asset] = pos.current_price;
      }
    }
    if (Object.keys(priceMap).length > 0) {
      await updateShadowPrices(priceMap);
    }
  } catch (e) {
    console.error("[bankr] Shadow price update:", e instanceof Error ? e.message : e);
  }
  return { checked: positions.length, closed, errors };
}
async function monitorCryptoPosition(pos, closed) {
  let currentPrice;
  try {
    const candles = await getHistoricalOHLCV(pos.asset, 7);
    if (candles.length === 0) return;
    currentPrice = candles[candles.length - 1].close;
  } catch {
    return;
  }
  const positions = await getPositions();
  const livePos = positions.find((p) => p.id === pos.id);
  if (!livePos) return;
  livePos.current_price = currentPrice;
  const isLong = livePos.direction === "LONG";
  if (isLong && currentPrice > livePos.peak_price) {
    livePos.peak_price = currentPrice;
    livePos.atr_stop_price = currentPrice - livePos.atr_value * 5.5;
  } else if (!isLong && currentPrice < livePos.peak_price) {
    livePos.peak_price = currentPrice;
    livePos.atr_stop_price = currentPrice + livePos.atr_value * 5.5;
  }
  const priceDiff = isLong ? currentPrice - livePos.entry_price : livePos.entry_price - currentPrice;
  livePos.unrealized_pnl = parseFloat((priceDiff * livePos.size).toFixed(4));
  await savePositions(positions);
  if (isLong && currentPrice <= livePos.atr_stop_price) {
    console.log(`[bankr] Trailing stop hit for ${pos.asset} at $${currentPrice}`);
    const record = await closePosition(pos.id, currentPrice, "trailing_stop");
    if (record) closed.push(record);
    return;
  }
  if (!isLong && currentPrice >= livePos.atr_stop_price) {
    console.log(`[bankr] Trailing stop hit for ${pos.asset} SHORT at $${currentPrice}`);
    const record = await closePosition(pos.id, currentPrice, "trailing_stop");
    if (record) closed.push(record);
    return;
  }
  try {
    const candles = await getHistoricalOHLCV(pos.asset, 14);
    if (candles.length >= 30) {
      const dbSignalParams = await loadCryptoSignalParams();
      const result = analyzeAsset(candles, dbSignalParams);
      if (isLong && result.votes.rsi_overbought) {
        console.log(`[bankr] RSI exit (overbought) for ${pos.asset}`);
        const record = await closePosition(pos.id, currentPrice, "rsi_exit");
        if (record) closed.push(record);
        return;
      }
      if (!isLong && result.votes.rsi_oversold) {
        console.log(`[bankr] RSI exit (oversold) for ${pos.asset} SHORT`);
        const record = await closePosition(pos.id, currentPrice, "rsi_exit");
        if (record) closed.push(record);
        return;
      }
    }
  } catch {
  }
  const hoursOpen = (Date.now() - new Date(pos.opened_at).getTime()) / (60 * 60 * 1e3);
  if (hoursOpen > 72) {
    console.log(`[bankr] Time exit (${hoursOpen.toFixed(0)}h > 72h) for ${pos.asset}`);
    const record = await closePosition(pos.id, currentPrice, "time_exit");
    if (record) closed.push(record);
    return;
  }
}
async function monitorPolymarketPosition(pos, closed) {
  let thesis = null;
  try {
    const pool2 = getPool();
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      const found = res.rows[0].value.find((t) => t.id === pos.thesis_id);
      if (found) thesis = found;
    }
  } catch {
  }
  if (!thesis) {
    console.warn(`[bankr] Polymarket thesis ${pos.thesis_id} not found \u2014 applying conservative stop loss`);
    const stopLoss2 = 0.1;
    const isYesFallback = pos.direction === "YES";
    if (isYesFallback && pos.current_price <= pos.entry_price - stopLoss2) {
      const record = await closePosition(pos.id, pos.current_price, "pm_stop_loss_no_thesis");
      if (record) closed.push(record);
    } else if (!isYesFallback && pos.current_price >= pos.entry_price + stopLoss2) {
      const record = await closePosition(pos.id, pos.current_price, "pm_stop_loss_no_thesis");
      if (record) closed.push(record);
    }
    return;
  }
  const market = await getMarketDetails(thesis.market_id);
  if (!market) return;
  const yesPrice = market.tokens.find((t) => t.outcome === "Yes")?.price || 0;
  const noPrice = market.tokens.find((t) => t.outcome === "No")?.price || 0;
  const isYes = pos.direction === "YES";
  const currentOdds = isYes ? yesPrice : noPrice;
  const positions = await getPositions();
  const livePos = positions.find((p) => p.id === pos.id);
  if (!livePos) return;
  livePos.current_price = currentOdds;
  const priceDiff = isYes ? currentOdds - livePos.entry_price : livePos.entry_price - currentOdds;
  livePos.unrealized_pnl = parseFloat((priceDiff * livePos.size).toFixed(4));
  if (isYes && currentOdds > livePos.peak_price || !isYes && currentOdds < livePos.peak_price) {
    livePos.peak_price = currentOdds;
  }
  await savePositions(positions);
  if (market.closed) {
    console.log(`[bankr] Polymarket resolved for ${pos.asset.slice(0, 60)}`);
    const record = await closePosition(pos.id, currentOdds, "market_resolved");
    if (record) closed.push(record);
    return;
  }
  const endDate = new Date(market.end_date_iso);
  const hoursToResolution = (endDate.getTime() - Date.now()) / (60 * 60 * 1e3);
  if (hoursToResolution < 4 && hoursToResolution > 0) {
    console.log(`[bankr] Polymarket near resolution (${hoursToResolution.toFixed(1)}h) for ${pos.asset.slice(0, 60)}`);
    const record = await closePosition(pos.id, currentOdds, "resolution_proximity");
    if (record) closed.push(record);
    return;
  }
  const targetOdds = thesis.exit_odds;
  if (isYes && currentOdds >= targetOdds) {
    console.log(`[bankr] Polymarket target reached (${(currentOdds * 100).toFixed(0)}% >= ${(targetOdds * 100).toFixed(0)}%) for ${pos.asset.slice(0, 60)}`);
    const record = await closePosition(pos.id, currentOdds, "odds_target");
    if (record) closed.push(record);
    return;
  }
  if (!isYes && currentOdds <= targetOdds) {
    console.log(`[bankr] Polymarket target reached (${(currentOdds * 100).toFixed(0)}% <= ${(targetOdds * 100).toFixed(0)}%) for ${pos.asset.slice(0, 60)}`);
    const record = await closePosition(pos.id, currentOdds, "odds_target");
    if (record) closed.push(record);
    return;
  }
  const stopLoss = 0.1;
  if (isYes && currentOdds <= livePos.entry_price - stopLoss) {
    console.log(`[bankr] Polymarket stop loss (${(currentOdds * 100).toFixed(0)}%) for ${pos.asset.slice(0, 60)}`);
    const record = await closePosition(pos.id, currentOdds, "pm_stop_loss");
    if (record) closed.push(record);
    return;
  }
  if (!isYes && currentOdds >= livePos.entry_price + stopLoss) {
    console.log(`[bankr] Polymarket stop loss (${(currentOdds * 100).toFixed(0)}%) for ${pos.asset.slice(0, 60)}`);
    const record = await closePosition(pos.id, currentOdds, "pm_stop_loss");
    if (record) closed.push(record);
    return;
  }
  const daysOpen = (Date.now() - new Date(pos.opened_at).getTime()) / (24 * 60 * 60 * 1e3);
  if (daysOpen > 30 && livePos.unrealized_pnl < 0) {
    console.log(`[bankr] Polymarket time exit (${daysOpen.toFixed(0)}d underwater) for ${pos.asset.slice(0, 60)}`);
    const record = await closePosition(pos.id, currentOdds, "pm_time_exit_underwater");
    if (record) closed.push(record);
    return;
  }
  try {
    const activities = await getWhaleActivities();
    const marketActivities = activities.filter((a) => a.market_id === thesis.market_id);
    if (marketActivities.length >= 2) {
      const flipped = marketActivities.filter(
        (a) => a.activity_type !== "position_exit" && a.direction !== pos.direction
      );
      if (flipped.length >= 2) {
        console.log(`[bankr] Polymarket whale consensus flipped for ${pos.asset.slice(0, 60)}`);
        const record = await closePosition(pos.id, currentOdds, "whale_consensus_flip");
        if (record) closed.push(record);
        return;
      }
    }
  } catch {
  }
}
async function getPortfolioSummary() {
  const [portfolio, peakPortfolio, consecutiveLosses, positions, mode, paused, killSwitch] = await Promise.all([
    getPortfolioValue(),
    getPeakPortfolioValue(),
    getConsecutiveLosses(),
    getPositions(),
    getMode2(),
    isPaused(),
    isKillSwitchActive()
  ]);
  const totalExposure = positions.reduce((sum, p) => sum + p.size * p.entry_price, 0);
  const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealized_pnl, 0);
  const peakDrawdownPct = peakPortfolio > 0 ? (portfolio - peakPortfolio) / peakPortfolio * 100 : 0;
  return {
    portfolio_value: portfolio,
    peak_portfolio_value: peakPortfolio,
    peak_drawdown_pct: parseFloat(peakDrawdownPct.toFixed(2)),
    consecutive_losses: consecutiveLosses,
    open_positions: positions.length,
    total_exposure: parseFloat(totalExposure.toFixed(2)),
    unrealized_pnl: parseFloat(unrealizedPnl.toFixed(4)),
    mode,
    paused,
    kill_switch: killSwitch,
    bnkr_configured: isConfigured6(),
    positions
  };
}
async function getTaxSummary() {
  const history = await getTradeHistory();
  const year = (/* @__PURE__ */ new Date()).getFullYear();
  const yearStart = new Date(year, 0, 1).getTime();
  const yearTrades = history.filter((t) => new Date(t.closed_at).getTime() >= yearStart);
  let gains = 0;
  let losses = 0;
  let washSaleAdj = 0;
  const quarterly = {};
  for (const t of yearTrades) {
    const q = `Q${Math.floor(new Date(t.closed_at).getMonth() / 3) + 1}`;
    if (!quarterly[q]) quarterly[q] = { trades: 0, pnl: 0 };
    quarterly[q].trades++;
    quarterly[q].pnl += t.pnl;
    if (t.pnl >= 0) gains += t.pnl;
    else losses += t.pnl;
    if (t.tax_lot.wash_sale_flagged) {
      washSaleAdj += t.tax_lot.wash_sale_disallowed;
    }
  }
  const netTaxable = gains + losses + washSaleAdj;
  const federalRate = 0.24;
  const nyRate = 0.0685;
  return {
    year,
    total_trades: yearTrades.length,
    realized_pnl: parseFloat((gains + losses).toFixed(2)),
    short_term_gains: parseFloat(gains.toFixed(2)),
    short_term_losses: parseFloat(losses.toFixed(2)),
    wash_sale_adjustments: parseFloat(washSaleAdj.toFixed(2)),
    net_taxable: parseFloat(netTaxable.toFixed(2)),
    estimated_federal_tax: parseFloat((Math.max(0, netTaxable) * federalRate).toFixed(2)),
    estimated_ny_tax: parseFloat((Math.max(0, netTaxable) * nyRate).toFixed(2)),
    total_estimated_tax: parseFloat((Math.max(0, netTaxable) * (federalRate + nyRate)).toFixed(2)),
    quarterly
  };
}
async function generateForm8949CSV() {
  const history = await getTradeHistory();
  const year = (/* @__PURE__ */ new Date()).getFullYear();
  const yearStart = new Date(year, 0, 1).getTime();
  const yearTrades = history.filter((t) => new Date(t.closed_at).getTime() >= yearStart);
  const lines = [
    '"Description of Property","Date Acquired","Date Sold","Proceeds","Cost or Other Basis","Code","Amount of Adjustment","Gain or (Loss)"'
  ];
  for (const t of yearTrades) {
    const lot = t.tax_lot;
    const desc = `${t.size.toFixed(6)} ${t.asset}`;
    const acquired = new Date(lot.acquired_at).toLocaleDateString("en-US");
    const disposed = lot.disposed_at ? new Date(lot.disposed_at).toLocaleDateString("en-US") : "";
    const proceeds = lot.proceeds?.toFixed(2) || "0.00";
    const costBasis = lot.cost_basis.toFixed(2);
    const code = lot.wash_sale_flagged ? "W" : "";
    const adjustment = lot.wash_sale_disallowed > 0 ? lot.wash_sale_disallowed.toFixed(2) : "";
    const gainLoss = lot.gain_loss?.toFixed(2) || "0.00";
    lines.push(`"${desc}","${acquired}","${disposed}","${proceeds}","${costBasis}","${code}","${adjustment}","${gainLoss}"`);
  }
  return lines.join("\n");
}
async function getSignalQuality() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = $1`, [SIGNAL_QUALITY_KEY]);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      const records = res.rows[0].value;
      const cutoff = Date.now() - SIGNAL_QUALITY_DECAY_MS;
      for (const record of records) {
        const before = record.recent_results.length;
        record.recent_results = record.recent_results.filter((r) => r.ts > cutoff);
        if (record.recent_results.length !== before) {
          const recentWins = record.recent_results.filter((r) => r.pnl > 0).length;
          const recentTotal = record.recent_results.length;
          const recentPnl = record.recent_results.reduce((s, r) => s + r.pnl, 0);
          record.win_rate = recentTotal > 0 ? parseFloat((recentWins / recentTotal * 100).toFixed(1)) : 0;
          record.avg_pnl = recentTotal > 0 ? parseFloat((recentPnl / recentTotal).toFixed(4)) : 0;
        }
      }
      return records;
    }
  } catch (err) {
    console.error("[bankr] getSignalQuality failed:", err instanceof Error ? err.message : err);
  }
  return [];
}
async function updateSignalQuality(params) {
  if (params.source === "manual") return;
  const pool2 = getPool();
  const client = await pool2.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
      [SIGNAL_QUALITY_KEY, JSON.stringify([]), Date.now()]
    );
    const lockRes = await client.query(
      `SELECT value FROM app_config WHERE key = $1 FOR UPDATE`,
      [SIGNAL_QUALITY_KEY]
    );
    const records = lockRes.rows.length > 0 && Array.isArray(lockRes.rows[0].value) ? lockRes.rows[0].value : [];
    const now = Date.now();
    const cutoff = now - SIGNAL_QUALITY_DECAY_MS;
    let record = records.find((r) => r.source === params.source && r.asset_class === params.asset_class);
    if (!record) {
      record = {
        source: params.source,
        asset_class: params.asset_class,
        wins: 0,
        losses: 0,
        total_pnl: 0,
        avg_pnl: 0,
        win_rate: 0,
        recent_results: []
      };
      records.push(record);
    }
    record.recent_results.push({ pnl: params.pnl, ts: now, asset: params.asset });
    record.recent_results = record.recent_results.filter((r) => r.ts > cutoff).slice(-SIGNAL_QUALITY_MAX_RECENT);
    const recentWins = record.recent_results.filter((r) => r.pnl > 0).length;
    const recentTotal = record.recent_results.length;
    const recentPnl = record.recent_results.reduce((s, r) => s + r.pnl, 0);
    if (params.pnl > 0) record.wins++;
    else record.losses++;
    record.total_pnl = parseFloat((record.total_pnl + params.pnl).toFixed(4));
    record.win_rate = recentTotal > 0 ? parseFloat((recentWins / recentTotal * 100).toFixed(1)) : 0;
    record.avg_pnl = recentTotal > 0 ? parseFloat((recentPnl / recentTotal).toFixed(4)) : 0;
    await client.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [SIGNAL_QUALITY_KEY, JSON.stringify(records), now]
    );
    await client.query("COMMIT");
    console.log(`[bankr] Signal quality updated: ${params.source}/${params.asset_class} \u2014 ${params.pnl > 0 ? "WIN" : "LOSS"} $${params.pnl.toFixed(2)}, win rate: ${record.win_rate}%`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
    });
    throw err;
  } finally {
    client.release();
  }
}
function getSignalQualityModifier(scores, source, assetClass) {
  const record = scores.find((r) => r.source === source && r.asset_class === assetClass);
  if (!record || record.recent_results.length < 3) {
    return { modifier: "neutral", winRate: 0, sampleSize: record?.recent_results.length || 0 };
  }
  if (record.win_rate > 60) return { modifier: "boost", winRate: record.win_rate, sampleSize: record.recent_results.length };
  if (record.win_rate < 40) return { modifier: "penalty", winRate: record.win_rate, sampleSize: record.recent_results.length };
  return { modifier: "neutral", winRate: record.win_rate, sampleSize: record.recent_results.length };
}
async function detectWashSales() {
  const history = await getTradeHistory();
  const flagged = [];
  const thirtyDays = 30 * 24 * 60 * 60 * 1e3;
  for (let i = 0; i < history.length; i++) {
    const trade = history[i];
    if (trade.pnl >= 0) continue;
    const closedAt = new Date(trade.closed_at).getTime();
    for (let j = 0; j < history.length; j++) {
      if (i === j) continue;
      const other = history[j];
      if (other.asset !== trade.asset) continue;
      const otherOpened = new Date(other.opened_at).getTime();
      if (Math.abs(otherOpened - closedAt) <= thirtyDays) {
        const lot = { ...trade.tax_lot };
        lot.wash_sale_flagged = true;
        lot.wash_sale_disallowed = Math.abs(trade.pnl);
        flagged.push(lot);
        break;
      }
    }
  }
  return flagged;
}
var PORTFOLIO_VALUE_KEY, PEAK_PORTFOLIO_KEY, CONSECUTIVE_LOSSES_KEY, RISK_CONFIG_KEY, DEFAULT_PORTFOLIO, DEFAULT_RISK_CONFIG, SIGNAL_QUALITY_KEY, SIGNAL_QUALITY_MAX_RECENT, SIGNAL_QUALITY_DECAY_MS;
var init_bankr = __esm({
  "src/bankr.ts"() {
    "use strict";
    init_db();
    init_technical_signals();
    init_coingecko();
    init_polymarket();
    init_bnkr();
    init_oversight();
    PORTFOLIO_VALUE_KEY = "wealth_engines_portfolio_value";
    PEAK_PORTFOLIO_KEY = "wealth_engines_peak_portfolio";
    CONSECUTIVE_LOSSES_KEY = "wealth_engines_consecutive_losses";
    RISK_CONFIG_KEY = "wealth_engine_config";
    DEFAULT_PORTFOLIO = 1e3;
    DEFAULT_RISK_CONFIG = {
      max_leverage: 5,
      risk_per_trade_pct: 5,
      max_positions: 3,
      exposure_cap_pct: 60,
      correlation_limit: 1,
      circuit_breaker_7d_pct: -15,
      circuit_breaker_drawdown_pct: -25,
      notification_mode: "all"
    };
    SIGNAL_QUALITY_KEY = "signal_quality_scores";
    SIGNAL_QUALITY_MAX_RECENT = 50;
    SIGNAL_QUALITY_DECAY_MS = 30 * 24 * 60 * 60 * 1e3;
  }
});

// server.ts
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { fileURLToPath } from "url";
import path7 from "path";
import fs6 from "fs";
import { execSync, spawn } from "child_process";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// src/obsidian.ts
var obsidianApiUrl = process.env.OBSIDIAN_API_URL ?? "";
var OBSIDIAN_API_KEY = process.env.OBSIDIAN_API_KEY ?? "";
var FETCH_TIMEOUT_MS = 1e4;
var MAX_RETRIES = 2;
var RETRY_DELAY_MS = 1e3;
var RETRYABLE_STATUSES = /* @__PURE__ */ new Set([502, 503, 504]);
function setApiUrl(url) {
  obsidianApiUrl = url.replace(/\/+$/, "");
}
function headers() {
  return {
    Authorization: `Bearer ${OBSIDIAN_API_KEY}`,
    Accept: "application/json"
  };
}
function baseUrl() {
  return obsidianApiUrl.replace(/\/+$/, "");
}
function encodePath(p) {
  return p.replace(/^\//, "").split("/").map(encodeURIComponent).join("/");
}
function isConfigured() {
  return !!(obsidianApiUrl && OBSIDIAN_API_KEY);
}
async function fetchWithRetry(url, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok || !RETRYABLE_STATUSES.has(res.status)) {
        return res;
      }
      lastError = new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === "AbortError") {
        lastError = new Error("Knowledge base request timed out (10s)");
      } else {
        lastError = new Error(`Knowledge base connection failed: ${err.message}`);
      }
    }
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastError;
}
async function ping() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5e3);
    const res = await fetch(`${baseUrl()}/`, { headers: headers(), signal: controller.signal });
    clearTimeout(timeout);
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}
async function listNotes(dirPath = "/") {
  const url = `${baseUrl()}/vault/${encodePath(dirPath)}`;
  const res = await fetchWithRetry(url, { headers: headers() });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify(data, null, 2);
}
async function readNote(notePath) {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const res = await fetchWithRetry(url, {
    headers: { ...headers(), Accept: "text/markdown" }
  });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  return await res.text();
}
async function createNote(notePath, content) {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const res = await fetchWithRetry(url, {
    method: "PUT",
    headers: { ...headers(), "Content-Type": "text/markdown" },
    body: content
  });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  return `Created note: ${notePath}`;
}
async function appendToNote(notePath, content) {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        ...headers(),
        "Content-Type": "text/markdown",
        "Content-Insertion-Position": "end"
      },
      body: content,
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
    return `Appended to note: ${notePath}`;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Knowledge base request timed out (10s)");
    throw err;
  }
}
async function deleteNote(notePath) {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const res = await fetchWithRetry(url, { method: "DELETE", headers: headers() });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  return `Deleted note: ${notePath}`;
}
async function moveNote(fromPath, toPath) {
  const content = await readNote(fromPath);
  await createNote(toPath, content);
  await deleteNote(fromPath);
  return `Moved note: ${fromPath} \u2192 ${toPath}`;
}
async function renameFolder(fromPath, toPath) {
  const listData = await listNotes(fromPath);
  const parsed = JSON.parse(listData);
  const items = parsed.files || [];
  for (const item of items) {
    const isDir = item.endsWith("/");
    if (isDir) {
      const subFrom = item.replace(/\/+$/, "");
      const subName = subFrom.split("/").pop() || subFrom;
      await renameFolder(subFrom, `${toPath.replace(/\/+$/, "")}/${subName}`);
    } else {
      const fileName = item.split("/").pop() || item;
      await moveNote(item, `${toPath.replace(/\/+$/, "")}/${fileName}`);
    }
  }
  return `Renamed folder: ${fromPath} \u2192 ${toPath}`;
}
async function listRecursive(dirPath = "/") {
  const files = [];
  async function walk(dir) {
    const data = await listNotes(dir);
    const parsed = JSON.parse(data);
    const items = parsed.files || [];
    for (const item of items) {
      files.push(item);
      if (item.endsWith("/")) {
        await walk(item.replace(/\/+$/, ""));
      }
    }
  }
  await walk(dirPath);
  return JSON.stringify({ files }, null, 2);
}
async function fileInfo(notePath) {
  try {
    const content = await readNote(notePath);
    const size = new TextEncoder().encode(content).length;
    return JSON.stringify({
      path: notePath,
      type: "file",
      size,
      sizeHuman: size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`,
      created: "unknown (API limitation)",
      modified: "unknown (API limitation)"
    }, null, 2);
  } catch {
    try {
      const listing = await listNotes(notePath);
      const parsed = JSON.parse(listing);
      const count = (parsed.files || []).length;
      return JSON.stringify({
        path: notePath,
        type: "folder",
        items: count,
        created: "unknown (API limitation)",
        modified: "unknown (API limitation)"
      }, null, 2);
    } catch {
      throw new Error(`Not found: ${notePath}`);
    }
  }
}
async function searchNotes(query) {
  const url = `${baseUrl()}/search/simple/?query=${encodeURIComponent(query)}`;
  const res = await fetchWithRetry(url, { headers: headers() });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify(data, null, 2);
}

// src/vault-local.ts
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
var vaultPath = "";
function init(basePath) {
  vaultPath = basePath;
}
function isConfigured2() {
  if (!vaultPath) return false;
  try {
    return fsSync.existsSync(vaultPath) && fsSync.readdirSync(vaultPath).length > 0;
  } catch {
    return false;
  }
}
async function listNotes2(dirPath = "/") {
  const resolved = resolvePath(dirPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new Error(`Path not found: ${dirPath}`);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = path.join(dirPath === "/" ? "" : dirPath, entry.name);
    files.push(entry.isDirectory() ? rel + "/" : rel);
  }
  return JSON.stringify({ files }, null, 2);
}
async function readNote2(notePath) {
  const resolved = resolvePath(notePath);
  try {
    return await fs.readFile(resolved, "utf-8");
  } catch {
    throw new Error(`Note not found: ${notePath}`);
  }
}
async function createNote2(notePath, content) {
  const resolved = resolvePath(notePath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(resolved, content, "utf-8");
  nudgeSync(resolved);
  return `Created note: ${notePath}`;
}
async function appendToNote2(notePath, content) {
  const resolved = resolvePath(notePath);
  try {
    await fs.access(resolved);
  } catch {
    throw new Error(`Note not found: ${notePath}`);
  }
  await fs.appendFile(resolved, content, "utf-8");
  nudgeSync(resolved);
  return `Appended to note: ${notePath}`;
}
async function deleteNote2(notePath) {
  const resolved = resolvePath(notePath);
  try {
    await fs.access(resolved);
  } catch {
    throw new Error(`Note not found: ${notePath}`);
  }
  await fs.unlink(resolved);
  const dir = path.dirname(resolved);
  try {
    const entries = await fs.readdir(dir);
    const visible = entries.filter((e) => !e.startsWith("."));
    if (visible.length === 0 && dir !== vaultPath) {
      await fs.rm(dir, { recursive: true });
    }
  } catch {
  }
  return `Deleted note: ${notePath}`;
}
async function moveNote2(fromPath, toPath) {
  const resolvedFrom = resolvePath(fromPath);
  const resolvedTo = resolvePath(toPath);
  try {
    await fs.access(resolvedFrom);
  } catch {
    throw new Error(`Note not found: ${fromPath}`);
  }
  const content = await fs.readFile(resolvedFrom, "utf-8");
  const destDir = path.dirname(resolvedTo);
  await fs.mkdir(destDir, { recursive: true });
  await fs.writeFile(resolvedTo, content, "utf-8");
  await fs.unlink(resolvedFrom);
  const oldDir = path.dirname(resolvedFrom);
  try {
    const entries = await fs.readdir(oldDir);
    const visible = entries.filter((e) => !e.startsWith("."));
    if (visible.length === 0 && oldDir !== vaultPath) {
      await fs.rm(oldDir, { recursive: true });
    }
  } catch {
  }
  nudgeSync(resolvedTo);
  return `Moved note: ${fromPath} \u2192 ${toPath}`;
}
async function renameFolder2(fromPath, toPath) {
  const resolvedFrom = resolvePath(fromPath.replace(/\/+$/, ""));
  const resolvedTo = resolvePath(toPath.replace(/\/+$/, ""));
  const stat = await fs.stat(resolvedFrom).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`Folder not found: ${fromPath}`);
  const destParent = path.dirname(resolvedTo);
  await fs.mkdir(destParent, { recursive: true });
  await fs.rename(resolvedFrom, resolvedTo);
  async function nudgeAll(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await nudgeAll(full);
      else nudgeSync(full);
    }
  }
  await nudgeAll(resolvedTo);
  return `Renamed folder: ${fromPath} \u2192 ${toPath}`;
}
async function listRecursive2(dirPath = "/") {
  const resolved = resolvePath(dirPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`Folder not found: ${dirPath}`);
  const files = [];
  async function walk(dir, relBase) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        files.push(rel + "/");
        await walk(path.join(dir, entry.name), rel);
      } else {
        files.push(rel);
      }
    }
  }
  await walk(resolved, dirPath === "/" ? "" : dirPath);
  return JSON.stringify({ files }, null, 2);
}
async function fileInfo2(notePath) {
  const resolved = resolvePath(notePath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new Error(`Not found: ${notePath}`);
  return JSON.stringify({
    path: notePath,
    type: stat.isDirectory() ? "folder" : "file",
    size: stat.size,
    sizeHuman: stat.size < 1024 ? `${stat.size} B` : stat.size < 1048576 ? `${(stat.size / 1024).toFixed(1)} KB` : `${(stat.size / 1048576).toFixed(1)} MB`,
    created: stat.birthtime.toISOString(),
    modified: stat.mtime.toISOString()
  }, null, 2);
}
function nudgeSync(filePath) {
  setTimeout(async () => {
    try {
      const now = /* @__PURE__ */ new Date();
      await fs.utimes(filePath, now, now);
    } catch {
    }
  }, 600);
}
async function searchNotes2(query) {
  if (!query || query.trim().length === 0) {
    return JSON.stringify([], null, 2);
  }
  const results = [];
  const queryLower = query.toLowerCase();
  async function walkDir(dir, relBase) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const promises = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        promises.push(walkDir(fullPath, relPath));
      } else if (entry.name.endsWith(".md")) {
        promises.push((async () => {
          try {
            const content = await fs.readFile(fullPath, "utf-8");
            const contentLower = content.toLowerCase();
            const matches = [];
            let idx = 0;
            while ((idx = contentLower.indexOf(queryLower, idx)) !== -1) {
              const start = Math.max(0, idx - 50);
              const end = Math.min(content.length, idx + query.length + 50);
              matches.push({
                match: { start: idx, end: idx + query.length },
                context: content.substring(start, end)
              });
              idx += query.length;
              if (matches.length >= 5) break;
            }
            if (matches.length > 0) {
              results.push({ filename: relPath, matches });
            }
          } catch {
          }
        })());
      }
    }
    await Promise.all(promises);
  }
  await walkDir(vaultPath, "");
  return JSON.stringify(results, null, 2);
}
function resolvePath(p) {
  const cleaned = p.replace(/^\/+/, "");
  const resolved = path.resolve(vaultPath, cleaned);
  const relative = path.relative(vaultPath, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path traversal not allowed");
  }
  return resolved;
}

// server.ts
init_db();

// src/conversations.ts
init_db();
import Anthropic from "@anthropic-ai/sdk";
async function init3() {
  console.log("[conversations] initialized");
}
async function save(conv) {
  conv.updatedAt = Date.now();
  await getPool().query(
    `INSERT INTO conversations (id, title, messages, created_at, updated_at, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       messages = EXCLUDED.messages,
       updated_at = EXCLUDED.updated_at,
       synced_at = EXCLUDED.synced_at`,
    [conv.id, conv.title, JSON.stringify(conv.messages), conv.createdAt, conv.updatedAt, conv.syncedAt || null]
  );
}
async function load(id) {
  const result = await getPool().query(
    `SELECT id, title, messages, created_at, updated_at, synced_at FROM conversations WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  return rowToConversation(result.rows[0]);
}
async function list() {
  const result = await getPool().query(
    `SELECT DISTINCT ON (title) id, title, messages, created_at, updated_at
     FROM conversations ORDER BY title, updated_at DESC`
  );
  const rows = result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messageCount: Array.isArray(row.messages) ? row.messages.length : 0
  }));
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}
async function remove(id) {
  const result = await getPool().query(`DELETE FROM conversations WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
async function getRecentSummary(count = 5) {
  const result = await getPool().query(
    `SELECT id, title, messages, created_at, updated_at
     FROM conversations
     WHERE jsonb_array_length(messages) > 0
     ORDER BY updated_at DESC LIMIT $1`,
    [count]
  );
  if (result.rows.length === 0) return "";
  const lines = result.rows.map((row) => {
    const conv = rowToConversation(row);
    const date = new Date(conv.createdAt).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric"
    });
    const userMsgs = conv.messages.filter((m) => m.role === "user").slice(0, 3).map((m) => m.text.length > 120 ? m.text.slice(0, 120) + "\u2026" : m.text);
    const topicHint = userMsgs.length > 0 ? ` \u2014 Topics: ${userMsgs.join("; ")}` : "";
    return `- "${conv.title}" (${date}, ${conv.messages.length} msgs)${topicHint}`;
  });
  return `Recent conversations:
${lines.join("\n")}`;
}
async function getLastConversationContext(maxMessages = 10) {
  const result = await getPool().query(
    `SELECT id, title, messages, created_at, updated_at FROM conversations
     WHERE jsonb_array_length(messages) > 0
     ORDER BY updated_at DESC LIMIT 3`
  );
  if (result.rows.length === 0) return "";
  const sections = [];
  for (let i = 0; i < result.rows.length; i++) {
    const conv = rowToConversation(result.rows[i]);
    const msgsToShow = i === 0 ? maxMessages : 4;
    const relevantMsgs = conv.messages.filter((m) => m.role !== "system").slice(-msgsToShow);
    if (relevantMsgs.length === 0) continue;
    const date = new Date(conv.createdAt).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric"
    });
    const time = new Date(conv.updatedAt).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit"
    });
    const charLimit = i === 0 ? 800 : 400;
    const exchanges = relevantMsgs.map((m) => {
      const role = m.role === "user" ? "Rickin" : "You";
      const text = m.text.length > charLimit ? m.text.slice(0, charLimit) + "\u2026" : m.text;
      return `**${role}:** ${text}`;
    }).join("\n\n");
    const label = i === 0 ? "Most recent conversation" : `Earlier conversation`;
    sections.push(`${label}: "${conv.title}" (${date}, last active ${time})

${exchanges}`);
  }
  if (sections.length === 0) return "";
  return sections.join("\n\n---\n\n");
}
function createConversation(sessionId) {
  return {
    id: sessionId,
    title: "New conversation",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}
function addMessage(conv, role, text, images) {
  const msg = { role, text, timestamp: Date.now() };
  if (images && images.length > 0) {
    msg.images = images;
  }
  conv.messages.push(msg);
  if (conv.title === "New conversation" && role === "user" && text.trim()) {
    conv.title = text.trim().slice(0, 60);
  }
  conv.updatedAt = Date.now();
}
async function generateTitle(conv) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const nonSystem = conv.messages.filter((m) => m.role !== "system");
  if (nonSystem.length < 2) return null;
  const transcript = nonSystem.slice(0, 6).map((m) => {
    const role = m.role === "user" ? "User" : "Assistant";
    const text = m.text.length > 300 ? m.text.slice(0, 300) + "..." : m.text;
    return `${role}: ${text}`;
  }).join("\n");
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 40,
      messages: [{
        role: "user",
        content: `Write a short title (max 6 words) for this conversation. Just the title, no quotes or punctuation at the end.

${transcript}`
      }]
    });
    const title = response.content[0]?.type === "text" ? response.content[0].text.trim() : null;
    if (title && title.length > 0 && title.length <= 80) {
      conv.title = title;
      return title;
    }
  } catch (err) {
    console.warn("[conversations] Title generation failed:", err);
  }
  return null;
}
async function search(query, options) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return [];
  const limit = options?.limit ?? 10;
  let sql = `SELECT id, title, messages, created_at, updated_at FROM conversations WHERE 1=1`;
  const params = [];
  let paramIdx = 1;
  if (options?.before) {
    sql += ` AND created_at <= $${paramIdx++}`;
    params.push(options.before);
  }
  if (options?.after) {
    sql += ` AND created_at >= $${paramIdx++}`;
    params.push(options.after);
  }
  sql += ` ORDER BY updated_at DESC`;
  const result = await getPool().query(sql, params);
  const results = [];
  for (const row of result.rows) {
    const conv = rowToConversation(row);
    const snippets = [];
    for (const msg of conv.messages) {
      if (msg.role === "system") continue;
      const lower = msg.text.toLowerCase();
      if (terms.some((t) => lower.includes(t))) {
        const snippet = msg.text.slice(0, 200);
        const role = msg.role === "user" ? "You" : "Agent";
        const time = new Date(msg.timestamp).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
        snippets.push(`[${role}, ${time}] ${snippet}`);
        if (snippets.length >= 3) break;
      }
    }
    if (snippets.length > 0) {
      results.push({
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messageCount: conv.messages.length,
        snippets
      });
    }
    if (results.length >= limit) break;
  }
  return results;
}
function shouldSync(conv) {
  const userMessages = conv.messages.filter((m) => m.role === "user");
  return userMessages.length >= 1;
}
function generateSnippetSummary(conv) {
  const date = new Date(conv.createdAt).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const time = new Date(conv.createdAt).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit"
  });
  const userMsgs = conv.messages.filter((m) => m.role === "user").map((m) => m.text.trim());
  const agentMsgs = conv.messages.filter((m) => m.role === "agent").map((m) => m.text.trim());
  const topicLines = userMsgs.slice(0, 8).map((t) => `- ${t.slice(0, 120)}`).join("\n");
  let keyPoints = "";
  for (const a of agentMsgs) {
    const lines = a.split("\n").filter((l) => l.trim().length > 10);
    for (const line of lines.slice(0, 2)) {
      keyPoints += `- ${line.trim().slice(0, 150)}
`;
    }
    if (keyPoints.split("\n").length > 6) break;
  }
  return `# ${conv.title}

**Date:** ${date} at ${time}
**Messages:** ${conv.messages.length}

## Topics Discussed
${topicLines}

## Key Points
${keyPoints.trim() || "- General discussion"}

---
*Session ID: ${conv.id}*
`;
}
async function generateAISummary(conv) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[conversations] No ANTHROPIC_API_KEY \u2014 falling back to snippet summary");
    return generateSnippetSummary(conv);
  }
  const date = new Date(conv.createdAt).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const time = new Date(conv.createdAt).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit"
  });
  const transcript = conv.messages.filter((m) => m.role !== "system").map((m) => {
    const role = m.role === "user" ? "Rickin" : "Assistant";
    const text = m.text.length > 500 ? m.text.slice(0, 500) + "..." : m.text;
    return `${role}: ${text}`;
  }).join("\n\n");
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `Summarize this conversation between Rickin and his AI assistant. Write in third person about what was discussed.

Format your response EXACTLY as markdown with these sections:
## Summary
2-3 sentences capturing the main topics and purpose of the conversation.

## Key Decisions & Outcomes
- Bullet points of any decisions made, answers given, or outcomes reached
- If none, write "- General discussion, no specific decisions"

## Action Items
- Any tasks, follow-ups, or things to do that came up
- If none, write "- No action items"

## Topics for Follow-up
- Things that were mentioned but not fully resolved, or areas to revisit
- If none, write "- None identified"

CONVERSATION:
${transcript}`
      }]
    });
    const aiText = response.content[0]?.type === "text" ? response.content[0].text : "";
    return `# ${conv.title}

**Date:** ${date} at ${time}
**Messages:** ${conv.messages.length}

${aiText}

---
*Session ID: ${conv.id}*
`;
  } catch (err) {
    console.error("[conversations] AI summary failed, falling back to snippet:", err);
    return generateSnippetSummary(conv);
  }
}
function rowToConversation(row) {
  const conv = {
    id: row.id,
    title: row.title,
    messages: Array.isArray(row.messages) ? row.messages : JSON.parse(row.messages || "[]"),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
  if (row.synced_at) {
    conv.syncedAt = Number(row.synced_at);
  }
  return conv;
}

// src/gmail.ts
init_db();
import { google } from "googleapis";
var SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/youtube.readonly"
];
async function init4() {
  const existing = await getPool().query(`SELECT tokens FROM oauth_tokens WHERE service = 'google'`);
  if (existing.rows.length === 0) {
    try {
      const fs7 = await import("fs");
      const path8 = await import("path");
      const legacyPath = path8.default.join(process.cwd(), "data", "gmail-tokens.json");
      if (fs7.default.existsSync(legacyPath)) {
        const tokens = JSON.parse(fs7.default.readFileSync(legacyPath, "utf-8"));
        await getPool().query(
          `INSERT INTO oauth_tokens (service, tokens, updated_at) VALUES ('google', $1, $2)`,
          [JSON.stringify(tokens), Date.now()]
        );
        cachedTokens = tokens;
        tokensCacheTime = Date.now();
        console.log("[gmail] Migrated tokens from data/gmail-tokens.json to PostgreSQL");
      }
    } catch (err) {
      console.error("[gmail] Token migration failed:", err);
    }
  } else {
    cachedTokens = existing.rows[0].tokens;
    tokensCacheTime = Date.now();
  }
  console.log("[gmail] initialized");
}
function isConfigured3() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
function isConnected() {
  if (!isConfigured3()) return false;
  return !!(cachedTokens && cachedTokens.refresh_token);
}
var cachedTokens = null;
var tokensCacheTime = 0;
async function loadTokens() {
  try {
    const result = await getPool().query(`SELECT tokens FROM oauth_tokens WHERE service = 'google'`);
    if (result.rows.length > 0) {
      cachedTokens = result.rows[0].tokens;
      tokensCacheTime = Date.now();
      return cachedTokens;
    }
  } catch (err) {
    console.error("[gmail] Failed to load tokens:", err);
  }
  return null;
}
async function saveTokens(tokens) {
  cachedTokens = tokens;
  tokensCacheTime = Date.now();
  try {
    await getPool().query(
      `INSERT INTO oauth_tokens (service, tokens, updated_at)
       VALUES ('google', $1, $2)
       ON CONFLICT (service) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(tokens), Date.now()]
    );
  } catch (err) {
    console.error("[gmail] Failed to save tokens:", err);
  }
}
function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = getRedirectUri();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}
function getRedirectUri() {
  if (process.env.GMAIL_REDIRECT_URI) {
    return process.env.GMAIL_REDIRECT_URI;
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}/api/gmail/callback`;
  }
  if (process.env.REPLIT_DOMAINS) {
    const domain = process.env.REPLIT_DOMAINS.split(",")[0];
    return `https://${domain}/api/gmail/callback`;
  }
  const port = process.env.PORT || "3000";
  return `http://localhost:${port}/api/gmail/callback`;
}
function getAuthUrl() {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent"
  });
}
async function handleCallback(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  await saveTokens(tokens);
}
async function getGmailClient() {
  const tokens = await loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Gmail not connected");
  }
  const client = getOAuth2Client();
  client.setCredentials(tokens);
  client.on("tokens", async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveTokens(merged);
  });
  const isExpired = !tokens.expiry_date || Date.now() >= tokens.expiry_date - 6e4;
  if (isExpired) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      const merged = { ...tokens, ...credentials };
      await saveTokens(merged);
    } catch (err) {
      if (err.message?.includes("invalid_grant")) {
        throw new Error("Gmail authorization expired \u2014 need to reconnect");
      }
      throw err;
    }
  }
  return google.gmail({ version: "v1", auth: client });
}
function decodeHeader(headers2, name) {
  const h = headers2.find((h2) => h2.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}
function decodeBody(payload) {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        const html = Buffer.from(part.body.data, "base64url").toString("utf-8");
        return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
    for (const part of payload.parts) {
      const nested = decodeBody(part);
      if (nested) return nested;
    }
  }
  return "";
}
async function listEmails(query, maxResults = 10) {
  try {
    const gmail = await getGmailClient();
    const params = {
      userId: "me",
      maxResults: Math.min(maxResults, 20)
    };
    if (query) params.q = query;
    const listRes = await gmail.users.messages.list(params);
    const messageRefs = listRes.data.messages || [];
    if (messageRefs.length === 0) {
      return query ? `No emails found matching "${query}".` : "Inbox is empty.";
    }
    const details = await Promise.all(
      messageRefs.map(async (ref) => {
        const msg = await gmail.users.messages.get({
          userId: "me",
          id: ref.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"]
        });
        const headers2 = msg.data.payload?.headers || [];
        return {
          id: ref.id,
          threadId: msg.data.threadId || "",
          from: decodeHeader(headers2, "From"),
          subject: decodeHeader(headers2, "Subject") || "(no subject)",
          date: decodeHeader(headers2, "Date"),
          snippet: msg.data.snippet || "",
          unread: (msg.data.labelIds || []).includes("UNREAD")
        };
      })
    );
    const lines = details.map((e, i) => {
      const marker = e.unread ? "*" : " ";
      return `${marker} ${i + 1}. [${e.id}] (thread: ${e.threadId})
   From: ${e.from}
   Subject: ${e.subject}
   Date: ${e.date}
   Preview: ${e.snippet}`;
    });
    const header = query ? `Emails matching "${query}" (${details.length}):` : `Recent emails (${details.length}):`;
    return `${header}
(* = unread)

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail listEmails error:", msg);
    if (msg.includes("not connected")) {
      return "Gmail is not connected. Please connect your Gmail account first.";
    }
    if (msg.includes("invalid_grant") || msg.includes("Token has been expired") || msg.includes("authorization expired")) {
      return "Gmail authorization has expired. Rickin needs to visit /api/gmail/auth in the browser to reconnect.";
    }
    return `Unable to check emails right now: ${msg}`;
  }
}
async function readEmail(messageId) {
  try {
    const gmail = await getGmailClient();
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full"
    });
    const headers2 = msg.data.payload?.headers || [];
    const from = decodeHeader(headers2, "From");
    const to = decodeHeader(headers2, "To");
    const subject = decodeHeader(headers2, "Subject") || "(no subject)";
    const date = decodeHeader(headers2, "Date");
    const threadId = msg.data.threadId || "";
    const body = decodeBody(msg.data.payload) || "(no readable content)";
    const attachments = findAttachments(msg.data.payload);
    const truncatedBody = body.length > 3e3 ? body.slice(0, 3e3) + "\n\n[...truncated]" : body;
    let result = `From: ${from}
To: ${to}
Subject: ${subject}
Date: ${date}
Thread ID: ${threadId}
`;
    if (attachments.length > 0) {
      result += `Attachments: ${attachments.map((a) => `${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)}KB) [id: ${a.attachmentId}]`).join("; ")}
`;
    }
    result += `
${truncatedBody}`;
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail readEmail error:", msg);
    if (msg.includes("not connected")) {
      return "Gmail is not connected. Please connect your Gmail account first.";
    }
    if (msg.includes("404") || msg.includes("Not Found")) {
      return "That email could not be found. It may have been deleted.";
    }
    if (msg.includes("invalid_grant") || msg.includes("authorization expired")) {
      return "Gmail authorization has expired. Rickin needs to visit /api/gmail/auth in the browser to reconnect.";
    }
    return `Unable to read this email right now: ${msg}`;
  }
}
async function searchEmails(query) {
  return listEmails(query, 10);
}
async function searchEmailsStructured(query, maxResults = 5) {
  try {
    const client = await getGmailClient();
    const listRes = await client.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(maxResults, 10)
    });
    const messageRefs = listRes.data.messages || [];
    if (messageRefs.length === 0) return [];
    const details = await Promise.all(
      messageRefs.map(async (ref) => {
        const msg = await client.users.messages.get({
          userId: "me",
          id: ref.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"]
        });
        const headers2 = msg.data.payload?.headers || [];
        const getH = (name) => headers2.find((h) => h.name === name)?.value || "";
        return {
          subject: getH("Subject") || "(no subject)",
          from: getH("From").replace(/<.*>/, "").trim(),
          date: getH("Date"),
          unread: (msg.data.labelIds || []).includes("UNREAD"),
          snippet: (msg.data.snippet || "").slice(0, 150)
        };
      })
    );
    return details;
  } catch {
    return [];
  }
}
async function getUnreadCount() {
  try {
    const client = await getGmailClient();
    const res = await client.users.messages.list({
      userId: "me",
      q: "is:unread category:primary",
      maxResults: 1
    });
    return res.data.resultSizeEstimate || 0;
  } catch (err) {
    console.error("Gmail getUnreadCount error:", err instanceof Error ? err.message : err);
    return 0;
  }
}
async function countUnread(query) {
  try {
    const client = await getGmailClient();
    const res = await client.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 1
    });
    return res.data.resultSizeEstimate || 0;
  } catch (err) {
    console.error("Gmail countUnread error:", err instanceof Error ? err.message : err);
    return 0;
  }
}
async function getConnectedEmail() {
  try {
    const client = await getGmailClient();
    const profile = await client.users.getProfile({ userId: "me" });
    return profile.data.emailAddress || null;
  } catch {
    return null;
  }
}
async function getAccessToken() {
  try {
    const tokens = await loadTokens();
    if (!tokens || !tokens.refresh_token) return null;
    const client = getOAuth2Client();
    client.setCredentials(tokens);
    const isExpired = !tokens.expiry_date || Date.now() >= tokens.expiry_date - 6e4;
    if (isExpired) {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      const merged = { ...tokens, ...credentials };
      await saveTokens(merged);
      return credentials.access_token || null;
    }
    return tokens.access_token || null;
  } catch (err) {
    console.error("[gmail] Failed to get access token:", err instanceof Error ? err.message : err);
    return null;
  }
}
var TRUSTED_SENDERS = [
  "rickin.patel@gmail.com",
  "rickin@rickin.live"
];
function isTrustedSender(from) {
  const emailMatch = from.match(/<([^>]+)>/);
  const email = emailMatch ? emailMatch[1].toLowerCase() : from.toLowerCase().trim();
  return TRUSTED_SENDERS.some((trusted) => email === trusted || email.endsWith(`<${trusted}>`));
}
async function getDarkNodeEmails() {
  try {
    const gmail = await getGmailClient();
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread from:me @darknode",
      maxResults: 5
    });
    const messageRefs = listRes.data.messages || [];
    if (messageRefs.length === 0) return [];
    const processedIds = await getProcessedDarkNodeIds();
    const results = [];
    for (const ref of messageRefs) {
      if (processedIds.has(ref.id)) continue;
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: ref.id,
        format: "full"
      });
      const headers2 = msg.data.payload?.headers || [];
      const from = decodeHeader(headers2, "From");
      if (!isTrustedSender(from)) {
        console.log(`[gmail] getDarkNodeEmails: skipping untrusted sender: ${from}`);
        await markDarkNodeProcessed(ref.id);
        continue;
      }
      const subject = decodeHeader(headers2, "Subject") || "(no subject)";
      const date = decodeHeader(headers2, "Date");
      const body = decodeBody(msg.data.payload) || "(no readable content)";
      const instruction = extractDarkNodeInstruction(body);
      if (!instruction) continue;
      results.push({
        messageId: ref.id,
        subject,
        from,
        date,
        body: body.length > 5e3 ? body.slice(0, 5e3) + "\n\n[...truncated]" : body,
        instruction
      });
    }
    return results;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gmail] getDarkNodeEmails error:", msg);
    return [];
  }
}
function extractDarkNodeInstruction(body) {
  const lines = body.split(/\n/);
  for (const line of lines) {
    if (line.trimStart().startsWith(">")) continue;
    const match = line.match(/@darknode\s*[-–—:]?\s*(.+)/i);
    if (match) {
      let instruction = match[1].trim();
      if (instruction.length === 0) continue;
      if (instruction.length > 200) instruction = instruction.slice(0, 200);
      return instruction;
    }
  }
  return null;
}
async function getProcessedDarkNodeIds() {
  try {
    const result = await getPool().query(`SELECT value FROM app_config WHERE key = 'darknode_processed_emails'`);
    if (result.rows.length > 0) {
      const ids = result.rows[0].value.ids || [];
      return new Set(ids);
    }
  } catch {
  }
  return /* @__PURE__ */ new Set();
}
async function markDarkNodeProcessed(messageId) {
  try {
    const existing = await getProcessedDarkNodeIds();
    existing.add(messageId);
    const ids = [...existing].slice(-200);
    await getPool().query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ('darknode_processed_emails', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify({ ids }), Date.now()]
    );
  } catch (err) {
    console.error("[gmail] markDarkNodeProcessed error:", err);
  }
}
function findAttachments(payload) {
  const attachments = [];
  function walk(part) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
        attachmentId: part.body.attachmentId,
        size: part.body.size || 0
      });
    }
    if (part.parts) {
      for (const p of part.parts) walk(p);
    }
  }
  walk(payload);
  return attachments;
}
async function getAttachment(messageId, attachmentId, filename) {
  try {
    const gmail = await getGmailClient();
    const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const allAttachments = findAttachments(msg.data.payload);
    if (allAttachments.length === 0) {
      return "This email has no attachments.";
    }
    let target = allAttachments[0];
    if (attachmentId) {
      const found = allAttachments.find((a) => a.attachmentId === attachmentId);
      if (found) {
        target = found;
      } else {
        const listStr2 = allAttachments.map((a) => `- ${a.filename} (${a.mimeType}) [id: ${a.attachmentId}]`).join("\n");
        return `Attachment ID not found. Available attachments:
${listStr2}`;
      }
    } else if (filename) {
      const found = allAttachments.find((a) => a.filename.toLowerCase().includes(filename.toLowerCase()));
      if (found) {
        target = found;
      } else {
        const listStr2 = allAttachments.map((a) => `- ${a.filename} (${a.mimeType})`).join("\n");
        return `No attachment matching "${filename}". Available attachments:
${listStr2}`;
      }
    }
    const attRes = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: target.attachmentId
    });
    const rawData = attRes.data.data;
    if (!rawData) return "Attachment data could not be retrieved.";
    const buffer = Buffer.from(rawData, "base64url");
    if (target.mimeType === "application/pdf" || target.filename.toLowerCase().endsWith(".pdf")) {
      try {
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        await parser.load();
        const textResult = await parser.getText();
        const text = (typeof textResult === "string" ? textResult : textResult?.text ?? "").trim();
        const info = await parser.getInfo();
        const numPages = info?.total ?? "?";
        await parser.destroy();
        if (text.length > 0) {
          const truncated = text.length > 8e3 ? text.slice(0, 8e3) + "\n\n[...truncated]" : text;
          return `\u{1F4CE} ${target.filename} (PDF, ${numPages} pages)

${truncated}`;
        }
        return `\u{1F4CE} ${target.filename} \u2014 PDF has no extractable text (may be scanned/image-based).`;
      } catch (pdfErr) {
        return `\u{1F4CE} ${target.filename} \u2014 PDF parsing failed: ${pdfErr instanceof Error ? pdfErr.message : String(pdfErr)}`;
      }
    }
    if (target.mimeType.startsWith("text/") || target.mimeType === "application/json" || target.mimeType === "application/xml") {
      const textContent = buffer.toString("utf-8");
      const truncated = textContent.length > 8e3 ? textContent.slice(0, 8e3) + "\n\n[...truncated]" : textContent;
      return `\u{1F4CE} ${target.filename}

${truncated}`;
    }
    if (target.mimeType.startsWith("image/")) {
      const b64 = buffer.toString("base64");
      return `\u{1F4CE} ${target.filename} (${target.mimeType}, ${Math.round(buffer.length / 1024)}KB)
[Image attachment \u2014 base64 data available but not displayed as text]`;
    }
    const listStr = allAttachments.map((a, i) => `${i + 1}. ${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)}KB) [attachmentId: ${a.attachmentId}]`).join("\n");
    return `\u{1F4CE} ${target.filename} is a binary file (${target.mimeType}, ${Math.round(buffer.length / 1024)}KB). Cannot display as text.

All attachments:
${listStr}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail getAttachment error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("404")) return "Email or attachment not found.";
    return `Unable to read attachment: ${msg}`;
  }
}
function sanitizeHeader(value) {
  return value.replace(/[\r\n]+/g, " ").trim();
}
function buildRfc2822Message(to, subject, body, options) {
  const lines = [];
  lines.push(`To: ${sanitizeHeader(to)}`);
  if (options?.cc) lines.push(`Cc: ${sanitizeHeader(options.cc)}`);
  if (options?.bcc) lines.push(`Bcc: ${sanitizeHeader(options.bcc)}`);
  lines.push(`Subject: ${sanitizeHeader(subject)}`);
  lines.push(`Content-Type: text/plain; charset="UTF-8"`);
  if (options?.inReplyTo) lines.push(`In-Reply-To: ${sanitizeHeader(options.inReplyTo)}`);
  if (options?.references) lines.push(`References: ${sanitizeHeader(options.references)}`);
  lines.push("");
  lines.push(body);
  return lines.join("\r\n");
}
async function sendEmail(to, subject, body, cc, bcc) {
  try {
    const gmail = await getGmailClient();
    const raw = buildRfc2822Message(to, subject, body, { cc, bcc });
    const encoded = Buffer.from(raw).toString("base64url");
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded }
    });
    return `\u2705 Email sent successfully.
To: ${to}
Subject: ${subject}
Message ID: ${res.data.id}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail sendEmail error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("invalid_grant") || msg.includes("authorization expired")) {
      return "Gmail authorization expired \u2014 need to reconnect. Visit /api/gmail/auth.";
    }
    return `Failed to send email: ${msg}`;
  }
}
async function replyToEmail(messageId, body, replyAll = false) {
  try {
    const gmail = await getGmailClient();
    const original = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const headers2 = original.data.payload?.headers || [];
    const origFrom = decodeHeader(headers2, "From");
    const origTo = decodeHeader(headers2, "To");
    const origCc = decodeHeader(headers2, "Cc");
    const origSubject = decodeHeader(headers2, "Subject");
    const origMessageId = decodeHeader(headers2, "Message-ID") || decodeHeader(headers2, "Message-Id");
    const origReferences = decodeHeader(headers2, "References");
    const threadId = original.data.threadId || void 0;
    const replyTo = origFrom;
    let cc;
    if (replyAll) {
      const allRecipients = [origTo, origCc].filter(Boolean).join(", ");
      cc = allRecipients || void 0;
    }
    const subject = origSubject.startsWith("Re:") ? origSubject : `Re: ${origSubject}`;
    const references = origReferences ? `${origReferences} ${origMessageId}` : origMessageId;
    const raw = buildRfc2822Message(replyTo, subject, body, {
      cc,
      inReplyTo: origMessageId,
      references,
      threadId
    });
    const encoded = Buffer.from(raw).toString("base64url");
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded, threadId }
    });
    return `\u2705 Reply sent successfully.
To: ${replyTo}${cc ? `
Cc: ${cc}` : ""}
Subject: ${subject}
Message ID: ${res.data.id}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail replyToEmail error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    return `Failed to send reply: ${msg}`;
  }
}
async function getThread(threadId) {
  try {
    const gmail = await getGmailClient();
    const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    const messages = thread.data.messages || [];
    if (messages.length === 0) return "Thread has no messages.";
    const formatted = messages.map((msg, i) => {
      const headers2 = msg.payload?.headers || [];
      const from = decodeHeader(headers2, "From");
      const to = decodeHeader(headers2, "To");
      const date = decodeHeader(headers2, "Date");
      const subject = decodeHeader(headers2, "Subject");
      const body = decodeBody(msg.payload) || "(no readable content)";
      const truncatedBody = body.length > 2e3 ? body.slice(0, 2e3) + "\n[...truncated]" : body;
      return `--- Message ${i + 1} of ${messages.length} [${msg.id}] ---
From: ${from}
To: ${to}
Date: ${date}
Subject: ${subject}

${truncatedBody}`;
    });
    return `Thread: ${messages.length} messages

${formatted.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail getThread error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("404")) return "Thread not found.";
    return `Unable to read thread: ${msg}`;
  }
}
async function createDraft(to, subject, body, cc, bcc) {
  try {
    const gmail = await getGmailClient();
    const raw = buildRfc2822Message(to, subject, body, { cc, bcc });
    const encoded = Buffer.from(raw).toString("base64url");
    const res = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw: encoded } }
    });
    return `\u2705 Draft saved.
To: ${to}
Subject: ${subject}
Draft ID: ${res.data.id}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail createDraft error:", msg);
    return `Failed to save draft: ${msg}`;
  }
}
async function archiveEmail(messageId) {
  try {
    const gmail = await getGmailClient();
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["INBOX"] }
    });
    return `\u2705 Email archived (removed from inbox).`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail archiveEmail error:", msg);
    if (msg.includes("404")) return "Email not found.";
    return `Failed to archive: ${msg}`;
  }
}
async function modifyLabels(messageId, addLabels, removeLabels) {
  try {
    const gmail = await getGmailClient();
    const body = {};
    if (addLabels && addLabels.length > 0) body.addLabelIds = addLabels;
    if (removeLabels && removeLabels.length > 0) body.removeLabelIds = removeLabels;
    await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: body });
    const parts = [];
    if (addLabels?.length) parts.push(`Added: ${addLabels.join(", ")}`);
    if (removeLabels?.length) parts.push(`Removed: ${removeLabels.join(", ")}`);
    return `\u2705 Labels updated. ${parts.join(". ")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail modifyLabels error:", msg);
    if (msg.includes("404")) return "Email not found.";
    return `Failed to modify labels: ${msg}`;
  }
}
async function markRead(messageId, read) {
  try {
    const gmail = await getGmailClient();
    const body = read ? { removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"] };
    await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: body });
    return `\u2705 Email marked as ${read ? "read" : "unread"}.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail markRead error:", msg);
    if (msg.includes("404")) return "Email not found.";
    return `Failed to update read status: ${msg}`;
  }
}
async function trashEmail(messageId) {
  try {
    const gmail = await getGmailClient();
    await gmail.users.messages.trash({ userId: "me", id: messageId });
    return `\u2705 Email moved to trash.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail trashEmail error:", msg);
    if (msg.includes("404")) return "Email not found.";
    return `Failed to trash email: ${msg}`;
  }
}
async function listLabels() {
  try {
    const gmail = await getGmailClient();
    const res = await gmail.users.labels.list({ userId: "me" });
    const labels = res.data.labels || [];
    if (labels.length === 0) return "No labels found.";
    const system = [];
    const user = [];
    for (const l of labels) {
      const entry = { id: l.id, name: l.name };
      if (l.type === "system") system.push(entry);
      else user.push(entry);
    }
    system.sort((a, b) => a.name.localeCompare(b.name));
    user.sort((a, b) => a.name.localeCompare(b.name));
    const lines = [];
    if (user.length > 0) {
      lines.push(`Custom labels (${user.length}):`);
      for (const l of user) lines.push(`  \u2022 ${l.name}  [id: ${l.id}]`);
    }
    lines.push(`
System labels (${system.length}):`);
    for (const l of system) lines.push(`  \u2022 ${l.name}  [id: ${l.id}]`);
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail listLabels error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    return `Failed to list labels: ${msg}`;
  }
}
async function createLabel(name, options) {
  try {
    const gmail = await getGmailClient();
    const body = {
      name,
      labelListVisibility: options?.labelListVisibility || "labelShow",
      messageListVisibility: options?.messageListVisibility || "show"
    };
    if (options?.backgroundColor || options?.textColor) {
      body.color = {};
      if (options.backgroundColor) body.color.backgroundColor = options.backgroundColor;
      if (options.textColor) body.color.textColor = options.textColor;
    }
    const res = await gmail.users.labels.create({ userId: "me", requestBody: body });
    return `\u2705 Label created.
Name: ${res.data.name}
ID: ${res.data.id}

Use this ID with the email_label tool to apply it to emails.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail createLabel error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("already exists") || msg.includes("409")) return `Label "${name}" already exists. Use gmail_list_labels to find its ID.`;
    return `Failed to create label: ${msg}`;
  }
}
async function deleteLabel(labelId) {
  try {
    const gmail = await getGmailClient();
    await gmail.users.labels.delete({ userId: "me", id: labelId });
    return `\u2705 Label deleted (ID: ${labelId}).`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail deleteLabel error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("404")) return "Label not found. It may have already been deleted.";
    if (msg.includes("invalid")) return "Cannot delete system labels \u2014 only custom labels can be deleted.";
    return `Failed to delete label: ${msg}`;
  }
}
async function checkConnectionStatus() {
  if (!isConfigured3()) return { connected: false, error: "GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set" };
  if (!isConnected()) return { connected: false, error: "No OAuth tokens \u2014 visit /api/gmail/auth to connect" };
  try {
    const email = await getConnectedEmail();
    if (email) return { connected: true, email };
    return { connected: false, error: "Token invalid \u2014 visit /api/gmail/auth to reconnect" };
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// src/calendar.ts
init_db();
import { google as google2 } from "googleapis";
function getOAuth2Client2() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || "";
  return new google2.auth.OAuth2(clientId, clientSecret, redirectUri);
}
async function loadTokens2() {
  try {
    const result = await getPool().query(`SELECT tokens FROM oauth_tokens WHERE service = 'google'`);
    if (result.rows.length > 0) {
      return result.rows[0].tokens;
    }
  } catch (err) {
    console.error("[calendar] Failed to load tokens:", err);
  }
  return null;
}
async function saveTokens2(tokens) {
  try {
    await getPool().query(
      `INSERT INTO oauth_tokens (service, tokens, updated_at)
       VALUES ('google', $1, $2)
       ON CONFLICT (service) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(tokens), Date.now()]
    );
  } catch (err) {
    console.error("[calendar] Failed to save tokens:", err);
  }
}
async function getCalendarClient() {
  const tokens = await loadTokens2();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Google not connected \u2014 need to authorize first");
  }
  const client = getOAuth2Client2();
  client.setCredentials(tokens);
  client.on("tokens", async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveTokens2(merged);
  });
  const isExpired = !tokens.expiry_date || Date.now() >= tokens.expiry_date - 6e4;
  if (isExpired) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      await saveTokens2({ ...tokens, ...credentials });
    } catch (err) {
      if (err.message?.includes("invalid_grant")) {
        throw new Error("Google authorization expired \u2014 need to reconnect");
      }
      throw err;
    }
  }
  return google2.calendar({ version: "v3", auth: client });
}
function isConfigured4() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
async function listEvents(options) {
  try {
    const cal = await getCalendarClient();
    const now = /* @__PURE__ */ new Date();
    const timeMin = options?.timeMin || now.toISOString();
    const maxResults = options?.maxResults || 10;
    let calendarIds = ["primary"];
    try {
      const calList = await cal.calendarList.list({ minAccessRole: "reader" });
      const items = calList.data.items || [];
      if (items.length > 0) {
        calendarIds = items.filter((c) => c.selected !== false).map((c) => c.id).filter(Boolean);
        if (calendarIds.length === 0) calendarIds = ["primary"];
      }
      console.log(`[calendar] Querying ${calendarIds.length} calendar(s): ${calendarIds.join(", ")}`);
    } catch (err) {
      console.log("[calendar] Could not list calendars, falling back to primary");
    }
    console.log(`[calendar] Query range: ${timeMin} to ${options?.timeMax || "open-ended"}`);
    const allEvents = [];
    for (const calId of calendarIds) {
      try {
        const params = {
          calendarId: calId,
          timeMin,
          maxResults,
          singleEvents: true,
          orderBy: "startTime"
        };
        if (options?.timeMax) params.timeMax = options.timeMax;
        const res = await cal.events.list(params);
        const items = res.data.items || [];
        allEvents.push(...items);
      } catch (err) {
        console.log(`[calendar] Failed to query calendar ${calId}:`, err instanceof Error ? err.message : String(err));
      }
    }
    allEvents.sort((a, b) => {
      const aTime = a.start?.dateTime || a.start?.date || "";
      const bTime = b.start?.dateTime || b.start?.date || "";
      return aTime.localeCompare(bTime);
    });
    const events = allEvents.slice(0, maxResults);
    console.log(`[calendar] Found ${allEvents.length} event(s), returning ${events.length}`);
    if (events.length === 0) return "No upcoming events found.";
    const lines = events.map((event, i) => {
      const start = event.start?.dateTime ? new Date(event.start.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : event.start?.date ? (/* @__PURE__ */ new Date(event.start.date + "T12:00:00")).toLocaleString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }) + " (all day)" : "TBD";
      const end = event.end?.dateTime ? new Date(event.end.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "";
      const location = event.location ? `
   Location: ${event.location}` : "";
      const desc = event.description ? `
   ${event.description.slice(0, 100).replace(/\n/g, " ")}` : "";
      return `${i + 1}. ${event.summary || "(No title)"}
   ${start}${end ? ` - ${end}` : ""}${location}${desc}`;
    });
    return `Upcoming events (${events.length}):

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Calendar listEvents error:", msg);
    if (msg.includes("authorization expired") || msg.includes("invalid_grant")) {
      return "Google authorization has expired. Rickin needs to reconnect at /api/gmail/auth.";
    }
    if (msg.includes("insufficient")) {
      return "Calendar access not authorized. Rickin needs to reconnect at /api/gmail/auth to grant calendar permissions.";
    }
    return `Unable to fetch calendar events: ${msg}`;
  }
}
async function listEventsStructured(options) {
  try {
    const cal = await getCalendarClient();
    const now = /* @__PURE__ */ new Date();
    const timeMin = options?.timeMin || now.toISOString();
    const maxResults = options?.maxResults || 10;
    let calendars = [{ id: "primary", name: "Rickin" }];
    try {
      const calList = await cal.calendarList.list({ minAccessRole: "reader" });
      const items = calList.data.items || [];
      if (items.length > 0) {
        calendars = items.filter((c) => c.selected !== false && c.id).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id }));
        if (calendars.length === 0) calendars = [{ id: "primary", name: "Rickin" }];
      }
    } catch {
    }
    const allEvents = [];
    for (const c of calendars) {
      try {
        const params = { calendarId: c.id, timeMin, maxResults, singleEvents: true, orderBy: "startTime" };
        if (options?.timeMax) params.timeMax = options.timeMax;
        const res = await cal.events.list(params);
        for (const ev of res.data.items || []) {
          allEvents.push({ event: ev, calName: c.name });
        }
      } catch {
      }
    }
    allEvents.sort((a, b) => {
      const aT = a.event.start?.dateTime || a.event.start?.date || "";
      const bT = b.event.start?.dateTime || b.event.start?.date || "";
      return aT.localeCompare(bT);
    });
    return allEvents.slice(0, maxResults).map(({ event, calName }) => {
      const start = event.start?.dateTime ? new Date(event.start.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : event.start?.date ? (/* @__PURE__ */ new Date(event.start.date + "T12:00:00")).toLocaleString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }) + " (all day)" : "TBD";
      const end = event.end?.dateTime ? new Date(event.end.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "";
      return {
        title: event.summary || "(No title)",
        time: `${start}${end ? " - " + end : ""}`,
        calendar: calName
      };
    });
  } catch (err) {
    console.error("[calendar] listEventsStructured error:", err instanceof Error ? err.message : String(err));
    return [];
  }
}
async function listCalendars() {
  try {
    const cal = await getCalendarClient();
    const calList = await cal.calendarList.list({ minAccessRole: "reader" });
    const items = calList.data.items || [];
    return items.filter((c) => c.id).map((c) => ({
      id: c.id,
      name: c.summaryOverride || c.summary || c.id,
      accessRole: c.accessRole || "reader"
    }));
  } catch (err) {
    console.error("[calendar] listCalendars error:", err instanceof Error ? err.message : String(err));
    return [];
  }
}
function fuzzyMatchCalendar(calendars, query) {
  const q = query.toLowerCase().trim();
  const exact = calendars.find((c) => c.name.toLowerCase() === q);
  if (exact) return exact.id;
  const starts = calendars.find((c) => c.name.toLowerCase().startsWith(q));
  if (starts) return starts.id;
  const contains = calendars.find((c) => c.name.toLowerCase().includes(q));
  if (contains) return contains.id;
  return "primary";
}
async function createEvent(summary, options) {
  try {
    const calendar = await getCalendarClient();
    let targetCalendarId = "primary";
    let targetCalendarName = "primary";
    if (options.calendarName && options.calendarName.trim()) {
      const cals = await listCalendars();
      if (cals.length === 0) {
        return `Unable to create event: could not retrieve calendar list to match "${options.calendarName}". Try again or omit calendarName to use the primary calendar.`;
      }
      const writableCals = cals.filter((c) => c.accessRole === "owner" || c.accessRole === "writer");
      const matchedId = fuzzyMatchCalendar(writableCals, options.calendarName);
      if (matchedId === "primary") {
        const readOnlyMatch = fuzzyMatchCalendar(cals, options.calendarName);
        if (readOnlyMatch !== "primary") {
          const roName = cals.find((c) => c.id === readOnlyMatch)?.name || readOnlyMatch;
          return `Cannot create event on "${roName}" \u2014 it is read-only. Available writable calendars: ${writableCals.map((c) => c.name).join(", ")}`;
        }
      }
      targetCalendarId = matchedId;
      const matched = writableCals.find((c) => c.id === targetCalendarId);
      targetCalendarName = matched ? matched.name : targetCalendarId;
    }
    let start;
    let end;
    if (options.allDay) {
      start = { date: options.startTime.split("T")[0] };
      const endDate = options.endTime ? options.endTime.split("T")[0] : options.startTime.split("T")[0];
      const d = new Date(endDate);
      d.setDate(d.getDate() + 1);
      end = { date: d.toISOString().split("T")[0] };
    } else {
      start = { dateTime: options.startTime, timeZone: "America/New_York" };
      if (options.endTime) {
        end = { dateTime: options.endTime, timeZone: "America/New_York" };
      } else {
        const endTime = new Date(new Date(options.startTime).getTime() + 60 * 60 * 1e3);
        end = { dateTime: endTime.toISOString(), timeZone: "America/New_York" };
      }
    }
    const event = {
      summary,
      start,
      end
    };
    if (options.description) event.description = options.description;
    if (options.location) event.location = options.location;
    const res = await calendar.events.insert({
      calendarId: targetCalendarId,
      requestBody: event
    });
    const created = res.data;
    const startStr = created.start?.dateTime ? new Date(created.start.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : created.start?.date || "";
    const calLabel = targetCalendarId !== "primary" ? ` on calendar "${targetCalendarName}"` : "";
    return `Created event: "${summary}" on ${startStr}${calLabel}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Calendar createEvent error:", msg);
    if (msg.includes("authorization expired") || msg.includes("invalid_grant")) {
      return "Google authorization has expired. Rickin needs to reconnect at /api/gmail/auth.";
    }
    if (msg.includes("insufficient") || msg.includes("Forbidden")) {
      return "Calendar write access not authorized. Rickin needs to reconnect at /api/gmail/auth to grant calendar permissions.";
    }
    return `Unable to create event: ${msg}`;
  }
}
async function findOrCreateCalendar(name) {
  const cal = await getCalendarClient();
  const list2 = await cal.calendarList.list({ minAccessRole: "owner" });
  const existing = (list2.data.items || []).find(
    (c) => (c.summaryOverride || c.summary || "").toLowerCase() === name.toLowerCase()
  );
  if (existing?.id) return existing.id;
  const res = await cal.calendars.insert({ requestBody: { summary: name, timeZone: "America/New_York" } });
  return res.data.id;
}
async function createRecurringEvent(calendarId, options) {
  const cal = await getCalendarClient();
  const d = new Date(options.date);
  d.setDate(d.getDate() + 1);
  const endDate = d.toISOString().split("T")[0];
  const event = {
    summary: options.summary,
    start: { date: options.date },
    end: { date: endDate }
  };
  if (options.description) event.description = options.description;
  if (options.colorId) event.colorId = options.colorId;
  if (options.recurrence) event.recurrence = options.recurrence;
  if (options.reminders) event.reminders = options.reminders;
  const res = await cal.events.insert({ calendarId, requestBody: event });
  return res.data.id || "created";
}

// src/weather.ts
var WMO_CODES = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail"
};
function cToF(c) {
  return Math.round(c * 9 / 5 + 32);
}
function tempStr(c) {
  return `${Math.round(c)}\xB0C (${cToF(c)}\xB0F)`;
}
async function geocode(location) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const r = data.results?.[0];
  if (!r) return null;
  return { name: r.name, lat: r.latitude, lon: r.longitude, country: r.country || "", timezone: r.timezone || "auto" };
}
async function getWeather(location, forecastDays = 3) {
  try {
    const geo = await geocode(location);
    if (!geo) return `Could not find location "${location}". Try a city name like "New York" or "London".`;
    const days = Math.max(1, Math.min(forecastDays, 7));
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,winddirection_10m,relative_humidity_2m,uv_index&hourly=precipitation_probability&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max&temperature_unit=celsius&windspeed_unit=mph&timezone=${encodeURIComponent(geo.timezone)}&forecast_days=${days}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather API error ${res.status}`);
    const data = await res.json();
    const c = data.current;
    if (!c) return `Could not get weather data for "${location}".`;
    const condition = WMO_CODES[c.weathercode] || "Unknown";
    const locationLabel = `${geo.name}${geo.country ? `, ${geo.country}` : ""}`;
    let result = `Current weather for ${locationLabel}:
`;
    result += `  Condition: ${condition}
`;
    result += `  Temperature: ${tempStr(c.temperature_2m)}
`;
    result += `  Feels like: ${tempStr(c.apparent_temperature)}
`;
    result += `  Humidity: ${c.relative_humidity_2m}%
`;
    result += `  Wind: ${Math.round(c.windspeed_10m)} mph
`;
    if (c.uv_index !== void 0) result += `  UV Index: ${c.uv_index}
`;
    const hourly = data.hourly;
    if (hourly?.time?.length > 0 && hourly?.precipitation_probability?.length > 0) {
      result += `
Hourly Precipitation:
`;
      for (let i = 0; i < Math.min(24, hourly.time.length); i++) {
        const h = hourly.time[i];
        const prob = hourly.precipitation_probability[i];
        if (prob > 0) {
          result += `  ${h}: ${prob}%
`;
        }
      }
    }
    const daily = data.daily;
    if (daily?.time?.length > 0) {
      result += `
${days}-Day Forecast:
`;
      for (let i = 0; i < daily.time.length; i++) {
        const date = daily.time[i];
        const hi = Math.round(daily.temperature_2m_max[i]);
        const lo = Math.round(daily.temperature_2m_min[i]);
        const hiF = cToF(daily.temperature_2m_max[i]);
        const loF = cToF(daily.temperature_2m_min[i]);
        const desc = WMO_CODES[daily.weathercode[i]] || "Unknown";
        const rain = daily.precipitation_probability_max[i];
        result += `  ${date}: ${desc}, ${lo}-${hi}\xB0C (${loF}-${hiF}\xB0F), Rain: ${rain}%
`;
      }
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Weather error:", msg);
    return `Unable to get weather for "${location}": ${msg}`;
  }
}

// src/websearch.ts
async function search2(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; pi-assistant/1.0)"
      }
    });
    if (!res.ok) throw new Error(`Search error ${res.status}`);
    const html = await res.text();
    const results = [];
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>.*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;
    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < 8) {
      const rawUrl = match[1];
      const title = match[2].replace(/<[^>]+>/g, "").trim();
      const snippet = match[3].replace(/<[^>]+>/g, "").trim();
      let decodedUrl = rawUrl;
      const uddg = rawUrl.match(/uddg=([^&]+)/);
      if (uddg) {
        decodedUrl = decodeURIComponent(uddg[1]);
      }
      if (title && snippet) {
        results.push({ title, url: decodedUrl, snippet });
      }
    }
    if (results.length === 0) {
      const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;
      const titleRegex = /<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/gs;
      const titles = [];
      const snippets = [];
      let m;
      while ((m = titleRegex.exec(html)) !== null && titles.length < 8) {
        titles.push(m[1].replace(/<[^>]+>/g, "").trim());
      }
      while ((m = snippetRegex.exec(html)) !== null && snippets.length < 8) {
        snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
      }
      for (let i = 0; i < Math.min(titles.length, snippets.length); i++) {
        results.push({ title: titles[i], url: "", snippet: snippets[i] });
      }
    }
    if (results.length === 0) {
      return `No search results found for "${query}".`;
    }
    const lines = results.map(
      (r, i) => `${i + 1}. ${r.title}
   ${r.snippet}${r.url ? `
   URL: ${r.url}` : ""}`
    );
    return `Search results for "${query}":

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Web search error:", msg);
    return `Unable to search for "${query}": ${msg}`;
  }
}

// src/webfetch.ts
var USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var ENTITY_MAP = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&ndash;": "\u2013",
  "&mdash;": "\u2014",
  "&lsquo;": "'",
  "&rsquo;": "'",
  "&ldquo;": "\u201C",
  "&rdquo;": "\u201D",
  "&bull;": "\u2022",
  "&hellip;": "\u2026",
  "&copy;": "\xA9",
  "&reg;": "\xAE",
  "&trade;": "\u2122",
  "&euro;": "\u20AC",
  "&pound;": "\xA3",
  "&yen;": "\xA5",
  "&cent;": "\xA2",
  "&deg;": "\xB0",
  "&times;": "\xD7",
  "&divide;": "\xF7",
  "&rarr;": "\u2192",
  "&larr;": "\u2190",
  "&uarr;": "\u2191",
  "&darr;": "\u2193",
  "&para;": "\xB6",
  "&sect;": "\xA7",
  "&frac12;": "\xBD",
  "&frac14;": "\xBC",
  "&frac34;": "\xBE"
};
function decodeEntities(text) {
  let result = text;
  for (const [entity, char] of Object.entries(ENTITY_MAP)) {
    result = result.replaceAll(entity, char);
  }
  result = result.replace(/&#(\d+);/g, (_, code) => {
    const n = parseInt(code, 10);
    return n > 0 && n < 1114111 ? String.fromCodePoint(n) : "";
  });
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const n = parseInt(hex, 16);
    return n > 0 && n < 1114111 ? String.fromCodePoint(n) : "";
  });
  return result;
}
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, "").trim()) : "";
}
function extractMetaDescription(html) {
  const m = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i) || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
  return m ? decodeEntities(m[1].trim()) : "";
}
function htmlToText(html) {
  let text = html;
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "\n");
  text = text.replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag, content) => {
    const level = parseInt(tag[1]);
    const prefix = "#".repeat(level);
    const clean = content.replace(/<[^>]+>/g, "").trim();
    return `

${prefix} ${clean}

`;
  });
  text = text.replace(/<(p|div|section|article|main|blockquote)[^>]*>/gi, "\n\n");
  text = text.replace(/<\/(p|div|section|article|main|blockquote)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
  text = text.replace(/<li[^>]*>/gi, "\n\u2022 ");
  text = text.replace(/<\/li>/gi, "");
  text = text.replace(/<\/?[ou]l[^>]*>/gi, "\n");
  text = text.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, content) => {
    const label = content.replace(/<[^>]+>/g, "").trim();
    if (!label) return "";
    if (href.startsWith("#") || href.startsWith("javascript:")) return label;
    return `${label} (${href})`;
  });
  text = text.replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, "[image: $1]");
  text = text.replace(/<(td|th)[^>]*>/gi, " | ");
  text = text.replace(/<\/tr>/gi, "\n");
  text = text.replace(/<\/?table[^>]*>/gi, "\n");
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "_$2_");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, content) => {
    const code = content.replace(/<[^>]+>/g, "");
    return `
\`\`\`
${code}
\`\`\`
`;
  });
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/ *\n */g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();
  return text;
}
var BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]$/,
  /^\[fc/i,
  /^\[fd/i,
  /^\[fe80:/i,
  /metadata\.google\.internal/i
];
var MAX_BODY_BYTES = 2 * 1024 * 1024;
function isBlockedHost(hostname) {
  return BLOCKED_HOSTS.some((re) => re.test(hostname));
}
async function readBodyCapped(res, cap) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    chunks.push(decoder.decode(value, { stream: true }));
    if (totalBytes >= cap) {
      reader.cancel();
      break;
    }
  }
  return chunks.join("");
}
async function fetchPage(url, options) {
  const maxLen = Math.min(Math.max(options?.maxLength ?? 8e4, 1e3), 2e5);
  const timeoutMs = options?.timeoutMs ?? 15e3;
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Blocked: only http/https URLs are allowed (got ${parsed.protocol})`);
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error(`Blocked: cannot fetch private/internal addresses`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers2 = {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
      "Accept-Language": "en-US,en;q=0.9",
      ...options?.includeHeaders || {}
    };
    const res = await fetch(url, {
      headers: headers2,
      signal: controller.signal,
      redirect: "follow"
    });
    const finalHost = new URL(res.url).hostname;
    if (isBlockedHost(finalHost)) {
      throw new Error(`Blocked: redirect to private/internal address`);
    }
    const contentType = res.headers.get("content-type") || "";
    const rawBody = await readBodyCapped(res, MAX_BODY_BYTES);
    if (contentType.includes("application/json")) {
      let content2 = rawBody;
      let truncated2 = false;
      if (content2.length > maxLen) {
        content2 = content2.slice(0, maxLen);
        truncated2 = true;
      }
      return {
        url: res.url || url,
        title: "",
        description: "",
        content: content2,
        statusCode: res.status,
        contentType,
        byteLength: rawBody.length,
        truncated: truncated2
      };
    }
    if (contentType.includes("text/plain")) {
      let content2 = rawBody;
      let truncated2 = false;
      if (content2.length > maxLen) {
        content2 = content2.slice(0, maxLen);
        truncated2 = true;
      }
      return {
        url: res.url || url,
        title: "",
        description: "",
        content: content2,
        statusCode: res.status,
        contentType,
        byteLength: rawBody.length,
        truncated: truncated2
      };
    }
    const title = extractTitle(rawBody);
    const description = extractMetaDescription(rawBody);
    let content = htmlToText(rawBody);
    let truncated = false;
    if (content.length > maxLen) {
      content = content.slice(0, maxLen);
      const lastNewline = content.lastIndexOf("\n");
      if (lastNewline > maxLen * 0.8) {
        content = content.slice(0, lastNewline);
      }
      truncated = true;
    }
    return {
      url: res.url || url,
      title,
      description,
      content,
      statusCode: res.status,
      contentType,
      byteLength: rawBody.length,
      truncated
    };
  } finally {
    clearTimeout(timer);
  }
}
function formatResult(result) {
  const parts = [];
  if (result.title) parts.push(`# ${result.title}`);
  parts.push(`URL: ${result.url}`);
  parts.push(`Status: ${result.statusCode} | Type: ${result.contentType} | Size: ${(result.byteLength / 1024).toFixed(1)}KB`);
  if (result.description) parts.push(`Description: ${result.description}`);
  if (result.truncated) parts.push(`\u26A0\uFE0F Content truncated to ~${(result.content.length / 1024).toFixed(0)}KB`);
  parts.push("");
  parts.push(result.content);
  return parts.join("\n");
}

// src/tasks.ts
init_db();
async function init5() {
  const existing = await getPool().query(`SELECT count(*) FROM tasks`);
  if (parseInt(existing.rows[0].count) === 0) {
    try {
      const fs7 = await import("fs");
      const pathMod = await import("path");
      const legacyPath = pathMod.default.join(process.cwd(), "data", "tasks.json");
      if (fs7.default.existsSync(legacyPath)) {
        const legacyTasks = JSON.parse(fs7.default.readFileSync(legacyPath, "utf-8"));
        for (const t of legacyTasks) {
          await getPool().query(
            `INSERT INTO tasks (id, title, description, due_date, priority, completed, created_at, completed_at, tags)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
            [t.id, t.title, t.description || null, t.dueDate || null, t.priority || "medium", t.completed || false, t.createdAt, t.completedAt || null, JSON.stringify(t.tags || [])]
          );
        }
        console.log(`[tasks] Migrated ${legacyTasks.length} tasks from data/tasks.json to PostgreSQL`);
      }
    } catch (err) {
      console.error("[tasks] Task migration failed:", err);
    }
  }
  console.log("[tasks] initialized");
}
function generateId() {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}
async function loadTasks() {
  const result = await getPool().query(`SELECT * FROM tasks ORDER BY created_at DESC`);
  return result.rows.map(rowToTask);
}
async function getActiveTasks() {
  const all = await loadTasks();
  return all.filter((t) => !t.completed).map((t) => ({ id: t.id, title: t.title, priority: t.priority, dueDate: t.dueDate }));
}
async function saveTask(task) {
  await getPool().query(
    `INSERT INTO tasks (id, title, description, due_date, priority, completed, created_at, completed_at, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       due_date = EXCLUDED.due_date,
       priority = EXCLUDED.priority,
       completed = EXCLUDED.completed,
       completed_at = EXCLUDED.completed_at,
       tags = EXCLUDED.tags`,
    [task.id, task.title, task.description || null, task.dueDate || null, task.priority, task.completed, task.createdAt, task.completedAt || null, JSON.stringify(task.tags || [])]
  );
}
function rowToTask(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || void 0,
    dueDate: row.due_date || void 0,
    priority: row.priority,
    completed: row.completed,
    createdAt: row.created_at,
    completedAt: row.completed_at || void 0,
    tags: Array.isArray(row.tags) ? row.tags : JSON.parse(row.tags || "[]")
  };
}
async function addTask(title, options) {
  const task = {
    id: generateId(),
    title,
    description: options?.description,
    dueDate: options?.dueDate,
    priority: options?.priority || "medium",
    completed: false,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    tags: options?.tags
  };
  await saveTask(task);
  return `Added task: "${title}"${task.dueDate ? ` (due: ${task.dueDate})` : ""}${task.priority !== "medium" ? ` [${task.priority} priority]` : ""}`;
}
async function listTasks(filter) {
  const tasks = await loadTasks();
  let filtered = tasks;
  if (!filter?.showCompleted) {
    filtered = filtered.filter((t) => !t.completed);
  }
  if (filter?.tag) {
    filtered = filtered.filter((t) => t.tags?.includes(filter.tag));
  }
  if (filter?.priority) {
    filtered = filtered.filter((t) => t.priority === filter.priority);
  }
  if (filtered.length === 0) {
    return filter?.showCompleted ? "No tasks found." : "No open tasks. You're all caught up!";
  }
  filtered.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (priorityOrder[a.priority] !== priorityOrder[b.priority]) return priorityOrder[a.priority] - priorityOrder[b.priority];
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });
  const lines = filtered.map((t, i) => {
    const status = t.completed ? "[x]" : "[ ]";
    const priority = t.priority === "high" ? " !!" : t.priority === "low" ? " ~" : "";
    const due = t.dueDate ? ` (due: ${t.dueDate})` : "";
    const tags = t.tags?.length ? ` [${t.tags.join(", ")}]` : "";
    return `${i + 1}. ${status} ${t.title}${priority}${due}${tags}
   ID: ${t.id}${t.description ? `
   ${t.description}` : ""}`;
  });
  const openCount = filtered.filter((t) => !t.completed).length;
  const doneCount = filtered.filter((t) => t.completed).length;
  let header = `Tasks (${openCount} open`;
  if (doneCount > 0) header += `, ${doneCount} completed`;
  header += "):";
  return `${header}

${lines.join("\n\n")}`;
}
async function getCompletedTasks() {
  const result = await getPool().query(`SELECT * FROM tasks WHERE completed = true ORDER BY completed_at DESC`);
  return result.rows.map(rowToTask).map((t) => ({ id: t.id, title: t.title, priority: t.priority, completedAt: t.completedAt }));
}
async function restoreTask(taskId) {
  const result = await getPool().query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  if (result.rows.length === 0) return `Task not found: ${taskId}`;
  const task = rowToTask(result.rows[0]);
  if (!task.completed) return `Task is already active: "${task.title}"`;
  task.completed = false;
  task.completedAt = void 0;
  await saveTask(task);
  return `Restored task: "${task.title}"`;
}
async function completeTask(taskId) {
  const result = await getPool().query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  if (result.rows.length === 0) return `Task not found: ${taskId}`;
  const task = rowToTask(result.rows[0]);
  if (task.completed) return `Task already completed: "${task.title}"`;
  task.completed = true;
  task.completedAt = (/* @__PURE__ */ new Date()).toISOString();
  await saveTask(task);
  return `Completed task: "${task.title}"`;
}
async function deleteTask(taskId) {
  const result = await getPool().query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  if (result.rows.length === 0) return `Task not found: ${taskId}`;
  const task = rowToTask(result.rows[0]);
  await getPool().query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
  return `Deleted task: "${task.title}"`;
}
async function updateTask(taskId, updates) {
  const result = await getPool().query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  if (result.rows.length === 0) return `Task not found: ${taskId}`;
  const task = rowToTask(result.rows[0]);
  if (updates.title) task.title = updates.title;
  if (updates.description !== void 0) task.description = updates.description;
  if (updates.dueDate !== void 0) task.dueDate = updates.dueDate;
  if (updates.priority) task.priority = updates.priority;
  if (updates.tags) task.tags = updates.tags;
  await saveTask(task);
  return `Updated task: "${task.title}"`;
}

// src/news.ts
var RSS_FEEDS = {
  "top": "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",
  "world": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "business": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "technology": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "science": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp0Y1RjU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "health": "https://news.google.com/rss/topics/CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FtVnVLQUFQAQ?hl=en-US&gl=US&ceid=US:en",
  "sports": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "entertainment": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en"
};
function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < 10) {
    const block = match[1];
    const title = block.match(/<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/)?.[1] || block.match(/<title>(.*?)<\/title>/)?.[1] || "";
    const link = block.match(/<link>(.*?)<\/link>/)?.[1] || "";
    const desc = block.match(/<description><!\[CDATA\[(.*?)\]\]>|<description>(.*?)<\/description>/)?.[1] || "";
    const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || "";
    const source = block.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || "";
    const cleanDesc = desc.replace(/<[^>]+>/g, "").trim();
    const cleanTitle = title.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    if (cleanTitle) {
      items.push({
        title: cleanTitle,
        link,
        description: cleanDesc.slice(0, 200),
        pubDate,
        source
      });
    }
  }
  return items;
}
async function getNews(category) {
  try {
    const cat = (category || "top").toLowerCase();
    const feedUrl = RSS_FEEDS[cat];
    if (!feedUrl) {
      const available = Object.keys(RSS_FEEDS).join(", ");
      return `Unknown category "${category}". Available categories: ${available}`;
    }
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "pi-assistant/1.0" }
    });
    if (!res.ok) throw new Error(`News feed error ${res.status}`);
    const xml = await res.text();
    const items = parseRssItems(xml);
    if (items.length === 0) return `No news articles found for "${cat}".`;
    const lines = items.map((item, i) => {
      const source = item.source ? ` (${item.source})` : "";
      const date = item.pubDate ? new Date(item.pubDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
      return `${i + 1}. ${item.title}${source}
   ${date}${item.description ? ` \u2014 ${item.description}` : ""}`;
    });
    const catLabel = cat.charAt(0).toUpperCase() + cat.slice(1);
    return `${catLabel} News Headlines:

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("News error:", msg);
    return `Unable to fetch news: ${msg}`;
  }
}
async function getTopHeadlines(count = 3) {
  try {
    const ua = { "User-Agent": "Mozilla/5.0 (compatible; pi-assistant/1.0)" };
    const [topRes, worldRes] = await Promise.all([
      fetch(RSS_FEEDS["top"], { headers: ua }),
      fetch(RSS_FEEDS["world"], { headers: ua })
    ]);
    const topItems = topRes.ok ? parseRssItems(await topRes.text()) : [];
    const worldItems = worldRes.ok ? parseRssItems(await worldRes.text()) : [];
    const seen = /* @__PURE__ */ new Set();
    const merged = [];
    for (const item of [...topItems, ...worldItems]) {
      const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push({ title: item.title, source: item.source, link: item.link });
      }
    }
    return merged.slice(0, count);
  } catch {
    return [];
  }
}
async function searchHeadlines(query, count = 5) {
  try {
    const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; pi-assistant/1.0)" }
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = parseRssItems(xml);
    return items.slice(0, count).map((item) => ({ title: item.title, source: item.source, link: item.link }));
  } catch {
    return [];
  }
}
async function searchNews(query) {
  try {
    const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "pi-assistant/1.0" }
    });
    if (!res.ok) throw new Error(`News search error ${res.status}`);
    const xml = await res.text();
    const items = parseRssItems(xml);
    if (items.length === 0) return `No news articles found for "${query}".`;
    const lines = items.map((item, i) => {
      const source = item.source ? ` (${item.source})` : "";
      const date = item.pubDate ? new Date(item.pubDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
      return `${i + 1}. ${item.title}${source}
   ${date}${item.description ? ` \u2014 ${item.description}` : ""}`;
    });
    return `News about "${query}":

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("News search error:", msg);
    return `Unable to search news for "${query}": ${msg}`;
  }
}

// src/twitter.ts
var API_BASE = "https://twitter241.p.rapidapi.com";
var API_HOST = "twitter241.p.rapidapi.com";
var RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
var TIMEOUT_MS = 15e3;
function cleanUsername(input) {
  return input.replace(/^@/, "").replace(/^https?:\/\/(x\.com|twitter\.com)\//, "").replace(/\/.*$/, "").trim();
}
function extractTweetId(input) {
  const match = input.match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/);
  if (match) return match[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}
async function apiFetch(endpoint, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${API_BASE}${endpoint}?${new URLSearchParams(params)}`;
    const res = await fetch(url, {
      headers: {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": API_HOST
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("X request timed out");
    throw err;
  }
}
function extractTweetFromResult(result) {
  if (!result) return null;
  if (result.__typename === "TweetWithVisibilityResults") return result.tweet || null;
  if (result.__typename === "Tweet" || result.legacy) return result;
  return null;
}
function extractTweetsFromEntries(entries) {
  const results = [];
  for (const entry of entries) {
    const content = entry?.content || {};
    const directResult = content?.itemContent?.tweet_results?.result;
    if (directResult) {
      const tweet = extractTweetFromResult(directResult);
      if (tweet) results.push(tweet);
    }
    const items = content?.items || [];
    for (const sub of items) {
      const subResult = sub?.item?.itemContent?.tweet_results?.result;
      if (subResult) {
        const tweet = extractTweetFromResult(subResult);
        if (tweet) results.push(tweet);
      }
    }
  }
  return results;
}
function formatTweetData(tweet) {
  if (!tweet) return null;
  const legacy = tweet.legacy || {};
  const userResult = tweet.core?.user_results?.result || {};
  const userCore = userResult.core || {};
  const fullText = legacy.full_text || "";
  if (!fullText && !legacy.id_str) return null;
  const mediaEntities = legacy.extended_entities?.media || legacy.entities?.media || [];
  let quoteText = null;
  let quoteAuthor = null;
  const qt = tweet.quoted_status_result?.result;
  if (qt) {
    const qtTweet = extractTweetFromResult(qt);
    if (qtTweet?.legacy?.full_text) {
      quoteText = qtTweet.legacy.full_text;
      quoteAuthor = qtTweet.core?.user_results?.result?.core?.screen_name || "unknown";
    }
  }
  return {
    text: fullText,
    author: userCore.name || "",
    handle: userCore.screen_name || "",
    likes: legacy.favorite_count || 0,
    retweets: legacy.retweet_count || 0,
    replies: legacy.reply_count || 0,
    views: tweet.views?.count || null,
    date: legacy.created_at || "",
    id: legacy.id_str || tweet.rest_id || "",
    media: mediaEntities.map((m) => m.type || "photo"),
    quoteText,
    quoteAuthor
  };
}
async function getUserProfile(username) {
  try {
    if (!RAPIDAPI_KEY) return "X/Twitter API not configured (missing API key).";
    const handle = cleanUsername(username);
    const data = await apiFetch("/user", { username: handle });
    const user = data?.result?.data?.user?.result;
    if (!user) return `Could not find X user @${handle}`;
    const core = user.core || {};
    const legacy = user.legacy || {};
    const location = user.location || {};
    const parts = [
      `@${core.screen_name || handle} (${core.name || ""})`,
      legacy.description ? `Bio: ${legacy.description}` : null,
      location.location ? `Location: ${location.location}` : null,
      `Followers: ${(legacy.followers_count || 0).toLocaleString()} | Following: ${(legacy.friends_count || 0).toLocaleString()}`,
      `Tweets: ${(legacy.statuses_count || 0).toLocaleString()} | Likes: ${(legacy.favourites_count || 0).toLocaleString()}`,
      user.is_blue_verified ? "\u2713 Verified" : null,
      core.created_at ? `Joined: ${new Date(core.created_at).toLocaleDateString("en-US", { month: "long", year: "numeric" })}` : null,
      legacy.entities?.url?.urls?.[0]?.expanded_url ? `Website: ${legacy.entities.url.urls[0].expanded_url}` : null,
      `Profile: https://x.com/${core.screen_name || handle}`
    ];
    return parts.filter(Boolean).join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching X profile: ${msg}`;
  }
}
async function getTweet(tweetInput) {
  try {
    if (!RAPIDAPI_KEY) return "X/Twitter API not configured (missing API key).";
    const tweetId = extractTweetId(tweetInput);
    if (!tweetId) return "Please provide a valid tweet URL or tweet ID.";
    const data = await apiFetch("/tweet", { pid: tweetId });
    const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        const rawResult = entry?.content?.itemContent?.tweet_results?.result;
        const tweet = extractTweetFromResult(rawResult);
        const formatted = formatTweetData(tweet);
        if (formatted && (formatted.id === tweetId || entry.entryId?.includes(tweetId))) {
          const parts = [
            `@${formatted.handle} (${formatted.author})`,
            formatted.text,
            "",
            `${formatted.likes.toLocaleString()} likes | ${formatted.retweets.toLocaleString()} retweets | ${formatted.replies.toLocaleString()} replies${formatted.views ? ` | ${Number(formatted.views).toLocaleString()} views` : ""}`,
            formatted.date ? `Posted: ${new Date(formatted.date).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}` : null,
            `Link: https://x.com/${formatted.handle}/status/${formatted.id}`
          ];
          if (formatted.media.length > 0) {
            parts.push(`Media: ${formatted.media.length} attachment(s) (${formatted.media.join(", ")})`);
          }
          if (formatted.quoteText) {
            parts.push("", `Quoting @${formatted.quoteAuthor}:`, formatted.quoteText);
          }
          return parts.filter((p) => p !== null).join("\n");
        }
      }
    }
    return "Tweet not found or may have been deleted.";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching tweet: ${msg}`;
  }
}
var KNOWN_USER_IDS = {
  deltaone: "2704294333",
  unusual_whales: "1200616796295847936",
  sentdefender: "1457867047334031360",
  pmarca: "5943622",
  intelcrab: "3331851939",
  spectatorindex: "1626294277",
  zeynep: "65375759",
  billackman: "880412538625810432",
  elbridgecolby: "443181346",
  adam_tooze: "3311286493",
  reuters: "1652541",
  ap: "51241574",
  bbcbreaking: "5402612",
  business: "34713362",
  cnn: "759251",
  cnbc: "20402945",
  ajenglish: "4970411",
  axios: "800707492346925056",
  politico: "9300262",
  ft: "18949452",
  ianbremmer: "60783724",
  michaelxpettis: "917683048782503937",
  rnaudbertrand: "43061739",
  jkylebass: "3005733012",
  fareedzakaria: "41814169",
  richardhaass: "195826487",
  peterzeihan: "1688796138",
  anneapplebaum: "297100174",
  nouriel: "19224439",
  brankomilan: "990009265",
  bbcworld: "742143",
  nytimes: "807095",
  theeconomist: "5988062",
  foreignpolicy: "26792275",
  foreignaffairs: "21114659",
  guardian: "87818409",
  cfr_org: "17469492",
  france24: "1994321",
  dwnews: "6134882",
  lynaldencontact: "823766058909761536",
  nicktimiraos: "59603406",
  lukegromen: "2936015319",
  josephwang: "718702333",
  raoulgmi: "2453385626",
  biancoresearch: "188369814",
  elerianm: "332617373",
  naval: "745273",
  kobeissiletter: "3316376038",
  balajis: "2178012643",
  wsj: "3108351",
  imfnews: "25098482",
  federalreserve: "26538229",
  bisbank: "90303963",
  markets: "69620713",
  karpathy: "33836629",
  sama: "1605",
  darioamodei: "874126509245476864",
  emollick: "39125788",
  andrewyngcourses: "216939636",
  aravsrinivas: "759894532649545732",
  ylecun: "48008938",
  drjimfan: "1007413134",
  gdb: "162124540",
  alexandr_wang: "615818451",
  wired: "1344951",
  techcrunch: "816653",
  verge: "275686563",
  arstechnica: "717313",
  venturebeat: "60642052",
  newscientist: "19658826",
  saylor: "244647486",
  apompliano: "339061487",
  prestonpysh: "538399586",
  dergigi: "1810407120313221120",
  pete_rizzo_: "341746855",
  bitfinexed: "851583986270957568",
  coindesk: "1333467482",
  cointelegraph: "2207129125",
  theblockcrypto: "916862424325570560",
  bitcoinmagazine: "361289499",
  decryptmedia: "993530753014054912",
  thedefiant: "29531842",
  wublockchain: "111533746",
  cryptobriefing: "1430225550"
};
var userIdCache = /* @__PURE__ */ new Map();
var USER_ID_CACHE_TTL = 24 * 60 * 60 * 1e3;
async function resolveUserId(username) {
  const key = username.toLowerCase();
  const known = KNOWN_USER_IDS[key];
  if (known) return known;
  const cached2 = userIdCache.get(key);
  if (cached2 && Date.now() - cached2.ts < USER_ID_CACHE_TTL) return cached2.id;
  try {
    const data = await apiFetch("/user", { username });
    const id = data?.result?.data?.user?.result?.rest_id || null;
    userIdCache.set(key, { id, ts: Date.now() });
    return id;
  } catch (err) {
    if (cached2) return cached2.id;
    return null;
  }
}
async function getUserTimelineStructured(username, count = 5) {
  try {
    if (!RAPIDAPI_KEY) return [];
    const handle = cleanUsername(username);
    const maxTweets = Math.min(count, 20);
    const userId = await resolveUserId(handle);
    if (!userId) return [];
    const data = await apiFetch("/user-tweets", { user: userId, count: String(maxTweets) });
    const instructions = data?.result?.timeline?.instructions || [];
    const tweets = [];
    const seen = /* @__PURE__ */ new Set();
    for (const inst of instructions) {
      const allTweets = extractTweetsFromEntries(inst.entries || []);
      for (const tweet of allTweets) {
        const formatted = formatTweetData(tweet);
        if (formatted && !seen.has(formatted.id) && !formatted.text.startsWith("RT @")) {
          seen.add(formatted.id);
          tweets.push({
            text: formatted.text.slice(0, 280),
            author: formatted.author,
            handle: formatted.handle,
            likes: formatted.likes,
            retweets: formatted.retweets,
            views: formatted.views,
            date: formatted.date,
            id: formatted.id
          });
          if (tweets.length >= maxTweets) break;
        }
      }
      if (tweets.length >= maxTweets) break;
    }
    return tweets;
  } catch {
    return [];
  }
}
async function getUserTimeline(username, count = 10) {
  try {
    if (!RAPIDAPI_KEY) return "X/Twitter API not configured (missing API key).";
    const handle = cleanUsername(username);
    const maxTweets = Math.min(count, 20);
    const userId = await resolveUserId(handle);
    if (!userId) return `Could not find X user @${handle}`;
    const data = await apiFetch("/user-tweets", { user: userId, count: String(maxTweets) });
    const instructions = data?.result?.timeline?.instructions || [];
    const tweets = [];
    const seen = /* @__PURE__ */ new Set();
    for (const inst of instructions) {
      const allTweets = extractTweetsFromEntries(inst.entries || []);
      for (const tweet of allTweets) {
        const formatted = formatTweetData(tweet);
        if (formatted && !seen.has(formatted.id) && !formatted.text.startsWith("RT @")) {
          seen.add(formatted.id);
          tweets.push(formatted);
          if (tweets.length >= maxTweets) break;
        }
      }
      if (tweets.length >= maxTweets) break;
    }
    if (tweets.length === 0) return `No recent tweets found for @${handle}. The account may be private or have no recent activity.`;
    const lines = tweets.map((t, i) => {
      if (!t) return "";
      const dateStr = t.date ? new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
      const stats = `${t.likes.toLocaleString()} likes | ${t.retweets.toLocaleString()} RTs${t.views ? ` | ${Number(t.views).toLocaleString()} views` : ""}`;
      return `${i + 1}. @${t.handle} \u2014 ${dateStr}
   ${t.text.slice(0, 280)}${t.text.length > 280 ? "..." : ""}
   ${stats} | https://x.com/${t.handle}/status/${t.id}`;
    });
    return `Recent tweets from @${handle}:

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching timeline: ${msg}`;
  }
}
async function searchTweets(query, count = 10, type = "Latest") {
  try {
    if (!RAPIDAPI_KEY) return "X/Twitter API not configured (missing API key).";
    const maxResults = Math.min(count, 20);
    const data = await apiFetch("/search", { query, count: String(maxResults), type });
    const instructions = data?.result?.timeline?.instructions || [];
    const tweets = [];
    const seen = /* @__PURE__ */ new Set();
    for (const inst of instructions) {
      const allTweets = extractTweetsFromEntries(inst.entries || []);
      for (const tweet of allTweets) {
        const formatted = formatTweetData(tweet);
        if (formatted && !seen.has(formatted.id)) {
          seen.add(formatted.id);
          tweets.push(formatted);
          if (tweets.length >= maxResults) break;
        }
      }
      if (tweets.length >= maxResults) break;
    }
    if (tweets.length === 0) return `No tweets found matching "${query}".`;
    const lines = tweets.map((t, i) => {
      if (!t) return "";
      const dateStr = t.date ? new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
      const stats = `${t.likes.toLocaleString()} likes | ${t.retweets.toLocaleString()} RTs${t.views ? ` | ${Number(t.views).toLocaleString()} views` : ""}`;
      let line = `${i + 1}. @${t.handle} \u2014 ${dateStr}
   ${t.text.slice(0, 280)}${t.text.length > 280 ? "..." : ""}
   ${stats} | https://x.com/${t.handle}/status/${t.id}`;
      if (t.quoteText) {
        line += `
   \u21B3 Quoting @${t.quoteAuthor}: ${t.quoteText.slice(0, 150)}${(t.quoteText.length || 0) > 150 ? "..." : ""}`;
      }
      return line;
    });
    return `X search results for "${query}" (${type}):

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error searching X: ${msg}`;
  }
}

// src/stocks.ts
var TIMEOUT_MS2 = 1e4;
var CRYPTO_ALIASES = {
  btc: "bitcoin",
  bitcoin: "bitcoin",
  eth: "ethereum",
  ethereum: "ethereum",
  sol: "solana",
  solana: "solana",
  doge: "dogecoin",
  dogecoin: "dogecoin",
  ada: "cardano",
  cardano: "cardano",
  xrp: "ripple",
  ripple: "ripple",
  dot: "polkadot",
  polkadot: "polkadot",
  matic: "matic-network",
  polygon: "matic-network",
  avax: "avalanche-2",
  avalanche: "avalanche-2",
  link: "chainlink",
  chainlink: "chainlink",
  bnb: "binancecoin",
  binancecoin: "binancecoin",
  ltc: "litecoin",
  litecoin: "litecoin",
  shib: "shiba-inu",
  uni: "uniswap",
  uniswap: "uniswap",
  atom: "cosmos",
  cosmos: "cosmos",
  near: "near",
  apt: "aptos",
  aptos: "aptos",
  arb: "arbitrum",
  arbitrum: "arbitrum",
  op: "optimism",
  optimism: "optimism",
  sui: "sui",
  pepe: "pepe"
};
async function fetchWithTimeout(url, headers2 = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS2);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "pi-assistant/1.0", ...headers2 },
      signal: controller.signal
    });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Request timed out");
    throw err;
  }
}
function formatNum(n) {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
function formatPrice(n) {
  if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${n.toFixed(6)}`;
}
async function getStockQuote(symbol) {
  try {
    const ticker = symbol.toUpperCase().trim();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d&includePrePost=false`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      if (res.status === 404) return `Could not find stock symbol "${ticker}". Try using the ticker symbol (e.g. AAPL, TSLA, MSFT).`;
      throw new Error(`Yahoo Finance error ${res.status}`);
    }
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return `No data found for "${ticker}".`;
    const meta = result.meta;
    const price = meta.regularMarketPrice;
    if (price == null) return `No price data available for "${ticker}". The market may be closed or the symbol may be invalid.`;
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const currency = meta.currency || "USD";
    const exchange = meta.exchangeName || "";
    const name = meta.shortName || meta.longName || ticker;
    const change = prevClose ? price - prevClose : 0;
    const changePct = prevClose ? change / prevClose * 100 : 0;
    const arrow = change >= 0 ? "\u25B2" : "\u25BC";
    const sign = change >= 0 ? "+" : "";
    const indicators = result.indicators?.quote?.[0];
    const volumes = indicators?.volume || [];
    const lastVolume = volumes.filter((v) => v != null).pop();
    const lines = [
      `${name} (${ticker}) \u2014 ${exchange}`,
      `Price: ${formatPrice(price)} ${currency}`,
      `Change: ${sign}${change.toFixed(2)} (${sign}${changePct.toFixed(2)}%) ${arrow}`
    ];
    if (prevClose) lines.push(`Prev Close: ${formatPrice(prevClose)}`);
    const timestamps = result.timestamp || [];
    const closes = indicators?.close || [];
    if (timestamps.length > 0 && closes.length > 0) {
      const highs = indicators?.high || [];
      const lows = indicators?.low || [];
      const lastIdx = closes.length - 1;
      if (highs[lastIdx] != null && lows[lastIdx] != null) lines.push(`Day Range: ${formatPrice(lows[lastIdx])} \u2013 ${formatPrice(highs[lastIdx])}`);
    }
    if (lastVolume) lines.push(`Volume: ${lastVolume.toLocaleString("en-US")}`);
    const marketState = meta.marketState || "";
    if (marketState && marketState !== "REGULAR") {
      lines.push(`Market: ${marketState.replace(/_/g, " ").toLowerCase()}`);
    }
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Stock quote error:", msg);
    return `Unable to get stock quote for "${symbol}": ${msg}`;
  }
}
async function getCryptoPrice(coin) {
  try {
    const input = coin.toLowerCase().trim();
    const coinId = CRYPTO_ALIASES[input] || input;
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      if (res.status === 404) {
        const searchUrl = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(input)}`;
        const searchRes = await fetchWithTimeout(searchUrl);
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          const coins = searchData.coins?.slice(0, 5);
          if (coins?.length > 0) {
            const suggestions = coins.map((c) => `${c.name} (${c.symbol.toUpperCase()})`).join(", ");
            return `Could not find "${coin}". Did you mean: ${suggestions}?`;
          }
        }
        return `Could not find cryptocurrency "${coin}". Try using the full name (e.g. "bitcoin") or ticker (e.g. "BTC").`;
      }
      throw new Error(`CoinGecko error ${res.status}`);
    }
    const data = await res.json();
    const market = data.market_data;
    if (!market) return `No market data for "${coin}".`;
    const price = market.current_price?.usd;
    if (price == null) return `No price data available for "${coin}".`;
    const change24h = market.price_change_percentage_24h;
    const change7d = market.price_change_percentage_7d;
    const marketCap = market.market_cap?.usd;
    const volume24h = market.total_volume?.usd;
    const high24h = market.high_24h?.usd;
    const low24h = market.low_24h?.usd;
    const ath = market.ath?.usd;
    const athChange = market.ath_change_percentage?.usd;
    const rank = data.market_cap_rank;
    const lines = [
      `${data.name} (${data.symbol.toUpperCase()})${rank ? ` \u2014 Rank #${rank}` : ""}`,
      `Price: ${formatPrice(price)}`
    ];
    if (change24h != null) {
      const arrow24 = change24h >= 0 ? "\u25B2" : "\u25BC";
      const sign24 = change24h >= 0 ? "+" : "";
      lines.push(`24h Change: ${sign24}${change24h.toFixed(2)}% ${arrow24}`);
    }
    if (change7d != null) {
      const sign7 = change7d >= 0 ? "+" : "";
      lines.push(`7d Change: ${sign7}${change7d.toFixed(2)}%`);
    }
    if (high24h != null && low24h != null) lines.push(`24h Range: ${formatPrice(low24h)} \u2013 ${formatPrice(high24h)}`);
    if (marketCap) lines.push(`Market Cap: ${formatNum(marketCap)}`);
    if (volume24h) lines.push(`24h Volume: ${formatNum(volume24h)}`);
    if (ath != null && athChange != null) lines.push(`ATH: ${formatPrice(ath)} (${athChange.toFixed(1)}% from ATH)`);
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Crypto price error:", msg);
    return `Unable to get crypto price for "${coin}": ${msg}`;
  }
}

// server.ts
init_coingecko();
init_coingecko();
init_technical_signals();

// src/nansen.ts
import * as fs3 from "fs";
import * as path3 from "path";
var NANSEN_API_KEY = process.env.NANSEN_API_KEY || "";
var BASE_URL2 = "https://api.nansen.ai/v1";
var CACHE_DIR2 = path3.join(process.env.HOME || "/tmp", ".cache", "nansen");
var TIMEOUT_MS4 = 15e3;
var CACHE_TTL = {
  smart_money: 30 * 60 * 1e3,
  token_holders: 60 * 60 * 1e3,
  hot_contracts: 15 * 60 * 1e3
};
function ensureCacheDir2() {
  if (!fs3.existsSync(CACHE_DIR2)) {
    fs3.mkdirSync(CACHE_DIR2, { recursive: true });
  }
}
function getCached(key, ttlMs) {
  ensureCacheDir2();
  const cacheFile = path3.join(CACHE_DIR2, `${key}.json`);
  if (!fs3.existsSync(cacheFile)) return null;
  try {
    const raw = fs3.readFileSync(cacheFile, "utf-8");
    const entry = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt < ttlMs) return entry.data;
  } catch {
  }
  return null;
}
function setCache(key, data) {
  ensureCacheDir2();
  const cacheFile = path3.join(CACHE_DIR2, `${key}.json`);
  try {
    fs3.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), data }));
  } catch (err) {
    console.warn("[nansen] cache write error:", err);
  }
}
function isConfigured5() {
  return NANSEN_API_KEY.length > 0;
}
async function nansenFetch(endpoint) {
  if (!isConfigured5()) {
    throw new Error("Nansen API key not configured. Set NANSEN_API_KEY environment variable.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS4);
  try {
    const url = `${BASE_URL2}${endpoint}`;
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${NANSEN_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "darknode/1.0"
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Nansen API error ${res.status}: ${text}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Nansen request timed out");
    throw err;
  }
}
async function getSmartMoneyFlow(token) {
  const cacheKey = `smart_money_${token.toLowerCase()}`;
  const cached2 = getCached(cacheKey, CACHE_TTL.smart_money);
  if (cached2) return cached2;
  if (!isConfigured5()) {
    return {
      token,
      net_flow_usd: 0,
      inflow_usd: 0,
      outflow_usd: 0,
      smart_money_wallets_buying: 0,
      smart_money_wallets_selling: 0,
      direction: "neutral",
      confidence: "low"
    };
  }
  try {
    const data = await nansenFetch(`/smart-money/token/${encodeURIComponent(token)}`);
    const result = {
      token,
      net_flow_usd: data.net_flow_usd || 0,
      inflow_usd: data.inflow_usd || 0,
      outflow_usd: data.outflow_usd || 0,
      smart_money_wallets_buying: data.wallets_buying || 0,
      smart_money_wallets_selling: data.wallets_selling || 0,
      direction: (data.net_flow_usd || 0) > 0 ? "inflow" : (data.net_flow_usd || 0) < 0 ? "outflow" : "neutral",
      confidence: Math.abs(data.net_flow_usd || 0) > 1e6 ? "high" : Math.abs(data.net_flow_usd || 0) > 1e5 ? "medium" : "low"
    };
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[nansen] smart money flow failed for ${token}:`, err instanceof Error ? err.message : err);
    return {
      token,
      net_flow_usd: 0,
      inflow_usd: 0,
      outflow_usd: 0,
      smart_money_wallets_buying: 0,
      smart_money_wallets_selling: 0,
      direction: "neutral",
      confidence: "low"
    };
  }
}
async function getTokenHolders(token) {
  const cacheKey = `token_holders_${token.toLowerCase()}`;
  const cached2 = getCached(cacheKey, CACHE_TTL.token_holders);
  if (cached2) return cached2;
  if (!isConfigured5()) {
    return {
      token,
      total_holders: 0,
      whale_holders: 0,
      whale_concentration_pct: 0,
      holder_change_24h: 0,
      whale_activity: "stable"
    };
  }
  try {
    const data = await nansenFetch(`/token/${encodeURIComponent(token)}/holders`);
    const result = {
      token,
      total_holders: data.total_holders || 0,
      whale_holders: data.whale_holders || 0,
      whale_concentration_pct: data.whale_concentration_pct || 0,
      holder_change_24h: data.holder_change_24h || 0,
      whale_activity: (data.holder_change_24h || 0) > 5 ? "accumulating" : (data.holder_change_24h || 0) < -5 ? "distributing" : "stable"
    };
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[nansen] token holders failed for ${token}:`, err instanceof Error ? err.message : err);
    return {
      token,
      total_holders: 0,
      whale_holders: 0,
      whale_concentration_pct: 0,
      holder_change_24h: 0,
      whale_activity: "stable"
    };
  }
}
async function getHotContracts(chain = "ethereum", limit = 10) {
  const cacheKey = `hot_contracts_${chain.toLowerCase()}`;
  const cached2 = getCached(cacheKey, CACHE_TTL.hot_contracts);
  if (cached2) return cached2;
  if (!isConfigured5()) {
    return [];
  }
  try {
    const data = await nansenFetch(`/hot-contracts?chain=${encodeURIComponent(chain)}&limit=${limit}`);
    const contracts = (data.contracts || []).map((c) => ({
      address: c.address || "",
      name: c.name || "Unknown",
      chain: c.chain || chain,
      interaction_count_24h: c.interaction_count_24h || 0,
      unique_wallets_24h: c.unique_wallets_24h || 0,
      smart_money_interactions: c.smart_money_interactions || 0,
      category: c.category || "unknown"
    }));
    setCache(cacheKey, contracts);
    return contracts;
  } catch (err) {
    console.error(`[nansen] hot contracts failed for ${chain}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

// server.ts
init_signal_sources();

// src/backtest.ts
init_technical_signals();
var DEFAULT_BACKTEST_CONFIG = {
  ema_fast: 7,
  ema_slow: 26,
  rsi_period: 8,
  rsi_overbought: 69,
  rsi_oversold: 31,
  momentum_lookback: 12,
  very_short_momentum_lookback: 6,
  macd_fast: 14,
  macd_slow: 23,
  macd_signal: 9,
  bb_period: 7,
  bb_percentile_threshold: 90,
  vol_lookback_bars: 24,
  atr_period: 14,
  atr_stop_multiplier: 5.5,
  vote_threshold: 4,
  cooldown_bars: 2,
  enable_ema: true,
  enable_rsi: true,
  enable_momentum: true,
  enable_very_short_momentum: true,
  enable_macd: true,
  enable_bb: true,
  enable_volatility_regime: true
};
function getVotesAtBar(closes, barIdx, cfg) {
  const slice = closes.slice(0, barIdx + 1);
  if (slice.length < 30) return { bull: 0, bear: 0, rsiOB: false, rsiOS: false };
  const signals = [
    computeEMACrossover(slice, cfg),
    computeRSI(slice, cfg),
    computeMomentum(slice, cfg),
    computeVeryShortMomentum(slice, cfg),
    computeMACD(slice, cfg),
    computeBBWidth(slice, cfg)
  ];
  let bull = 0, bear = 0;
  let rsiOB = false, rsiOS = false;
  for (const s of signals) {
    if (!s.enabled) continue;
    if (s.bull_vote) bull++;
    if (s.bear_vote) bear++;
  }
  const rsiSig = signals.find((s) => s.name === "rsi" && s.enabled);
  if (rsiSig) {
    const rsiResult = computeRSI(slice, cfg);
    rsiOB = rsiResult.rsi_value >= cfg.rsi_overbought;
    rsiOS = rsiResult.rsi_value <= cfg.rsi_oversold;
  }
  return { bull, bear, rsiOB, rsiOS };
}
function runBacktest(candles, assetName, config3) {
  const cfg = { ...DEFAULT_BACKTEST_CONFIG, ...config3 };
  const closes = candles.map((c) => c.close);
  const trades = [];
  const minBars = Math.max(cfg.ema_slow + 10, cfg.bb_period + 50, cfg.macd_slow + cfg.macd_signal + 5);
  if (closes.length < minBars) {
    return {
      asset: assetName,
      period_days: Math.round(closes.length / 24),
      total_bars: closes.length,
      total_trades: 0,
      winning_trades: 0,
      losing_trades: 0,
      win_rate: 0,
      total_return_pct: 0,
      max_drawdown_pct: 0,
      sharpe_ratio: 0,
      avg_bars_held: 0,
      nunchi_score: 0,
      trades: [],
      parameters_used: config3 || {}
    };
  }
  let inPosition = false;
  let entryBar = 0;
  let entryPrice = 0;
  let peakPrice = 0;
  let lastExitBar = -cfg.cooldown_bars - 1;
  for (let i = minBars; i < closes.length; i++) {
    const price = closes[i];
    if (inPosition) {
      if (price > peakPrice) peakPrice = price;
      const atr = computeATR(candles.slice(0, i + 1), cfg.atr_period);
      const stopPrice = peakPrice - atr * cfg.atr_stop_multiplier;
      const { rsiOB } = getVotesAtBar(closes, i, cfg);
      let exitReason = null;
      if (price <= stopPrice) exitReason = "stop_loss";
      else if (rsiOB) exitReason = "rsi_exit";
      if (exitReason) {
        const pnl_pct = (price - entryPrice) / entryPrice * 100;
        trades.push({
          entry_bar: entryBar,
          exit_bar: i,
          entry_price: entryPrice,
          exit_price: price,
          direction: "LONG",
          pnl_pct,
          exit_reason: exitReason,
          bars_held: i - entryBar
        });
        inPosition = false;
        lastExitBar = i;
      }
    } else {
      if (i - lastExitBar < cfg.cooldown_bars) continue;
      const { bull } = getVotesAtBar(closes, i, cfg);
      if (bull >= cfg.vote_threshold) {
        inPosition = true;
        entryBar = i;
        entryPrice = price;
        peakPrice = price;
      }
    }
  }
  if (inPosition) {
    const lastPrice = closes[closes.length - 1];
    const pnl_pct = (lastPrice - entryPrice) / entryPrice * 100;
    trades.push({
      entry_bar: entryBar,
      exit_bar: closes.length - 1,
      entry_price: entryPrice,
      exit_price: lastPrice,
      direction: "LONG",
      pnl_pct,
      exit_reason: "end_of_data",
      bars_held: closes.length - 1 - entryBar
    });
  }
  const winningTrades = trades.filter((t) => t.pnl_pct > 0);
  const losingTrades = trades.filter((t) => t.pnl_pct <= 0);
  const winRate = trades.length > 0 ? winningTrades.length / trades.length : 0;
  const totalReturnPct = trades.reduce((sum, t) => sum + t.pnl_pct, 0);
  const returns = trades.map((t) => t.pnl_pct / 100);
  let maxDD = 0;
  let peak = 1;
  let equity = 1;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  const maxDrawdownPct = maxDD * 100;
  let sharpe = 0;
  if (returns.length > 1) {
    const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);
    if (stdDev > 0) {
      sharpe = meanReturn / stdDev * Math.sqrt(252);
    }
  }
  const avgBarsHeld = trades.length > 0 ? trades.reduce((s, t) => s + t.bars_held, 0) / trades.length : 0;
  const tradeCountFactor = Math.min(trades.length / 10, 1);
  const drawdownPenalty = maxDrawdownPct > 20 ? (maxDrawdownPct - 20) * 0.1 : 0;
  const turnoverPenalty = trades.length > 50 ? (trades.length - 50) * 0.01 : 0;
  const nunchiScore = sharpe * Math.sqrt(tradeCountFactor) - drawdownPenalty - turnoverPenalty;
  return {
    asset: assetName,
    period_days: Math.round(closes.length / 24),
    total_bars: closes.length,
    total_trades: trades.length,
    winning_trades: winningTrades.length,
    losing_trades: losingTrades.length,
    win_rate: parseFloat(winRate.toFixed(3)),
    total_return_pct: parseFloat(totalReturnPct.toFixed(2)),
    max_drawdown_pct: parseFloat(maxDrawdownPct.toFixed(2)),
    sharpe_ratio: parseFloat(sharpe.toFixed(3)),
    avg_bars_held: parseFloat(avgBarsHeld.toFixed(1)),
    nunchi_score: parseFloat(nunchiScore.toFixed(3)),
    trades,
    parameters_used: config3 || {}
  };
}

// server.ts
init_crypto_scout();
init_polymarket();

// src/polymarket-scout.ts
init_db();
var PM_THESIS_EXPIRY_MS = 72 * 60 * 60 * 1e3;
function createPMThesisId(marketSlug) {
  const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, "_");
  const rand = Math.random().toString(36).slice(2, 8);
  const slug = marketSlug.replace(/[^a-z0-9]/gi, "_").slice(0, 20);
  return `pm_${date}_${slug}_${rand}`;
}
async function getActiveTheses2() {
  const pool2 = getPool();
  try {
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      const now = Date.now();
      return res.rows[0].value.filter((t) => t.status === "active" && t.expires_at > now);
    }
  } catch (err) {
    console.error("[polymarket-scout] getActiveTheses error:", err);
  }
  return [];
}
async function saveTheses2(theses) {
  const pool2 = getPool();
  const existing = await getActiveTheses2();
  const now = Date.now();
  const activeExisting = existing.filter((t) => t.expires_at > now && t.status === "active");
  const newMarketIds = new Set(theses.map((t) => t.market_id));
  const kept = activeExisting.filter((t) => !newMarketIds.has(t.market_id));
  const merged = [...kept, ...theses];
  await pool2.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('polymarket_scout_active_theses', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(merged), Date.now()]
  );
}
async function retireThesis2(thesisId) {
  const pool2 = getPool();
  const theses = await getActiveTheses2();
  const updated = theses.map((t) => t.id === thesisId ? { ...t, status: "retired" } : t);
  await pool2.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('polymarket_scout_active_theses', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(updated), Date.now()]
  );
}
function buildThesis2(params) {
  const now = Date.now();
  const market = params.market;
  const yesPrice = market.tokens.find((t) => t.outcome === "Yes")?.price || 0;
  const noPrice = market.tokens.find((t) => t.outcome === "No")?.price || 0;
  const currentOdds = params.direction === "YES" ? yesPrice : noPrice;
  const entryOdds = currentOdds;
  const exitOdds = params.direction === "YES" ? Math.min(currentOdds + 0.15, 0.95) : Math.max(currentOdds - 0.15, 0.05);
  return {
    id: createPMThesisId(market.market_slug),
    asset: market.question,
    asset_class: "polymarket",
    market_id: market.condition_id,
    market_slug: market.market_slug,
    direction: params.direction,
    confidence: params.confidence,
    current_odds: parseFloat(currentOdds.toFixed(3)),
    entry_odds: parseFloat(entryOdds.toFixed(3)),
    exit_odds: parseFloat(exitOdds.toFixed(3)),
    whale_consensus: params.whale_consensus,
    whale_wallets: params.whale_wallets,
    whale_avg_score: params.whale_avg_score,
    total_whale_amount: params.total_whale_amount,
    volume: market.volume,
    liquidity: market.liquidity,
    end_date: market.end_date_iso,
    category: market.category,
    sources: params.sources,
    reasoning: params.reasoning,
    created_at: now,
    expires_at: now + PM_THESIS_EXPIRY_MS,
    status: "active"
  };
}
async function meetsThesisThresholds(params) {
  const failures = [];
  const passed = [];
  const oddsInRange = params.odds >= 0.15 && params.odds <= 0.85;
  const oddsInTightRange = params.odds >= 0.3 && params.odds <= 0.7;
  const volumeAbove50K = params.market_volume >= 5e4;
  const volumeAbove100K = params.market_volume >= 1e5;
  const volumeAbove500K = params.market_volume >= 5e5;
  const minResolution = volumeAbove100K ? 12 : 24;
  const resolutionOk = params.hours_to_resolution >= minResolution;
  if (!oddsInRange) failures.push(`Odds ${(params.odds * 100).toFixed(0)}% outside 15-85% range`);
  else passed.push(`Odds ${(params.odds * 100).toFixed(0)}% in range`);
  if (!resolutionOk) failures.push(`Resolution in ${params.hours_to_resolution.toFixed(0)}h < ${minResolution}h minimum`);
  else passed.push(`Resolution ${params.hours_to_resolution.toFixed(0)}h >= ${minResolution}h`);
  if (!volumeAbove50K) failures.push(`Volume $${params.market_volume.toFixed(0)} < $50,000`);
  else passed.push(`Volume $${params.market_volume.toFixed(0)}`);
  if (!oddsInRange || !resolutionOk || !volumeAbove50K) {
    console.log(`[pm-scout] Threshold REJECT: ${failures.join("; ")}`);
    return { meets: false, tier: null, failures, passed };
  }
  if (params.whale_consensus >= 3 && params.whale_score >= 0.8) {
    passed.push(`Strong whale consensus: ${params.whale_consensus} whales, score ${params.whale_score.toFixed(2)}`);
    console.log(`[pm-scout] Threshold PASS (HIGH): ${passed.join("; ")}`);
    return { meets: true, tier: "HIGH", failures: [], passed };
  }
  if (params.whale_consensus >= 2 && params.whale_score >= 0.5) {
    passed.push(`Whale consensus: ${params.whale_consensus} whales, score ${params.whale_score.toFixed(2)}`);
    console.log(`[pm-scout] Threshold PASS (MEDIUM): ${passed.join("; ")}`);
    return { meets: true, tier: "MEDIUM", failures: [], passed };
  }
  if (params.whale_consensus >= 1 && params.whale_score >= 0.7) {
    passed.push(`Single whale signal: score ${params.whale_score.toFixed(2)}`);
    console.log(`[pm-scout] Threshold PASS (SPECULATIVE): ${passed.join("; ")}`);
    return { meets: true, tier: "SPECULATIVE", failures: [], passed };
  }
  if (volumeAbove500K && oddsInTightRange && params.whale_consensus === 0) {
    passed.push(`Volume-weighted fallback: $${(params.market_volume / 1e3).toFixed(0)}K volume, ${(params.odds * 100).toFixed(0)}% odds (high uncertainty edge)`);
    console.log(`[pm-scout] Threshold PASS (LOW): ${passed.join("; ")}`);
    return { meets: true, tier: "LOW", failures: [], passed };
  }
  failures.push(`Whale consensus ${params.whale_consensus} whales, score ${params.whale_score.toFixed(2)} \u2014 insufficient for any tier`);
  if (!volumeAbove500K && params.whale_consensus === 0) {
    failures.push(`Volume $${params.market_volume.toFixed(0)} < $500K for volume-only fallback`);
  }
  if (!oddsInTightRange && params.whale_consensus === 0) {
    failures.push(`Odds ${(params.odds * 100).toFixed(0)}% outside 30-70% for volume-only fallback`);
  }
  console.log(`[pm-scout] Threshold REJECT: ${failures.join("; ")}`);
  return { meets: false, tier: null, failures, passed };
}

// server.ts
init_bankr();

// src/maps.ts
var TIMEOUT_MS5 = 1e4;
var NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
var OSRM_BASE = "https://router.project-osrm.org";
var UA = "pi-assistant/1.0 (personal-project)";
async function fetchWithTimeout2(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS5);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: controller.signal
    });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Request timed out");
    throw err;
  }
}
async function geocode2(query) {
  const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`;
  const res = await fetchWithTimeout2(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;
  const r = data[0];
  return {
    name: r.name || r.display_name.split(",")[0],
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    displayName: r.display_name
  };
}
function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.round(seconds % 3600 / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins} min`;
}
function formatDistance(meters) {
  const miles = meters / 1609.34;
  if (miles >= 1) return `${miles.toFixed(1)} miles`;
  const feet = meters * 3.281;
  return `${Math.round(feet)} ft`;
}
function cleanInstruction(html) {
  return html.replace(/<[^>]+>/g, "").trim();
}
async function getDirections(from, to, mode) {
  try {
    const travelMode = (mode || "driving").toLowerCase();
    const osrmProfile = travelMode === "walking" || travelMode === "walk" ? "foot" : travelMode === "cycling" || travelMode === "bike" || travelMode === "bicycle" ? "bike" : "car";
    const [originGeo, destGeo] = await Promise.all([geocode2(from), geocode2(to)]);
    if (!originGeo) return `Could not find location "${from}". Try being more specific (e.g. include city/state).`;
    if (!destGeo) return `Could not find location "${to}". Try being more specific (e.g. include city/state).`;
    const url = `${OSRM_BASE}/route/v1/${osrmProfile === "car" ? "driving" : osrmProfile}/${originGeo.lon},${originGeo.lat};${destGeo.lon},${destGeo.lat}?overview=false&steps=true&geometries=geojson`;
    const res = await fetchWithTimeout2(url);
    if (!res.ok) throw new Error(`Routing error ${res.status}`);
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes?.length) {
      return `No route found from "${from}" to "${to}" by ${travelMode}. The locations may be on different continents or unreachable.`;
    }
    const route = data.routes[0];
    const totalDist = formatDistance(route.distance);
    const totalTime = formatDuration(route.duration);
    const lines = [
      `Directions from ${originGeo.name} to ${destGeo.name}`,
      `Mode: ${travelMode.charAt(0).toUpperCase() + travelMode.slice(1)}`,
      `Distance: ${totalDist}`,
      `Estimated time: ${totalTime}`,
      ""
    ];
    const steps = route.legs?.[0]?.steps || [];
    const significantSteps = steps.filter((s) => s.distance > 30 && s.maneuver?.type !== "arrive" && s.maneuver?.type !== "depart");
    const displaySteps = significantSteps.slice(0, 15);
    if (displaySteps.length > 0) {
      lines.push("Route:");
      displaySteps.forEach((step, i) => {
        const instruction = cleanInstruction(step.name || step.maneuver?.type || "Continue");
        const dist = formatDistance(step.distance);
        const modifier = step.maneuver?.modifier ? ` ${step.maneuver.modifier}` : "";
        const type = step.maneuver?.type || "";
        const action = type === "turn" ? `Turn${modifier}` : type === "merge" ? `Merge${modifier}` : type === "fork" ? `Take${modifier} fork` : type === "roundabout" ? "Enter roundabout" : type === "new name" ? "Continue" : type.charAt(0).toUpperCase() + type.slice(1);
        lines.push(`  ${i + 1}. ${action} onto ${instruction} (${dist})`);
      });
      if (significantSteps.length > 15) {
        lines.push(`  ... and ${significantSteps.length - 15} more steps`);
      }
    }
    lines.push("", `From: ${originGeo.displayName}`);
    lines.push(`To: ${destGeo.displayName}`);
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Directions error:", msg);
    return `Unable to get directions: ${msg}`;
  }
}
async function searchPlaces(query, near) {
  try {
    let url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(query)}&format=json&limit=8&addressdetails=1`;
    if (near) {
      const geo = await geocode2(near);
      if (geo) {
        const viewbox = `${geo.lon - 0.1},${geo.lat + 0.1},${geo.lon + 0.1},${geo.lat - 0.1}`;
        url += `&viewbox=${viewbox}&bounded=0`;
      }
    }
    const res = await fetchWithTimeout2(url);
    if (!res.ok) throw new Error(`Places search error ${res.status}`);
    const data = await res.json();
    if (!data.length) return `No places found for "${query}"${near ? ` near ${near}` : ""}.`;
    const lines = data.map((place, i) => {
      const name = place.name || place.display_name.split(",")[0];
      const type = place.type ? place.type.replace(/_/g, " ") : "";
      const address = place.display_name;
      return `${i + 1}. ${name}${type ? ` (${type})` : ""}
   ${address}`;
    });
    const header = near ? `Places matching "${query}" near ${near}:` : `Places matching "${query}":`;
    return `${header}

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Places search error:", msg);
    return `Unable to search places: ${msg}`;
  }
}

// src/gws.ts
import { execFile } from "child_process";
import path4 from "path";
var GWS_BIN = path4.join(process.cwd(), "bin", "gws");
var TIMEOUT_MS6 = 15e3;
function parseHexColor(hex) {
  return {
    red: parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue: parseInt(hex.slice(5, 7), 16) / 255
  };
}
async function runGws(args) {
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, data: null, raw: "Google not connected \u2014 visit /api/gmail/auth to connect" };
  }
  return new Promise((resolve) => {
    const env = { ...process.env, GOOGLE_WORKSPACE_CLI_TOKEN: token };
    execFile(GWS_BIN, args, { env, timeout: TIMEOUT_MS6, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const errMsg = [stderr, stdout, err.message].filter(Boolean).join("\n").trim() || "Unknown error";
        console.error(`[gws] Error running: gws ${args.join(" ")}`, errMsg);
        if (errMsg.includes("401") || errMsg.includes("Unauthorized") || errMsg.includes("invalid_credentials")) {
          resolve({ ok: false, data: null, raw: "Google authorization expired \u2014 visit /api/gmail/auth to reconnect" });
          return;
        }
        if (errMsg.includes("403") || errMsg.includes("Forbidden") || errMsg.includes("insufficient")) {
          resolve({ ok: false, data: null, raw: "Insufficient permissions \u2014 visit /api/gmail/auth to reconnect with required scopes" });
          return;
        }
        resolve({ ok: false, data: null, raw: `Error: ${errMsg.slice(0, 1e3)}` });
        return;
      }
      const output = stdout.trim();
      try {
        const data = JSON.parse(output);
        resolve({ ok: true, data, raw: output });
      } catch {
        resolve({ ok: false, data: null, raw: output });
      }
    });
  });
}
async function driveList(query, pageSize = 20) {
  const params = {
    pageSize,
    fields: "files(id,name,mimeType,modifiedTime,size,parents,webViewLink)",
    orderBy: "modifiedTime desc"
  };
  if (query) params.q = query;
  const args = ["drive", "files", "list", "--params", JSON.stringify(params)];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const files = result.data?.files;
  if (!files || files.length === 0) return query ? `No files found matching query.` : "No files in Drive.";
  const lines = files.map((f, i) => {
    const type = f.mimeType === "application/vnd.google-apps.folder" ? "\u{1F4C1}" : f.mimeType === "application/vnd.google-apps.spreadsheet" ? "\u{1F4CA}" : f.mimeType === "application/vnd.google-apps.document" ? "\u{1F4C4}" : f.mimeType === "application/vnd.google-apps.presentation" ? "\u{1F4FD}\uFE0F" : "\u{1F4CE}";
    const modified = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
    return `${i + 1}. ${type} ${f.name}
   ID: ${f.id}
   Modified: ${modified}${f.webViewLink ? `
   Link: ${f.webViewLink}` : ""}`;
  });
  return `Drive files (${files.length}):

${lines.join("\n\n")}`;
}
async function driveGet(fileId) {
  const args = ["drive", "files", "get", "--params", JSON.stringify({ fileId, fields: "id,name,mimeType,modifiedTime,size,parents,webViewLink,description,owners,shared" })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const f = result.data;
  if (!f) return "File not found.";
  const lines = [
    `Name: ${f.name}`,
    `ID: ${f.id}`,
    `Type: ${f.mimeType}`,
    f.size ? `Size: ${(parseInt(f.size) / 1024).toFixed(1)} KB` : null,
    f.modifiedTime ? `Modified: ${new Date(f.modifiedTime).toLocaleString("en-US", { timeZone: "America/New_York" })}` : null,
    f.owners ? `Owner: ${f.owners.map((o) => o.displayName || o.emailAddress).join(", ")}` : null,
    f.shared !== void 0 ? `Shared: ${f.shared}` : null,
    f.webViewLink ? `Link: ${f.webViewLink}` : null,
    f.description ? `Description: ${f.description}` : null,
    f.parents ? `Parent folder ID: ${f.parents.join(", ")}` : null
  ].filter(Boolean);
  return lines.join("\n");
}
async function driveCreateFolder(name, parentId) {
  const body = {
    name,
    mimeType: "application/vnd.google-apps.folder"
  };
  if (parentId) body.parents = [parentId];
  const args = ["drive", "files", "create", "--json", JSON.stringify(body), "--params", JSON.stringify({ fields: "id,name,webViewLink" })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const f = result.data;
  return `Created folder: "${f?.name || name}"
ID: ${f?.id || "unknown"}${f?.webViewLink ? `
Link: ${f.webViewLink}` : ""}`;
}
async function driveMove(fileId, newParentId) {
  const getResult = await runGws(["drive", "files", "get", "--params", JSON.stringify({ fileId, fields: "id,name,parents" })]);
  if (!getResult.ok) return getResult.raw;
  const currentParents = getResult.data?.parents?.join(",") || "";
  const args = ["drive", "files", "update", "--params", JSON.stringify({
    fileId,
    addParents: newParentId,
    removeParents: currentParents,
    fields: "id,name,parents"
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Moved "${result.data?.name || fileId}" to folder ${newParentId}`;
}
async function driveRename(fileId, newName) {
  const args = ["drive", "files", "update", "--params", JSON.stringify({ fileId }), "--json", JSON.stringify({ name: newName })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Renamed to: "${result.data?.name || newName}"`;
}
async function driveDelete(fileId) {
  const args = ["drive", "files", "update", "--params", JSON.stringify({ fileId }), "--json", JSON.stringify({ trashed: true })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Moved "${result.data?.name || fileId}" to trash.`;
}
async function sheetsRead(spreadsheetId, range) {
  const args = ["sheets", "+read", "--spreadsheet", spreadsheetId, "--range", range];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  if (result.data?.values) {
    const rows = result.data.values;
    if (rows.length === 0) return "No data in the specified range.";
    const formatted = rows.map((row, i) => `Row ${i + 1}: ${row.join(" | ")}`).join("\n");
    return `${range} (${rows.length} rows):

${formatted}`;
  }
  return result.raw || "No data returned.";
}
async function sheetsList() {
  return driveList("mimeType='application/vnd.google-apps.spreadsheet'");
}
async function sheetsAppend(spreadsheetId, values) {
  const jsonValues = JSON.stringify(values);
  const args = ["sheets", "+append", "--spreadsheet", spreadsheetId, "--json-values", jsonValues];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Appended ${values.length} row(s) to spreadsheet.`;
}
async function sheetsUpdate(spreadsheetId, range, values) {
  const args = [
    "sheets",
    "spreadsheets",
    "values",
    "update",
    "--params",
    JSON.stringify({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED"
    }),
    "--json",
    JSON.stringify({ values })
  ];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Updated ${range} with ${values.length} row(s).`;
}
async function sheetsCreate(title) {
  const args = ["sheets", "spreadsheets", "create", "--json", JSON.stringify({ properties: { title } })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const s = result.data;
  return `Created spreadsheet: "${s?.properties?.title || title}"
ID: ${s?.spreadsheetId || "unknown"}
URL: ${s?.spreadsheetUrl || ""}`;
}
async function sheetsAddSheet(spreadsheetId, title) {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{ addSheet: { properties: { title } } }]
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const reply = result.data?.replies?.[0]?.addSheet;
  const sheetId = reply?.properties?.sheetId ?? "unknown";
  return `Added sheet "${title}" (sheetId: ${sheetId}) to spreadsheet ${spreadsheetId}.`;
}
async function sheetsDeleteSheet(spreadsheetId, sheetId) {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{ deleteSheet: { sheetId } }]
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Deleted sheet ${sheetId} from spreadsheet ${spreadsheetId}.`;
}
async function sheetsClear(spreadsheetId, range) {
  const args = ["sheets", "spreadsheets", "values", "clear", "--params", JSON.stringify({ spreadsheetId, range }), "--json", JSON.stringify({})];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Cleared range ${range} in spreadsheet ${spreadsheetId}.`;
}
async function sheetsFormatCells(spreadsheetId, sheetId, startRow, endRow, startCol, endCol, bold, bgColor, textColor, fontSize) {
  const cellFormat = {};
  const fields = [];
  if (bold !== void 0) {
    cellFormat.textFormat = { ...cellFormat.textFormat, bold };
    fields.push("userEnteredFormat.textFormat.bold");
  }
  if (fontSize !== void 0) {
    cellFormat.textFormat = { ...cellFormat.textFormat, fontSize };
    fields.push("userEnteredFormat.textFormat.fontSize");
  }
  if (bgColor) {
    cellFormat.backgroundColor = bgColor;
    fields.push("userEnteredFormat.backgroundColor");
  }
  if (textColor) {
    cellFormat.textFormat = { ...cellFormat.textFormat, foregroundColor: textColor };
    fields.push("userEnteredFormat.textFormat.foregroundColor");
  }
  if (fields.length === 0) return "Error: At least one formatting option (bold, fontSize, bgColor, textColor) must be specified.";
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{
      repeatCell: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
        cell: { userEnteredFormat: cellFormat },
        fields: fields.join(",")
      }
    }]
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Formatted cells [${startRow}:${endRow}, ${startCol}:${endCol}] in sheet ${sheetId}.`;
}
async function sheetsAutoResize(spreadsheetId, sheetId, startCol, endCol) {
  const dimension = { sheetId, dimension: "COLUMNS" };
  if (startCol !== void 0) dimension.startIndex = startCol;
  if (endCol !== void 0) dimension.endIndex = endCol;
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{ autoResizeDimensions: { dimensions: dimension } }]
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Auto-resized columns in sheet ${sheetId}.`;
}
async function sheetsMergeCells(spreadsheetId, sheetId, startRow, endRow, startCol, endCol) {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{
      mergeCells: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
        mergeType: "MERGE_ALL"
      }
    }]
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Merged cells [${startRow}:${endRow}, ${startCol}:${endCol}] in sheet ${sheetId}.`;
}
async function sheetsBatchUpdate(spreadsheetId, requests) {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const replyCount = result.data?.replies?.length ?? 0;
  return `Batch update completed: ${requests.length} request(s) sent, ${replyCount} reply(ies) received.

${result.raw}`;
}
async function sheetsSort(spreadsheetId, sheetId, sortCol, ascending) {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{
      sortRange: {
        range: { sheetId },
        sortSpecs: [{ dimensionIndex: sortCol, sortOrder: ascending === false ? "DESCENDING" : "ASCENDING" }]
      }
    }]
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Sorted sheet ${sheetId} by column ${sortCol} (${ascending === false ? "descending" : "ascending"}).`;
}
async function docsList() {
  return driveList("mimeType='application/vnd.google-apps.document'");
}
async function docsGet(documentId) {
  const args = ["docs", "documents", "get", "--params", JSON.stringify({ documentId })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const doc = result.data;
  if (!doc) return "Document not found.";
  const title = doc.title || "Untitled";
  const docId = doc.documentId || documentId;
  const textParts = [];
  if (doc.body?.content) {
    for (const element of doc.body.content) {
      if (element.paragraph?.elements) {
        for (const el of element.paragraph.elements) {
          if (el.textRun?.content) textParts.push(el.textRun.content);
        }
      }
      if (element.table) {
        textParts.push("[Table]\n");
      }
    }
  }
  const textContent = textParts.join("");
  const lines = [
    `Title: ${title}`,
    `ID: ${docId}`,
    ``,
    `--- Content ---`,
    textContent.trim() || "(empty document)"
  ];
  return lines.join("\n");
}
async function docsCreate(title) {
  const args = ["docs", "documents", "create", "--json", JSON.stringify({ title })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const doc = result.data;
  return `Created document: "${doc?.title || title}"
ID: ${doc?.documentId || "unknown"}`;
}
async function docsAppend(documentId, text) {
  const args = ["docs", "+write", "--document", documentId, "--text", text];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Appended text to document ${documentId}.`;
}
async function docsInsertText(documentId, text, index) {
  const requests = [];
  if (index !== void 0) {
    requests.push({ insertText: { location: { index }, text } });
  } else {
    requests.push({ insertText: { endOfSegmentLocation: {}, text } });
  }
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted text into document ${documentId}${index !== void 0 ? ` at index ${index}` : " at end"}.`;
}
async function docsDeleteContent(documentId, startIndex, endIndex) {
  const requests = [{ deleteContentRange: { range: { startIndex, endIndex } } }];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Deleted content from index ${startIndex} to ${endIndex} in document ${documentId}.`;
}
async function docsInsertTable(documentId, rows, cols) {
  const requests = [{ insertTable: { rows, columns: cols, endOfSegmentLocation: {} } }];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted ${rows}\xD7${cols} table into document ${documentId}.`;
}
async function docsFormatText(documentId, startIndex, endIndex, bold, italic, fontSize, foregroundColor) {
  const textStyle = {};
  const fields = [];
  if (bold !== void 0) {
    textStyle.bold = bold;
    fields.push("bold");
  }
  if (italic !== void 0) {
    textStyle.italic = italic;
    fields.push("italic");
  }
  if (fontSize !== void 0) {
    textStyle.fontSize = { magnitude: fontSize, unit: "PT" };
    fields.push("fontSize");
  }
  if (foregroundColor) {
    textStyle.foregroundColor = { color: { rgbColor: parseHexColor(foregroundColor) } };
    fields.push("foregroundColor");
  }
  if (fields.length === 0) return "Error: At least one formatting option (bold, italic, fontSize, foregroundColor) must be specified.";
  const requests = [{ updateTextStyle: { range: { startIndex, endIndex }, textStyle, fields: fields.join(",") } }];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Formatted text (index ${startIndex}\u2013${endIndex}) in document ${documentId}.`;
}
async function docsInsertImage(documentId, imageUri, index) {
  const request = { insertInlineImage: { uri: imageUri } };
  if (index !== void 0) {
    request.insertInlineImage.location = { index };
  } else {
    request.insertInlineImage.endOfSegmentLocation = {};
  }
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests: [request] })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted image into document ${documentId}.`;
}
async function docsReplaceText(documentId, findText, replaceText) {
  const requests = [{ replaceAllText: { containsText: { text: findText, matchCase: true }, replaceText } }];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const count = result.data?.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;
  return `Replaced ${count} occurrence(s) of "${findText}" with "${replaceText}" in document ${documentId}.`;
}
async function docsInsertHeading(documentId, text, level) {
  const headingStyle = `HEADING_${Math.min(Math.max(level, 1), 6)}`;
  const getArgs = ["docs", "documents", "get", "--params", JSON.stringify({ documentId })];
  const getResult = await runGws(getArgs);
  if (!getResult.ok) return getResult.raw;
  const body = getResult.data?.body?.content;
  const endIndex = body && body.length > 0 ? (body[body.length - 1]?.endIndex || 1) - 1 : 1;
  const insertAt = Math.max(endIndex, 1);
  const requests = [
    { insertText: { location: { index: insertAt }, text: text + "\n" } },
    { updateParagraphStyle: { range: { startIndex: insertAt, endIndex: insertAt + text.length + 1 }, paragraphStyle: { namedStyleType: headingStyle }, fields: "namedStyleType" } }
  ];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted heading (H${level}) "${text}" into document ${documentId}.`;
}
async function docsBatchUpdate(documentId, requests) {
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Batch update applied ${requests.length} request(s) to document ${documentId}.
${JSON.stringify(result.data?.replies || [], null, 2)}`;
}
async function slidesList() {
  return driveList("mimeType='application/vnd.google-apps.presentation'");
}
async function slidesGet(presentationId) {
  const args = ["slides", "presentations", "get", "--params", JSON.stringify({ presentationId })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const pres = result.data;
  if (!pres) return "Presentation not found.";
  const title = pres.title || "Untitled";
  const presId = pres.presentationId || presentationId;
  const slideCount = pres.slides?.length || 0;
  const lines = [
    `Title: ${title}`,
    `ID: ${presId}`,
    `Slides: ${slideCount}`,
    `Page size: ${pres.pageSize?.width?.magnitude || "?"}\xD7${pres.pageSize?.height?.magnitude || "?"} ${pres.pageSize?.width?.unit || ""}`
  ];
  if (pres.slides) {
    lines.push("", "--- Slides ---");
    for (let i = 0; i < pres.slides.length; i++) {
      const slide = pres.slides[i];
      let slideText = "";
      if (slide.pageElements) {
        for (const el of slide.pageElements) {
          if (el.shape?.text?.textElements) {
            for (const te of el.shape.text.textElements) {
              if (te.textRun?.content) slideText += te.textRun.content;
            }
          }
        }
      }
      lines.push(`
Slide ${i + 1} (${slide.objectId}):`);
      lines.push(slideText.trim() || "(no text)");
    }
  }
  return lines.join("\n");
}
async function slidesCreate(title) {
  const args = ["slides", "presentations", "create", "--json", JSON.stringify({ title })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const pres = result.data;
  return `Created presentation: "${pres?.title || title}"
ID: ${pres?.presentationId || "unknown"}`;
}
async function slidesAppend(presentationId, title, body) {
  const slideId = `slide_${Date.now()}`;
  const createArgs = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({
    requests: [
      {
        createSlide: {
          objectId: slideId,
          slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" }
        }
      }
    ]
  })];
  const createResult = await runGws(createArgs);
  if (!createResult.ok) return createResult.raw;
  const pageResult = await runGws(["slides", "presentations", "pages", "get", "--params", JSON.stringify({ presentationId, pageObjectId: slideId })]);
  if (!pageResult.ok) return pageResult.raw;
  const page = pageResult.data;
  let titleId = "";
  let bodyId = "";
  if (page?.pageElements) {
    for (const el of page.pageElements) {
      const phType = el.shape?.placeholder?.type;
      if (phType === "TITLE" || phType === "CENTERED_TITLE") titleId = el.objectId;
      else if (phType === "BODY" || phType === "SUBTITLE") bodyId = el.objectId;
    }
  }
  const textRequests = [];
  if (titleId && title) {
    textRequests.push({ insertText: { objectId: titleId, text: title, insertionIndex: 0 } });
  }
  if (bodyId && body) {
    textRequests.push({ insertText: { objectId: bodyId, text: body, insertionIndex: 0 } });
  }
  if (textRequests.length > 0) {
    const textArgs = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests: textRequests })];
    const textResult = await runGws(textArgs);
    if (!textResult.ok) return `Slide created but text insertion failed: ${textResult.raw}`;
  }
  return `Added slide "${title}" to presentation ${presentationId}.`;
}
async function slidesInsertTable(presentationId, slideObjectId, rows, cols, data) {
  const tableId = `table_${Date.now()}`;
  const requests = [
    {
      createTable: {
        objectId: tableId,
        elementProperties: {
          pageObjectId: slideObjectId,
          size: {
            width: { magnitude: 72e5, unit: "EMU" },
            height: { magnitude: rows * 4e5, unit: "EMU" }
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: 4e5,
            translateY: 15e5,
            unit: "EMU"
          }
        },
        rows,
        columns: cols
      }
    }
  ];
  if (data) {
    for (let r = 0; r < Math.min(data.length, rows); r++) {
      for (let c = 0; c < Math.min(data[r].length, cols); c++) {
        if (data[r][c]) {
          requests.push({
            insertText: {
              objectId: tableId,
              cellLocation: { rowIndex: r, columnIndex: c },
              text: data[r][c],
              insertionIndex: 0
            }
          });
        }
      }
    }
  }
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted ${rows}\xD7${cols} table on slide ${slideObjectId}.`;
}
async function slidesInsertImage(presentationId, slideObjectId, imageUrl, width, height) {
  const requests = [
    {
      createImage: {
        url: imageUrl,
        elementProperties: {
          pageObjectId: slideObjectId,
          size: {
            width: { magnitude: width || 3e6, unit: "EMU" },
            height: { magnitude: height || 3e6, unit: "EMU" }
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: 2e6,
            translateY: 15e5,
            unit: "EMU"
          }
        }
      }
    }
  ];
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted image on slide ${slideObjectId}.`;
}
async function slidesInsertShape(presentationId, slideObjectId, shapeType, text, left, top, width, height) {
  const shapeId = `shape_${Date.now()}`;
  const requests = [
    {
      createShape: {
        objectId: shapeId,
        shapeType,
        elementProperties: {
          pageObjectId: slideObjectId,
          size: {
            width: { magnitude: width, unit: "EMU" },
            height: { magnitude: height, unit: "EMU" }
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: left,
            translateY: top,
            unit: "EMU"
          }
        }
      }
    }
  ];
  if (text) {
    requests.push({
      insertText: {
        objectId: shapeId,
        text,
        insertionIndex: 0
      }
    });
  }
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted ${shapeType} shape on slide ${slideObjectId}. Shape ID: ${shapeId}`;
}
async function slidesFormatText(presentationId, objectId, startIndex, endIndex, bold, italic, fontSize, color) {
  const style = {};
  const fields = [];
  if (bold !== void 0) {
    style.bold = bold;
    fields.push("bold");
  }
  if (italic !== void 0) {
    style.italic = italic;
    fields.push("italic");
  }
  if (fontSize !== void 0) {
    style.fontSize = { magnitude: fontSize, unit: "PT" };
    fields.push("fontSize");
  }
  if (color) {
    style.foregroundColor = { opaqueColor: { rgbColor: parseHexColor(color) } };
    fields.push("foregroundColor");
  }
  if (fields.length === 0) return "Error: At least one formatting option (bold, italic, fontSize, color) must be specified.";
  const requests = [
    {
      updateTextStyle: {
        objectId,
        textRange: { type: "FIXED_RANGE", startIndex, endIndex },
        style,
        fields: fields.join(",")
      }
    }
  ];
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Formatted text in object ${objectId} (chars ${startIndex}-${endIndex}).`;
}
async function slidesDeleteSlide(presentationId, slideObjectId) {
  const requests = [{ deleteObject: { objectId: slideObjectId } }];
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Deleted slide ${slideObjectId} from presentation ${presentationId}.`;
}
async function slidesDuplicateSlide(presentationId, slideObjectId) {
  const requests = [{ duplicateObject: { objectId: slideObjectId } }];
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const newId = result.data?.replies?.[0]?.duplicateObject?.objectId || "unknown";
  return `Duplicated slide ${slideObjectId}. New slide ID: ${newId}`;
}
async function slidesReplaceText(presentationId, findText, replaceText) {
  const requests = [
    {
      replaceAllText: {
        containsText: { text: findText, matchCase: true },
        replaceText
      }
    }
  ];
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const count = result.data?.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;
  return `Replaced ${count} occurrence(s) of "${findText}" with "${replaceText}".`;
}
async function slidesBatchUpdate(presentationId, requests) {
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Batch update completed (${requests.length} request(s)). Response: ${JSON.stringify(result.data?.replies || []).slice(0, 2e3)}`;
}

// src/youtube.ts
var BASE_URL3 = "https://www.googleapis.com/youtube/v3";
var TIMEOUT_MS7 = 15e3;
async function ytFetch(endpoint, params) {
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, data: null, raw: "Google not connected \u2014 visit /api/gmail/auth to connect" };
  }
  const url = new URL(`${BASE_URL3}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS7);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await res.text();
    if (!res.ok) {
      const errMsg = text.slice(0, 1e3);
      console.error(`[youtube] Error ${res.status} on ${endpoint}:`, errMsg);
      if (res.status === 401) {
        return { ok: false, data: null, raw: "Google authorization expired \u2014 visit /api/gmail/auth to reconnect" };
      }
      if (res.status === 403) {
        return { ok: false, data: null, raw: `Insufficient permissions or quota exceeded: ${errMsg}` };
      }
      return { ok: false, data: null, raw: `YouTube API error ${res.status}: ${errMsg}` };
    }
    try {
      const data = JSON.parse(text);
      return { ok: true, data, raw: text };
    } catch {
      return { ok: true, data: null, raw: text };
    }
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, data: null, raw: "YouTube API request timed out" };
    }
    console.error(`[youtube] Fetch error on ${endpoint}:`, err.message);
    return { ok: false, data: null, raw: `Error: ${err.message}` };
  }
}
function formatDuration2(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return iso;
  const h = match[1] ? `${match[1]}:` : "";
  const m = (match[2] || "0").padStart(h ? 2 : 1, "0");
  const s = (match[3] || "0").padStart(2, "0");
  return `${h}${m}:${s}`;
}
function formatCount(n) {
  const num = typeof n === "string" ? parseInt(n) : n;
  if (num >= 1e9) return `${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  return num.toString();
}
async function youtubeSearch(query, maxResults = 10) {
  const result = await ytFetch("search", {
    part: "snippet",
    type: "video",
    q: query,
    maxResults: String(maxResults),
    order: "relevance"
  });
  if (!result.ok) return result.raw;
  const items = result.data?.items;
  if (!items || items.length === 0) return `No videos found for "${query}".`;
  const lines = items.map((item, i) => {
    const s = item.snippet;
    const videoId = item.id?.videoId;
    const published = s.publishedAt ? new Date(s.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
    return `${i + 1}. ${s.title}
   Channel: ${s.channelTitle}
   Published: ${published}
   ID: ${videoId}
   URL: https://youtube.com/watch?v=${videoId}`;
  });
  return `YouTube results for "${query}" (${items.length}):

${lines.join("\n\n")}`;
}
async function youtubeVideoDetails(videoId) {
  const result = await ytFetch("videos", {
    part: "snippet,statistics,contentDetails",
    id: videoId
  });
  if (!result.ok) return result.raw;
  const items = result.data?.items;
  if (!items || items.length === 0) return "Video not found.";
  const v = items[0];
  const s = v.snippet;
  const stats = v.statistics;
  const duration = v.contentDetails?.duration ? formatDuration2(v.contentDetails.duration) : "?";
  const lines = [
    `Title: ${s.title}`,
    `Channel: ${s.channelTitle}`,
    `Published: ${s.publishedAt ? new Date(s.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "?"}`,
    `Duration: ${duration}`,
    `Views: ${stats.viewCount ? formatCount(stats.viewCount) : "?"}`,
    `Likes: ${stats.likeCount ? formatCount(stats.likeCount) : "hidden"}`,
    `Comments: ${stats.commentCount ? formatCount(stats.commentCount) : "disabled"}`,
    `URL: https://youtube.com/watch?v=${videoId}`,
    ``,
    `Description:`,
    (s.description || "(no description)").slice(0, 500)
  ];
  return lines.join("\n");
}
async function youtubeChannelInfo(channelIdentifier) {
  let params = {
    part: "snippet,statistics"
  };
  if (channelIdentifier.startsWith("UC") && channelIdentifier.length >= 20) {
    params.id = channelIdentifier;
  } else {
    const searchResult = await ytFetch("search", {
      part: "snippet",
      type: "channel",
      q: channelIdentifier,
      maxResults: "1"
    });
    if (!searchResult.ok) return searchResult.raw;
    const channelId = searchResult.data?.items?.[0]?.id?.channelId;
    if (!channelId) return `Channel "${channelIdentifier}" not found.`;
    params.id = channelId;
  }
  const result = await ytFetch("channels", params);
  if (!result.ok) return result.raw;
  const items = result.data?.items;
  if (!items || items.length === 0) return "Channel not found.";
  const ch = items[0];
  const s = ch.snippet;
  const stats = ch.statistics;
  const lines = [
    `Channel: ${s.title}`,
    `ID: ${ch.id}`,
    s.customUrl ? `Handle: ${s.customUrl}` : null,
    `Created: ${s.publishedAt ? new Date(s.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "?"}`,
    `Subscribers: ${stats.subscriberCount ? formatCount(stats.subscriberCount) : "hidden"}`,
    `Videos: ${stats.videoCount ? formatCount(stats.videoCount) : "?"}`,
    `Total views: ${stats.viewCount ? formatCount(stats.viewCount) : "?"}`,
    `URL: https://youtube.com/channel/${ch.id}`,
    ``,
    `Description:`,
    (s.description || "(no description)").slice(0, 500)
  ].filter(Boolean);
  return lines.join("\n");
}
async function youtubeTrending(regionCode = "US", maxResults = 10) {
  const result = await ytFetch("videos", {
    part: "snippet,statistics",
    chart: "mostPopular",
    regionCode,
    maxResults: String(maxResults)
  });
  if (!result.ok) return result.raw;
  const items = result.data?.items;
  if (!items || items.length === 0) return `No trending videos found for region ${regionCode}.`;
  const lines = items.map((v, i) => {
    const s = v.snippet;
    const stats = v.statistics;
    return `${i + 1}. ${s.title}
   Channel: ${s.channelTitle}
   Views: ${stats.viewCount ? formatCount(stats.viewCount) : "?"}
   URL: https://youtube.com/watch?v=${v.id}`;
  });
  return `Trending on YouTube (${regionCode}, ${items.length}):

${lines.join("\n\n")}`;
}

// src/alerts.ts
init_db();
import Anthropic2 from "@anthropic-ai/sdk";
var DEFAULT_CONFIG2 = {
  timezone: "America/New_York",
  location: "New York",
  briefs: {
    morning: { enabled: true, hour: 8, minute: 0, content: ["calendar", "tasks", "weather", "news", "markets", "headlines", "email"] },
    afternoon: { enabled: true, hour: 13, minute: 0, content: ["calendar", "tasks", "email", "markets", "headlines"] },
    evening: { enabled: true, hour: 19, minute: 0, content: ["calendar_tomorrow", "tasks", "markets", "headlines", "email"] }
  },
  alerts: {
    calendarReminder: { enabled: true, minutesBefore: 30 },
    stockMove: { enabled: true, thresholdPercent: 3 },
    taskDeadline: { enabled: true },
    importantEmail: { enabled: true }
  },
  watchlist: [
    { symbol: "GC=F", type: "stock", displaySymbol: "GOLD" },
    { symbol: "SI=F", type: "stock", displaySymbol: "SILVER" },
    { symbol: "bitcoin", type: "crypto", displaySymbol: "BTCUSD" },
    { symbol: "MSTR", type: "stock" }
  ],
  theme: "dark",
  lastPrices: {},
  lastBriefRun: {}
};
var config = { ...DEFAULT_CONFIG2 };
var broadcastFn = null;
var saveBriefFn = null;
var briefInterval = null;
var alertInterval = null;
var alertedCalendarEvents = /* @__PURE__ */ new Set();
var alertedEmailIds = /* @__PURE__ */ new Set();
var initialAlertCheckDone = false;
var briefRunning = false;
var alertRunning = false;
var lastDedupeReset = "";
async function init7() {
  const existing = await getPool().query(`SELECT value FROM app_config WHERE key = 'alerts'`);
  if (existing.rows.length === 0) {
    try {
      const fs7 = await import("fs");
      const path8 = await import("path");
      const legacyPath = path8.default.join(process.cwd(), "data", "alerts-config.json");
      if (fs7.default.existsSync(legacyPath)) {
        const raw = JSON.parse(fs7.default.readFileSync(legacyPath, "utf-8"));
        const migrated = { ...DEFAULT_CONFIG2, ...raw, briefs: { ...DEFAULT_CONFIG2.briefs, ...raw.briefs }, alerts: { ...DEFAULT_CONFIG2.alerts, ...raw.alerts } };
        await getPool().query(
          `INSERT INTO app_config (key, value, updated_at) VALUES ('alerts', $1, $2)`,
          [JSON.stringify(migrated), Date.now()]
        );
        config = migrated;
        console.log("[alerts] Migrated config from data/alerts-config.json to PostgreSQL");
      }
    } catch (err) {
      console.error("[alerts] Config migration failed:", err);
    }
  }
  if (existing.rows.length > 0) {
    config = await loadConfig();
  }
  console.log("[alerts] initialized");
}
async function loadConfig() {
  try {
    const result = await getPool().query(`SELECT value FROM app_config WHERE key = 'alerts'`);
    if (result.rows.length > 0) {
      const raw = result.rows[0].value;
      return { ...DEFAULT_CONFIG2, ...raw, briefs: { ...DEFAULT_CONFIG2.briefs, ...raw.briefs }, alerts: { ...DEFAULT_CONFIG2.alerts, ...raw.alerts } };
    }
  } catch (err) {
    console.error("[alerts] Failed to load config:", err);
  }
  return { ...DEFAULT_CONFIG2 };
}
async function saveConfig() {
  try {
    await getPool().query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ('alerts', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(config), Date.now()]
    );
  } catch (err) {
    console.error("[alerts] Failed to save config:", err);
  }
}
function getConfig() {
  const { lastPrices, lastBriefRun, ...rest } = config;
  return rest;
}
function updateConfig(partial) {
  if (partial.timezone) config.timezone = partial.timezone;
  if (partial.location) config.location = partial.location;
  if (partial.briefs) {
    for (const key of ["morning", "afternoon", "evening"]) {
      if (partial.briefs[key]) {
        config.briefs[key] = { ...config.briefs[key], ...partial.briefs[key] };
      }
    }
  }
  if (partial.alerts) {
    for (const key of ["calendarReminder", "stockMove", "taskDeadline", "importantEmail"]) {
      if (partial.alerts[key]) {
        config.alerts[key] = { ...config.alerts[key], ...partial.alerts[key] };
      }
    }
  }
  if (partial.watchlist) config.watchlist = partial.watchlist;
  if (partial.theme === "dark" || partial.theme === "light") config.theme = partial.theme;
  saveConfig();
  return getConfig();
}
function getNow() {
  const nowStr = (/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: config.timezone });
  return new Date(nowStr);
}
function getTodayKey() {
  const now = getNow();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function getTzOffset(tz, refDate) {
  const utcStr = refDate.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = refDate.toLocaleString("en-US", { timeZone: tz });
  return new Date(tzStr).getTime() - new Date(utcStr).getTime();
}
function getDateInTimezone(tz, daysOffset = 0) {
  const now = /* @__PURE__ */ new Date();
  const nowOffsetMs = getTzOffset(tz, now);
  const nowInTz = new Date(now.getTime() + nowOffsetMs);
  nowInTz.setUTCDate(nowInTz.getUTCDate() + daysOffset);
  const noonOnTarget = new Date(Date.UTC(nowInTz.getUTCFullYear(), nowInTz.getUTCMonth(), nowInTz.getUTCDate(), 12, 0, 0, 0));
  const targetOffsetMs = getTzOffset(tz, new Date(noonOnTarget.getTime() - nowOffsetMs));
  const startInTz = new Date(Date.UTC(nowInTz.getUTCFullYear(), nowInTz.getUTCMonth(), nowInTz.getUTCDate(), 0, 0, 0, 0));
  const endInTz = new Date(Date.UTC(nowInTz.getUTCFullYear(), nowInTz.getUTCMonth(), nowInTz.getUTCDate(), 23, 59, 59, 999));
  const startUTC = new Date(startInTz.getTime() - targetOffsetMs);
  const endUTC = new Date(endInTz.getTime() - targetOffsetMs);
  return { start: startUTC, end: endUTC };
}
async function gatherSection(name) {
  try {
    switch (name) {
      case "calendar": {
        if (!isConfigured4()) return "**Calendar:** [not connected]";
        const now = /* @__PURE__ */ new Date();
        const { end: endOfDay } = getDateInTimezone(config.timezone, 0);
        console.log(`[alerts] Calendar today query: ${now.toISOString()} to ${endOfDay.toISOString()}`);
        const result = await listEvents({ timeMin: now.toISOString(), timeMax: endOfDay.toISOString(), maxResults: 10 });
        return `**Today's Calendar:**
${result}`;
      }
      case "calendar_tomorrow": {
        if (!isConfigured4()) return "**Calendar:** [not connected]";
        const { start: tomorrow, end: endTomorrow } = getDateInTimezone(config.timezone, 1);
        console.log(`[alerts] Calendar tomorrow query: ${tomorrow.toISOString()} to ${endTomorrow.toISOString()}`);
        const result = await listEvents({ timeMin: tomorrow.toISOString(), timeMax: endTomorrow.toISOString(), maxResults: 10 });
        return `**Tomorrow's Calendar:**
${result}`;
      }
      case "tasks": {
        const localTasks = await listTasks();
        return `**Tasks:**
${localTasks}`;
      }
      case "weather": {
        const result = await getWeather(config.location);
        return `**Weather:**
${result}`;
      }
      case "news": {
        const [top, finance, tech] = await Promise.allSettled([
          getNews("top"),
          getNews("business"),
          getNews("technology")
        ]);
        const sections = [];
        if (top.status === "fulfilled") {
          const lines = top.value.split("\n").slice(0, 12).join("\n");
          sections.push(`**Top Headlines:**
${lines}`);
        }
        if (finance.status === "fulfilled") {
          const lines = finance.value.split("\n").slice(0, 12).join("\n");
          sections.push(`**Finance Headlines:**
${lines}`);
        }
        if (tech.status === "fulfilled") {
          const lines = tech.value.split("\n").slice(0, 12).join("\n");
          sections.push(`**Technology Headlines:**
${lines}`);
        }
        return sections.join("\n\n") || "**News:** [unavailable]";
      }
      case "markets": {
        const items = [];
        for (const w of config.watchlist) {
          try {
            const label = w.displaySymbol || w.symbol.toUpperCase();
            if (w.type === "crypto") {
              const data = await getCryptoPrice(w.symbol);
              const priceLine = data.split("\n").slice(0, 3).join(" | ");
              items.push(`${label}: ${priceLine}`);
            } else {
              const data = await getStockQuote(w.symbol);
              const priceLine = data.split("\n").slice(0, 3).join(" | ");
              items.push(`${label}: ${priceLine}`);
            }
          } catch {
            items.push(`${w.displaySymbol || w.symbol}: [unavailable]`);
          }
        }
        return `**Markets:**
${items.join("\n")}`;
      }
      case "headlines": {
        try {
          const topNews = await getNews("top");
          const items = topNews.split("\n").filter((l) => /^\d+\./.test(l)).slice(0, 5);
          const bullets = items.map((line) => {
            const cleaned = line.replace(/^\d+\.\s*/, "");
            return `\u2022 ${cleaned}`;
          });
          return `**Top Headlines:**
${bullets.join("\n")}`;
        } catch {
          return "**Top Headlines:** [unavailable]";
        }
      }
      case "email": {
        if (!isConfigured3() || !isConnected()) return "**Email:** [not connected]";
        try {
          const result = await listEmails("is:unread", 5);
          const cleaned = result.replace(/\s*\[[a-f0-9]+\]/gi, "").replace(/\(\* = unread\)\n?/g, "").replace(/^\* /gm, "").replace(/\n{3,}/g, "\n\n");
          return `**Email:**
${cleaned}`;
        } catch {
          return "**Email:** [unavailable]";
        }
      }
      default:
        return "";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[alerts] Section "${name}" failed:`, msg);
    return `**${name}:** [unavailable]`;
  }
}
async function synthesizeBrief(type, rawSections) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return rawSections;
  try {
    const client = new Anthropic2({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `You are Rickin's personal assistant delivering his ${type} briefing. Synthesize the following raw data into a concise, natural-language briefing. Lead with the most important and actionable items. Be direct \u2014 no filler.

Format rules:
- Use markdown headers (##) for major sections
- Use bullet points for individual items
- Keep each item to 1-2 lines max
- If a section has no data or says "not connected", skip it entirely
- For markets, highlight notable moves; don't just list prices
- For calendar, emphasize timing and what's next
- For email, mention sender and subject briefly

RAW DATA:
${rawSections}`
      }]
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    return text || rawSections;
  } catch (err) {
    console.error(`[alerts] AI synthesis failed for ${type} brief:`, err);
    return rawSections;
  }
}
async function generateBrief(type) {
  const briefConfig = config.briefs[type];
  const sections = [];
  const results = await Promise.allSettled(
    briefConfig.content.map((name) => gatherSection(name))
  );
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      sections.push(result.value);
    }
  }
  const rawContent = sections.join("\n\n---\n\n");
  const synthesized = await synthesizeBrief(type, rawContent);
  if (saveBriefFn) {
    try {
      const dateStr = (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: config.timezone });
      const briefPath = `Daily Digests/${dateStr}-${type}.md`;
      const header = `# ${type.charAt(0).toUpperCase() + type.slice(1)} Brief \u2014 ${dateStr}

`;
      await saveBriefFn(briefPath, header + synthesized);
      console.log(`[alerts] Brief saved to vault: ${briefPath}`);
    } catch (err) {
      console.error(`[alerts] Failed to save brief to vault:`, err);
    }
  }
  return synthesized;
}
async function checkBriefs() {
  if (briefRunning) return;
  briefRunning = true;
  try {
    await doCheckBriefs();
  } finally {
    briefRunning = false;
  }
}
async function doCheckBriefs() {
  const now = getNow();
  const todayKey = getTodayKey();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  if (lastDedupeReset !== todayKey) {
    alertedCalendarEvents.clear();
    alertedEmailIds.clear();
    lastDedupeReset = todayKey;
  }
  for (const type of ["morning", "afternoon", "evening"]) {
    const briefConfig = config.briefs[type];
    if (!briefConfig.enabled) continue;
    const runKey = `${type}_${todayKey}`;
    if (config.lastBriefRun[runKey]) continue;
    const targetMinutes = briefConfig.hour * 60 + briefConfig.minute;
    const nowMinutes = currentHour * 60 + currentMinute;
    if (nowMinutes >= targetMinutes && nowMinutes <= targetMinutes + 2) {
      console.log(`[alerts] Triggering ${type} brief`);
      config.lastBriefRun[runKey] = (/* @__PURE__ */ new Date()).toISOString();
      await saveConfig();
      try {
        const content = await generateBrief(type);
        const event = {
          type: "brief",
          briefType: type,
          content,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        };
        broadcastFn?.(event);
        console.log(`[alerts] ${type} brief sent`);
      } catch (err) {
        console.error(`[alerts] ${type} brief failed:`, err);
      }
    }
  }
}
async function checkAlerts() {
  if (alertRunning) return;
  alertRunning = true;
  try {
    await doCheckAlerts();
  } finally {
    alertRunning = false;
  }
}
async function doCheckAlerts() {
  const now = /* @__PURE__ */ new Date();
  if (config.alerts.calendarReminder.enabled && isConfigured4()) {
    try {
      const minutesBefore = config.alerts.calendarReminder.minutesBefore || 30;
      const windowEnd = new Date(now.getTime() + minutesBefore * 60 * 1e3);
      const result = await listEvents({ timeMin: now.toISOString(), timeMax: windowEnd.toISOString(), maxResults: 5 });
      if (!result.includes("No upcoming events")) {
        const lines = result.split("\n").filter((l) => l.trim());
        for (const line of lines) {
          const eventKey = line.trim().slice(0, 80);
          if (alertedCalendarEvents.has(eventKey)) continue;
          if (/^\d+\./.test(line.trim())) {
            alertedCalendarEvents.add(eventKey);
            broadcastFn?.({
              type: "alert",
              alertType: "calendar",
              title: "Upcoming Event",
              content: line.trim().replace(/^\d+\.\s*/, ""),
              timestamp: now.toISOString()
            });
          }
        }
      }
    } catch (err) {
      console.error("[alerts] Calendar alert check failed:", err);
    }
  }
  if (config.alerts.stockMove.enabled && config.watchlist.length > 0) {
    const threshold = config.alerts.stockMove.thresholdPercent || 3;
    for (const w of config.watchlist) {
      try {
        const label = w.displaySymbol || w.symbol.toUpperCase();
        let currentPrice = null;
        if (w.type === "crypto") {
          const data = await getCryptoPrice(w.symbol);
          const priceMatch = data.match(/Price:\s*\$([0-9,]+\.?\d*)/);
          if (priceMatch) currentPrice = parseFloat(priceMatch[1].replace(/,/g, ""));
        } else {
          const data = await getStockQuote(w.symbol);
          const priceMatch = data.match(/Price:\s*\$([0-9,]+\.?\d*)/);
          if (priceMatch) currentPrice = parseFloat(priceMatch[1].replace(/,/g, ""));
        }
        if (currentPrice !== null) {
          const lastPrice = config.lastPrices[label];
          if (lastPrice) {
            const pctChange = (currentPrice - lastPrice) / lastPrice * 100;
            if (Math.abs(pctChange) >= threshold) {
              const direction = pctChange > 0 ? "UP" : "DOWN";
              const arrow = pctChange > 0 ? "\u25B2" : "\u25BC";
              broadcastFn?.({
                type: "alert",
                alertType: "stock",
                title: `${label} ${direction} ${Math.abs(pctChange).toFixed(1)}%`,
                content: `${label} moved ${arrow} ${Math.abs(pctChange).toFixed(1)}% \u2014 now $${currentPrice.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
                timestamp: now.toISOString()
              });
            }
          }
          config.lastPrices[label] = currentPrice;
        }
      } catch (err) {
        console.error(`[alerts] Stock alert check for ${w.symbol} failed:`, err);
      }
    }
    await saveConfig();
  }
  if (config.alerts.taskDeadline.enabled) {
    try {
      const todayKey = getTodayKey();
      const taskList = await listTasks();
      if (!taskList.includes("No open tasks") && !taskList.includes("No tasks found")) {
        const lines = taskList.split("\n");
        for (const line of lines) {
          if (line.includes(`due: ${todayKey}`) && !line.includes("[x]")) {
            const taskTitle = line.replace(/^\d+\.\s*\[.\]\s*/, "").replace(/\s*!!.*/, "").replace(/\s*\(due:.*/, "").trim();
            if (taskTitle && !alertedCalendarEvents.has(`task_${taskTitle}`)) {
              alertedCalendarEvents.add(`task_${taskTitle}`);
              broadcastFn?.({
                type: "alert",
                alertType: "task",
                title: "Task Due Today",
                content: taskTitle,
                timestamp: now.toISOString()
              });
            }
          }
        }
      }
    } catch (err) {
      console.error("[alerts] Task alert check failed:", err);
    }
  }
  if (config.alerts.importantEmail.enabled && isConfigured3() && isConnected()) {
    try {
      const result = await listEmails("is:unread is:important", 5);
      if (!result.includes("No emails found") && !result.includes("not authorized")) {
        const idMatches = result.matchAll(/\[([a-f0-9]+)\]/gi);
        for (const match of idMatches) {
          const emailId = match[1];
          if (!alertedEmailIds.has(emailId)) {
            alertedEmailIds.add(emailId);
            if (initialAlertCheckDone) {
              const lineIdx = result.indexOf(`[${emailId}]`);
              const blockEnd = result.indexOf("\n\n", lineIdx);
              const block = result.slice(lineIdx, blockEnd === -1 ? void 0 : blockEnd);
              const fromMatch = block.match(/From:\s*(.+)/);
              const subjectMatch = block.match(/Subject:\s*(.+)/);
              const sender = fromMatch ? fromMatch[1].replace(/<[^>]+>/, "").trim() : "Unknown";
              const subject = subjectMatch ? subjectMatch[1].trim() : "No subject";
              broadcastFn?.({
                type: "alert",
                alertType: "email",
                title: sender,
                content: subject,
                timestamp: now.toISOString()
              });
            }
          }
        }
      }
    } catch (err) {
      console.error("[alerts] Email alert check failed:", err);
    }
  }
}
function startAlertSystem(broadcast, saveBrief) {
  broadcastFn = broadcast;
  saveBriefFn = saveBrief || null;
  briefInterval = setInterval(() => {
    checkBriefs().catch((err) => console.error("[alerts] Brief check error:", err));
  }, 6e4);
  alertInterval = setInterval(() => {
    checkAlerts().catch((err) => console.error("[alerts] Alert check error:", err));
  }, 15 * 6e4);
  console.log(`[alerts] System started \u2014 briefs: morning=${config.briefs.morning.enabled}/${config.briefs.morning.hour}:${String(config.briefs.morning.minute).padStart(2, "0")}, afternoon=${config.briefs.afternoon.enabled}/${config.briefs.afternoon.hour}:${String(config.briefs.afternoon.minute).padStart(2, "0")}, evening=${config.briefs.evening.enabled}/${config.briefs.evening.hour}:${String(config.briefs.evening.minute).padStart(2, "0")} (${config.timezone})`);
  console.log(`[alerts] Watchlist: ${config.watchlist.map((w) => w.displaySymbol || w.symbol).join(", ")}`);
  alertedCalendarEvents.clear();
  alertedEmailIds.clear();
  initialAlertCheckDone = false;
  setTimeout(async () => {
    try {
      await checkAlerts();
    } catch (err) {
      console.error("[alerts] Initial alert check error:", err);
    }
    initialAlertCheckDone = true;
  }, 3e4);
}
async function triggerBrief(type) {
  console.log(`[alerts] Manual trigger: ${type} brief`);
  const content = await generateBrief(type);
  const event = {
    type: "brief",
    briefType: type,
    content,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  broadcastFn?.(event);
  return event;
}

// server.ts
init_telegram();

// src/scheduled-jobs.ts
init_db();
init_telegram();
function getJobSavePath(jobId, dateStr, safeName) {
  if (jobId === "moodys-daily-intel") return `Scheduled Reports/Moody's Intelligence/Daily/${dateStr}-Brief.md`;
  if (jobId === "moodys-profile-updates") return `Scheduled Reports/Moody's Intelligence/Daily/${dateStr}-Profile-Updates.md`;
  if (jobId === "moodys-weekly-digest") return `Scheduled Reports/Moody's Intelligence/Weekly/${dateStr}-Digest.md`;
  if (jobId === "real-estate-daily-scan") return `Scheduled Reports/Real Estate/${dateStr}-Property-Scan.md`;
  if (jobId === "darknode-inbox-monitor") return `Scheduled Reports/Inbox Monitor/${dateStr}-${safeName}.md`;
  if (jobId === "life-audit") return `Scheduled Reports/Life-Audit/${dateStr}.md`;
  if (jobId === "daily-inbox-triage-am") return `Scheduled Reports/Inbox Cleanup/${dateStr}-AM-triage.md`;
  if (jobId === "daily-inbox-triage-pm") return `Scheduled Reports/Inbox Cleanup/${dateStr}-PM-triage.md`;
  if (jobId === "weekly-inbox-deep-clean") return `Scheduled Reports/Inbox Cleanup/${dateStr}-weekly-summary.md`;
  if (jobId === "baby-dashboard-weekly-update") return `Scheduled Reports/Baby Dashboard/${dateStr}-Weekly-Log.md`;
  if (jobId === "birthday-calendar-sync") return `Scheduled Reports/Birthday Sync/${dateStr}-Sync.md`;
  if (jobId === "scout-micro-scan") return `Scheduled Reports/Wealth Engines/Scout/${dateStr}-Micro-Scan.md`;
  if (jobId === "scout-full-cycle") return `Scheduled Reports/Wealth Engines/Scout/${dateStr}-Full-Cycle.md`;
  if (jobId === "polymarket-activity-scan") return `Scheduled Reports/Wealth Engines/Polymarket/${dateStr}-Activity-Scan.md`;
  if (jobId === "polymarket-full-cycle") return `Scheduled Reports/Wealth Engines/Polymarket/${dateStr}-Full-Cycle.md`;
  if (jobId === "weekly-memory-reflect") return `Scheduled Reports/Memory/${dateStr}-Weekly-Digest.md`;
  if (jobId === "bankr-execute") return `Scheduled Reports/Wealth Engines/BANKR/${dateStr}-Execution.md`;
  if (jobId === "oversight-health") return `Scheduled Reports/Wealth Engines/Oversight/${dateStr}-Health.md`;
  if (jobId === "oversight-weekly") return `Scheduled Reports/Wealth Engines/Oversight/${dateStr}-Weekly-Review.md`;
  if (jobId === "oversight-daily-summary") return `Scheduled Reports/Wealth Engines/Oversight/${dateStr}-Daily-Summary.md`;
  if (jobId === "oversight-shadow-refresh") return `Scheduled Reports/Wealth Engines/Oversight/${dateStr}-Shadow-Refresh.md`;
  if (jobId === "autoresearch-weekly") return `Scheduled Reports/Wealth Engines/Autoresearch/${dateStr}-Weekly-Optimization.md`;
  return `Scheduled Reports/${dateStr}-${safeName}.md`;
}
var jobStatusCache = {};
async function writeJobStatus(jobId, entry) {
  jobStatusCache[jobId] = entry;
  if (kbCreateFn) {
    await kbCreateFn("Scheduled Reports/job-status.json", JSON.stringify(jobStatusCache, null, 2));
  }
}
var DEFAULT_JOBS = [
  {
    id: "kb-organizer",
    name: "Knowledge Base Cleanup",
    agentId: "knowledge-organizer",
    prompt: `Audit the vault and produce a report \u2014 do NOT modify, move, or delete any files. Read-only scan only.

Check for these issues and list each finding with a suggested action:
1. Empty folders \u2014 list them and suggest removal
2. Orphaned or misplaced files \u2014 list them with suggested new locations
3. Duplicate or near-duplicate notes \u2014 list pairs with a suggestion to consolidate
4. Inconsistent naming \u2014 list files that don't follow conventions (kebab-case or Title Case) with suggested renames
5. Large files or folders that could be reorganised

Save the report to "Scheduled Reports/KB Audit Report.md" (overwrite previous). Format as a clear checklist so I can review and action items manually.`,
    schedule: { type: "daily", hour: 2, minute: 0 },
    enabled: false
  },
  {
    id: "daily-news",
    name: "Daily News Brief",
    agentId: "deep-researcher",
    prompt: `Research and compile today's top news across these categories:
1. Technology & AI developments
2. Financial markets & economy
3. World events

For each story, provide a 2-3 sentence summary with context on why it matters.
Save the compiled brief to "Scheduled Reports/Daily News.md" (overwrite previous).`,
    schedule: { type: "daily", hour: 6, minute: 30 },
    enabled: false
  },
  {
    id: "market-summary",
    name: "Market Summary",
    agentId: "analyst",
    prompt: `Analyze the current market conditions:
1. Check the watchlist stocks and crypto prices
2. Search X for ticker sentiment and market chatter \u2014 x_search("$GOLD OR $BTC OR $MSTR OR stock market") for real-time trader sentiment
3. Note any significant moves (>2%) with brief analysis
4. Summarize overall market sentiment (include X/social sentiment alongside data)
5. Flag any notable earnings or economic events today

Save the report to "Scheduled Reports/Market Summary.md" (overwrite previous).`,
    schedule: { type: "daily", hour: 7, minute: 30 },
    enabled: false
  },
  {
    id: "moodys-daily-intel",
    name: "Moody's Intelligence Brief",
    agentId: "moodys",
    prompt: `You are a competitive intelligence analyst for Moody's Banking Solutions. Compile a comprehensive daily intelligence brief by ACTIVELY researching each category using web_search, web_fetch, AND x_search. You MUST call these tools \u2014 do not rely on prior knowledge.

RESEARCH METHOD \u2014 For EVERY category below:
1. Run web_search with the specified queries to find articles
2. Use web_fetch on the top 2-3 result URLs to read actual article content for richer summaries. If web_fetch returns empty/thin content (just nav text or errors), retry with render_page which uses a cloud browser with anti-bot protection
3. Run x_search with the specified queries for real-time signals
4. Write 3-5 bullet items per category (not just 1)

CATEGORY 1 \u2014 Moody's Corporate:
web_search("Moody's Analytics news 2026") AND web_search("site:moodys.com press release")
web_fetch the top 2 results from moodys.com
x_search("from:MoodysAnalytics OR from:MoodysInvSvc OR Moody's Analytics OR Credit Lens")
Focus: press releases, product launches, leadership, earnings, Credit Lens, Banking Solutions, KYC, risk analytics.

CATEGORY 2 \u2014 Banking Segment:
web_search("Moody's Credit Lens banking") AND web_search("Moody's Analytics banking product launch OR partnership")
web_fetch any relevant moodys.com product pages
x_search("Credit Lens OR Moody's banking OR OnlineALM OR BankFocus")
Focus: Credit Lens updates, customer wins, partnerships, banking vertical product news.

CATEGORY 3 \u2014 Competitor Intelligence:
Run SEPARATE searches for each competitor group:
web_search("Bloomberg Terminal AI 2026 OR Bloomberg Enterprise Data") \u2192 web_fetch top result
web_search("S&P Global Capital IQ AI OR S&P Market Intelligence 2026") \u2192 web_fetch top result
web_search("Fitch Solutions banking analytics OR Fitch Ratings 2026") \u2192 web_fetch top result
web_search("Nasdaq AxiomSL OR Nasdaq Financial Technology 2026") \u2192 web_fetch top result
web_search("nCino banking AI OR nCino 2026 news") \u2192 web_fetch top result
web_search("Quantexa banking OR Databricks financial services 2026")
web_search("ValidMind AI governance OR Regnology regulatory reporting 2026")
x_search("Bloomberg data AI OR S&P Global Capital IQ OR Fitch Solutions OR nCino")
x_search("Quantexa OR Databricks financial services OR ValidMind OR Regnology")
Write at least 3-5 competitor items with specific details from the articles.

CATEGORY 4 \u2014 Enterprise AI Trends:
web_search("agentic AI banking financial services 2026") \u2192 web_fetch top 2 results
web_search("enterprise LLM deployment regulated industries") \u2192 web_fetch top result
web_search("AI governance banking regulation EU AI Act")
x_search("agentic AI banking OR enterprise LLM financial services OR AI governance banking")
Focus: agentic AI in banking, LLM deployments, AI regulation, MCP adoption, CDM standards.

CATEGORY 5 \u2014 Industry Analyst Coverage:
web_search("site:celent.com Moody's OR Credit Lens OR banking AI")
web_search("site:chartis-research.com RiskTech100 OR credit risk technology 2026")
web_search("Forrester banking technology 2026 OR Gartner risk analytics OR IDC financial services AI")
x_search("from:CelentResearch OR from:Chartis_Research OR Celent banking OR RiskTech100")
web_fetch any analyst report pages found.

OUTPUT FORMAT \u2014 Do NOT use notes_create. Instead, output the full brief as your final response. The system will save it automatically. Format:

## \u{1F3E2} Moody's Corporate
- \u{1F534}/\u{1F7E1}/\u{1F7E2} {item summary \u2014 1-2 sentences with specific details} ([source](url))
- {3-5 items minimum}

## \u{1F3E6} Banking Segment
- \u{1F534}/\u{1F7E1}/\u{1F7E2} {item summary} ([source](url))
- {3-5 items minimum}

## \u{1F50D} Competitor Watch
- \u{1F534}/\u{1F7E1}/\u{1F7E2} **{Competitor Name}**: {what happened \u2014 specific details from article} ([source](url))
- {5-8 items covering multiple competitors}

## \u{1F916} Enterprise AI Trends
- \u{1F534}/\u{1F7E1}/\u{1F7E2} {item summary} ([source](url))
- {3-5 items minimum}

## \u{1F4CA} Industry Analyst Coverage
- \u{1F534}/\u{1F7E1}/\u{1F7E2} {item summary} ([source](url))
- {3-5 items minimum}

## \u26A1 Key Takeaways
1. {takeaway with strategic implication for Moody's}
2. {3-5 numbered takeaways}

IMPORTANT:
- Each category MUST have at least 3 bullets. If web_search returns few results, broaden the query or try alternate terms.
- Use web_fetch to read article content \u2014 summaries from search snippets alone are too thin. If web_fetch returns empty or blocked content, use render_page (cloud browser) instead.
- Tag each item: \u{1F534} High (directly impacts Moody's Banking), \u{1F7E1} Medium (industry trend), \u{1F7E2} Low (background).
- Do NOT produce a summary table \u2014 write full bullet content under each ## section header.
- Do NOT use notes_create or notes_append \u2014 just output the brief directly. The system saves it for you.
- Do NOT update competitor profiles \u2014 a separate job handles that.`,
    schedule: { type: "daily", hour: 6, minute: 0 },
    enabled: true
  },
  {
    id: "moodys-profile-updates",
    name: "Moody's Profile Updates",
    agentId: "moodys",
    prompt: `Read today's intelligence brief and update competitor/analyst profiles with the findings.

STEP 1: Use notes_list on "Scheduled Reports/Moody's Intelligence/Daily/" to find today's brief (filename format: YYYY-MM-DD-Brief.md). Read it with notes_read.

STEP 2: For each competitor that has actual findings in the brief (not "No new developments"), use notes_append on the corresponding profile file to add a date-stamped entry:

Competitor Profiles \u2014 append to "Projects/Moody's/Competitive Intelligence/Competitor Profiles/{Name}.md":
- Bloomberg, S&P Global, Fitch, Nasdaq, nCino, QRM, Empyrean, Quantexa, Databricks, Regnology, FinregE, ValidMind

Industry Analyst Profiles \u2014 append to "Projects/Moody's/Competitive Intelligence/Industry Analysts/{Name}.md":
- Celent, Chartis Research, Forrester, Gartner, IDC

Entry format for each profile:
### {today's date YYYY-MM-DD}
- {bullet findings from today's brief}

Only append to profiles that had actual findings \u2014 skip any with "No new developments" or no mention in the brief.

After completing all updates, provide a summary of how many profiles were updated and which ones.`,
    schedule: { type: "daily", hour: 6, minute: 15 },
    enabled: true
  },
  {
    id: "moodys-weekly-digest",
    name: "Moody's Weekly Strategic Digest",
    agentId: "moodys",
    prompt: `Generate the weekly Moody's strategic digest by reading and synthesising all daily intelligence briefs from this past week.

STEP 1: List files in "Scheduled Reports/Moody's Intelligence/Daily/" folder using notes_list.
STEP 2: Read every file matching "*-Brief.md" from the last 7 days.
STEP 3: Synthesise all daily briefs into the weekly digest format below.

Save using notes_create to "Scheduled Reports/Moody's Intelligence/Weekly/{today's date YYYY-MM-DD}-Digest.md":

# Moody's Weekly Strategic Digest \u2014 Week of {date}

## \u{1F4C8} Week in Review
- {3-5 sentence executive summary of the most important developments}

## \u{1F3E2} Moody's Moves This Week
- {consolidated list of Moody's news, deduplicated across daily briefs}

## \u{1F50D} Competitor Patterns
- {trends across competitors \u2014 who's gaining, who's shipping, strategic shifts}
- {any new partnerships, acquisitions, or product launches}

## \u{1F916} AI & Tech Trajectory
- {emerging patterns in enterprise AI, agentic AI, banking tech}
- {regulatory developments that impact Moody's strategy}

## \u{1F4CA} Analyst Signals
- {any new rankings, quadrant reports, or vendor assessments}
- {shifts in analyst sentiment toward Moody's or competitors}

## \u26A0\uFE0F Strategic Implications for Moody's Banking
- {what these developments mean for Rickin's data moat strategy}
- {opportunities to exploit or threats to watch}
- {specific actions or talking points for the coming week}

## \u{1F3AF} Recommended Focus This Week
- {top 3 things to pay attention to or act on}

Be thorough in reading all available daily briefs. If fewer than 7 daily briefs exist, work with what's available.`,
    schedule: { type: "weekly", hour: 7, minute: 0, daysOfWeek: [0] },
    enabled: true
  },
  {
    id: "real-estate-daily-scan",
    name: "Daily Property Scan",
    agentId: "real-estate",
    prompt: `You are running the daily property scan. First read "Real Estate/Search Criteria.md" for full criteria and target areas.

For each of the 6 target areas, search for hidden gem properties matching: $1.3M\u2013$1.8M, 4+ bedrooms, 3+ bathrooms, Houses.

STEP 1 \u2014 ZILLOW SEARCH: Use property_search with these locations (one call per area):
1. "Upper Saddle River, NJ" (also try "Ridgewood, NJ", "Ho-Ho-Kus, NJ")
2. "Montclair, NJ" (also try "Glen Ridge, NJ")
3. "Princeton, NJ" (also try "West Windsor, NJ")
4. "Garden City, NY" (also try "Manhasset, NY", "Great Neck, NY", "Cold Spring Harbor, NY")
5. "Tarrytown, NY" (also try "Scarsdale, NY", "Chappaqua, NY", "Bronxville, NY")
6. "Westport, CT" (also try "Darien, CT", "Stamford, CT")
For each search: set minPrice=1300000, maxPrice=1800000, minBeds=4, minBaths=3, sort="Newest".

STEP 2 \u2014 REDFIN SEARCH: Use redfin_search with these pre-verified URLs (one call per area):
1. https://www.redfin.com/city/19045/NJ/Upper-Saddle-River/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
2. https://www.redfin.com/city/35939/NJ/Montclair/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
3. https://www.redfin.com/city/15686/NJ/Princeton/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
4. https://www.redfin.com/city/7197/NY/Garden-City/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
5. https://www.redfin.com/city/18651/NY/Tarrytown/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
6. https://www.redfin.com/city/26700/CT/Westport/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
Only use redfin_autocomplete as a fallback if a URL returns no results.

STEP 3 \u2014 CROSS-REFERENCE: Compare Zillow and Redfin results by address. Flag:
- \u{1F535} Redfin-only exclusives (not on Zillow)
- \u{1F7E1} Zillow-only exclusives (not on Redfin)
- Note any price discrepancies between platforms

STEP 4 \u2014 DEEP DIVE: For the top 3-5 most interesting properties per area:
- Use property_details (Zillow zpid + location) for zestimate, open house info, listing details
- Use redfin_details (Redfin URL path) for photos, room details, market data

STEP 5 \u2014 X/SOCIAL SIGNALS: Search X for hyper-local real estate intel in each target area:
- x_search("Upper Saddle River NJ home OR house OR listing OR real estate")
- x_search("Montclair NJ real estate OR new listing OR open house")
- x_search("Princeton NJ home OR listing OR real estate market")
- x_search("Garden City NY real estate OR new listing")
- x_search("Tarrytown NY OR Scarsdale NY real estate OR home")
- x_search("Westport CT real estate OR new listing OR open house")
Look for: pocket listings, agent buzz about upcoming listings, local market sentiment, neighborhood chatter, price trend discussions. Note any relevant finds in the Executive Summary under "Social Signals".

STEP 6 \u2014 COMMUTE RESEARCH: For any area where the area note's commute section still has placeholder text ("To be populated") or only rough estimates, use web_search to look up current peak-hour transit schedules (NJ Transit, LIRR, Metro-North) and update the area note with actual commute times to Brookfield Place. Include route, transfers, and total door-to-door time.

For each property include: address, price, beds/baths, sqft, lot size, year built, key features, school district + rating, estimated commute to Brookfield Place (route + transfers + time from area note), days on market, listing URL(s) from both platforms, source (Zillow/Redfin/Both), and WHY it's interesting (1-2 sentences on character/charm/value).

Focus on:
- New listings (< 7 days on market)
- Price reductions
- Back-on-market properties
- Hidden gems: unique architecture, mature landscaping, walkable location, overlooked value
- Platform exclusives (listed on one but not the other)

Flag \u2B50 standout properties (great schools + walkable + good commute + character) and save each to "Real Estate/Favorites/{Address slug}.md" with full details using notes_create.

OUTPUT \u2014 Save using notes_create to "Scheduled Reports/Real Estate/{today's date YYYY-MM-DD}-Property-Scan.md":

# Daily Property Scan \u2014 {today's date}

## \u26A1 Executive Summary
- Total new listings found across all areas (Zillow + Redfin combined)
- Platform coverage: X on both, Y Zillow-only, Z Redfin-only
- Top gems of the day (\u2B50 properties)
- Price trends or market observations
- Commute comparison across areas
- \u{1F426} Social Signals: {any notable X chatter about target areas \u2014 pocket listings, agent buzz, market sentiment}

## \u{1F3E1} Upper Saddle River / Bergen County, NJ
{property listings with full details, source noted}

## \u{1F3E1} Montclair, NJ
{property listings with full details, source noted}

## \u{1F3E1} Princeton, NJ
{property listings with full details, source noted}

## \u{1F3E1} Long Island, NY
{property listings with full details, source noted}

## \u{1F3E1} Hudson Valley / Upstate NY
{property listings with full details, source noted}

## \u{1F3E1} Stamford\u2013Westport, CT
{property listings with full details, source noted}

## \u{1F3AF} Top Gems Today
{ranked list of \u2B50 properties with one-line reasons}

STEP 7 \u2014 MARKET OVERVIEW: After saving the scan report, overwrite "Real Estate/Market Overview.md" using notes_create with:
- Market Snapshot: today's date, total listings found, notable market trends
- Area Comparison table: | Area | Listings | Price Range | Avg $/sqft | New (<7d) |
- Commute Comparison: transit route + estimated time per area (from area notes)

After the Market Overview, append any notable new listings to the corresponding area file in "Real Estate/Areas/" using notes_append with a date-stamped header (### YYYY-MM-DD).

If no properties are found in an area, note "No new listings matching criteria" rather than omitting the section.`,
    schedule: { type: "daily", hour: 7, minute: 30 },
    enabled: true
  },
  {
    id: "life-audit",
    name: "Weekly Life Audit",
    agentId: "deep-researcher",
    prompt: `You are running a proactive Life Audit for Rickin's family.

## Your Task
1. Read the constraints register: "About Me/Active Constraints.md"
2. Read all notes in "Vacation Planning/" for upcoming trips
3. Check the calendar for events in the next 60 days using calendar_list
4. For EACH upcoming trip or travel event:
   a. Cross-reference against EVERY active constraint (pregnancy weeks, age limits, passport requirements, visa needs, health restrictions)
   b. Web search for specific policies (airline pregnancy cutoffs, cruise line policies, resort age minimums, entry requirements for destination)
   c. Calculate exact dates/ages/weeks at time of travel
5. Check all Watch Items & Deadlines in the constraints file for approaching deadlines (within 14 days)
6. Check Document Checklist for any missing/unverified items needed before the next trip

## Output Format
Save a report to "Scheduled Reports/Life-Audit/" with:
- \u{1F534} CRITICAL: Conflicts that could prevent travel (denied boarding, expired documents, policy violations)
- \u{1F7E1} WARNING: Items that need attention within 14 days (deadlines, missing documents, insurance windows)
- \u{1F7E2} OK: Confirmed-clear items (gives confidence)
- \u{1F4CB} ACTION ITEMS: Numbered list of specific things Rickin should do, ordered by urgency

Be thorough. Be specific. Calculate exact gestational weeks, exact ages, exact document dates. Don't assume \u2014 verify via web search.`,
    schedule: { type: "weekly", hour: 8, minute: 0, daysOfWeek: [0] },
    enabled: true
  },
  {
    id: "daily-inbox-triage-am",
    name: "Daily Inbox Triage (AM)",
    agentId: "email-drafter",
    prompt: `You are running a daily inbox triage for Rickin. This is an autonomous job \u2014 do NOT use interview forms or ask for confirmation. Process everything directly.

## Step 1: Read Label Structure
Read "Preferences/Gmail Label Structure.md" from the vault using notes_read. This contains all label IDs you'll need.

## Step 2: Scan New Emails
Use email_list with query "in:inbox newer_than:1d" and maxResults 20. This scans only recent emails since roughly the last run. Process up to 50 emails. Track message IDs to avoid duplicates if you make multiple calls with narrower queries.

For each email, read the sender (From), subject, and snippet. If the category is unclear from metadata alone, use email_read to check the body.

## Step 3: Apply Labels
Apply labels using email_label with the label IDs from Step 1. Each email gets a CATEGORY label + an ACTION label:

### Category Rules (apply the FIRST match):
- From contains "@delta.com", "@jetblue.com", "@united.com", "@aa.com", "@spirit.com", "@southwest.com" OR subject contains "flight", "boarding pass", "itinerary" \u2192 Travel/Flights (Label_32)
- Subject contains "reservation", "hotel", "resort", "check-in", "booking" (non-flight) \u2192 Travel/Bookings (Label_31)
- Subject contains "Marriott", "Hilton", "Hyatt", "Airbnb" \u2192 Travel/Hotels (Label_33)
- From contains "@schools.nyc.gov" or "KCicio" OR subject contains "school", "class", "PTA", "curriculum" \u2192 Family/School (Label_22)
- From "pooja.bhatt@gmail.com" \u2192 Family/Pooja (Label_20)
- Subject contains "Reya" or relates to Reya's schedule \u2192 Family/Reya (Label_21)
- Subject contains "baby", "prenatal", "OB", "nursery", "registry" \u2192 Family/Baby (Label_23)
- From contains "@chase.com", "@bankofamerica.com", "@citi.com", "@wellsfargo.com", "@capitalone.com" OR subject contains "bank", "account", "statement" \u2192 Finance/Banking (Label_24)
- From contains "@fidelity.com", "@vanguard.com", "@schwab.com", "@robinhood.com" OR subject contains "investment", "portfolio", "dividend", "401k" \u2192 Finance/Investments (Label_25)
- Subject contains "tax", "W-2", "1099", "TurboTax", "CPA" \u2192 Finance/Tax (Label_26)
- Subject contains "bill", "invoice", "payment due", "autopay", "utility" \u2192 Finance/Bills (Label_27)
- From contains "@zillow.com", "@redfin.com", "@realtor.com", "@streeteasy.com" OR subject contains "listing", "open house", "property" \u2192 Real Estate/Listings (Label_28)
- Subject contains "mortgage", "pre-approval", "loan", "rate lock" \u2192 Real Estate/Mortgage (Label_30)
- Subject contains "closing", "title", "deed" (real estate) \u2192 Real Estate/Legal (Label_29)
- From contains "@healthfirst.org", "@mycharthealth.com", "@zocdoc.com" OR subject contains "appointment", "prescription", "lab results", "doctor" \u2192 Health (Label_34 for Pooja-related, Label_35 for Rickin-related)
- Subject contains "subscription", "renewal", "your plan", "membership" \u2192 Personal/Subscriptions (Label_36)
- From contains "@amazon.com", "@ebay.com", "@target.com" OR subject contains "order", "shipped", "delivered", "tracking" \u2192 Personal/Shopping (Label_37)
- Subject contains "insurance", "policy", "claim", "coverage", "premium" \u2192 Personal/Insurance (Label_38)

### Action Rules (apply ONE per email):
- Needs a response or decision from Rickin \u2192 \u26A1 Action Required (Label_16)
- Rickin sent something and is waiting for reply \u2192 \u23F3 Waiting On (Label_17)
- Confirms a scheduled event/appointment \u2192 \u{1F4C5} Scheduled (Label_18)
- Informational only, no action needed \u2192 \u{1F501} Reference (Label_19)

## Step 4: Auto-Archive
After labeling, archive (email_archive) these:
- From "@linkedin.com" with subject containing "invitation", "endorsed", "who viewed", "new connection"
- From marketing/noreply addresses (sender contains "noreply@", "no-reply@", "marketing@", "news@", "promo@")
- Calendar sharing notifications ("added you to the shared calendar", "shared a calendar")
- Newsletters \u2014 if the body or snippet mentions "unsubscribe" and the sender is not a known contact (family, school, financial institution)

Do NOT archive:
- Anything labeled \u26A1 Action Required (Label_16)
- Emails from Pooja, family, school, or financial institutions with action items
- Security alerts from Google, Apple, or banks \u2014 always keep these in inbox
- Anything you're unsure about \u2014 when in doubt, leave it in inbox

## Step 5: Save Triage Log
Save a lightweight log using notes_create to "Scheduled Reports/Inbox Cleanup/{today YYYY-MM-DD}-AM-triage.md":

# Inbox Triage \u2014 {date} AM

- Emails processed: X
- Labeled: X
- Archived: X
- Action items left in inbox: X

### Action Items
1. [Subject] \u2014 [Sender] \u2014 reason flagged

Process everything autonomously. Be thorough but efficient.`,
    schedule: { type: "daily", hour: 6, minute: 0 },
    enabled: true
  },
  {
    id: "daily-inbox-triage-pm",
    name: "Daily Inbox Triage (PM)",
    agentId: "email-drafter",
    prompt: `You are running a daily inbox triage for Rickin. This is an autonomous job \u2014 do NOT use interview forms or ask for confirmation. Process everything directly.

## Step 1: Read Label Structure
Read "Preferences/Gmail Label Structure.md" from the vault using notes_read. This contains all label IDs you'll need.

## Step 2: Scan New Emails
Use email_list with query "in:inbox newer_than:1d" and maxResults 20. This scans only recent emails since roughly the last run. Process up to 50 emails. Track message IDs to avoid duplicates if you make multiple calls with narrower queries.

For each email, read the sender (From), subject, and snippet. If the category is unclear from metadata alone, use email_read to check the body.

## Step 3: Apply Labels
Apply labels using email_label with the label IDs from Step 1. Each email gets a CATEGORY label + an ACTION label:

### Category Rules (apply the FIRST match):
- From contains "@delta.com", "@jetblue.com", "@united.com", "@aa.com", "@spirit.com", "@southwest.com" OR subject contains "flight", "boarding pass", "itinerary" \u2192 Travel/Flights (Label_32)
- Subject contains "reservation", "hotel", "resort", "check-in", "booking" (non-flight) \u2192 Travel/Bookings (Label_31)
- Subject contains "Marriott", "Hilton", "Hyatt", "Airbnb" \u2192 Travel/Hotels (Label_33)
- From contains "@schools.nyc.gov" or "KCicio" OR subject contains "school", "class", "PTA", "curriculum" \u2192 Family/School (Label_22)
- From "pooja.bhatt@gmail.com" \u2192 Family/Pooja (Label_20)
- Subject contains "Reya" or relates to Reya's schedule \u2192 Family/Reya (Label_21)
- Subject contains "baby", "prenatal", "OB", "nursery", "registry" \u2192 Family/Baby (Label_23)
- From contains "@chase.com", "@bankofamerica.com", "@citi.com", "@wellsfargo.com", "@capitalone.com" OR subject contains "bank", "account", "statement" \u2192 Finance/Banking (Label_24)
- From contains "@fidelity.com", "@vanguard.com", "@schwab.com", "@robinhood.com" OR subject contains "investment", "portfolio", "dividend", "401k" \u2192 Finance/Investments (Label_25)
- Subject contains "tax", "W-2", "1099", "TurboTax", "CPA" \u2192 Finance/Tax (Label_26)
- Subject contains "bill", "invoice", "payment due", "autopay", "utility" \u2192 Finance/Bills (Label_27)
- From contains "@zillow.com", "@redfin.com", "@realtor.com", "@streeteasy.com" OR subject contains "listing", "open house", "property" \u2192 Real Estate/Listings (Label_28)
- Subject contains "mortgage", "pre-approval", "loan", "rate lock" \u2192 Real Estate/Mortgage (Label_30)
- Subject contains "closing", "title", "deed" (real estate) \u2192 Real Estate/Legal (Label_29)
- From contains "@healthfirst.org", "@mycharthealth.com", "@zocdoc.com" OR subject contains "appointment", "prescription", "lab results", "doctor" \u2192 Health (Label_34 for Pooja-related, Label_35 for Rickin-related)
- Subject contains "subscription", "renewal", "your plan", "membership" \u2192 Personal/Subscriptions (Label_36)
- From contains "@amazon.com", "@ebay.com", "@target.com" OR subject contains "order", "shipped", "delivered", "tracking" \u2192 Personal/Shopping (Label_37)
- Subject contains "insurance", "policy", "claim", "coverage", "premium" \u2192 Personal/Insurance (Label_38)

### Action Rules (apply ONE per email):
- Needs a response or decision from Rickin \u2192 \u26A1 Action Required (Label_16)
- Rickin sent something and is waiting for reply \u2192 \u23F3 Waiting On (Label_17)
- Confirms a scheduled event/appointment \u2192 \u{1F4C5} Scheduled (Label_18)
- Informational only, no action needed \u2192 \u{1F501} Reference (Label_19)

## Step 4: Auto-Archive
After labeling, archive (email_archive) these:
- From "@linkedin.com" with subject containing "invitation", "endorsed", "who viewed", "new connection"
- From marketing/noreply addresses (sender contains "noreply@", "no-reply@", "marketing@", "news@", "promo@")
- Calendar sharing notifications ("added you to the shared calendar", "shared a calendar")
- Newsletters \u2014 if the body or snippet mentions "unsubscribe" and the sender is not a known contact (family, school, financial institution)

Do NOT archive:
- Anything labeled \u26A1 Action Required (Label_16)
- Emails from Pooja, family, school, or financial institutions with action items
- Security alerts from Google, Apple, or banks \u2014 always keep these in inbox
- Anything you're unsure about \u2014 when in doubt, leave it in inbox

## Step 5: Save Triage Log
Save a lightweight log using notes_create to "Scheduled Reports/Inbox Cleanup/{today YYYY-MM-DD}-PM-triage.md":

# Inbox Triage \u2014 {date} PM

- Emails processed: X
- Labeled: X
- Archived: X
- Action items left in inbox: X

### Action Items
1. [Subject] \u2014 [Sender] \u2014 reason flagged

Process everything autonomously. Be thorough but efficient.`,
    schedule: { type: "daily", hour: 18, minute: 0 },
    enabled: true
  },
  {
    id: "baby-dashboard-weekly-update",
    name: "Baby Dashboard Weekly Update",
    agentId: "deep-researcher",
    prompt: `You are updating the Baby Chikki #2 dashboard at rickin.live/pages/baby-dashboard. This is an autonomous job \u2014 do NOT ask for confirmation. Process everything directly.

## Key Facts
- Due date: July 7, 2026 (Week 40)
- OB: Dr. Boester
- Google Sheet: 1fhtMkDSTUlRCFqY4hQiSdZg7cOe4FYNkmOIIHWo4KSU
- Dashboard slug: baby-dashboard

The dashboard HTML auto-calculates week/trimester/countdown/size via inline JS. Your job is to inject LIVE DATA that the static page can't compute on its own: appointments, names, tasks, and checklist progress from Google Sheets.

## Step 1: Pull OB Appointments from Calendar
Use calendar_list with timeMin = today, timeMax = 2026-07-15.
Filter events containing "Dr. Boester", "OB", "appointment", "glucose", "NICU", "nursery", "ultrasound", "tour".
Build a JSON array sorted by date: [{"title":"Video Appointment","date":"2026-03-19","time":"11:00 AM","detail":"Week 25 check-in via video call."},...]
- title: event summary
- date: YYYY-MM-DD format only (no time in date field)
- time: optional, human-readable time if available
- detail: optional one-line description

Always add a final entry: {"title":"\u{1F389} Due Date","date":"2026-07-07","detail":"Baby Chikki #2 arrives! \u{1F499}"}

## Step 2: Pull Data from Google Sheets
Read these tabs from spreadsheet 1fhtMkDSTUlRCFqY4hQiSdZg7cOe4FYNkmOIIHWo4KSU:

### 2a: Timeline (tab "Timeline")
Read range "Timeline!A1:F19". Row 1 = header (week, dates, trimester, development, milestone, status).
Find the current week: the row where column F contains "\u2705 Current Week".
Extract: week number, dates, trimester, development, milestone.

### 2b: Baby Names (tab "Baby Names")
Read range "Baby Names!A1:F16". Columns: A=name, B=meaning, C=origin, D=rickin rating, E=pooja rating, F=notes.
SKIP section header rows where col A == "\u2B50 FAVORITES" or "\u{1F4CB} SHORTLIST".
Favorites = rows where col D contains "\u2B50 Fav" or "\u{1F195} New Fav" or col E contains "\u2B50 Fav".
Build two arrays of {name, meaning} \u2014 favorites and others.
If tab doesn't exist or is empty, skip (HTML has defaults).

### 2c: To-Do List (tab "To-Do List")
Read range "To-Do List!A1:F23". Columns: A=task, B=category, C=due_week, D=owner, E=status, F=notes.
Status values: "\u2B1C Pending", "\u{1F504} In Progress", "\u2705 Done".
Build array: [{"text":"...","priority":"high","week":25,"done":false,"owner":"Rickin","category":"\u{1F3E5} Medical"},...]
Mark done=true if status contains "\u2705 Done".
If tab doesn't exist, skip.

### 2d: Shopping List (tab "Shopping List")
Read range "Shopping List!A1:F40". Columns: A=category, B=item, C=priority, D=status, E=budget, F=notes.
Status values: "\u2B1C Pending", "\u{1F504} In Progress", "\u2705 Done".
Count total items (non-header rows with item in col B) and items where col D contains "\u2705 Done". Format as "X/Y".
If tab doesn't exist, skip.

### 2e: Appointments (tab "Appointments")
Read range "Appointments!A1:E14". Columns: A=date, B=type, C=provider, D=notes, E=status.
Status values: "\u{1F5D3}\uFE0F Upcoming", "\u2B1C Scheduled", "\u2705 Done", "\u{1F38A} Due Date!".
Use this data to SUPPLEMENT the calendar data from Step 1 \u2014 if the Sheet has appointments not found in Calendar, include them. Merge by date, preferring Calendar data for duplicates.
If tab doesn't exist, skip (Step 1 calendar data is still used).

### 2f: Build Checklist Progress Object
Combine counts: {"shoppingDone":"5/39","tasksDone":"3/22"}
If any tab was missing, omit that field.

## Step 3: Inject Data into Dashboard HTML
Read the current file at "Scheduled Reports/baby-dashboard-source.html" using notes_read. If not found, read "data/pages/baby-dashboard.html".

DO NOT regenerate the HTML. Only inject data blocks before </body>. For each data type, if a \`<script id="..."\` block already exists, REPLACE it. Otherwise INSERT before </body>.

### 3a: Appointments
\`<script id="appt-data" type="application/json">[...appointments array...]</script>\`

### 3b: Tasks
\`<script id="tasks-data" type="application/json">[...tasks array...]</script>\`

### 3c: Checklist Progress
\`<script id="checklist-data" type="application/json">{"shoppingDone":"5/39","tasksDone":"3/22"}</script>\`

### 3d: Names (only if Sheets data available)
Find these lines and replace the array contents:
  var defaultFavNames = [...]
  var defaultOtherNames = [...]
Use format: {name:'Kian',meaning:'Ancient / King'}
Escape apostrophes in names/meanings with backslash.

Save the modified HTML using web_save with slug "baby-dashboard".

## Step 4: Output Summary

# Baby Dashboard Update \u2014 {date}
- **Week**: {N} of 40 ({trimester})
- **Appointments**: {count} injected, next: {title} on {date}
- **Names**: {fav count} favorites, {other count} others (source: Sheets / fallback)
- **To-Do**: {done}/{total} complete
- **Shopping List**: {bought}/{total} items
- **Hospital Bag**: {packed}/{total} packed
- **Dashboard**: Updated at rickin.live/pages/baby-dashboard

Process everything autonomously. Be thorough but efficient.`,
    schedule: { type: "weekly", hour: 7, minute: 0, daysOfWeek: [1] },
    enabled: true
  },
  {
    id: "baby-timeline-advance",
    name: "Baby Timeline Auto-Advance",
    agentId: "system",
    prompt: "Advances the \u2705 Current Week marker in the Timeline tab to match the calculated pregnancy week.",
    schedule: { type: "weekly", hour: 23, minute: 59, daysOfWeek: [0] },
    enabled: true
  },
  {
    id: "weekly-inbox-deep-clean",
    name: "Weekly Inbox Deep Clean",
    agentId: "email-drafter",
    prompt: `You are running a weekly deep clean of Rickin's inbox. This is an autonomous job \u2014 do NOT use interview forms or ask for confirmation. Process everything directly.

This job catches anything the daily triage jobs missed and does subscription detection.

## Step 1: Read Label Structure
Read "Preferences/Gmail Label Structure.md" from the vault using notes_read. This contains all label IDs you'll need.

## Step 2: Full Inbox Scan
Use email_list with query "in:inbox" and maxResults 20. This returns the 20 most recent inbox emails. Make additional calls with narrower queries (e.g., "in:inbox older_than:3d", "in:inbox from:linkedin.com", "in:inbox category:promotions") to catch more. Track message IDs to avoid duplicates. Aim for up to 100 emails total.

For each email, read the sender (From), subject, and snippet. If the category is unclear from metadata alone, use email_read to check the body.

## Step 3: Apply Labels (catch-all pass)
Apply labels using email_label with the label IDs from Step 1. Each email gets a CATEGORY label + an ACTION label. Skip emails that already have the correct labels from daily triage.

### Category Rules (apply the FIRST match):
- From contains "@delta.com", "@jetblue.com", "@united.com", "@aa.com", "@spirit.com", "@southwest.com" OR subject contains "flight", "boarding pass", "itinerary" \u2192 Travel/Flights (Label_32)
- Subject contains "reservation", "hotel", "resort", "check-in", "booking" (non-flight) \u2192 Travel/Bookings (Label_31)
- Subject contains "Marriott", "Hilton", "Hyatt", "Airbnb" \u2192 Travel/Hotels (Label_33)
- From contains "@schools.nyc.gov" or "KCicio" OR subject contains "school", "class", "PTA", "curriculum" \u2192 Family/School (Label_22)
- From "pooja.bhatt@gmail.com" \u2192 Family/Pooja (Label_20)
- Subject contains "Reya" or relates to Reya's schedule \u2192 Family/Reya (Label_21)
- Subject contains "baby", "prenatal", "OB", "nursery", "registry" \u2192 Family/Baby (Label_23)
- From contains "@chase.com", "@bankofamerica.com", "@citi.com", "@wellsfargo.com", "@capitalone.com" OR subject contains "bank", "account", "statement" \u2192 Finance/Banking (Label_24)
- From contains "@fidelity.com", "@vanguard.com", "@schwab.com", "@robinhood.com" OR subject contains "investment", "portfolio", "dividend", "401k" \u2192 Finance/Investments (Label_25)
- Subject contains "tax", "W-2", "1099", "TurboTax", "CPA" \u2192 Finance/Tax (Label_26)
- Subject contains "bill", "invoice", "payment due", "autopay", "utility" \u2192 Finance/Bills (Label_27)
- From contains "@zillow.com", "@redfin.com", "@realtor.com", "@streeteasy.com" OR subject contains "listing", "open house", "property" \u2192 Real Estate/Listings (Label_28)
- Subject contains "mortgage", "pre-approval", "loan", "rate lock" \u2192 Real Estate/Mortgage (Label_30)
- Subject contains "closing", "title", "deed" (real estate) \u2192 Real Estate/Legal (Label_29)
- From contains "@healthfirst.org", "@mycharthealth.com", "@zocdoc.com" OR subject contains "appointment", "prescription", "lab results", "doctor" \u2192 Health (Label_34 for Pooja-related, Label_35 for Rickin-related)
- Subject contains "subscription", "renewal", "your plan", "membership" \u2192 Personal/Subscriptions (Label_36)
- From contains "@amazon.com", "@ebay.com", "@target.com" OR subject contains "order", "shipped", "delivered", "tracking" \u2192 Personal/Shopping (Label_37)
- Subject contains "insurance", "policy", "claim", "coverage", "premium" \u2192 Personal/Insurance (Label_38)

### Action Rules (apply ONE per email):
- Needs a response or decision from Rickin \u2192 \u26A1 Action Required (Label_16)
- Rickin sent something and is waiting for reply \u2192 \u23F3 Waiting On (Label_17)
- Confirms a scheduled event/appointment \u2192 \u{1F4C5} Scheduled (Label_18)
- Informational only, no action needed \u2192 \u{1F501} Reference (Label_19)

## Step 4: Auto-Archive
After labeling, archive (email_archive) these:
- From "@linkedin.com" with subject containing "invitation", "endorsed", "who viewed", "new connection"
- From marketing/noreply addresses (sender contains "noreply@", "no-reply@", "marketing@", "news@", "promo@")
- Calendar sharing notifications ("added you to the shared calendar", "shared a calendar")
- Newsletters \u2014 if the body or snippet mentions "unsubscribe" and the sender is not a known contact (family, school, financial institution)

Do NOT archive:
- Anything labeled \u26A1 Action Required (Label_16)
- Emails from Pooja, family, school, or financial institutions with action items
- Security alerts from Google, Apple, or banks \u2014 always keep these in inbox
- Anything you're unsure about \u2014 when in doubt, leave it in inbox

## Step 5: Subscription Detection
While scanning, note any senders that appear to be subscriptions or recurring newsletters. After processing, append detected subscriptions to Google Sheet "Bhatt Family \u2014 Subscriptions & Bills Tracker" (spreadsheet ID: 1j5-EOdfIyqMFewDkXQ09a1o9HZAeSDGv4w52zWa0ELs) in the "Email Subscriptions" tab using sheets_append. Columns: Sender, Email Address, Type (newsletter/subscription/marketing), Frequency (daily/weekly/monthly), First Seen Date. Check existing rows first with sheets_read to avoid duplicates.

## Step 6: Save Weekly Summary
Save a summary report using notes_create to "Scheduled Reports/Inbox Cleanup/{today YYYY-MM-DD}-weekly-summary.md":

# Weekly Inbox Summary \u2014 {date}

## Week at a Glance
- Total emails processed: X
- Labeled: X | Archived: X | Left in inbox: X

## Label Breakdown
| Label | Count |
|-------|-------|
| Travel/Flights | 3 |
| Finance/Bills | 2 |
| Family/School | 4 |
| ... | ... |

## Action Items Remaining
1. [Subject] \u2014 [Sender] \u2014 flagged reason

## New Subscriptions Detected
- sender@domain.com \u2014 "Newsletter Name" \u2014 added to tracker sheet

## Archived Noise
- Xx LinkedIn notifications
- Xx promotional emails
- Xx newsletters

Process everything autonomously. Be thorough but efficient.`,
    schedule: { type: "weekly", hour: 10, minute: 0, daysOfWeek: [6] },
    enabled: true
  },
  {
    id: "birthday-calendar-sync",
    name: "Birthday Calendar Sync",
    agentId: "system",
    prompt: "Reads unsynced rows from the Birthday Tracker sheet and creates recurring annual events in the Birthdays calendar.",
    schedule: { type: "daily", hour: 8, minute: 0 },
    enabled: true
  },
  {
    id: "darknode-inbox-monitor",
    name: "Inbox Monitor (@darknode)",
    agentId: "orchestrator",
    prompt: "",
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 180 },
    enabled: true
  },
  {
    id: "scout-micro-scan",
    name: "SCOUT Micro-Scan",
    agentId: "scout",
    prompt: `Run a MICRO-SCAN cycle. This is a quick data refresh, not a full analysis.

1. Get the current watchlist via scout_watchlist
2. For each asset on the watchlist, run technical_analysis to get updated vote counts
3. Report the results as a brief table:

| Asset | Votes | Score | Regime | Entry Signal | Notes |
|-------|-------|-------|--------|-------------|-------|

4. Flag any assets where:
   - Vote count changed significantly since last scan
   - New entry signal appeared (votes crossed threshold)
   - RSI exit signal appeared (overbought/oversold)

Keep this concise \u2014 it runs every 30 minutes. No thesis generation, no Nansen/X checks, just signal refresh.`,
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 30 },
    enabled: true
  },
  {
    id: "scout-full-cycle",
    name: "SCOUT Full Cycle",
    agentId: "scout",
    prompt: `Run a FULL CYCLE analysis. This is a comprehensive market scan.

1. Check signal_quality FIRST \u2014 review your historical win rate for crypto signals. Note the modifier (boost/penalty/neutral) and factor it into confidence levels below.
2. Start with BTC technical_analysis \u2014 check BTC momentum for alt confirmation filter
3. Check crypto_trending and crypto_movers for candidates
4. Run technical_analysis on top 20 candidates, filter for vote_count >= 3/6
5. Run crypto_backtest on top 5 candidates (30-day data)
6. Check nansen_smart_money on top candidates (gracefully handle if API key not set)
7. Search X for sentiment on top 3 candidates
8. Generate thesis for each candidate meeting entry criteria (votes >= 4/6)
9. CONFIDENCE ADJUSTMENT: If signal_quality shows win rate >60%, you may upgrade MEDIUM\u2192HIGH confidence. If win rate <40%, downgrade HIGH\u2192MEDIUM. Include "Signal quality: X% win rate (N trades)" in thesis reasoning.
10. Include: vote count, technical score, regime, Nansen flow, backtest score, entry/stop/target
11. Provide a brief market overview at the top (BTC dominance, market regime, sector rotations)
12. List any watchlist changes (assets added/removed)

Output the full brief \u2014 the system will save it automatically. Do NOT use notes_create.`,
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 240 },
    enabled: true
  },
  {
    id: "polymarket-activity-scan",
    name: "Polymarket Activity Scan",
    agentId: "polymarket-scout",
    prompt: `Run a POLYMARKET ACTIVITY SCAN. Quick check of whale activity and market movements.

1. Check polymarket_whale_activity for new whale entries in the last 30 minutes
2. Check polymarket_consensus for any markets with 1+ whales aligned
3. For any new consensus, check polymarket_details to get current odds and volume
4. Report results as a brief summary:

**New Whale Activity:** X entries detected
**Active Consensus:** Y markets with 1+ whales

For each consensus market:
- Question, direction, whale count, avg score, current odds

Keep this concise \u2014 it runs every 30 minutes. Only flag actionable consensus.`,
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 30 },
    enabled: true
  },
  {
    id: "polymarket-full-cycle",
    name: "Polymarket Full Cycle",
    agentId: "polymarket-scout",
    prompt: `Run a FULL POLYMARKET CYCLE. Comprehensive prediction market scan.

1. Check signal_quality FIRST \u2014 review your historical win rate for polymarket signals. Note the modifier (boost/penalty/neutral) and factor it into confidence levels below.
2. Get trending markets via polymarket_trending (top 20 by volume)
3. Search specific categories: polymarket_search("crypto"), polymarket_search("politics"), polymarket_search("sports")
4. Filter markets: volume > $50K, odds between 15-85%, resolution > 12h (if volume > $100K) or > 24h
5. Check polymarket_whale_watchlist for tracked wallets
6. Check polymarket_whale_activity for recent whale movements
7. Run polymarket_consensus to detect aligned whale positions
8. Evaluate EACH qualifying market against TIERED thesis criteria (try all tiers top-down):
   - HIGH: 3+ whales aligned, avg score >= 0.8
   - MEDIUM: 2+ whales aligned, avg score >= 0.5
   - SPECULATIVE: 1 whale with score >= 0.7 (single-whale signal)
   - LOW: No whales needed IF volume > $500K AND odds 30-70% (volume-weighted edge)
   For ANY market matching ANY tier, generate thesis via save_pm_thesis with the tier as confidence.
   For LOW theses (volume-only): use empty whale_wallets=[], whale_avg_score=0, total_whale_amount=0.
9. CONFIDENCE ADJUSTMENT: If signal_quality shows win rate >60%, you may upgrade confidence one tier. If win rate <40%, downgrade one tier. Include "Signal quality: X% win rate (N trades)" in thesis reasoning.
10. Check existing polymarket_theses \u2014 retire any that have expired or resolved
11. Search X for sentiment on top markets

IMPORTANT: You MUST generate at least 1 thesis per cycle if ANY market qualifies at ANY tier. Prefer more theses at lower confidence over zero theses.

Output a full brief with:
- Market overview (total volume, trending categories)
- Whale activity summary
- Signal quality feedback (current win rate and modifier)
- New theses generated (with tier/confidence and reasoning)
- Existing theses status update
- Markets that were evaluated but rejected (with which criteria failed)

Do NOT use notes_create \u2014 the system saves automatically.`,
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 240 },
    enabled: true
  },
  {
    id: "bankr-execute",
    name: "BANKR Execute",
    agentId: "bankr",
    prompt: `Run a BANKR EXECUTION CYCLE. Check for actionable theses and execute trades.

1. Check scout_theses for active crypto theses with confidence HIGH or MEDIUM
2. Check polymarket_theses for active polymarket theses with confidence HIGH or MEDIUM
3. For each thesis NOT already associated with an open position (check bankr_positions):
   a. Run bankr_risk_check to validate the trade passes all risk rules
   b. If risk check passes AND tier is "autonomous" or "dead_zone":
      - For autonomous: execute directly via bankr_open_position
      - For dead_zone: execute but note it for Telegram flagging
   c. If tier is "human_required": log the thesis but do NOT execute \u2014 it needs Telegram approval
4. Report execution summary:
   - Theses evaluated (crypto + polymarket)
   - Trades executed (with position IDs)
   - Trades skipped (with reasons)
   - Current portfolio state

Keep this concise. The position monitor handles exits independently.`,
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 30 },
    enabled: true
  },
  {
    id: "weekly-memory-reflect",
    name: "Weekly Memory Reflect",
    agentId: "knowledge-organizer",
    prompt: `Run a WEEKLY MEMORY REFLECTION using Hindsight knowledge graph.

STEP 1: Call memory_reflect to consolidate and analyze all stored memories. This triggers the Hindsight reflect operation which surfaces patterns, recurring themes, and insights.

STEP 2: Call memory_recall with these queries to gather additional context:
- "important decisions and preferences" (top 15)
- "projects and work activities" (top 15)
- "family, personal life, and routines" (top 10)
- "action items and follow-ups" (top 10)

STEP 3: Synthesize the reflect results and recall results into a weekly digest:
- **Key Themes**: What topics dominated this week
- **Decisions Made**: Important choices or directions set
- **Active Projects**: Status of ongoing work
- **Personal**: Family, health, routine updates
- **Open Items**: Things that need follow-up
- **Patterns**: Recurring topics or concerns (from memory_reflect output)
- **Insights**: Meta-observations about activity patterns

Keep it concise and actionable. Save to the vault automatically.`,
    schedule: { type: "weekly", hour: 9, minute: 0, daysOfWeek: [0] },
    enabled: true
  },
  {
    id: "oversight-health",
    name: "Oversight Health Check",
    agentId: "oversight",
    prompt: `Run a scheduled HEALTH CHECK on all Wealth Engines subsystems.

1. Call oversight_health_check \u2014 this evaluates SCOUT freshness, BANKR freshness, Polymarket SCOUT freshness, position monitor heartbeat, kill switch, pause state, circuit breaker, scout data freshness, and recent job failures.
2. Review the report. If overall status is "degraded" or "critical", flag the specific failing checks.
3. If any issues are found, they are auto-captured as improvement requests.
4. Save a brief summary (overall status + any failing checks) to the vault.

Keep the output concise \u2014 just the health status and any action items.`,
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 240 },
    enabled: true
  },
  {
    id: "oversight-weekly",
    name: "Oversight Weekly Review",
    agentId: "oversight",
    prompt: `Run the WEEKLY OVERSIGHT REVIEW for Wealth Engines.

STEP 1: Run oversight_health_check for current system state.
STEP 2: Run oversight_performance_review for 7-day trading performance stats.
STEP 3: Run oversight_cross_domain_exposure to detect crypto-Polymarket correlations.
STEP 4: Check oversight_improvement_queue for open improvement requests.
STEP 5: Check oversight_shadow_performance for shadow trading results.

STEP 6: Run oversight_thesis_review for adversarial bull/bear analysis of all active theses.
STEP 7: Run oversight_per_asset_losses to check for concentrated per-asset losses.

STEP 8: Compile a weekly report with these sections:
- System Health: overall status, any recurring issues this week
- Performance: win rate, total P&L, max drawdown, Sharpe ratio, best/worst trades, slippage
- Per-Asset Analysis: P&L by asset, flag concentrated losses
- Source Analysis: crypto_scout vs polymarket_scout signal quality comparison
- Cross-Domain Exposure: any correlated positions flagged
- Signal Attribution: which signal types contributed to wins vs losses
- Bull/Bear Thesis Review: summary of thesis verdicts from adversarial review
- Improvements: open items, resolved items, new items this week, routing summary
- Shadow Trading: shadow vs live comparison (if shadow trades exist)
- Recommendations: 3-5 specific action items for next week

Save the full report to the vault. Keep it actionable and data-driven.`,
    schedule: { type: "weekly", hour: 8, minute: 30, daysOfWeek: [0] },
    enabled: true
  },
  {
    id: "oversight-daily-summary",
    name: "Oversight Daily Summary",
    agentId: "oversight",
    prompt: `Generate and send the daily performance summary.

1. Call oversight_daily_summary with send_telegram=true to generate and send the daily recap.
2. This covers: portfolio value, drawdown, today's trades, system health, and open issues.
3. Save a brief copy to the vault.

Keep it quick \u2014 the daily summary is meant to be a 30-second glance at the day's results.`,
    schedule: { type: "daily", hour: 20, minute: 0 },
    enabled: true
  },
  {
    id: "oversight-shadow-refresh",
    name: "Oversight Shadow Price Refresh",
    agentId: "oversight",
    prompt: `Refresh shadow trade prices from live market data.

1. Call oversight_shadow_refresh to fetch current market prices for all open shadow trades.
2. This updates hypothetical P&L using real market data and auto-closes trades older than 7 days.
3. If any trades were updated or closed, note the counts.
4. Save a brief summary to the vault.

This ensures shadow/paper trading accurately tracks what BANKR would have earned.`,
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 60 },
    enabled: true
  },
  {
    id: "autoresearch-weekly",
    name: "Autoresearch Strategy Optimization",
    agentId: "scout",
    prompt: `Run the WEEKLY AUTORESEARCH STRATEGY OPTIMIZATION.

1. Call autoresearch_run with domain "both" and experiments_per_domain 15.
2. This runs parameter mutation experiments against crypto signals and polymarket thresholds.
3. Each experiment backtests a parameter variation and keeps improvements >0.5%.
4. Report the results: experiments run, improvements found, score progression, parameters changed.
5. If improvements were found, note which parameters evolved and by how much.
6. Save the full results summary to the vault.

This autonomously evolves trading parameters based on recent market data.`,
    schedule: { type: "weekly", hour: 3, minute: 0, daysOfWeek: [0] },
    enabled: true
  }
];
var config2 = {
  jobs: [...DEFAULT_JOBS],
  lastJobRun: {},
  timezone: "America/New_York"
};
var checkInterval = null;
var jobRunning = false;
var currentRunningJobId = null;
var runAgentFn = null;
var broadcastFn2 = null;
var kbCreateFn = null;
var kbListFn = null;
var kbMoveFn = null;
var dbPoolFn = null;
async function writeJobHistory(jobId, jobName, status, summary, savedTo, durationMs, agentId, modelUsed, tokensInput, tokensOutput) {
  if (!dbPoolFn) return;
  try {
    const pool2 = dbPoolFn();
    await pool2.query(
      `INSERT INTO job_history (job_id, job_name, status, summary, saved_to, duration_ms, agent_id, model_used, tokens_input, tokens_output) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [jobId, jobName, status, summary?.slice(0, 1e3) || null, savedTo, durationMs, agentId || null, modelUsed || null, tokensInput || null, tokensOutput || null]
    );
    await pool2.query(
      `DELETE FROM job_history WHERE id IN (
        SELECT id FROM job_history WHERE job_id = $1 ORDER BY created_at DESC OFFSET 50
      )`,
      [jobId]
    );
  } catch (err) {
    console.warn(`[scheduled-jobs] Failed to write job history:`, err);
  }
}
async function getJobHistory(limit = 20) {
  if (!dbPoolFn) return [];
  try {
    const pool2 = dbPoolFn();
    const result = await pool2.query(
      `SELECT job_id, job_name, status, summary, saved_to, duration_ms, created_at, agent_id, model_used, tokens_input, tokens_output FROM job_history ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch (err) {
    console.warn(`[scheduled-jobs] Failed to read job history:`, err);
    return [];
  }
}
async function getCostSummary() {
  if (!dbPoolFn) return { daily: 0, weekly: 0, monthly: 0, tokensIn: 0, tokensOut: 0, agents: [] };
  try {
    let calcCost2 = function(model, tokIn, tokOut) {
      if (!model || !tokIn) return 0;
      let tier = "sonnet";
      if (model.includes("haiku")) tier = "haiku";
      else if (model.includes("opus")) tier = "opus";
      const r = rates[tier];
      return tokIn / 1e6 * r.input + (tokOut || 0) / 1e6 * r.output;
    };
    var calcCost = calcCost2;
    const pool2 = dbPoolFn();
    const now = /* @__PURE__ */ new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const weekAgo = new Date(now.getTime() - 7 * 864e5).toISOString();
    const monthAgo = new Date(now.getTime() - 30 * 864e5).toISOString();
    const result = await pool2.query(
      `SELECT job_id, job_name, agent_id, model_used, tokens_input, tokens_output, status, created_at FROM job_history WHERE created_at > $1 ORDER BY created_at DESC`,
      [monthAgo]
    );
    const rows = result.rows;
    const rates = {
      haiku: { input: 1, output: 5 },
      sonnet: { input: 3, output: 15 },
      opus: { input: 15, output: 75 }
    };
    let daily = 0, weekly = 0, monthly = 0, tokensIn = 0, tokensOut = 0;
    const agentMap = {};
    for (const r of rows) {
      const cost = calcCost2(r.model_used, r.tokens_input, r.tokens_output);
      monthly += cost;
      tokensIn += r.tokens_input || 0;
      tokensOut += r.tokens_output || 0;
      const created = new Date(r.created_at);
      if (created >= new Date(weekAgo)) weekly += cost;
      if (r.created_at?.slice?.(0, 10) === todayStr || created.toISOString().slice(0, 10) === todayStr) daily += cost;
      const key = r.agent_id || r.job_id;
      if (!agentMap[key]) agentMap[key] = { name: r.job_name, cost: 0, runs: 0, errors: 0, model: null, tokensIn: 0, tokensOut: 0 };
      agentMap[key].cost += cost;
      agentMap[key].runs++;
      if (r.status === "error") agentMap[key].errors++;
      if (r.model_used) agentMap[key].model = r.model_used;
      agentMap[key].tokensIn += r.tokens_input || 0;
      agentMap[key].tokensOut += r.tokens_output || 0;
    }
    const agents2 = Object.entries(agentMap).map(([id, s]) => ({ id, ...s })).sort((a, b) => b.cost - a.cost);
    return { daily, weekly, monthly, tokensIn, tokensOut, agents: agents2, totalRuns: rows.length };
  } catch (err) {
    console.warn(`[scheduled-jobs] Failed to get cost summary:`, err);
    return { daily: 0, weekly: 0, monthly: 0, tokensIn: 0, tokensOut: 0, agents: [], totalRuns: 0 };
  }
}
async function archiveOldReports() {
  if (!kbListFn || !kbMoveFn) return;
  const cutoff = /* @__PURE__ */ new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const folders = [
    { src: "Scheduled Reports/Moody's Intelligence/Daily", dest: "Archive/Moody's Intelligence/Daily" },
    { src: "Scheduled Reports/Moody's Intelligence/Weekly", dest: "Archive/Moody's Intelligence/Weekly" },
    { src: "Scheduled Reports/Real Estate", dest: "Archive/Real Estate" },
    { src: "Scheduled Reports/Life-Audit", dest: "Archive/Life-Audit" },
    { src: "Scheduled Reports/Inbox Cleanup", dest: "Archive/Inbox Cleanup" },
    { src: "Scheduled Reports/Baby Dashboard", dest: "Archive/Baby Dashboard" }
  ];
  let archived = 0;
  for (const { src, dest } of folders) {
    try {
      const listing = await kbListFn(src);
      let files = [];
      try {
        const parsed = JSON.parse(listing);
        files = (parsed.files || []).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }
      for (const filePath of files) {
        const basename = filePath.split("/").pop() || "";
        const dateMatch = basename.match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch && dateMatch[1] < cutoffStr) {
          const destPath = `${dest}/${basename}`;
          try {
            await kbMoveFn(filePath, destPath);
            archived++;
          } catch (e) {
            console.error(`[scheduled-jobs] Archive move failed: ${filePath}`, e);
          }
        }
      }
    } catch {
    }
  }
  if (archived > 0) {
    console.log(`[scheduled-jobs] Archived ${archived} old brief(s)`);
  }
}
async function init8() {
  try {
    const result = await getPool().query(`SELECT value FROM app_config WHERE key = 'scheduled_jobs'`);
    if (result.rows.length > 0) {
      const raw = result.rows[0].value;
      const existingIds = new Set((raw.jobs || []).map((j) => j.id));
      const mergedJobs = [...raw.jobs || []];
      for (const preset of DEFAULT_JOBS) {
        if (!existingIds.has(preset.id)) {
          mergedJobs.push(preset);
        }
      }
      config2 = {
        ...config2,
        ...raw,
        jobs: mergedJobs,
        lastJobRun: raw.lastJobRun || {}
      };
      const kbJob = config2.jobs.find((j) => j.id === "kb-organizer");
      if (kbJob && kbJob.prompt.includes("Find and remove empty folders")) {
        const preset = DEFAULT_JOBS.find((j) => j.id === "kb-organizer");
        kbJob.prompt = preset.prompt;
        await saveConfig2();
      }
      const intelJob = config2.jobs.find((j) => j.id === "moodys-daily-intel");
      if (intelJob && intelJob.prompt.includes("AFTER saving the brief, update competitor")) {
        const preset = DEFAULT_JOBS.find((j) => j.id === "moodys-daily-intel");
        intelJob.prompt = preset.prompt;
        console.log("[scheduled-jobs] Migrated moodys-daily-intel: removed profile update step (now handled by moodys-profile-updates)");
        await saveConfig2();
      }
      const scanJob = config2.jobs.find((j) => j.id === "real-estate-daily-scan");
      if (scanJob && (scanJob.prompt.includes("minPrice=1500000") || scanJob.prompt.includes("$1.5M\u2013$2M") || scanJob.prompt.includes("minBeds=5"))) {
        const preset = DEFAULT_JOBS.find((j) => j.id === "real-estate-daily-scan");
        scanJob.prompt = preset.prompt;
        console.log("[scheduled-jobs] Migrated real-estate-daily-scan: updated budget to $1.3M\u2013$1.8M, 4+ bed, added commute/market-overview steps");
        await saveConfig2();
      }
      const pmFullCycle = config2.jobs.find((j) => j.id === "polymarket-full-cycle");
      if (pmFullCycle && pmFullCycle.prompt.includes("score >= 0.6, 2+ whales")) {
        const preset = DEFAULT_JOBS.find((j) => j.id === "polymarket-full-cycle");
        pmFullCycle.prompt = preset.prompt;
        console.log("[scheduled-jobs] Migrated polymarket-full-cycle: updated to tiered threshold criteria (HIGH/MEDIUM/SPECULATIVE/LOW)");
        await saveConfig2();
      }
      const pmActivityScan = config2.jobs.find((j) => j.id === "polymarket-activity-scan");
      if (pmActivityScan && pmActivityScan.prompt.includes("2+ whales aligned")) {
        const preset = DEFAULT_JOBS.find((j) => j.id === "polymarket-activity-scan");
        pmActivityScan.prompt = preset.prompt;
        console.log("[scheduled-jobs] Migrated polymarket-activity-scan: updated to 1+ whale threshold");
        await saveConfig2();
      }
    } else {
      await saveConfig2();
    }
    const alertsResult = await getPool().query(`SELECT value FROM app_config WHERE key = 'alerts'`);
    if (alertsResult.rows.length > 0) {
      config2.timezone = alertsResult.rows[0].value.timezone || "America/New_York";
    }
  } catch (err) {
    console.error("[scheduled-jobs] Init error:", err);
  }
  console.log(`[scheduled-jobs] initialized (${config2.jobs.length} jobs, ${config2.jobs.filter((j) => j.enabled).length} enabled)`);
}
async function saveConfig2() {
  try {
    await getPool().query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ('scheduled_jobs', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(config2), Date.now()]
    );
  } catch (err) {
    console.error("[scheduled-jobs] Save config error:", err);
  }
}
function getJobs() {
  return config2.jobs;
}
function getNextJob() {
  const tz = config2.timezone || "America/New_York";
  const now = /* @__PURE__ */ new Date();
  const nowLocal = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const nowH = nowLocal.getHours();
  const nowM = nowLocal.getMinutes();
  const nowDay = nowLocal.getDay();
  const enabled = config2.jobs.filter((j) => j.enabled);
  if (enabled.length === 0) return null;
  let bestJob = null;
  let bestMinutesAway = Infinity;
  for (const job of enabled) {
    if (job.schedule.type === "interval") {
      const intervalMs = (job.schedule.intervalMinutes || 30) * 6e4;
      const lastRunTime = job.lastRun ? new Date(job.lastRun).getTime() : 0;
      const elapsed = Date.now() - lastRunTime;
      const remaining = Math.max(0, intervalMs - elapsed);
      const mins = Math.ceil(remaining / 6e4);
      if (mins < bestMinutesAway) {
        bestMinutesAway = mins;
        bestJob = job;
      }
      continue;
    }
    const jH = job.schedule.hour;
    const jM = job.schedule.minute;
    if (job.schedule.type === "weekly" && job.schedule.daysOfWeek) {
      for (const dow of job.schedule.daysOfWeek) {
        let dayDiff = dow - nowDay;
        if (dayDiff < 0) dayDiff += 7;
        let mins = dayDiff * 1440 + (jH * 60 + jM) - (nowH * 60 + nowM);
        if (mins <= 0) mins += 7 * 1440;
        if (mins < bestMinutesAway) {
          bestMinutesAway = mins;
          bestJob = job;
        }
      }
    } else {
      let mins = jH * 60 + jM - (nowH * 60 + nowM);
      if (mins <= 0) mins += 1440;
      if (mins < bestMinutesAway) {
        bestMinutesAway = mins;
        bestJob = job;
      }
    }
  }
  if (!bestJob) return null;
  let timeStr;
  if (bestJob.schedule.type === "interval") {
    timeStr = `every ${bestJob.schedule.intervalMinutes || 30}m`;
  } else {
    const h = bestJob.schedule.hour;
    const m = bestJob.schedule.minute;
    const ampm = h < 12 ? "AM" : "PM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    timeStr = `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  }
  return { name: bestJob.name, id: bestJob.id, time: timeStr };
}
function updateConfig2(partial) {
  if (partial.jobs) {
    config2.jobs = partial.jobs;
  }
  if (partial.timezone) {
    config2.timezone = partial.timezone;
  }
  saveConfig2();
  return config2;
}
function updateJob(jobId, updates) {
  const job = config2.jobs.find((j) => j.id === jobId);
  if (!job) return null;
  if (updates.enabled !== void 0) job.enabled = updates.enabled;
  if (updates.name) job.name = updates.name;
  if (updates.prompt) job.prompt = updates.prompt;
  if (updates.schedule) job.schedule = { ...job.schedule, ...updates.schedule };
  if (updates.agentId) job.agentId = updates.agentId;
  saveConfig2();
  return job;
}
function addJob(job) {
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const newJob = { id, ...job };
  config2.jobs.push(newJob);
  saveConfig2();
  return newJob;
}
function removeJob(jobId) {
  const idx = config2.jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) return false;
  config2.jobs.splice(idx, 1);
  for (const key of Object.keys(config2.lastJobRun)) {
    if (key === jobId || key.startsWith(`${jobId}_`)) {
      delete config2.lastJobRun[key];
    }
  }
  saveConfig2();
  return true;
}
function getNow2() {
  const nowStr = (/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: config2.timezone });
  return new Date(nowStr);
}
function getTodayKey2() {
  const now = getNow2();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function shouldJobRun(job, now, nowMinutes, todayKey, dayOfWeek) {
  if (job.schedule.type === "interval") {
    const intervalMs = (job.schedule.intervalMinutes || 30) * 6e4;
    const lastRunTime = job.lastRun ? new Date(job.lastRun).getTime() : 0;
    return Date.now() - lastRunTime >= intervalMs;
  }
  const targetMinutes = job.schedule.hour * 60 + job.schedule.minute;
  if (nowMinutes < targetMinutes || nowMinutes > targetMinutes + 2) return false;
  if (job.schedule.type === "weekly" && job.schedule.daysOfWeek) {
    if (!job.schedule.daysOfWeek.includes(dayOfWeek)) return false;
  }
  const runKey = `${job.id}_${todayKey}`;
  return !config2.lastJobRun[runKey];
}
var BABY_SHEET_ID = "1fhtMkDSTUlRCFqY4hQiSdZg7cOe4FYNkmOIIHWo4KSU";
var BABY_DUE_DATE = /* @__PURE__ */ new Date("2026-07-07T00:00:00");
async function runTimelineAdvance(job) {
  console.log(`[scheduled-jobs] Timeline advance: calculating current week...`);
  try {
    const now = getNow2();
    const msLeft = BABY_DUE_DATE.getTime() - now.getTime();
    const weeksLeft = Math.floor(msLeft / (7 * 24 * 60 * 60 * 1e3));
    const currentWeek = Math.min(40, Math.max(1, 40 - weeksLeft));
    console.log(`[scheduled-jobs] Timeline advance: current pregnancy week = ${currentWeek}`);
    const raw = await sheetsRead(BABY_SHEET_ID, "Timeline!A1:F50");
    const lines = raw.split("\n").filter((l) => l.trim());
    let currentSheetRow = -1;
    let currentWeekLabel = "?";
    let targetSheetRow = -1;
    let targetWeekNum = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const rowMatch = line.match(/^Row\s+(\d+):\s*(.*)/);
      if (!rowMatch) continue;
      const sheetRow = parseInt(rowMatch[1], 10);
      const cols = rowMatch[2].split(" | ").map((c) => c.trim());
      const weekNum = parseInt(cols[0], 10);
      if (isNaN(weekNum)) continue;
      if (cols.length > 5 && cols[5]?.includes("\u2705")) {
        currentSheetRow = sheetRow;
        currentWeekLabel = cols[0];
      }
      if (weekNum === currentWeek) {
        targetSheetRow = sheetRow;
        targetWeekNum = weekNum;
      }
    }
    if (targetSheetRow === -1) {
      console.log(`[scheduled-jobs] Timeline advance: week ${currentWeek} row not found in sheet, skipping`);
      job.lastRun = now.toISOString();
      job.lastResult = `Week ${currentWeek} row not found`;
      job.lastStatus = "error";
      await saveConfig2();
      await writeJobHistory(job.id, job.name, "error", job.lastResult, null, null);
      return;
    }
    if (currentSheetRow === targetSheetRow) {
      console.log(`[scheduled-jobs] Timeline advance: already at week ${currentWeek}, no change needed`);
      job.lastRun = now.toISOString();
      job.lastResult = `Already at week ${currentWeek}`;
      job.lastStatus = "success";
      await saveConfig2();
      await writeJobHistory(job.id, job.name, "success", job.lastResult, null, null);
      return;
    }
    if (currentSheetRow >= 0 && currentSheetRow !== targetSheetRow) {
      const prevWeek = parseInt(currentWeekLabel, 10);
      const oldStatus = prevWeek >= 40 ? "\u{1F38A} Due Jul 7!" : `\u2714\uFE0F Week ${prevWeek}`;
      await sheetsUpdate(BABY_SHEET_ID, `Timeline!F${currentSheetRow}`, [[oldStatus]]);
      console.log(`[scheduled-jobs] Timeline advance: marked row ${currentSheetRow} as "${oldStatus}"`);
    }
    const newStatus = targetWeekNum >= 40 ? "\u{1F38A} Due Jul 7!" : "\u2705 Current Week";
    await sheetsUpdate(BABY_SHEET_ID, `Timeline!F${targetSheetRow}`, [[newStatus]]);
    console.log(`[scheduled-jobs] Timeline advance: set row ${targetSheetRow} (week ${currentWeek}) as "${newStatus}"`);
    job.lastRun = now.toISOString();
    job.lastResult = `Advanced from week ${currentWeekLabel} to week ${currentWeek}`;
    job.lastStatus = "success";
    await saveConfig2();
    await writeJobHistory(job.id, job.name, "success", job.lastResult, null, null);
    if (broadcastFn2) {
      broadcastFn2({
        type: "job_complete",
        jobId: job.id,
        jobName: job.name,
        summary: `Timeline advanced to week ${currentWeek}`,
        timestamp: Date.now()
      });
    }
  } catch (err) {
    console.error(`[scheduled-jobs] Timeline advance error:`, err);
    job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
    job.lastResult = String(err).slice(0, 300);
    job.lastStatus = "error";
    await saveConfig2();
    await writeJobHistory(job.id, job.name, "error", String(err).slice(0, 300), null, null);
  }
}
var BIRTHDAY_SHEET_ID = "1m4T-vniOylUSyVMSirtun5u9M6gJZlXS3iLy5hGxfuY";
var RELATIONSHIP_COLORS = {
  family: "11",
  friend: "9",
  coworker: "10"
};
async function runBirthdayCalendarSync(job) {
  console.log(`[scheduled-jobs] Birthday sync: reading sheet...`);
  const now = getNow2();
  const results = [];
  let created = 0;
  let skipped = 0;
  let errors = 0;
  try {
    const raw = await sheetsRead(BIRTHDAY_SHEET_ID, "Sheet1!A1:F100");
    const lines = raw.split("\n").filter((l) => l.trim());
    const rows = [];
    for (const line of lines) {
      const rowMatch = line.match(/^Row\s+(\d+):\s*(.*)/);
      if (!rowMatch) continue;
      const sheetRow = parseInt(rowMatch[1], 10);
      if (sheetRow === 1) continue;
      const cols = rowMatch[2].split(" | ").map((c) => c.trim());
      rows.push({
        sheetRow,
        name: cols[0] || "",
        relationship: cols[1] || "",
        birthday: cols[2] || "",
        birthYear: cols[3] || "",
        notes: cols[4] || "",
        synced: cols[5] || ""
      });
    }
    const unsynced = rows.filter((r) => r.name && r.birthday && r.synced.toLowerCase() !== "yes");
    if (unsynced.length === 0) {
      console.log(`[scheduled-jobs] Birthday sync: no unsynced rows`);
      job.lastRun = now.toISOString();
      job.lastResult = "No unsynced birthdays";
      job.lastStatus = "success";
      await saveConfig2();
      await writeJobHistory(job.id, job.name, "success", "No unsynced birthdays", null, null);
      return;
    }
    console.log(`[scheduled-jobs] Birthday sync: ${unsynced.length} unsynced row(s) found`);
    const calendarId = await findOrCreateCalendar("Birthdays");
    console.log(`[scheduled-jobs] Birthday sync: using calendar ${calendarId}`);
    for (const row of unsynced) {
      try {
        const parts = row.birthday.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (!parts) {
          console.log(`[scheduled-jobs] Birthday sync: invalid date "${row.birthday}" for ${row.name}, skipping`);
          results.push(`\u26A0\uFE0F Skipped ${row.name}: invalid date "${row.birthday}"`);
          await sheetsUpdate(BIRTHDAY_SHEET_ID, `Sheet1!F${row.sheetRow}`, [["Invalid"]]);
          errors++;
          continue;
        }
        const month = parseInt(parts[1], 10);
        const day = parseInt(parts[2], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) {
          console.log(`[scheduled-jobs] Birthday sync: out-of-range date "${row.birthday}" for ${row.name}, skipping`);
          results.push(`\u26A0\uFE0F Skipped ${row.name}: invalid month/day "${row.birthday}"`);
          await sheetsUpdate(BIRTHDAY_SHEET_ID, `Sheet1!F${row.sheetRow}`, [["Invalid"]]);
          errors++;
          continue;
        }
        const testDate = new Date(2024, month - 1, day);
        if (testDate.getMonth() !== month - 1 || testDate.getDate() !== day) {
          console.log(`[scheduled-jobs] Birthday sync: non-existent date "${row.birthday}" for ${row.name}, skipping`);
          results.push(`\u26A0\uFE0F Skipped ${row.name}: date doesn't exist "${row.birthday}"`);
          await sheetsUpdate(BIRTHDAY_SHEET_ID, `Sheet1!F${row.sheetRow}`, [["Invalid"]]);
          errors++;
          continue;
        }
        let year = now.getFullYear();
        const thisYearDate = new Date(year, month - 1, day);
        if (thisYearDate < now) {
          year++;
        }
        const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const description = [
          `Relationship: ${row.relationship}`,
          row.birthYear ? `Birth Year: ${row.birthYear}` : "",
          row.notes ? `Notes: ${row.notes}` : ""
        ].filter(Boolean).join("\n");
        const colorId = RELATIONSHIP_COLORS[row.relationship.toLowerCase()] || "9";
        const eventId = await createRecurringEvent(calendarId, {
          summary: `\u{1F382} ${row.name}'s Birthday`,
          date: dateStr,
          description,
          colorId,
          recurrence: ["RRULE:FREQ=YEARLY"],
          reminders: {
            useDefault: false,
            overrides: [{ method: "popup", minutes: 0 }]
          }
        });
        try {
          await sheetsUpdate(BIRTHDAY_SHEET_ID, `Sheet1!F${row.sheetRow}`, [["Yes"]]);
        } catch (markErr) {
          console.error(`[scheduled-jobs] Birthday sync: event created for ${row.name} (${eventId}) but failed to mark sheet \u2014 may create duplicate on next run`);
        }
        results.push(`\u2705 ${row.name} \u2014 ${row.birthday} (${row.relationship})`);
        created++;
        console.log(`[scheduled-jobs] Birthday sync: created event for ${row.name} (${eventId})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[scheduled-jobs] Birthday sync error for ${row.name}:`, msg);
        results.push(`\u274C ${row.name}: ${msg.slice(0, 100)}`);
        errors++;
      }
    }
    const summary = `Synced ${created}, skipped/errors ${errors + skipped}`;
    job.lastRun = now.toISOString();
    job.lastResult = summary;
    job.lastStatus = errors > 0 && created === 0 ? "error" : errors > 0 ? "partial" : "success";
    await saveConfig2();
    const reportContent = `# Birthday Calendar Sync
*${now.toLocaleString("en-US", { timeZone: "America/New_York" })}*

## Results
- Created: ${created}
- Errors: ${errors}

${results.join("\n")}`;
    const savePath = getJobSavePath(job.id, getTodayKey2(), "Birthday-Sync");
    if (kbCreateFn) {
      try {
        await kbCreateFn(savePath, reportContent);
      } catch {
      }
    }
    await writeJobHistory(job.id, job.name, job.lastStatus, summary, savePath, null);
    if (broadcastFn2) {
      broadcastFn2({
        type: "job_complete",
        jobId: job.id,
        jobName: job.name,
        summary,
        timestamp: Date.now()
      });
    }
    console.log(`[scheduled-jobs] Birthday sync complete: ${summary}`);
  } catch (err) {
    console.error(`[scheduled-jobs] Birthday sync error:`, err);
    job.lastRun = now.toISOString();
    job.lastResult = String(err).slice(0, 300);
    job.lastStatus = "error";
    await saveConfig2();
    await writeJobHistory(job.id, job.name, "error", String(err).slice(0, 300), null, null);
  }
}
async function runInboxMonitor(job) {
  console.log(`[scheduled-jobs] Inbox monitor: checking for @darknode emails...`);
  let emails;
  try {
    emails = await getDarkNodeEmails();
  } catch (err) {
    console.error("[scheduled-jobs] Inbox monitor: failed to fetch emails:", err);
    job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
    job.lastResult = `Error fetching emails: ${err}`;
    job.lastStatus = "error";
    await saveConfig2();
    return;
  }
  if (emails.length === 0) {
    console.log("[scheduled-jobs] Inbox monitor: no new @darknode emails");
    job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
    job.lastResult = "No new @darknode emails found";
    job.lastStatus = "success";
    await saveConfig2();
    return;
  }
  console.log(`[scheduled-jobs] Inbox monitor: found ${emails.length} @darknode email(s)`);
  const results = [];
  for (const email of emails) {
    const prompt = `You received a forwarded email with a @darknode instruction. Process it accordingly.

**Instruction**: ${email.instruction}

**Email Details**:
- Subject: ${email.subject}
- From: ${email.from}
- Date: ${email.date}

**Email Body**:
${email.body}

Process the email content according to the instruction "${email.instruction}". Common instructions:
- "add to KB" / "save" = Save the email content as a well-organized note in the knowledge base
- "summarize" = Create a concise summary and save it
- "add to calendar" = Extract event details and create calendar events
- "action items" / "tasks" = Extract action items and create tasks
- For any other instruction, use your best judgment to fulfill the request

After processing, briefly confirm what you did.`;
    try {
      const agentResult = await runAgentFn(job.agentId === "orchestrator" ? "deep-researcher" : job.agentId, prompt);
      results.push(`## ${email.subject}
**Instruction**: ${email.instruction}
**Result**: ${agentResult.response}`);
      await markDarkNodeProcessed(email.messageId);
      console.log(`[scheduled-jobs] Inbox monitor: processed "${email.subject}" (${email.instruction})`);
    } catch (err) {
      results.push(`## ${email.subject}
**Instruction**: ${email.instruction}
**Error**: ${err}`);
      console.error(`[scheduled-jobs] Inbox monitor: failed to process "${email.subject}":`, err);
    }
  }
  const fullResult = results.join("\n\n---\n\n");
  job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
  job.lastResult = fullResult.slice(0, 500);
  job.lastStatus = results.some((r) => r.includes("**Error**")) ? "partial" : "success";
  await saveConfig2();
  let inboxSavePath = null;
  if (kbCreateFn) {
    const todayKey = getTodayKey2();
    const timestamp = (/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: config2.timezone }).replace(/[/:]/g, "-").replace(/,\s*/g, "_");
    inboxSavePath = `Scheduled Reports/Inbox Monitor/${todayKey}-${timestamp}.md`;
    try {
      await kbCreateFn(inboxSavePath, `# Inbox Monitor Results
*Processed: ${(/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: config2.timezone })}*
*Emails processed: ${emails.length}*

${fullResult}`);
    } catch {
    }
    try {
      await writeJobStatus(job.id, { lastRun: job.lastRun, status: job.lastStatus, savedTo: inboxSavePath, error: null });
    } catch {
    }
  }
  await writeJobHistory(job.id, job.name, job.lastStatus || "success", `Processed ${emails.length} email(s)`, inboxSavePath, null);
  if (broadcastFn2) {
    broadcastFn2({
      type: "job_complete",
      jobId: job.id,
      jobName: job.name,
      summary: `Processed ${emails.length} @darknode email(s): ${emails.map((e) => e.instruction).join(", ")}`,
      timestamp: Date.now()
    });
  }
}
var WEALTH_ENGINE_AGENTS = /* @__PURE__ */ new Set(["scout", "bankr", "polymarket-scout", "oversight"]);
async function isWealthEnginesPaused() {
  try {
    const pool2 = dbPoolFn ? dbPoolFn() : getPool();
    const res = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_paused'`);
    return res.rows.length > 0 && res.rows[0].value === true;
  } catch {
    return false;
  }
}
async function checkJobs() {
  if (jobRunning || !runAgentFn) return;
  const now = getNow2();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todayKey = getTodayKey2();
  const dayOfWeek = now.getDay();
  let wePaused = null;
  for (const job of config2.jobs) {
    if (!job.enabled) continue;
    if (!shouldJobRun(job, now, nowMinutes, todayKey, dayOfWeek)) continue;
    if (WEALTH_ENGINE_AGENTS.has(job.agentId)) {
      if (wePaused === null) wePaused = await isWealthEnginesPaused();
      if (wePaused) {
        console.log(`[scheduled-jobs] Skipping ${job.name} \u2014 Wealth Engines paused`);
        continue;
      }
    }
    if (job.schedule.type !== "interval") {
      const runKey = `${job.id}_${todayKey}`;
      config2.lastJobRun[runKey] = true;
      await saveConfig2();
    }
    jobRunning = true;
    currentRunningJobId = job.id;
    console.log(`[scheduled-jobs] Running job: ${job.name} (${job.id})`);
    if (broadcastFn2) {
      broadcastFn2({
        type: "job_start",
        jobId: job.id,
        jobName: job.name,
        timestamp: Date.now()
      });
    }
    try {
      if (job.id === "darknode-inbox-monitor") {
        await runInboxMonitor(job);
      } else if (job.id === "baby-timeline-advance") {
        await runTimelineAdvance(job);
      } else if (job.id === "birthday-calendar-sync") {
        await runBirthdayCalendarSync(job);
      } else {
        const jobStartMs = Date.now();
        const progressCb = (info) => {
          if (broadcastFn2) {
            broadcastFn2({ type: "job_progress", jobId: job.id, jobName: job.name, toolName: info.toolName, timestamp: Date.now() });
          }
        };
        const agentResult = await runAgentFn(job.agentId, job.prompt, progressCb);
        const result = agentResult.response;
        const isPartial = agentResult.timedOut || result.includes("\u26A0\uFE0F PARTIAL");
        job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
        job.lastResult = result.slice(0, 500);
        job.lastStatus = isPartial ? "partial" : "success";
        await saveConfig2();
        const dateStr = todayKey;
        const safeName = job.name.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "-");
        const savePath = getJobSavePath(job.id, dateStr, safeName);
        let vaultSaved = false;
        if (kbCreateFn) {
          try {
            await kbCreateFn(savePath, `# ${job.name}
*Generated: ${(/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: config2.timezone })}*

${result}`);
            vaultSaved = true;
          } catch (e) {
            console.error(`[scheduled-jobs] Failed to save to vault:`, e);
          }
          try {
            await writeJobStatus(job.id, { lastRun: job.lastRun, status: job.lastStatus, savedTo: vaultSaved ? savePath : null, error: vaultSaved ? null : "vault save failed" });
          } catch {
          }
        }
        if (broadcastFn2) {
          broadcastFn2({
            type: "job_complete",
            jobId: job.id,
            jobName: job.name,
            summary: result.slice(0, 300),
            savedTo: vaultSaved ? savePath : null,
            status: job.lastStatus,
            timestamp: Date.now()
          });
          if (job.id === "life-audit" && result.includes("\u{1F534} CRITICAL")) {
            const criticalLine = result.split("\n").find((l) => l.includes("\u{1F534} CRITICAL")) || "Critical finding detected";
            broadcastFn2({
              type: "alert",
              alertType: "life-audit-critical",
              title: "\u{1F534} Life Audit: Critical Finding",
              content: criticalLine.slice(0, 300),
              timestamp: Date.now()
            });
            console.log(`[scheduled-jobs] Life Audit CRITICAL alert broadcast`);
          }
        }
        console.log(`[scheduled-jobs] Job completed${isPartial ? " (partial)" : ""}: ${job.name}`);
        await writeJobHistory(job.id, job.name, job.lastStatus || "success", result.slice(0, 500), vaultSaved ? savePath : null, Date.now() - jobStartMs, agentResult.agentId, agentResult.modelUsed, agentResult.tokensUsed?.input, agentResult.tokensUsed?.output);
        sendJobCompletionNotification({
          jobId: job.id,
          jobName: job.name,
          status: job.lastStatus || "success",
          summary: result.slice(0, 500),
          durationMs: Date.now() - jobStartMs
        }).catch((err) => console.warn("[scheduled-jobs] Telegram notification failed:", err));
        if (job.id === "scout-full-cycle" || job.id === "scout-micro-scan") {
          try {
            const pool2 = dbPoolFn ? dbPoolFn() : null;
            if (pool2) {
              const briefKey = job.id === "scout-full-cycle" ? "scout_latest_brief" : "scout_latest_micro_scan";
              await pool2.query(
                `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
                [briefKey, JSON.stringify(result.slice(0, 1e4)), Date.now()]
              );
              console.log(`[scheduled-jobs] Saved SCOUT brief to ${briefKey}`);
            }
          } catch (e) {
            console.warn(`[scheduled-jobs] Failed to save SCOUT brief:`, e);
          }
        }
        if ((job.id.startsWith("moodys") || job.id.startsWith("real-estate") || job.id === "life-audit" || job.id === "weekly-inbox-deep-clean" || job.id === "baby-dashboard-weekly-update") && kbListFn && kbMoveFn) {
          await archiveOldReports();
        }
      }
    } catch (err) {
      job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
      job.lastResult = String(err);
      job.lastStatus = "error";
      await saveConfig2();
      if (kbCreateFn) {
        try {
          await writeJobStatus(job.id, { lastRun: job.lastRun, status: "error", savedTo: null, error: String(err).slice(0, 300) });
        } catch {
        }
      }
      await writeJobHistory(job.id, job.name, "error", String(err).slice(0, 500), null, null);
      if (broadcastFn2) {
        broadcastFn2({
          type: "job_complete",
          jobId: job.id,
          jobName: job.name,
          summary: String(err).slice(0, 200),
          savedTo: null,
          status: "error",
          timestamp: Date.now()
        });
      }
      sendJobCompletionNotification({
        jobId: job.id,
        jobName: job.name,
        status: "error",
        summary: String(err).slice(0, 500)
      }).catch((e) => console.warn("[scheduled-jobs] Telegram error notification failed:", e));
      console.error(`[scheduled-jobs] Job failed: ${job.name}`, err);
    } finally {
      jobRunning = false;
      currentRunningJobId = null;
    }
  }
  const keys = Object.keys(config2.lastJobRun);
  if (keys.length > 100) {
    const sorted = keys.sort();
    for (let i = 0; i < keys.length - 50; i++) {
      delete config2.lastJobRun[sorted[i]];
    }
    saveConfig2();
  }
}
function startJobSystem(runAgent, broadcast, kbCreate2, kbList2, kbMove2, getDbPool) {
  runAgentFn = runAgent;
  broadcastFn2 = broadcast;
  kbCreateFn = kbCreate2 || null;
  kbListFn = kbList2 || null;
  kbMoveFn = kbMove2 || null;
  dbPoolFn = getDbPool || null;
  checkInterval = setInterval(() => {
    checkJobs().catch((err) => console.error("[scheduled-jobs] Check error:", err));
  }, 6e4);
  const enabledJobs = config2.jobs.filter((j) => j.enabled);
  const jobList = enabledJobs.length > 0 ? enabledJobs.map((j) => {
    if (j.schedule.type === "interval") return `${j.name}/every ${j.schedule.intervalMinutes || 30}m`;
    return `${j.name}/${j.schedule.hour}:${String(j.schedule.minute).padStart(2, "0")}`;
  }).join(", ") : "none enabled";
  console.log(`[scheduled-jobs] System started \u2014 ${jobList} (${config2.timezone})`);
}
function getRunningJob() {
  if (!jobRunning || !currentRunningJobId) return { running: false, jobId: null, jobName: null };
  const job = config2.jobs.find((j) => j.id === currentRunningJobId);
  return { running: true, jobId: currentRunningJobId, jobName: job?.name || null };
}
function stopJobSystem() {
  if (checkInterval) clearInterval(checkInterval);
  runAgentFn = null;
  broadcastFn2 = null;
  console.log("[scheduled-jobs] System stopped");
}
async function triggerJob(jobId) {
  const job = config2.jobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (!runAgentFn) throw new Error("Job system not started");
  if (jobRunning) throw new Error("Another job is currently running");
  jobRunning = true;
  currentRunningJobId = job.id;
  console.log(`[scheduled-jobs] Manual trigger: ${job.name}`);
  if (broadcastFn2) {
    broadcastFn2({ type: "job_start", jobId: job.id, jobName: job.name, timestamp: Date.now() });
  }
  try {
    if (job.id === "darknode-inbox-monitor") {
      await runInboxMonitor(job);
      return job.lastResult || "Inbox monitor completed";
    }
    if (job.id === "baby-timeline-advance") {
      await runTimelineAdvance(job);
      return job.lastResult || "Timeline advance completed";
    }
    if (job.id === "birthday-calendar-sync") {
      await runBirthdayCalendarSync(job);
      return job.lastResult || "Birthday sync completed";
    }
    const triggerStartMs = Date.now();
    const progressCb = (info) => {
      if (broadcastFn2) {
        broadcastFn2({ type: "job_progress", jobId: job.id, jobName: job.name, toolName: info.toolName, timestamp: Date.now() });
      }
    };
    const agentResult = await runAgentFn(job.agentId, job.prompt, progressCb);
    let result = agentResult.response;
    const isPartial = agentResult.timedOut || result.includes("\u26A0\uFE0F PARTIAL");
    job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
    job.lastResult = result.slice(0, 500);
    job.lastStatus = isPartial ? "partial" : "success";
    await saveConfig2();
    const todayKey = getTodayKey2();
    const safeName = job.name.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "-");
    const savePath = getJobSavePath(job.id, todayKey, safeName);
    if (job.id === "moodys-daily-intel") {
      try {
        const fs7 = await import("fs");
        const path8 = await import("path");
        const briefDir = path8.join(process.cwd(), "data/vault/Scheduled Reports/Moody's Intelligence/Daily");
        if (fs7.existsSync(briefDir)) {
          const files = fs7.readdirSync(briefDir).filter((f) => f.endsWith("-Brief.md") && f > `${todayKey}-Brief.md`).sort().reverse();
          for (const fname of files) {
            const content = fs7.readFileSync(path8.join(briefDir, fname), "utf-8");
            if (content.length > 1e3 && content.includes("## \u{1F3E2}")) {
              result = content;
              console.log(`[scheduled-jobs] Moody's brief: using agent-saved file ${fname} (${result.length} chars)`);
              break;
            }
          }
        }
      } catch (e) {
        console.error("[scheduled-jobs] Moody's brief recovery failed:", e);
      }
    }
    let vaultSaved = false;
    if (kbCreateFn) {
      try {
        await kbCreateFn(savePath, `# ${job.name}
*Generated: ${(/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: config2.timezone })}*

${result}`);
        vaultSaved = true;
      } catch {
      }
      try {
        await writeJobStatus(job.id, { lastRun: job.lastRun, status: job.lastStatus, savedTo: vaultSaved ? savePath : null, error: vaultSaved ? null : "vault save failed" });
      } catch {
      }
    }
    if (job.id === "scout-full-cycle" || job.id === "scout-micro-scan") {
      try {
        const pool2 = dbPoolFn ? dbPoolFn() : null;
        if (pool2) {
          const briefKey = job.id === "scout-full-cycle" ? "scout_latest_brief" : "scout_latest_micro_scan";
          await pool2.query(
            `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
            [briefKey, JSON.stringify(result.slice(0, 1e4)), Date.now()]
          );
          console.log(`[scheduled-jobs] Saved SCOUT brief to ${briefKey} (manual trigger)`);
        }
      } catch (e) {
        console.warn(`[scheduled-jobs] Failed to save SCOUT brief:`, e);
      }
    }
    if ((job.id.startsWith("moodys") || job.id.startsWith("real-estate") || job.id === "life-audit" || job.id === "weekly-inbox-deep-clean" || job.id === "baby-dashboard-weekly-update") && kbListFn && kbMoveFn) {
      await archiveOldReports();
    }
    await writeJobHistory(job.id, job.name, job.lastStatus || "success", result.slice(0, 500), vaultSaved ? savePath : null, Date.now() - triggerStartMs, agentResult.agentId, agentResult.modelUsed, agentResult.tokensUsed?.input, agentResult.tokensUsed?.output);
    sendJobCompletionNotification({
      jobId: job.id,
      jobName: job.name,
      status: job.lastStatus || "success",
      summary: result.slice(0, 500),
      durationMs: Date.now() - triggerStartMs
    }).catch((err) => console.warn("[scheduled-jobs] Telegram notification failed:", err));
    if (broadcastFn2) {
      broadcastFn2({
        type: "job_complete",
        jobId: job.id,
        jobName: job.name,
        summary: result.slice(0, 300),
        savedTo: vaultSaved ? savePath : null,
        status: job.lastStatus,
        timestamp: Date.now()
      });
    }
    return result;
  } catch (err) {
    job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
    job.lastResult = String(err);
    job.lastStatus = "error";
    await saveConfig2();
    if (kbCreateFn) {
      try {
        await writeJobStatus(job.id, { lastRun: job.lastRun, status: "error", savedTo: null, error: String(err).slice(0, 300) });
      } catch {
      }
    }
    await writeJobHistory(job.id, job.name, "error", String(err).slice(0, 500), null, null);
    sendJobCompletionNotification({
      jobId: job.id,
      jobName: job.name,
      status: "error",
      summary: String(err).slice(0, 500)
    }).catch((e) => console.warn("[scheduled-jobs] Telegram error notification failed:", e));
    if (broadcastFn2) {
      broadcastFn2({
        type: "job_complete",
        jobId: job.id,
        jobName: job.name,
        summary: String(err).slice(0, 200),
        savedTo: null,
        status: "error",
        timestamp: Date.now()
      });
    }
    throw err;
  } finally {
    jobRunning = false;
    currentRunningJobId = null;
  }
}

// src/agents/loader.ts
import fs4 from "fs";
import path5 from "path";
var agents = [];
var configPath = "";
var registeredToolNames = null;
function init9(dataDir) {
  configPath = path5.join(dataDir, "agents.json");
  loadAgents();
  let reloadTimer = null;
  try {
    fs4.watch(configPath, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        console.log("[agents] Config file changed \u2014 reloading");
        loadAgents();
        reloadTimer = null;
      }, 500);
    });
  } catch {
    console.warn("[agents] Could not watch agents.json \u2014 using periodic reload");
    setInterval(loadAgents, 6e4);
  }
}
function setRegisteredTools(toolNames) {
  registeredToolNames = new Set(toolNames);
  validateAgentTools();
}
function validateAgentTools() {
  if (!registeredToolNames || agents.length === 0) return;
  for (const agent of agents) {
    const unknownTools = agent.tools.filter((t) => !registeredToolNames.has(t));
    if (unknownTools.length > 0) {
      console.warn(`[agents] WARNING: agent "${agent.id}" references unknown tools: ${unknownTools.join(", ")}`);
    }
  }
}
function loadAgents() {
  try {
    const raw = fs4.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error("[agents] agents.json must be an array");
      return;
    }
    const valid = [];
    for (const entry of parsed) {
      if (!entry.id || !entry.name || !entry.systemPrompt || !Array.isArray(entry.tools)) {
        console.warn(`[agents] Skipping malformed agent entry: ${JSON.stringify(entry.id || entry.name || "unknown")}`);
        continue;
      }
      valid.push({
        id: entry.id,
        name: entry.name,
        description: entry.description || "",
        systemPrompt: entry.systemPrompt,
        tools: entry.tools,
        enabled: entry.enabled !== false,
        timeout: entry.timeout || 120,
        model: entry.model || "default"
      });
    }
    agents = valid;
    console.log(`[agents] Loaded ${agents.length} agents: ${agents.map((a) => a.id).join(", ")}`);
    if (registeredToolNames) validateAgentTools();
  } catch (err) {
    console.error(`[agents] Failed to load agents.json: ${err.message}`);
  }
}
function getAgents() {
  return agents;
}
function getEnabledAgents() {
  return agents.filter((a) => a.enabled);
}
function getAgent(id) {
  return agents.find((a) => a.id === id);
}

// src/agents/orchestrator.ts
import Anthropic3 from "@anthropic-ai/sdk";

// src/obsidian-skills.ts
import fs5 from "fs";
import path6 from "path";
var SKILLS_DIR = path6.join(process.cwd(), "data", "skills");
var CACHE_TTL3 = 24 * 60 * 60 * 1e3;
var GITHUB_BASE = "https://raw.githubusercontent.com/kepano/obsidian-skills/main/skills";
var SKILL_FILES = {
  "obsidian-markdown": `${GITHUB_BASE}/obsidian-markdown/SKILL.md`,
  "json-canvas": `${GITHUB_BASE}/json-canvas/SKILL.md`,
  "obsidian-bases": `${GITHUB_BASE}/obsidian-bases/SKILL.md`,
  "defuddle": `${GITHUB_BASE}/defuddle/SKILL.md`
};
var memoryCache = /* @__PURE__ */ new Map();
function ensureDir() {
  if (!fs5.existsSync(SKILLS_DIR)) {
    fs5.mkdirSync(SKILLS_DIR, { recursive: true });
  }
}
function getCachePath(name) {
  return path6.join(SKILLS_DIR, `${name}.md`);
}
function readDiskCache(name) {
  const p = getCachePath(name);
  const metaPath = p + ".meta";
  try {
    if (!fs5.existsSync(p) || !fs5.existsSync(metaPath)) return null;
    const content = fs5.readFileSync(p, "utf-8");
    const meta = JSON.parse(fs5.readFileSync(metaPath, "utf-8"));
    return { content, fetchedAt: meta.fetchedAt || 0 };
  } catch {
    return null;
  }
}
function writeDiskCache(name, content) {
  ensureDir();
  fs5.writeFileSync(getCachePath(name), content, "utf-8");
  fs5.writeFileSync(getCachePath(name) + ".meta", JSON.stringify({ fetchedAt: Date.now() }), "utf-8");
}
async function fetchSkill(name) {
  const cached2 = memoryCache.get(name);
  if (cached2 && Date.now() - cached2.fetchedAt < CACHE_TTL3) {
    return cached2.content;
  }
  const disk = readDiskCache(name);
  if (disk && Date.now() - disk.fetchedAt < CACHE_TTL3) {
    memoryCache.set(name, disk);
    return disk.content;
  }
  const url = SKILL_FILES[name];
  if (!url) return "";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1e4);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const content = await res.text();
    memoryCache.set(name, { content, fetchedAt: Date.now() });
    writeDiskCache(name, content);
    console.log(`[obsidian-skills] Fetched ${name} (${content.length} bytes)`);
    return content;
  } catch (err) {
    console.warn(`[obsidian-skills] Failed to fetch ${name}: ${err.message}`);
    if (disk) {
      memoryCache.set(name, disk);
      return disk.content;
    }
    return "";
  }
}
async function loadAllSkills() {
  const names = Object.keys(SKILL_FILES);
  await Promise.allSettled(names.map((n) => fetchSkill(n)));
  const loaded = names.filter((n) => memoryCache.has(n) && memoryCache.get(n).content.length > 0);
  console.log(`[obsidian-skills] Loaded ${loaded.length}/${names.length} skills: ${loaded.join(", ")}`);
}
async function getVaultSkillsContext() {
  const parts = [];
  for (const name of Object.keys(SKILL_FILES)) {
    const content = await fetchSkill(name);
    if (content) {
      parts.push(`### ${name}
${content}`);
    }
  }
  if (parts.length === 0) return "";
  return `

---
## Obsidian Vault Formatting Guide
When writing to the vault, follow these Obsidian-flavored markdown conventions:

${parts.join("\n\n")}`;
}
function hasVaultTools(toolNames) {
  const vaultTools = ["notes_create", "notes_read", "notes_list", "notes_append", "notes_search", "notes_move", "notes_delete", "notes_rename_folder", "notes_list_recursive", "notes_file_info"];
  return toolNames.some((t) => vaultTools.includes(t));
}

// src/agents/orchestrator.ts
var MAX_TOOL_ITERATIONS = 15;
var WE_AGENT_IDS = /* @__PURE__ */ new Set(["scout", "bankr", "polymarket-scout", "oversight"]);
function convertToolsToAnthropicFormat(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: toJsonSchema(t.parameters)
  }));
}
function toJsonSchema(typeboxSchema) {
  if (!typeboxSchema) return { type: "object", properties: {} };
  const schema = JSON.parse(JSON.stringify(typeboxSchema));
  delete schema[/* @__PURE__ */ Symbol.for("TypeBox.Kind")];
  removeTypeBoxKeys(schema);
  return schema;
}
function removeTypeBoxKeys(obj) {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    if (key.startsWith("$") && key !== "$ref" && key !== "$defs") {
      delete obj[key];
    }
    removeTypeBoxKeys(obj[key]);
  }
}
function parseApiError(err) {
  const status = err?.status || err?.statusCode || 0;
  let type = "unknown_error";
  let message = err?.message || String(err);
  try {
    const body = err?.error || err?.body;
    if (body?.error) {
      type = body.error.type || type;
      message = body.error.message || message;
    }
  } catch {
  }
  return { status, type, message };
}
async function runSubAgent(opts) {
  if (!opts.apiKey) throw new Error("Anthropic API key is not configured \u2014 cannot run sub-agents");
  const agent = getAgent(opts.agentId);
  if (!agent) throw new Error(`Agent "${opts.agentId}" not found. Use list_agents to see available agents.`);
  if (!agent.enabled) throw new Error(`Agent "${opts.agentId}" is currently disabled`);
  const startTime = Date.now();
  console.log(`[agent:${agent.id}] started \u2014 "${opts.task.slice(0, 80)}"`);
  const filteredTools = opts.allTools.filter((t) => agent.tools.includes(t.name));
  console.log(`[agent:${agent.id}] tools: ${filteredTools.length} of ${opts.allTools.length} (${filteredTools.map((t) => t.name).join(", ")})`);
  const anthropicTools = convertToolsToAnthropicFormat(filteredTools);
  const toolsUsed = [];
  const client = new Anthropic3({ apiKey: opts.apiKey });
  const modelId = agent.model === "default" ? opts.model || "claude-sonnet-4-6" : agent.model;
  let systemPrompt = agent.systemPrompt;
  if (hasVaultTools(agent.tools)) {
    try {
      const vaultSkills = await getVaultSkillsContext();
      if (vaultSkills) {
        systemPrompt += vaultSkills;
        console.log(`[agent:${agent.id}] injected Obsidian vault skills into system prompt`);
      }
    } catch (err) {
      console.warn(`[agent:${agent.id}] failed to load vault skills: ${err.message}`);
    }
  }
  let userContent = opts.task;
  if (opts.context) userContent = `Context:
${opts.context}

Task:
${opts.task}`;
  const messages = [
    { role: "user", content: userContent }
  ];
  let totalInput = 0;
  let totalOutput = 0;
  let finalResponse = "";
  let softTimeoutSent = false;
  let hardTimedOut = false;
  let containerId;
  const timeoutMs = agent.timeout * 1e3;
  const softTimeoutMs = timeoutMs * 0.8;
  const buildResult = (extra) => ({
    agentId: agent.id,
    agentName: agent.name,
    response: finalResponse || "(No response generated)",
    toolsUsed,
    durationMs: Date.now() - startTime,
    tokensUsed: { input: totalInput, output: totalOutput },
    modelUsed: modelId,
    timedOut: hardTimedOut,
    ...extra || {}
  });
  const iterLimit = WE_AGENT_IDS.has(agent.id) ? 30 : MAX_TOOL_ITERATIONS;
  for (let iteration = 0; iteration < iterLimit; iteration++) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      console.warn(`[agent:${agent.id}] timeout after ${agent.timeout}s`);
      hardTimedOut = true;
      break;
    }
    if (!softTimeoutSent && elapsed > softTimeoutMs) {
      softTimeoutSent = true;
      console.log(`[agent:${agent.id}] soft timeout at 80% \u2014 nudging to save`);
      messages.push({
        role: "user",
        content: "\u26A0\uFE0F TIME WARNING: You are running low on time. Immediately save whatever findings you have so far using notes_create. Prefix the filename with '\u26A0\uFE0F PARTIAL \u2014 ' to indicate incomplete results. Then provide your final summary."
      });
    }
    let apiResponse;
    try {
      const requestParams = {
        model: modelId,
        max_tokens: 16384,
        system: systemPrompt,
        tools: anthropicTools,
        messages
      };
      if (containerId) {
        requestParams.container_id = containerId;
      }
      apiResponse = await client.messages.create(requestParams);
    } catch (err) {
      const parsed = parseApiError(err);
      console.error(`[agent:${agent.id}] API error (${parsed.status}): ${parsed.type} \u2014 ${parsed.message}`);
      if (parsed.status === 400) {
        if (containerId && parsed.message.includes("container")) {
          console.warn(`[agent:${agent.id}] stale container_id \u2014 clearing and retrying`);
          containerId = void 0;
          try {
            apiResponse = await client.messages.create({
              model: modelId,
              max_tokens: 16384,
              system: systemPrompt,
              tools: anthropicTools,
              messages
            });
          } catch (retryErr) {
            const retryParsed = parseApiError(retryErr);
            console.error(`[agent:${agent.id}] retry without container_id also failed: ${retryParsed.message}`);
            finalResponse = finalResponse ? `${finalResponse}

[Agent hit API error: ${retryParsed.message}]` : `Agent "${agent.id}" encountered an API error: ${retryParsed.message}`;
            return buildResult({ error: retryParsed.message });
          }
        } else {
          finalResponse = finalResponse ? `${finalResponse}

[Agent hit API error: ${parsed.message}]` : `Agent "${agent.id}" encountered an API error on iteration ${iteration + 1}: ${parsed.message}`;
          return buildResult({ error: parsed.message });
        }
      }
      if (parsed.status === 429 || parsed.status === 529) {
        console.log(`[agent:${agent.id}] rate limited \u2014 waiting 5s before retry`);
        await new Promise((r) => setTimeout(r, 5e3));
        try {
          const retryParams = {
            model: modelId,
            max_tokens: 16384,
            system: systemPrompt,
            tools: anthropicTools,
            messages
          };
          if (containerId) retryParams.container_id = containerId;
          apiResponse = await client.messages.create(retryParams);
        } catch (retryErr) {
          const retryParsed = parseApiError(retryErr);
          console.error(`[agent:${agent.id}] retry also failed (${retryParsed.status}): ${retryParsed.message}`);
          finalResponse = finalResponse ? `${finalResponse}

[Agent hit API error after retry: ${retryParsed.message}]` : `Agent "${agent.id}" failed after retry: ${retryParsed.message}`;
          return buildResult({ error: retryParsed.message });
        }
      } else {
        finalResponse = finalResponse ? `${finalResponse}

[Agent hit API error: ${parsed.message}]` : `Agent "${agent.id}" encountered an API error: ${parsed.message}`;
        return buildResult({ error: parsed.message });
      }
    }
    if (apiResponse.container_id) {
      containerId = apiResponse.container_id;
    }
    totalInput += apiResponse.usage?.input_tokens || 0;
    totalOutput += apiResponse.usage?.output_tokens || 0;
    const textBlocks = apiResponse.content.filter((b) => b.type === "text");
    const toolBlocks = apiResponse.content.filter((b) => b.type === "tool_use");
    if (textBlocks.length > 0) {
      finalResponse = textBlocks.map((b) => b.text).join("\n");
    }
    if (apiResponse.stop_reason === "end_turn" || toolBlocks.length === 0) {
      break;
    }
    messages.push({ role: "assistant", content: apiResponse.content });
    const toolResults = [];
    for (const toolCall of toolBlocks) {
      const impl = filteredTools.find((t) => t.name === toolCall.name);
      if (!impl) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: `Tool "${toolCall.name}" not available`,
          is_error: true
        });
        continue;
      }
      if (!toolsUsed.includes(toolCall.name)) toolsUsed.push(toolCall.name);
      console.log(`[agent:${agent.id}] calling tool: ${toolCall.name}`);
      if (opts.onProgress) {
        try {
          opts.onProgress({ toolName: toolCall.name, iteration });
        } catch {
        }
      }
      try {
        const result = await impl.execute(toolCall.id, toolCall.input);
        const text = result.content.map((c) => c.text || JSON.stringify(c)).filter(Boolean).join("\n");
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: text || "(empty result)"
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: `Error: ${err.message}`,
          is_error: true
        });
      }
    }
    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }
  }
  if (!finalResponse && messages.length > 1 && !hardTimedOut) {
    try {
      console.log(`[agent:${agent.id}] no final response \u2014 requesting summary`);
      messages.push({ role: "user", content: "Please provide your final summary and findings based on the work you've done so far." });
      const summaryParams = {
        model: modelId,
        max_tokens: 4096,
        system: systemPrompt,
        messages
      };
      if (containerId) summaryParams.container_id = containerId;
      const summaryResponse = await client.messages.create(summaryParams);
      totalInput += summaryResponse.usage?.input_tokens || 0;
      totalOutput += summaryResponse.usage?.output_tokens || 0;
      const summaryText = summaryResponse.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (summaryText) finalResponse = summaryText;
    } catch (err) {
      console.error(`[agent:${agent.id}] summary request failed:`, err.message);
    }
  }
  const durationMs = Date.now() - startTime;
  console.log(`[agent:${agent.id}] completed in ${(durationMs / 1e3).toFixed(1)}s (${toolsUsed.length} tools used, ${totalInput + totalOutput} tokens)`);
  return buildResult();
}

// src/memory-extractor.ts
import Anthropic4 from "@anthropic-ai/sdk";

// src/hindsight.ts
var BASE_URL4 = "https://api.vectorize.io/v1";
var TIMEOUT_MS8 = 15e3;
var MAX_RETRIES2 = 2;
function getConfig2() {
  const apiKey = process.env.VECTORIZE_API_KEY;
  const organizationId = process.env.VECTORIZE_ORG_ID;
  const knowledgeBaseId = process.env.VECTORIZE_KB_ID;
  if (!apiKey || !organizationId || !knowledgeBaseId) return null;
  return { apiKey, organizationId, knowledgeBaseId };
}
function isConfigured8() {
  return getConfig2() !== null;
}
async function apiRequest(method, path8, body, retries = MAX_RETRIES2) {
  const config3 = getConfig2();
  if (!config3) throw new Error("Hindsight not configured: missing VECTORIZE_API_KEY, VECTORIZE_ORG_ID, or VECTORIZE_KB_ID");
  const url = `${BASE_URL4}/org/${config3.organizationId}/knowledgebases/${config3.knowledgeBaseId}${path8}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS8);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        "Authorization": config3.apiKey,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : void 0,
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (retries > 0 && (res.status === 429 || res.status >= 500)) {
        const delay = res.status === 429 ? 2e3 : 1e3;
        await new Promise((r) => setTimeout(r, delay));
        return apiRequest(method, path8, body, retries - 1);
      }
      throw new Error(`Hindsight API ${res.status}: ${text.slice(0, 200)}`);
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return await res.json();
    }
    return await res.text();
  } catch (err) {
    if (err.name === "AbortError") {
      if (retries > 0) return apiRequest(method, path8, body, retries - 1);
      throw new Error("Hindsight API timeout");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
async function retain(params) {
  try {
    await apiRequest("POST", "/memory", {
      text: params.text,
      metadata: params.metadata || {}
    });
    return true;
  } catch (err) {
    console.error("[hindsight] retain failed:", err);
    return false;
  }
}
async function retainBatch(items) {
  let succeeded = 0;
  for (const item of items) {
    const ok = await retain(item);
    if (ok) succeeded++;
  }
  return succeeded;
}
async function recall(params) {
  try {
    const data = await apiRequest("POST", "/memory/retrieve", {
      question: params.query,
      topK: params.topK || 10
    });
    const memories = Array.isArray(data) ? data.map((m) => ({
      text: m.text || m.content || "",
      score: m.score || m.similarity || 0,
      metadata: m.metadata || {},
      createdAt: m.createdAt || m.created_at || void 0
    })) : Array.isArray(data?.results) ? data.results.map((m) => ({
      text: m.text || m.content || "",
      score: m.score || m.similarity || 0,
      metadata: m.metadata || {},
      createdAt: m.createdAt || m.created_at || void 0
    })) : [];
    return { memories };
  } catch (err) {
    console.error("[hindsight] recall failed:", err);
    return { memories: [] };
  }
}
async function reflect() {
  try {
    const data = await apiRequest("POST", "/memory/reflect", {});
    if (data && typeof data === "object") {
      return {
        summary: data.summary || data.text || "Reflection complete.",
        patterns: Array.isArray(data.patterns) ? data.patterns : [],
        insights: Array.isArray(data.insights) ? data.insights : []
      };
    }
    return await reflectLocal();
  } catch (err) {
    if (err?.message?.includes("404") || err?.message?.includes("405") || err?.message?.includes("not found")) {
      console.warn("[hindsight] reflect endpoint not available, using local fallback");
      return await reflectLocal();
    }
    console.error("[hindsight] reflect failed:", err);
    return { summary: "Reflection failed", patterns: [], insights: [] };
  }
}
async function reflectLocal() {
  try {
    const recent = await recall({ query: "What are the most important things I've been working on and thinking about recently?", topK: 50 });
    if (recent.memories.length === 0) {
      return { summary: "No memories stored yet.", patterns: [], insights: [] };
    }
    const memoryTexts = recent.memories.map((m) => m.text);
    const categories = {};
    for (const text of memoryTexts) {
      const lower = text.toLowerCase();
      let cat = "general";
      if (lower.includes("project") || lower.includes("work") || lower.includes("moody")) cat = "work";
      else if (lower.includes("family") || lower.includes("baby") || lower.includes("pooja") || lower.includes("reya")) cat = "family";
      else if (lower.includes("trade") || lower.includes("crypto") || lower.includes("invest") || lower.includes("market")) cat = "finance";
      else if (lower.includes("health") || lower.includes("exercise") || lower.includes("diet")) cat = "health";
      else if (lower.includes("house") || lower.includes("property") || lower.includes("real estate")) cat = "housing";
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(text);
    }
    const patterns = [];
    for (const [cat, items] of Object.entries(categories)) {
      if (items.length >= 3) {
        patterns.push(`${cat}: ${items.length} related memories (frequent topic)`);
      }
    }
    const insights = [];
    if (categories["work"]?.length >= 5) insights.push("Heavy work focus detected \u2014 consider work-life balance check");
    if (categories["finance"]?.length >= 3) insights.push("Active financial decision-making period");
    if (categories["family"]?.length >= 3) insights.push("Family-focused period \u2014 priorities are shifting toward family matters");
    const summary = `Memory digest: ${recent.memories.length} memories analyzed across ${Object.keys(categories).length} categories. ${patterns.length} recurring patterns detected.`;
    return { summary, patterns, insights };
  } catch (err) {
    console.error("[hindsight] reflectLocal failed:", err);
    return { summary: "Reflection failed", patterns: [], insights: [] };
  }
}

// src/memory-extractor.ts
async function extractAndFileInsights(messages, currentProfile) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { profileUpdates: [], actionItems: [], skipReason: "no_api_key" };
  }
  const transcript = messages.filter((m) => m.role !== "system").map((m) => {
    const role = m.role === "user" ? "Rickin" : "Assistant";
    const text = m.text.length > 600 ? m.text.slice(0, 600) + "..." : m.text;
    return `${role}: ${text}`;
  }).join("\n\n");
  if (transcript.length < 50) {
    return { profileUpdates: [], actionItems: [], skipReason: "too_short" };
  }
  try {
    const client = new Anthropic4({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `You analyze conversations between Rickin and his AI assistant to extract new facts worth remembering.

CURRENT PROFILE (already known):
${currentProfile || "(empty)"}

CONVERSATION:
${transcript}

Extract ONLY genuinely new information not already in the profile. Respond with valid JSON:
{
  "profileUpdates": ["string array of new facts about Rickin \u2014 preferences, people, projects, routines, interests, decisions. Each item is a short sentence."],
  "actionItems": ["string array of action items or tasks mentioned \u2014 things to do, follow up on, or remember. Each item is a short sentence."],
  "skipReason": "If nothing new was learned, set this to 'nothing_new'. Otherwise omit this field."
}

Rules:
- Only include facts that are NOT already in the current profile
- Do not include generic observations or AI-side actions
- Action items must be things Rickin needs to do, not things the assistant did
- If the conversation was purely functional (weather check, quick lookup) with no new personal info, return skipReason: "nothing_new"
- Keep each item concise \u2014 one sentence max
- Return ONLY the JSON, no markdown fencing`
      }]
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const result = {
      profileUpdates: Array.isArray(parsed.profileUpdates) ? parsed.profileUpdates : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
      skipReason: parsed.skipReason || void 0
    };
    if (isConfigured8() && !result.skipReason) {
      try {
        const retainItems = [];
        const dateStr = (/* @__PURE__ */ new Date()).toISOString();
        for (const update of result.profileUpdates) {
          retainItems.push({
            text: update,
            metadata: { type: "profile_update", source: "conversation", date: dateStr }
          });
        }
        for (const item of result.actionItems) {
          retainItems.push({
            text: item,
            metadata: { type: "action_item", source: "conversation", date: dateStr }
          });
        }
        if (retainItems.length > 0) {
          const retained = await retainBatch(retainItems);
          result.hindsightRetained = retained;
          console.log(`[memory] Hindsight: retained ${retained}/${retainItems.length} memories`);
        }
      } catch (err) {
        console.warn("[memory] Hindsight dual-write failed (vault still saved):", err);
      }
    }
    return result;
  } catch (err) {
    console.error("[memory-extractor] Extraction failed:", err);
    return { profileUpdates: [], actionItems: [], skipReason: "extraction_error" };
  }
}

// src/defuddle.ts
var STRIP_TAGS = /* @__PURE__ */ new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "object",
  "embed",
  "svg",
  "canvas",
  "template",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "fieldset",
  "nav",
  "footer",
  "header",
  "aside"
]);
var BLOCK_TAGS = /* @__PURE__ */ new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "pre",
  "table",
  "tr",
  "td",
  "th",
  "article",
  "section",
  "main",
  "figure",
  "figcaption"
]);
var AD_PATTERNS = [
  /class="[^"]*\b(ad[s_-]|banner|sponsor|promo|sidebar|popup|modal|cookie|gdpr|newsletter|signup|subscribe)\b[^"]*"/gi,
  /id="[^"]*\b(ad[s_-]|banner|sponsor|sidebar|popup|modal|cookie|gdpr)\b[^"]*"/gi,
  /aria-label="[^"]*\b(advertisement|sponsored|cookie|banner)\b[^"]*"/gi
];
function cleanHtmlToMarkdown(html) {
  if (!html || typeof html !== "string") return "";
  let cleaned = html;
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of STRIP_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    cleaned = cleaned.replace(re, "");
    const selfClose = new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi");
    cleaned = cleaned.replace(selfClose, "");
  }
  for (const pattern of AD_PATTERNS) {
    cleaned = cleaned.replace(new RegExp(`<[a-z]+\\s+[^>]*${pattern.source}[^>]*>[\\s\\S]*?<\\/[a-z]+>`, "gi"), "");
  }
  cleaned = cleaned.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*\balt="([^"]*)"[^>]*\/?>/gi, "![$2]($1)");
  cleaned = cleaned.replace(/<img\b[^>]*\balt="([^"]*)"[^>]*\bsrc="([^"]+)"[^>]*\/?>/gi, "![$1]($2)");
  cleaned = cleaned.replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*\/?>/gi, "![]($1)");
  cleaned = cleaned.replace(/<a\b[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)");
  cleaned = cleaned.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => {
    return "\n" + "#".repeat(parseInt(level)) + " " + stripTags(text).trim() + "\n";
  });
  cleaned = cleaned.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  cleaned = cleaned.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  cleaned = cleaned.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  cleaned = cleaned.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n");
  cleaned = cleaned.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "- " + "$1".trim());
  cleaned = cleaned.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, text) => {
    return stripTags(text).split("\n").map((l) => "> " + l).join("\n");
  });
  cleaned = cleaned.replace(/<br\s*\/?>/gi, "\n");
  cleaned = cleaned.replace(/<hr\s*\/?>/gi, "\n---\n");
  for (const tag of BLOCK_TAGS) {
    cleaned = cleaned.replace(new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "\n");
  }
  cleaned = cleaned.replace(/<[^>]+>/g, "");
  cleaned = cleaned.replace(/&amp;/g, "&");
  cleaned = cleaned.replace(/&lt;/g, "<");
  cleaned = cleaned.replace(/&gt;/g, ">");
  cleaned = cleaned.replace(/&quot;/g, '"');
  cleaned = cleaned.replace(/&#039;/g, "'");
  cleaned = cleaned.replace(/&nbsp;/g, " ");
  cleaned = cleaned.replace(/&#\d+;/g, "");
  cleaned = cleaned.replace(/&\w+;/g, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  cleaned = cleaned.replace(/[ \t]+$/gm, "");
  cleaned = cleaned.replace(/^[ \t]+$/gm, "");
  cleaned = cleaned.trim();
  return cleaned;
}
function stripTags(html) {
  return html.replace(/<[^>]+>/g, "").trim();
}
function looksLikeHtml(content) {
  if (!content) return false;
  const trimmed = content.trim();
  if (trimmed.startsWith("<!DOCTYPE") || trimmed.startsWith("<html") || trimmed.startsWith("<HTML")) return true;
  const tagCount = (trimmed.match(/<[a-zA-Z][^>]*>/g) || []).length;
  return tagCount > 5 && tagCount / trimmed.length > 1e-3;
}

// src/vault-graph.ts
var ops = null;
function init10(vaultOps) {
  ops = vaultOps;
}
function extractWikilinks(markdown) {
  const links = [];
  const seen = /* @__PURE__ */ new Set();
  let inCodeBlock = false;
  let inInlineCode = false;
  const lines = markdown.split("\n");
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    let i = 0;
    while (i < line.length) {
      if (line[i] === "`") {
        inInlineCode = !inInlineCode;
        i++;
        continue;
      }
      if (inInlineCode) {
        i++;
        continue;
      }
      if (line[i] === "\\" && i + 1 < line.length && line[i + 1] === "[") {
        i += 2;
        continue;
      }
      if (line[i] === "[" && i + 1 < line.length && line[i + 1] === "[") {
        const start = i + 2;
        const end = line.indexOf("]]", start);
        if (end === -1) {
          i++;
          continue;
        }
        const raw = line.substring(start, end).trim();
        if (raw.length === 0) {
          i = end + 2;
          continue;
        }
        let linkTarget = raw.includes("|") ? raw.split("|")[0].trim() : raw;
        linkTarget = linkTarget.replace(/\\/g, "/");
        if (linkTarget.includes("..")) {
          i = end + 2;
          continue;
        }
        if (linkTarget.length > 0) {
          if (!linkTarget.endsWith(".md")) linkTarget += ".md";
          const key = linkTarget.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            links.push(linkTarget);
          }
        }
        i = end + 2;
        continue;
      }
      i++;
    }
    inInlineCode = false;
  }
  return links;
}
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
async function resolveVaultPath(link) {
  if (!ops) return null;
  try {
    await ops.read(link);
    return link;
  } catch {
  }
  const withoutExt = link.replace(/\.md$/, "");
  try {
    await ops.read(withoutExt);
    return withoutExt;
  } catch {
  }
  try {
    const allData = await ops.listRecursive("/");
    const parsed = JSON.parse(allData);
    const files = parsed.files || [];
    const baseName = link.split("/").pop()?.toLowerCase() || "";
    for (const f of files) {
      if (f.endsWith("/")) continue;
      const fBase = f.split("/").pop()?.toLowerCase() || "";
      if (fBase === baseName) return f;
    }
  } catch {
  }
  return null;
}
async function graphContext(startPath, maxDepth = 2, tokenBudget = 3e4) {
  if (!ops) throw new Error("Vault graph not initialized");
  const visited = /* @__PURE__ */ new Set();
  const result = [];
  let totalTokens = 0;
  let truncated = false;
  const queue = [{ notePath: startPath, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift();
    const normalizedPath = item.notePath.toLowerCase();
    if (visited.has(normalizedPath)) continue;
    visited.add(normalizedPath);
    let content;
    try {
      content = await ops.read(item.notePath);
    } catch {
      continue;
    }
    const tokens = estimateTokens(content);
    if (totalTokens + tokens > tokenBudget) {
      truncated = true;
      const remaining = tokenBudget - totalTokens;
      if (remaining > 200) {
        const charLimit = remaining * 4;
        result.push({ path: item.notePath, depth: item.depth, content: content.slice(0, charLimit) + "\n\n[...truncated due to token budget]" });
        totalTokens += remaining;
      }
      break;
    }
    totalTokens += tokens;
    result.push({ path: item.notePath, depth: item.depth, content });
    if (item.depth < maxDepth) {
      const links = extractWikilinks(content);
      for (const link of links) {
        const linkNorm = link.toLowerCase();
        if (!visited.has(linkNorm)) {
          const resolved = await resolveVaultPath(link);
          if (resolved) {
            if (!visited.has(resolved.toLowerCase())) {
              queue.push({ notePath: resolved, depth: item.depth + 1 });
            }
          }
        }
      }
    }
  }
  return { notes: result, totalTokens, truncated };
}
async function findRelatedNotes(newNotePath, content, maxResults = 5) {
  if (!ops) return [];
  const newBaseName = newNotePath.split("/").pop()?.replace(/\.md$/, "").toLowerCase() || "";
  const keywords = extractKeywords(newBaseName, content);
  if (keywords.length === 0) return [];
  let allFiles;
  try {
    const data = await ops.listRecursive("/");
    const parsed = JSON.parse(data);
    allFiles = (parsed.files || []).filter((f) => !f.endsWith("/") && f.endsWith(".md"));
  } catch {
    return [];
  }
  const newNorm = newNotePath.toLowerCase().replace(/^\/+/, "");
  const scored = [];
  for (const filePath of allFiles) {
    if (filePath.toLowerCase() === newNorm) continue;
    const fileBaseName = filePath.split("/").pop()?.replace(/\.md$/, "").toLowerCase() || "";
    let score = 0;
    for (const kw of keywords) {
      if (fileBaseName.includes(kw)) score += 3;
    }
    const folderParts = filePath.toLowerCase().split("/").slice(0, -1);
    for (const kw of keywords) {
      for (const part of folderParts) {
        if (part.includes(kw)) {
          score += 1;
          break;
        }
      }
    }
    if (score > 0) {
      scored.push({ filePath, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((s) => s.filePath);
}
function extractKeywords(baseName, content) {
  const stopWords = /* @__PURE__ */ new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "but",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "with",
    "by",
    "from",
    "is",
    "it",
    "as",
    "be",
    "was",
    "are",
    "this",
    "that",
    "not",
    "has",
    "had",
    "have",
    "will",
    "can",
    "do",
    "does",
    "did",
    "been",
    "being",
    "than",
    "its",
    "my",
    "me",
    "we",
    "he",
    "she",
    "they",
    "them",
    "our",
    "you",
    "your",
    "what",
    "which",
    "who",
    "how",
    "when",
    "where",
    "why",
    "all",
    "each",
    "every",
    "both",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "only",
    "very",
    "just",
    "about",
    "up",
    "so",
    "if",
    "then",
    "new",
    "also",
    "one",
    "two",
    "md",
    "http",
    "https",
    "www",
    "com"
  ]);
  const words = /* @__PURE__ */ new Set();
  const nameWords = baseName.replace(/[-_]+/g, " ").split(/\s+/).map((w) => w.toLowerCase()).filter((w) => w.length > 2 && !stopWords.has(w));
  for (const w of nameWords) words.add(w);
  const headings = content.match(/^#{1,3}\s+(.+)$/gm) || [];
  for (const h of headings.slice(0, 5)) {
    const text = h.replace(/^#+\s+/, "");
    const hWords = text.replace(/[-_]+/g, " ").split(/\s+/).map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, "")).filter((w) => w.length > 2 && !stopWords.has(w));
    for (const w of hWords.slice(0, 3)) words.add(w);
  }
  return Array.from(words).slice(0, 8);
}
async function addBidirectionalLinks(newNotePath, newNoteContent) {
  if (!ops) return { linkedTo: [] };
  const related = await findRelatedNotes(newNotePath, newNoteContent);
  if (related.length === 0) return { linkedTo: [] };
  const newBaseName = newNotePath.split("/").pop()?.replace(/\.md$/, "") || newNotePath;
  const newLink = `[[${newNotePath.replace(/\.md$/, "")}|${newBaseName}]]`;
  const relatedLinks = related.map((rp) => {
    const rBaseName = rp.split("/").pop()?.replace(/\.md$/, "") || rp;
    return `[[${rp.replace(/\.md$/, "")}|${rBaseName}]]`;
  });
  const relatedSection = `

---
## Related Notes
${relatedLinks.map((l) => `- ${l}`).join("\n")}
`;
  try {
    await ops.append(newNotePath, relatedSection);
    console.log(`[vault-graph] appended Related Notes section to ${newNotePath}`);
  } catch (err) {
    console.warn(`[vault-graph] failed to append related links to ${newNotePath}: ${err.message}`);
  }
  const backlinkLine = `
- ${newLink}
`;
  for (const rp of related) {
    try {
      const existingContent = await ops.read(rp);
      if (existingContent.includes(`[[${newNotePath.replace(/\.md$/, "")}`) || existingContent.includes(`[[${newBaseName}]]`)) {
        continue;
      }
      const backlinkHeading = "## Backlinks";
      if (existingContent.includes(backlinkHeading)) {
        await ops.append(rp, backlinkLine);
      } else {
        await ops.append(rp, `

---
${backlinkHeading}${backlinkLine}`);
      }
      console.log(`[vault-graph] backlink added: ${rp} \u2190 ${newBaseName}`);
    } catch (err) {
      console.warn(`[vault-graph] failed to add backlink to ${rp}: ${err.message}`);
    }
  }
  return { linkedTo: related };
}

// server.ts
init_oversight();
init_autoresearch();
var PORT = parseInt(process.env.PORT || "5000", 10);
var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
var APP_PASSWORD = process.env.APP_PASSWORD || "";
var POOJA_PASSWORD = process.env.POOJA_PASSWORD || "";
var DARKNODE_PASSWORD = process.env.DARKNODE_PASSWORD || "";
var USERS = {
  rickin: { password: APP_PASSWORD, displayName: "Rickin" },
  pooja: { password: POOJA_PASSWORD, displayName: "Pooja" },
  darknode: { password: DARKNODE_PASSWORD, displayName: "DarkNode" }
};
var SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
var __filename = fileURLToPath(import.meta.url);
var __dirname = path7.dirname(__filename);
var PROJECT_ROOT = __filename.includes("/dist/") ? path7.resolve(__dirname, "..") : __dirname;
var PUBLIC_DIR = path7.join(PROJECT_ROOT, "public");
var AGENT_DIR = path7.join(PROJECT_ROOT, ".pi/agent");
var VAULT_DIR = path7.join(PROJECT_ROOT, "data", "vault");
fs6.mkdirSync(AGENT_DIR, { recursive: true });
init(VAULT_DIR);
init9(path7.join(PROJECT_ROOT, "data"));
loadAllSkills().catch((err) => console.warn("[startup] Failed to preload Obsidian skills:", err));
var useLocalVault = isConfigured2();
setInterval(() => {
  const localAvailable = isConfigured2();
  if (localAvailable && !useLocalVault) {
    useLocalVault = true;
    console.log("[health] Knowledge base: switched to local vault (Obsidian Sync)");
  } else if (!localAvailable && useLocalVault) {
    useLocalVault = false;
    if (isConfigured()) {
      console.warn("[health] Local vault unavailable \u2014 falling back to remote (tunnel)");
    } else {
      console.warn("[health] Local vault unavailable \u2014 no remote fallback configured");
    }
  }
}, 15e3);
if (!ANTHROPIC_KEY) console.warn("ANTHROPIC_API_KEY is not set.");
if (useLocalVault) {
  console.log("[boot] Knowledge base: local vault (Obsidian Sync)");
} else if (isConfigured()) {
  console.log("[boot] Knowledge base: remote (tunnel)");
} else {
  console.warn("Knowledge base integration not configured.");
}
if (!APP_PASSWORD) console.warn("APP_PASSWORD is not set \u2014 auth disabled.");
console.log(`[boot] PORT=${PORT} PUBLIC_DIR=${PUBLIC_DIR} AGENT_DIR=${AGENT_DIR}`);
console.log(`[boot] public/ exists: ${fs6.existsSync(PUBLIC_DIR)}`);
function kbList(p) {
  return useLocalVault ? listNotes2(p) : listNotes(p);
}
function kbRead(p) {
  return useLocalVault ? readNote2(p) : readNote(p);
}
function kbCreate(p, c) {
  return useLocalVault ? createNote2(p, c) : createNote(p, c);
}
function kbAppend(p, c) {
  return useLocalVault ? appendToNote2(p, c) : appendToNote(p, c);
}
function kbSearch(q) {
  return useLocalVault ? searchNotes2(q) : searchNotes(q);
}
function kbDelete(p) {
  return useLocalVault ? deleteNote2(p) : deleteNote(p);
}
function kbMove(from, to) {
  return useLocalVault ? moveNote2(from, to) : moveNote(from, to);
}
function kbRenameFolder(from, to) {
  return useLocalVault ? renameFolder2(from, to) : renameFolder(from, to);
}
function kbListRecursive(p) {
  return useLocalVault ? listRecursive2(p) : listRecursive(p);
}
function kbFileInfo(p) {
  return useLocalVault ? fileInfo2(p) : fileInfo(p);
}
init10({
  read: kbRead,
  list: kbList,
  listRecursive: kbListRecursive,
  append: kbAppend
});
function buildKnowledgeBaseTools() {
  if (!useLocalVault && !isConfigured()) return [];
  return [
    {
      name: "notes_list",
      label: "Notes List",
      description: "List files and folders in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Directory path inside the knowledge base. Defaults to root." }))
      }),
      async execute(_toolCallId, params) {
        const p = params.path ?? "/";
        try {
          const result = await kbList(p);
          console.log(`[vault] notes_list OK: ${p}`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_list FAILED: ${p} \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_read",
      label: "Notes Read",
      description: "Read the markdown content of a note in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the note, e.g. 'Daily Notes/2025-01-15.md'" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await kbRead(params.path);
          console.log(`[vault] notes_read OK: ${params.path}`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_read FAILED: ${params.path} \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_create",
      label: "Notes Create",
      description: "Create or overwrite a note in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.String({ description: "Path for the new note, e.g. 'Ideas/new-idea.md'" }),
        content: Type.String({ description: "Markdown content for the note" })
      }),
      async execute(_toolCallId, params) {
        try {
          let content = params.content;
          if (looksLikeHtml(content)) {
            const cleaned = cleanHtmlToMarkdown(content);
            if (cleaned.length > 0) {
              console.log(`[vault] defuddle: cleaned HTML (${content.length} \u2192 ${cleaned.length} chars)`);
              content = cleaned;
            }
          }
          const result = await kbCreate(params.path, content);
          console.log(`[vault] notes_create OK: ${params.path} (${content.length} chars)`);
          try {
            const linkResult = await addBidirectionalLinks(params.path, content);
            if (linkResult.linkedTo.length > 0) {
              console.log(`[vault-graph] auto-linked ${params.path} to ${linkResult.linkedTo.length} related notes`);
            }
          } catch (linkErr) {
            console.warn(`[vault-graph] bidirectional linking failed (non-fatal): ${linkErr.message}`);
          }
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_create FAILED: ${params.path} \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_append",
      label: "Notes Append",
      description: "Append content to the end of an existing note in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the note to append to" }),
        content: Type.String({ description: "Markdown content to append" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await kbAppend(params.path, params.content);
          console.log(`[vault] notes_append OK: ${params.path} (+${params.content.length} chars)`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_append FAILED: ${params.path} \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_search",
      label: "Notes Search",
      description: "Search for text across all notes in the user's knowledge base. Returns matching notes and snippets.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query string" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await kbSearch(params.query);
          const count = JSON.parse(result).length;
          console.log(`[vault] notes_search OK: "${params.query}" (${count} matches)`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_search FAILED: "${params.query}" \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_delete",
      label: "Notes Delete",
      description: "Permanently delete a note from the user's knowledge base. This cannot be undone. Use when reorganizing notes (e.g. after moving content to a new location). Empty parent folders are cleaned up automatically.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the note to delete (e.g. 'Projects/old-file.md')" })
      }),
      async execute(_toolCallId, params) {
        console.log(`[vault] notes_delete: ${params.path}`);
        try {
          const result = await kbDelete(params.path);
          console.log(`[vault] notes_delete OK: ${params.path}`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_delete FAILED: ${params.path} \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_move",
      label: "Notes Move",
      description: "Move or rename a note in the user's knowledge base. Moves the file from one path to another, creating destination folders as needed. Empty source folders are cleaned up automatically.",
      parameters: Type.Object({
        from: Type.String({ description: "Current path of the note (e.g. 'Projects/old-name.md')" }),
        to: Type.String({ description: "New path for the note (e.g. 'Projects/Subfolder/new-name.md')" })
      }),
      async execute(_toolCallId, params) {
        console.log(`[vault] notes_move: ${params.from} \u2192 ${params.to}`);
        try {
          const result = await kbMove(params.from, params.to);
          console.log(`[vault] notes_move OK: ${params.from} \u2192 ${params.to}`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_move FAILED: ${params.from} \u2192 ${params.to} \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_rename_folder",
      label: "Notes Rename Folder",
      description: "Rename or move an entire folder in the knowledge base. All files and subfolders inside are moved to the new location. Use for reorganizing vault structure.",
      parameters: Type.Object({
        from: Type.String({ description: "Current folder path (e.g. 'Projects/Old Name')" }),
        to: Type.String({ description: "New folder path (e.g. 'Projects/New Name')" })
      }),
      async execute(_toolCallId, params) {
        console.log(`[vault] notes_rename_folder: ${params.from} \u2192 ${params.to}`);
        try {
          const result = await kbRenameFolder(params.from, params.to);
          console.log(`[vault] notes_rename_folder OK: ${params.from} \u2192 ${params.to}`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_rename_folder FAILED: ${params.from} \u2192 ${params.to} \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_list_recursive",
      label: "Notes List Recursive",
      description: "List all files and subfolders within a folder recursively. Unlike notes_list which only shows one level, this shows the entire tree. Useful for auditing folder structure.",
      parameters: Type.Object({
        path: Type.String({ description: "Folder path to list recursively (e.g. 'Projects/' or '/')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await kbListRecursive(params.path);
          const count = JSON.parse(result).files?.length ?? 0;
          console.log(`[vault] notes_list_recursive OK: ${params.path} (${count} items)`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_list_recursive FAILED: ${params.path} \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_file_info",
      label: "Notes File Info",
      description: "Get metadata about a note or folder: file size, creation date, and last modified date. Use to identify stale or oversized notes.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the file or folder (e.g. 'Projects/Research.md')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await kbFileInfo(params.path);
          console.log(`[vault] notes_file_info OK: ${params.path}`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_file_info FAILED: ${params.path} \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_graph_context",
      label: "Notes Graph Context",
      description: "Follow [[wikilinks]] in a note to gather related context. Reads the starting note, extracts all wikilinks, and recursively follows them (breadth-first) up to the specified depth. Returns the combined content of all linked notes. Use this when investigating a vault topic to automatically pull in connected knowledge.",
      parameters: Type.Object({
        path: Type.String({ description: "Starting note path (e.g. 'Projects/Research.md')" }),
        depth: Type.Optional(Type.Number({ description: "Max link-following depth (default 2, max 3)" })),
        token_budget: Type.Optional(Type.Number({ description: "Max estimated tokens to return (default 30000)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const depth = Math.min(Math.max(params.depth ?? 2, 1), 3);
          const budget = Math.min(Math.max(params.token_budget ?? 3e4, 1e3), 6e4);
          const result = await graphContext(params.path, depth, budget);
          const output = result.notes.map(
            (n) => `--- ${n.path} (depth ${n.depth}) ---
${n.content}`
          ).join("\n\n");
          const summary = `Graph traversal from "${params.path}": ${result.notes.length} notes, ~${result.totalTokens} tokens${result.truncated ? " (truncated by budget)" : ""}`;
          console.log(`[vault] notes_graph_context OK: ${summary}`);
          return { content: [{ type: "text", text: `${summary}

${output}` }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_graph_context FAILED: ${params.path} \u2014 ${err.message}`);
          throw err;
        }
      }
    }
  ];
}
function buildGmailTools() {
  if (!isConfigured3()) return [];
  return [
    {
      name: "email_list",
      label: "Email List",
      description: "List recent emails from the user's inbox. Optionally filter with a Gmail search query (e.g. 'is:unread', 'from:someone@example.com', 'subject:meeting').",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Gmail search query to filter emails. Uses Gmail search syntax." })),
        maxResults: Type.Optional(Type.Number({ description: "Maximum number of emails to return (default 10, max 20)." }))
      }),
      async execute(_toolCallId, params) {
        const result = await listEmails(params.query, params.maxResults ?? 10);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_read",
      label: "Email Read",
      description: "Read the full content of a specific email by its message ID. Use email_list first to find the ID.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID to read (from email_list results)." })
      }),
      async execute(_toolCallId, params) {
        const result = await readEmail(params.messageId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_search",
      label: "Email Search",
      description: "Search emails using Gmail search syntax. Supports queries like 'from:name subject:topic after:2025/01/01 has:attachment'.",
      parameters: Type.Object({
        query: Type.String({ description: "Gmail search query string." })
      }),
      async execute(_toolCallId, params) {
        const result = await searchEmails(params.query);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_get_attachment",
      label: "Email Attachment",
      description: "Download and read an email attachment. For PDFs, extracts text content automatically. Specify the email message ID and optionally a filename to target a specific attachment. Use email_read first to see what attachments exist.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID containing the attachment." }),
        attachmentId: Type.Optional(Type.String({ description: "Specific attachment ID (from email_read). If omitted, reads the first attachment." })),
        filename: Type.Optional(Type.String({ description: "Partial filename to match (e.g. 'invoice' to find 'invoice.pdf'). Used if attachmentId not provided." }))
      }),
      async execute(_toolCallId, params) {
        const result = await getAttachment(params.messageId, params.attachmentId, params.filename);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_send",
      label: "Send Email",
      description: "Send a new email. IMPORTANT: Always confirm with the user via interview form BEFORE calling this tool \u2014 show them the recipient, subject, and full body for review. Never auto-send.",
      parameters: Type.Object({
        to: Type.String({ description: "Recipient email address(es), comma-separated for multiple." }),
        subject: Type.String({ description: "Email subject line." }),
        body: Type.String({ description: "Email body text (plain text)." }),
        cc: Type.Optional(Type.String({ description: "CC recipients, comma-separated." })),
        bcc: Type.Optional(Type.String({ description: "BCC recipients, comma-separated." }))
      }),
      async execute(_toolCallId, params) {
        const result = await sendEmail(params.to, params.subject, params.body, params.cc, params.bcc);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_reply",
      label: "Reply to Email",
      description: "Reply to an existing email in-thread with proper threading headers. IMPORTANT: Always confirm with the user via interview form BEFORE calling this tool \u2014 show them the reply body for review. Never auto-send.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID to reply to." }),
        body: Type.String({ description: "Reply body text (plain text)." }),
        replyAll: Type.Optional(Type.Boolean({ description: "If true, reply to all recipients. Default: false (reply to sender only)." }))
      }),
      async execute(_toolCallId, params) {
        const result = await replyToEmail(params.messageId, params.body, params.replyAll ?? false);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_thread",
      label: "Email Thread",
      description: "Read an entire email conversation thread. Returns all messages in order. Get the threadId from email_list or email_read results.",
      parameters: Type.Object({
        threadId: Type.String({ description: "The Gmail thread ID." })
      }),
      async execute(_toolCallId, params) {
        const result = await getThread(params.threadId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_draft",
      label: "Save Email Draft",
      description: "Save a composed email as a Gmail draft without sending it. The draft will appear in Gmail's Drafts folder for later review and sending.",
      parameters: Type.Object({
        to: Type.String({ description: "Recipient email address(es)." }),
        subject: Type.String({ description: "Email subject line." }),
        body: Type.String({ description: "Email body text (plain text)." }),
        cc: Type.Optional(Type.String({ description: "CC recipients, comma-separated." })),
        bcc: Type.Optional(Type.String({ description: "BCC recipients, comma-separated." }))
      }),
      async execute(_toolCallId, params) {
        const result = await createDraft(params.to, params.subject, params.body, params.cc, params.bcc);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_archive",
      label: "Archive Email",
      description: "Archive an email (remove from inbox without deleting). The email remains searchable and in All Mail.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID to archive." })
      }),
      async execute(_toolCallId, params) {
        const result = await archiveEmail(params.messageId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_label",
      label: "Email Labels",
      description: "Add or remove Gmail labels on an email. Use system label IDs (STARRED, IMPORTANT, UNREAD, SPAM, TRASH, CATEGORY_PERSONAL, CATEGORY_SOCIAL, CATEGORY_PROMOTIONS, CATEGORY_UPDATES, CATEGORY_FORUMS) or custom label IDs from gmail_list_labels.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID." }),
        addLabels: Type.Optional(Type.Array(Type.String(), { description: "Label IDs to add." })),
        removeLabels: Type.Optional(Type.Array(Type.String(), { description: "Label IDs to remove." }))
      }),
      async execute(_toolCallId, params) {
        const result = await modifyLabels(params.messageId, params.addLabels, params.removeLabels);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_mark_read",
      label: "Mark Email Read/Unread",
      description: "Mark an email as read or unread.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID." }),
        read: Type.Boolean({ description: "true to mark as read, false to mark as unread." })
      }),
      async execute(_toolCallId, params) {
        const result = await markRead(params.messageId, params.read);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_trash",
      label: "Trash Email",
      description: "Move an email to the trash. It can be recovered from Trash within 30 days.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID to trash." })
      }),
      async execute(_toolCallId, params) {
        const result = await trashEmail(params.messageId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "gmail_list_labels",
      label: "List Gmail Labels",
      description: "List all Gmail labels (system and custom). Returns label names and IDs. Use before email_label to find the correct label ID, or before gmail_delete_label to find the ID of a label to remove.",
      parameters: Type.Object({}),
      async execute() {
        const result = await listLabels();
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "gmail_create_label",
      label: "Create Gmail Label",
      description: "Create a new custom Gmail label for inbox organization. Supports nested labels with '/' separator (e.g. 'Family/School'). The returned label ID can be used with email_label to tag emails.",
      parameters: Type.Object({
        name: Type.String({ description: "Label name (e.g. 'Travel', 'Family/School', 'Finance')." }),
        labelListVisibility: Type.Optional(Type.String({ description: "Visibility in label list: 'labelShow' (default), 'labelHide', or 'labelShowIfUnread'." })),
        messageListVisibility: Type.Optional(Type.String({ description: "Visibility in message list: 'show' (default) or 'hide'." })),
        backgroundColor: Type.Optional(Type.String({ description: "Background color hex (e.g. '#4986e7')." })),
        textColor: Type.Optional(Type.String({ description: "Text color hex (e.g. '#ffffff')." }))
      }),
      async execute(_toolCallId, params) {
        const result = await createLabel(params.name, {
          labelListVisibility: params.labelListVisibility,
          messageListVisibility: params.messageListVisibility,
          backgroundColor: params.backgroundColor,
          textColor: params.textColor
        });
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "gmail_delete_label",
      label: "Delete Gmail Label",
      description: "Delete a custom Gmail label by its ID. System labels cannot be deleted. Use gmail_list_labels first to find the label ID.",
      parameters: Type.Object({
        labelId: Type.String({ description: "The Gmail label ID to delete (from gmail_list_labels)." })
      }),
      async execute(_toolCallId, params) {
        const result = await deleteLabel(params.labelId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildWeatherTools() {
  return [
    {
      name: "weather_get",
      label: "Weather",
      description: "Get current weather conditions and 3-day forecast for a location. Use city names, zip codes, or landmarks.",
      parameters: Type.Object({
        location: Type.String({ description: "Location to get weather for (e.g. 'New York', '90210', 'Tokyo')" })
      }),
      async execute(_toolCallId, params) {
        const result = await getWeather(params.location);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildSearchTools() {
  return [
    {
      name: "web_search",
      label: "Web Search",
      description: "Search the web for real-time information. Returns top results with titles, snippets, and URLs.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" })
      }),
      async execute(_toolCallId, params) {
        const result = await search2(params.query);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildWebFetchTools() {
  return [
    {
      name: "web_fetch",
      label: "Web Fetch",
      description: "Fetch a web page and return its content as clean readable text. Use when you need to read the actual content of a URL \u2014 articles, documentation, blog posts, product pages, API docs, etc. Returns the page title, description, and full text content with HTML stripped. Handles HTML, JSON, and plain text responses. For searching the web (when you don't have a URL), use web_search instead.",
      parameters: Type.Object({
        url: Type.String({ description: "The full URL to fetch (must start with http:// or https://)" }),
        max_length: Type.Optional(Type.Number({ description: "Maximum content length in characters (default 80000). Use a smaller value like 20000 if you only need a summary or the beginning of a page." }))
      }),
      async execute(_toolCallId, params) {
        try {
          let url = params.url.trim();
          if (!url.match(/^https?:\/\//i)) url = "https://" + url;
          const result = await fetchPage(url, { maxLength: params.max_length });
          return {
            content: [{ type: "text", text: formatResult(result) }],
            details: { statusCode: result.statusCode, truncated: result.truncated }
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Failed to fetch "${params.url}": ${msg}` }],
            details: { error: msg }
          };
        }
      }
    }
  ];
}
function buildImageTools() {
  if (!ANTHROPIC_KEY) return [];
  return [
    {
      name: "describe_image",
      label: "Describe Image",
      description: "Fetch an image from a URL and describe its visual content using a vision model. Use when you need to 'see' an image, verify how a web page looks, check a chart/graph, or describe a photo. Supports JPEG, PNG, WebP, GIF. Returns a detailed text description of what the image contains.",
      parameters: Type.Object({
        url: Type.String({ description: "The URL of the image to describe (must be a direct image URL ending in .jpg, .png, .webp, .gif, or a URL that returns an image content type)" }),
        question: Type.Optional(Type.String({ description: "Optional specific question about the image, e.g. 'What text is visible?' or 'Are the appointments showing correctly?'" }))
      }),
      async execute(_toolCallId, params) {
        try {
          let url = params.url.trim();
          if (!url.match(/^https?:\/\//i)) url = "https://" + url;
          const imgRes = await fetch(url, {
            headers: { "User-Agent": "DarkNode/1.0" },
            signal: AbortSignal.timeout(15e3)
          });
          if (!imgRes.ok) return { content: [{ type: "text", text: `Failed to fetch image: HTTP ${imgRes.status}` }], details: { error: `HTTP ${imgRes.status}` } };
          const contentType = imgRes.headers.get("content-type") || "";
          const validTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
          const mediaType = validTypes.find((t) => contentType.includes(t.split("/")[1])) || "image/jpeg";
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          if (buffer.length > 20 * 1024 * 1024) return { content: [{ type: "text", text: "Image too large (>20MB)" }], details: { error: "too_large" } };
          const base64 = buffer.toString("base64");
          const prompt = params.question ? `Describe this image in detail, then answer this specific question: ${params.question}` : "Describe this image in detail. Include all visible text, layout, colors, and any notable elements.";
          const { default: Anthropic5 } = await import("@anthropic-ai/sdk");
          const client = new Anthropic5({ apiKey: ANTHROPIC_KEY });
          const response = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1500,
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
                { type: "text", text: prompt }
              ]
            }]
          });
          const description = response.content.map((b) => b.type === "text" ? b.text : "").join("");
          return {
            content: [{ type: "text", text: `**Image Description** (${url})

${description}` }],
            details: { size: buffer.length, contentType: mediaType }
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Failed to describe image: ${msg}` }], details: { error: msg } };
        }
      }
    }
  ];
}
function buildRenderPageTools() {
  const bbKey = process.env.BROWSERBASE_API_KEY;
  const lightpandaBin = path7.join(PROJECT_ROOT, ".bin/lightpanda");
  const hasLightpanda = fs6.existsSync(lightpandaBin);
  if (!bbKey && !hasLightpanda) return [];
  function isBlockedUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return true;
      if (host.startsWith("192.168.") || host.startsWith("10.") || host.startsWith("172.")) return true;
      if (host === "metadata.google.internal" || host.startsWith("169.254.")) return true;
      return false;
    } catch {
      return true;
    }
  }
  async function renderWithBrowserbase(url) {
    const puppeteer = (await import("puppeteer-core")).default;
    const browser = await puppeteer.connect({
      browserWSEndpoint: `wss://connect.browserbase.com?apiKey=${bbKey}`
    });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: "networkidle2", timeout: 3e4 });
      const title = await page.title();
      const text = await page.evaluate(() => {
        const el = document.querySelector("article") || document.querySelector("main") || document.body;
        return el?.innerText || "";
      });
      return `# ${title}

${text}`;
    } finally {
      await browser.close();
    }
  }
  async function renderWithLightpanda(url, fmt) {
    const { execFile: execFile2 } = await import("child_process");
    return new Promise((resolve, reject) => {
      execFile2(lightpandaBin, ["fetch", "--dump", fmt, "--http_timeout", "15000", url], { timeout: 2e4, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
  }
  const tools = [
    {
      name: "render_page",
      label: "Render Page",
      description: "Render a web page in a cloud browser (Browserbase) and return the fully rendered content. Unlike web_fetch which returns raw HTML, this tool executes JavaScript in a real Chrome browser with anti-bot protection, and returns the page as a human would see it \u2014 with all dynamic content loaded, JS-rendered elements visible, and anti-scraping measures bypassed. Use this when web_fetch returns empty/incomplete content, for JS-heavy pages, paywalled sites, or any page that blocks scrapers. For authenticated pages on rickin.live, include the appropriate auth query parameters.",
      parameters: Type.Object({
        url: Type.String({ description: "The full URL to render (must start with http:// or https://)" }),
        format: Type.Optional(Type.String({ description: "Output format: 'markdown' (default) or 'html'" }))
      }),
      async execute(_toolCallId, params) {
        try {
          let url = params.url.trim();
          if (!url.match(/^https?:\/\//i)) url = "https://" + url;
          if (isBlockedUrl(url)) return { content: [{ type: "text", text: "Blocked: cannot render internal/private URLs" }], details: { error: "blocked" } };
          const fmt = params.format === "html" ? "html" : "markdown";
          let result;
          if (bbKey) {
            try {
              console.log(`[render_page] Using Browserbase for ${url}`);
              result = await renderWithBrowserbase(url);
            } catch (bbErr) {
              if (hasLightpanda) {
                console.log(`[render_page] Browserbase failed (${bbErr.message}), falling back to Lightpanda for ${url}`);
                result = await renderWithLightpanda(url, fmt);
              } else {
                throw bbErr;
              }
            }
          } else {
            console.log(`[render_page] Using Lightpanda fallback for ${url}`);
            result = await renderWithLightpanda(url, fmt);
          }
          const truncated = result.length > 8e4;
          const content = truncated ? result.slice(0, 8e4) + "\n\n[TRUNCATED \u2014 content too long]" : result;
          return {
            content: [{ type: "text", text: `**Rendered Page** (${fmt}) \u2014 ${url}

${content}` }],
            details: { format: fmt, length: result.length, truncated }
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Failed to render page: ${msg}` }], details: { error: msg } };
        }
      }
    }
  ];
  if (bbKey) {
    tools.push({
      name: "browse_page",
      label: "Browse Page",
      description: "Interactive cloud browser session powered by Browserbase. Unlike render_page which just captures the page content, this tool can interact with the page \u2014 click buttons, fill forms, wait for elements, handle cookie consent, navigate pagination, and extract targeted data. Use for: sites with cookie/consent walls, paginated results, content behind login forms, or when you need to click through to specific sections. Returns the extracted text content after all actions are performed.",
      parameters: Type.Object({
        url: Type.String({ description: "The URL to navigate to" }),
        actions: Type.Optional(Type.Array(Type.Object({
          type: Type.String({ description: "Action type: 'click', 'type', 'wait', 'scroll', 'extract', 'screenshot'" }),
          selector: Type.Optional(Type.String({ description: "CSS selector for the target element" })),
          value: Type.Optional(Type.String({ description: "Value to type (for 'type' action) or attribute to extract" })),
          timeout: Type.Optional(Type.Number({ description: "Timeout in ms for wait actions (default 5000)" }))
        }), { description: "Ordered list of actions to perform on the page" })),
        extract_selector: Type.Optional(Type.String({ description: "CSS selector to extract text from after actions (default: article || main || body)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          let url = params.url.trim();
          if (!url.match(/^https?:\/\//i)) url = "https://" + url;
          if (isBlockedUrl(url)) return { content: [{ type: "text", text: "Blocked: cannot browse internal/private URLs" }], details: { error: "blocked" } };
          console.log(`[browse_page] Starting Browserbase session for ${url}`);
          const puppeteer = (await import("puppeteer-core")).default;
          const browser = await puppeteer.connect({
            browserWSEndpoint: `wss://connect.browserbase.com?apiKey=${bbKey}`
          });
          try {
            const page = await browser.newPage();
            await page.goto(url, { waitUntil: "networkidle2", timeout: 3e4 });
            const actionResults = [];
            if (params.actions) {
              for (const action of params.actions) {
                try {
                  switch (action.type) {
                    case "click":
                      if (action.selector) {
                        await page.waitForSelector(action.selector, { timeout: action.timeout || 5e3 });
                        await page.click(action.selector);
                        actionResults.push(`Clicked: ${action.selector}`);
                        await new Promise((r) => setTimeout(r, 1e3));
                      }
                      break;
                    case "type":
                      if (action.selector && action.value) {
                        await page.waitForSelector(action.selector, { timeout: action.timeout || 5e3 });
                        await page.type(action.selector, action.value);
                        actionResults.push(`Typed into: ${action.selector}`);
                      }
                      break;
                    case "wait":
                      if (action.selector) {
                        await page.waitForSelector(action.selector, { timeout: action.timeout || 1e4 });
                        actionResults.push(`Found: ${action.selector}`);
                      } else {
                        await new Promise((r) => setTimeout(r, action.timeout || 2e3));
                        actionResults.push(`Waited ${action.timeout || 2e3}ms`);
                      }
                      break;
                    case "scroll":
                      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
                      actionResults.push("Scrolled down");
                      await new Promise((r) => setTimeout(r, 1e3));
                      break;
                    case "extract":
                      if (action.selector) {
                        const extracted = await page.evaluate((sel) => {
                          const els = document.querySelectorAll(sel);
                          return Array.from(els).map((el) => el.textContent?.trim()).filter(Boolean).join("\n");
                        }, action.selector);
                        actionResults.push(`Extracted from ${action.selector}:
${extracted}`);
                      }
                      break;
                    case "screenshot":
                      actionResults.push("Screenshot captured (browser session)");
                      break;
                  }
                } catch (actionErr) {
                  actionResults.push(`Action failed (${action.type} ${action.selector || ""}): ${actionErr.message}`);
                }
              }
            }
            const extractSel = params.extract_selector || "article, main, body";
            const title = await page.title();
            const mainContent = await page.evaluate((sel) => {
              const el = document.querySelector(sel) || document.body;
              return el?.innerText || "";
            }, extractSel);
            await browser.close();
            const actionsLog = actionResults.length > 0 ? `
**Actions performed:**
${actionResults.map((a) => `- ${a}`).join("\n")}
` : "";
            const fullContent = `# ${title}
${actionsLog}
${mainContent}`;
            const truncated = fullContent.length > 8e4;
            const content = truncated ? fullContent.slice(0, 8e4) + "\n\n[TRUNCATED]" : fullContent;
            return {
              content: [{ type: "text", text: `**Browsed Page** \u2014 ${url}

${content}` }],
              details: { actionsPerformed: actionResults.length, length: fullContent.length, truncated }
            };
          } catch (innerErr) {
            await browser.close();
            throw innerErr;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Failed to browse page: ${msg}` }], details: { error: msg } };
        }
      }
    });
  }
  return tools;
}
function buildCalendarTools() {
  if (!isConfigured4()) return [];
  return [
    {
      name: "calendar_list",
      label: "Calendar Events",
      description: "List upcoming calendar events. Can filter by date range.",
      parameters: Type.Object({
        maxResults: Type.Optional(Type.Number({ description: "Maximum number of events to return (default 10)" })),
        timeMin: Type.Optional(Type.String({ description: "Start of date range in ISO 8601 format (defaults to now)" })),
        timeMax: Type.Optional(Type.String({ description: "End of date range in ISO 8601 format" }))
      }),
      async execute(_toolCallId, params) {
        const result = await listEvents(params);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "calendar_create",
      label: "Create Event",
      description: `Create a new calendar event. Can target a specific calendar by name (e.g. 'Reya' to match "Reya's Schedule"). Use calendar_list_available to see available calendars.`,
      parameters: Type.Object({
        summary: Type.String({ description: "Event title" }),
        startTime: Type.String({ description: "Start time in ISO 8601 format (e.g. '2025-03-15T14:00:00')" }),
        endTime: Type.Optional(Type.String({ description: "End time in ISO 8601 format (defaults to 1 hour after start)" })),
        description: Type.Optional(Type.String({ description: "Event description" })),
        location: Type.Optional(Type.String({ description: "Event location" })),
        allDay: Type.Optional(Type.Boolean({ description: "Whether this is an all-day event" })),
        calendarName: Type.Optional(Type.String({ description: "Target calendar name to fuzzy-match (e.g. 'Reya', 'Pooja'). Defaults to primary calendar if omitted." }))
      }),
      async execute(_toolCallId, params) {
        const { summary, ...options } = params;
        const result = await createEvent(summary, options);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "calendar_list_available",
      label: "List Calendars",
      description: "List all available Google calendars with their names and access levels. Use this to find the correct calendar name for calendar_create.",
      parameters: Type.Object({}),
      async execute() {
        const cals = await listCalendars();
        if (cals.length === 0) return { content: [{ type: "text", text: "No calendars found or not connected." }], details: {} };
        const lines = cals.map((c, i) => `${i + 1}. ${c.name} (${c.accessRole})${c.id === "primary" ? " [PRIMARY]" : ""}`);
        return { content: [{ type: "text", text: `Available calendars (${cals.length}):

${lines.join("\n")}` }], details: {} };
      }
    }
  ];
}
function buildTaskTools() {
  return [
    {
      name: "task_add",
      label: "Add Task",
      description: "Add a new task or to-do item with optional due date, priority, and tags.",
      parameters: Type.Object({
        title: Type.String({ description: "Task title" }),
        description: Type.Optional(Type.String({ description: "Task description or details" })),
        dueDate: Type.Optional(Type.String({ description: "Due date in YYYY-MM-DD format" })),
        priority: Type.Optional(Type.String({ description: "Priority: 'low', 'medium', or 'high' (default: medium)" })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" }))
      }),
      async execute(_toolCallId, params) {
        const { title, ...options } = params;
        const result = await addTask(title, options);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "task_list",
      label: "List Tasks",
      description: "List tasks and to-do items. Shows open tasks by default.",
      parameters: Type.Object({
        showCompleted: Type.Optional(Type.Boolean({ description: "Include completed tasks (default: false)" })),
        tag: Type.Optional(Type.String({ description: "Filter by tag" })),
        priority: Type.Optional(Type.String({ description: "Filter by priority: 'low', 'medium', 'high'" }))
      }),
      async execute(_toolCallId, params) {
        const result = await listTasks(params);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "task_complete",
      label: "Complete Task",
      description: "Mark a task as completed.",
      parameters: Type.Object({
        taskId: Type.String({ description: "The task ID to complete" })
      }),
      async execute(_toolCallId, params) {
        const result = await completeTask(params.taskId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "task_delete",
      label: "Delete Task",
      description: "Delete a task permanently.",
      parameters: Type.Object({
        taskId: Type.String({ description: "The task ID to delete" })
      }),
      async execute(_toolCallId, params) {
        const result = await deleteTask(params.taskId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "task_update",
      label: "Update Task",
      description: "Update an existing task's details.",
      parameters: Type.Object({
        taskId: Type.String({ description: "The task ID to update" }),
        title: Type.Optional(Type.String({ description: "New title" })),
        description: Type.Optional(Type.String({ description: "New description" })),
        dueDate: Type.Optional(Type.String({ description: "New due date in YYYY-MM-DD format" })),
        priority: Type.Optional(Type.String({ description: "New priority: 'low', 'medium', 'high'" })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "New tags" }))
      }),
      async execute(_toolCallId, params) {
        const { taskId, ...updates } = params;
        const result = await updateTask(taskId, updates);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildNewsTools() {
  return [
    {
      name: "news_headlines",
      label: "News Headlines",
      description: "Get latest news headlines by category. Categories: top, world, business, technology, science, health, sports, entertainment.",
      parameters: Type.Object({
        category: Type.Optional(Type.String({ description: "News category (default: 'top'). Options: top, world, business, technology, science, health, sports, entertainment" }))
      }),
      async execute(_toolCallId, params) {
        const result = await getNews(params.category);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "news_search",
      label: "Search News",
      description: "Search for news articles about a specific topic.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query for news articles" })
      }),
      async execute(_toolCallId, params) {
        const result = await searchNews(params.query);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildTwitterTools() {
  return [
    {
      name: "x_user_profile",
      label: "X User Profile",
      description: "Get an X (Twitter) user's profile info including bio, follower count, and stats. Accepts a username or profile URL.",
      parameters: Type.Object({
        username: Type.String({ description: "X username (e.g. 'elonmusk') or profile URL" })
      }),
      async execute(_toolCallId, params) {
        const result = await getUserProfile(params.username);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "x_read_tweet",
      label: "Read Tweet",
      description: "Read the full content of a specific tweet/post. Accepts a tweet URL (x.com or twitter.com) or tweet ID.",
      parameters: Type.Object({
        tweet: Type.String({ description: "Tweet URL (e.g. 'https://x.com/user/status/123') or tweet ID" })
      }),
      async execute(_toolCallId, params) {
        const result = await getTweet(params.tweet);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "x_user_timeline",
      label: "X Timeline",
      description: "Read recent tweets/posts from an X (Twitter) user's timeline. Returns their latest public posts with engagement stats and view counts.",
      parameters: Type.Object({
        username: Type.String({ description: "X username (e.g. 'elonmusk') or profile URL" }),
        count: Type.Optional(Type.Number({ description: "Number of tweets to fetch (default 10, max 20)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await getUserTimeline(params.username, params.count ?? 10);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "x_search",
      label: "X Search",
      description: "Search X (Twitter) for tweets matching a query. Returns matching posts with engagement stats and view counts. Useful for finding mentions, discussions, news, and sentiment on any topic.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query \u2014 supports keywords, phrases, @mentions, #hashtags, from:user, to:user, etc." }),
        count: Type.Optional(Type.Number({ description: "Number of results to return (default 10, max 20)" })),
        type: Type.Optional(Type.String({ description: "Search type: 'Latest' (most recent) or 'Top' (most popular). Default: 'Latest'" }))
      }),
      async execute(_toolCallId, params) {
        const searchType = params.type === "Top" ? "Top" : "Latest";
        const result = await searchTweets(params.query, params.count ?? 10, searchType);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildStockTools() {
  return [
    {
      name: "stock_quote",
      label: "Stock Quote",
      description: "Get real-time stock price, change, and stats for a ticker symbol. Use standard stock symbols (e.g. AAPL, TSLA, MSFT, GOOGL, AMZN).",
      parameters: Type.Object({
        symbol: Type.String({ description: "Stock ticker symbol (e.g. 'AAPL', 'TSLA', 'MSFT')" })
      }),
      async execute(_toolCallId, params) {
        const result = await getStockQuote(params.symbol);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "crypto_price",
      label: "Crypto Price",
      description: "Get real-time cryptocurrency price, 24h/7d change, market cap, and volume. Supports common tickers (BTC, ETH, SOL, etc.) and full names (bitcoin, ethereum, etc.).",
      parameters: Type.Object({
        coin: Type.String({ description: "Cryptocurrency name or ticker (e.g. 'bitcoin', 'BTC', 'ethereum', 'ETH', 'solana')" })
      }),
      async execute(_toolCallId, params) {
        const result = await getCryptoPrice(params.coin);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildSignalSourceTools() {
  return [
    {
      name: "fear_greed_index",
      label: "Fear & Greed Index",
      description: "Get the current Crypto Fear & Greed Index (0-100). Returns value, classification (Extreme Fear/Fear/Neutral/Greed/Extreme Greed), regime signal, and previous day comparison. Use for market regime filtering.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const result = await getFearGreedIndex();
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "binance_signals",
      label: "Binance Multi-TF Signals",
      description: "Get multi-timeframe (1h/4h/1d) technical signals for a crypto pair from Binance. Returns RSI, MACD, SMA crossovers, volume ratios, and composite bull/bear score per timeframe. Use for additional confirmation alongside the Nunchi voting ensemble.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Trading pair symbol (e.g. 'BTC', 'BTCUSDT', 'ETH', 'SOL')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await getBinanceSignals(params.symbol);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "binance_watchlist_scan",
      label: "Binance Watchlist Scanner",
      description: "Scan multiple crypto symbols at once using Binance multi-timeframe analysis. Returns scored signals ranked by strength. Use to quickly screen the watchlist for strongest setups.",
      parameters: Type.Object({
        symbols: Type.Array(Type.String(), { description: "Array of symbols to scan (e.g. ['BTC', 'ETH', 'SOL', 'BNKR'])" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await scanBinanceWatchlist(params.symbols);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "crypto_liquidations",
      label: "Crypto Liquidations",
      description: "Get 24h crypto liquidation data. Returns total liquidations, long vs short breakdown, and regime signal (LONG_SQUEEZE, SHORT_SQUEEZE, BALANCED). Use for detecting leverage cascade risk.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const result = await getCryptoLiquidations();
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "crypto_sentiment",
      label: "Crypto Sentiment",
      description: "Get aggregated social sentiment for a crypto asset. Returns overall sentiment (BULLISH/BEARISH/NEUTRAL), score, and source breakdown. Use for confirming thesis direction.",
      parameters: Type.Object({
        query: Type.String({ description: "Crypto asset name or ticker (e.g. 'bitcoin', 'BTC', 'ethereum')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await getCryptoSentiment(params.query);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "defillama_tvl",
      label: "DefiLlama TVL Data",
      description: "Get DeFi protocol TVL data from DefiLlama. Returns top protocols by TVL, chain TVL breakdown. Optionally filter by specific protocol. Use for identifying DeFi capital flows.",
      parameters: Type.Object({
        protocol: Type.Optional(Type.String({ description: "Specific protocol slug (e.g. 'aave', 'uniswap'). Omit for global overview." }))
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await getDefiLlamaData(params.protocol);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "defillama_yields",
      label: "DefiLlama Top Yields",
      description: "Get top DeFi yield pools from DefiLlama. Returns pools sorted by TVL with APY breakdown (base + reward), project, chain. Use for identifying yield opportunities and DeFi momentum.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const result = await getDefiLlamaYields();
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "binance_funding_rates",
      label: "Binance Funding Rates",
      description: "Get current perpetual futures funding rates from Binance. Returns rates per symbol with signals (OVERLEVERAGED_LONGS/SHORTS/NEUTRAL). Extreme funding rates indicate crowded positioning. Optionally filter by symbols.",
      parameters: Type.Object({
        symbols: Type.Optional(Type.Array(Type.String(), { description: "Filter by specific symbols (e.g. ['BTC', 'ETH']). Omit for top 30." }))
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await getBinanceFundingRates(params.symbols);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "open_interest",
      label: "Open Interest & Positioning",
      description: "Get open interest, funding rate, and long/short ratio for a futures pair on Binance. Returns positioning signal (CROWDED_LONG, CROWDED_SHORT, etc). Use for detecting overcrowded trades.",
      parameters: Type.Object({
        symbol: Type.String({ description: "Futures pair (e.g. 'BTC', 'BTCUSDT', 'ETH')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await getOpenInterestHistory(params.symbol);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "enhanced_coingecko",
      label: "Enhanced CoinGecko Intelligence",
      description: "Get enhanced CoinGecko data: trending tokens, top DeFi by mcap/TVL ratio, BTC/ETH dominance breakdown. Use for sector rotation and trend analysis.",
      parameters: Type.Object({
        category: Type.Optional(Type.String({ description: "Optional category filter" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await getEnhancedCoinGeckoData(params.category);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    }
  ];
}
function buildCoinGeckoTools() {
  return [
    {
      name: "crypto_trending",
      label: "Crypto Trending",
      description: "Get trending cryptocurrencies and categories on CoinGecko. Returns structured JSON with coins (name, symbol, rank, price, 24h change) and trending categories.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const result = await getTrending();
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "crypto_movers",
      label: "Crypto Movers",
      description: "Get top crypto gainers or losers by 24h price change. Returns structured JSON with direction and coins array (name, symbol, price, 24h/7d change, market cap).",
      parameters: Type.Object({
        direction: Type.Optional(Type.Union([Type.Literal("gainers"), Type.Literal("losers")], { description: "Show top gainers or losers. Default: gainers", default: "gainers" })),
        limit: Type.Optional(Type.Number({ description: "Number of results (max 50). Default: 20", default: 20 }))
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await getMovers(params.direction || "gainers", Math.min(params.limit || 20, 50));
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "crypto_categories",
      label: "Crypto Categories",
      description: "Get crypto market categories sorted by 24h market cap change. Returns structured JSON with categories array (name, 24h change, market cap, volume). Useful for sector analysis.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Number of categories (max 50). Default: 20", default: 20 }))
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await getCategories(Math.min(params.limit || 20, 50));
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "crypto_market_overview",
      label: "Crypto Market Overview",
      description: "Get global crypto market overview. Returns structured JSON: total market cap, 24h volume, BTC/ETH dominance, active cryptocurrencies, and 24h market cap change.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const result = await getMarketOverview();
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "crypto_historical",
      label: "Crypto Historical Data",
      description: "Get historical price data summary for a cryptocurrency. Returns structured JSON: coin_id, days, candle_count, period dates, current price, high/low, return %. Data cached hourly.",
      parameters: Type.Object({
        coin: Type.String({ description: "Cryptocurrency name or ticker (e.g. 'bitcoin', 'BTC', 'ethereum')" }),
        days: Type.Optional(Type.Number({ description: "Number of days of history (max 90). Default: 90", default: 90 }))
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await getHistoricalOHLCVFormatted(params.coin, Math.min(params.days || 90, 90));
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "technical_analysis",
      label: "Technical Analysis",
      description: "Run technical analysis on a cryptocurrency using the 6-signal Nunchi voting ensemble. Returns structured JSON: technical_score (0.0-1.0), regime (TRENDING/RANGING/VOLATILE), ATR stop loss, per-signal breakdown, vote counts, BTC confirmation filter (for alt coins). Uses cached hourly OHLCV. Parameters are UNVALIDATED starting points.",
      parameters: Type.Object({
        coin: Type.String({ description: "Cryptocurrency name or ticker (e.g. 'bitcoin', 'BTC', 'BNKR', 'VIRTUAL')" }),
        days: Type.Optional(Type.Number({ description: "Days of data to analyze (max 90). Default: 90", default: 90 }))
      }),
      async execute(_toolCallId, params) {
        try {
          const candles = await getHistoricalOHLCV(params.coin, Math.min(params.days || 90, 90));
          if (candles.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ error: `No historical data available for "${params.coin}"` }) }], details: {} };
          }
          const coinLower = (params.coin || "").toLowerCase();
          const isBTC = coinLower === "bitcoin" || coinLower === "btc";
          let btcCandles;
          if (!isBTC) {
            try {
              btcCandles = await getHistoricalOHLCV("bitcoin", Math.min(params.days || 90, 90));
            } catch {
            }
          }
          const dbParams = await loadCryptoSignalParams();
          const result = analyzeAsset(candles, dbParams, btcCandles, coinLower);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "crypto_backtest",
      label: "Crypto Backtest",
      description: "Run a backtest of the 6-signal voting ensemble on historical OHLCV data. Returns Sharpe ratio, win rate, max drawdown, Nunchi composite score, and trade log.",
      parameters: Type.Object({
        coin: Type.String({ description: "Cryptocurrency name or ticker (e.g. 'bitcoin', 'BTC')" }),
        days: Type.Optional(Type.Number({ description: "Days of data to backtest (max 90). Default: 30", default: 30 }))
      }),
      async execute(_toolCallId, params) {
        try {
          const candles = await getHistoricalOHLCV(params.coin, Math.min(params.days || 30, 90));
          if (candles.length === 0) {
            return { content: [{ type: "text", text: JSON.stringify({ error: `No historical data for "${params.coin}"` }) }], details: {} };
          }
          const result = runBacktest(candles, params.coin);
          const { trades, ...summary } = result;
          return { content: [{ type: "text", text: JSON.stringify({ ...summary, recent_trades: trades.slice(-10) }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "nansen_smart_money",
      label: "Nansen Smart Money",
      description: "Get smart money wallet flow data for a token from Nansen. Shows net flow direction, inflow/outflow amounts, and number of smart money wallets buying vs selling.",
      parameters: Type.Object({
        token: Type.String({ description: "Token symbol or name (e.g. 'ethereum', 'bitcoin')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await getSmartMoneyFlow(params.token);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "nansen_token_holders",
      label: "Nansen Token Holders",
      description: "Get token holder distribution data from Nansen. Shows total holders, whale concentration, 24h holder change, and whale activity (accumulating/distributing/stable).",
      parameters: Type.Object({
        token: Type.String({ description: "Token symbol or name (e.g. 'ethereum', 'bitcoin')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await getTokenHolders(params.token);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "nansen_hot_contracts",
      label: "Nansen Hot Contracts",
      description: "Get trending smart contracts from Nansen. Shows contracts with highest smart money interaction counts, useful for identifying emerging DeFi activity.",
      parameters: Type.Object({
        chain: Type.Optional(Type.String({ description: "Blockchain to query (default: ethereum). Options: ethereum, base, solana", default: "ethereum" })),
        limit: Type.Optional(Type.Number({ description: "Number of contracts to return (default: 10)", default: 10 }))
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await getHotContracts(params.chain || "ethereum", params.limit || 10);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "signal_quality",
      label: "Signal Quality Scores",
      description: "Get signal quality scores \u2014 historical win rates by source (crypto_scout, polymarket_scout) and asset class. Shows rolling win rate, avg P&L, total wins/losses, and recent trade results. Use this before generating theses to understand which signal sources are performing well. Sources with >60% win rate deserve a confidence boost, <40% deserve a penalty.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const scores = await getSignalQuality();
          const summary = scores.map((s) => ({
            source: s.source,
            asset_class: s.asset_class,
            win_rate: s.win_rate,
            wins: s.wins,
            losses: s.losses,
            total_pnl: s.total_pnl,
            avg_pnl: s.avg_pnl,
            sample_size: s.recent_results.length,
            modifier: getSignalQualityModifier(scores, s.source, s.asset_class).modifier
          }));
          return { content: [{ type: "text", text: JSON.stringify({ scores: summary }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "scout_theses",
      label: "SCOUT Active Theses",
      description: "Get all active CRYPTO SCOUT trading theses. Returns structured thesis data including vote counts, technical scores, entry/stop/target prices, and confidence levels.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const theses = await getActiveTheses();
          return { content: [{ type: "text", text: JSON.stringify({ count: theses.length, theses }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "scout_watchlist",
      label: "SCOUT Watchlist",
      description: "Get the current SCOUT watchlist \u2014 the list of CoinGecko IDs that the micro-scan monitors every 30 minutes.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const watchlist = await getWatchlist();
          return { content: [{ type: "text", text: JSON.stringify({ count: watchlist.length, assets: watchlist }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "save_thesis",
      label: "Save SCOUT Thesis",
      description: "Persist a trading thesis to the database. Required fields: asset, asset_id (CoinGecko ID), direction (LONG/SHORT), confidence (HIGH/MEDIUM/LOW), technical_score, vote_count (e.g. '5/6'), market_regime, entry_price, exit_price (target), stop_price, atr_value, sources (array), reasoning. Optional: backtest_score, nansen_flow_direction, time_horizon.",
      parameters: Type.Object({
        asset: Type.String({ description: "Asset display name (e.g. 'Bitcoin')" }),
        asset_id: Type.String({ description: "CoinGecko ID (e.g. 'bitcoin')" }),
        direction: Type.Union([Type.Literal("LONG"), Type.Literal("SHORT")]),
        confidence: Type.Union([Type.Literal("HIGH"), Type.Literal("MEDIUM"), Type.Literal("LOW")]),
        technical_score: Type.Number(),
        vote_count: Type.String({ description: "Vote count string e.g. '5/6'" }),
        market_regime: Type.String(),
        entry_price: Type.Number(),
        exit_price: Type.Number({ description: "Target/take-profit price" }),
        stop_price: Type.Number(),
        atr_value: Type.Number(),
        sources: Type.Array(Type.String()),
        reasoning: Type.String(),
        backtest_score: Type.Optional(Type.Number()),
        nansen_flow_direction: Type.Optional(Type.String()),
        time_horizon: Type.Optional(Type.String())
      }),
      async execute(_toolCallId, params) {
        try {
          const scores = await getSignalQuality();
          const sqMod = getSignalQualityModifier(scores, "crypto_scout", "crypto");
          const CONFIDENCE_TIERS = { HIGH: 3, MEDIUM: 2, LOW: 1 };
          const TIER_FROM_RANK = { 3: "HIGH", 2: "MEDIUM", 1: "LOW" };
          let finalConfidence = params.confidence;
          if (sqMod.sampleSize >= 3) {
            let rank = CONFIDENCE_TIERS[finalConfidence] || 2;
            if (sqMod.modifier === "boost") rank = Math.min(rank + 1, 3);
            else if (sqMod.modifier === "penalty") rank = Math.max(rank - 1, 1);
            finalConfidence = TIER_FROM_RANK[rank] || finalConfidence;
          }
          const sqNote = `[signal_quality: ${sqMod.modifier}, win_rate=${sqMod.winRate}%, n=${sqMod.sampleSize}${finalConfidence !== params.confidence ? `, adjusted ${params.confidence}\u2192${finalConfidence}` : ""}]`;
          const thesis = buildThesis({
            asset: params.asset,
            asset_id: params.asset_id,
            direction: params.direction,
            confidence: finalConfidence,
            technical_score: params.technical_score,
            vote_count: params.vote_count,
            market_regime: params.market_regime,
            entry_price: params.entry_price,
            exit_price: params.exit_price,
            stop_price: params.stop_price,
            atr_value: params.atr_value,
            sources: params.sources,
            reasoning: `${params.reasoning}
${sqNote}`,
            backtest_score: params.backtest_score,
            nansen_flow_direction: params.nansen_flow_direction,
            time_horizon: params.time_horizon
          });
          await saveTheses([thesis]);
          recordSignal(params.asset_id, "entry");
          console.log(`[save_thesis] ${params.asset} ${params.direction} confidence=${params.confidence}\u2192${finalConfidence} ${sqNote}`);
          return { content: [{ type: "text", text: JSON.stringify({ saved: true, thesis_id: thesis.id, expires_at: new Date(thesis.expires_at).toISOString(), signal_quality_modifier: sqMod.modifier, original_confidence: params.confidence, final_confidence: finalConfidence }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "update_watchlist",
      label: "Update SCOUT Watchlist",
      description: "Update the SCOUT watchlist with a list of CoinGecko IDs. Default assets (BTC, ETH, SOL, BNKR) are always included.",
      parameters: Type.Object({
        assets: Type.Array(Type.String(), { description: "Array of CoinGecko IDs to watch (e.g. ['bitcoin', 'ethereum', 'solana', 'virtual-protocol'])" })
      }),
      async execute(_toolCallId, params) {
        try {
          await updateWatchlist(params.assets);
          const updated = await getWatchlist();
          return { content: [{ type: "text", text: JSON.stringify({ updated: true, count: updated.length, assets: updated }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "retire_thesis",
      label: "Retire SCOUT Thesis",
      description: "Retire (deactivate) a SCOUT thesis by its ID. Used when a thesis is no longer valid or has been executed.",
      parameters: Type.Object({
        thesis_id: Type.String({ description: "The thesis ID to retire" })
      }),
      async execute(_toolCallId, params) {
        try {
          await retireThesis(params.thesis_id);
          return { content: [{ type: "text", text: JSON.stringify({ retired: true, thesis_id: params.thesis_id }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "polymarket_search",
      label: "Polymarket Search",
      description: "Search Polymarket for prediction markets by topic/tag. Returns markets with odds, volume, liquidity, and end dates.",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Topic or tag to search (e.g. 'crypto', 'politics', 'sports')" })),
        limit: Type.Optional(Type.Number({ description: "Max results (default 20)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const result = params.query ? await searchMarkets(params.query, params.limit || 20) : await getTrendingMarkets(params.limit || 20);
          return { content: [{ type: "text", text: JSON.stringify({ count: result.length, markets: result }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "polymarket_trending",
      label: "Polymarket Trending",
      description: "Get trending Polymarket prediction markets sorted by 24h volume.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max results (default 20)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await getTrendingMarkets(params.limit || 20);
          return { content: [{ type: "text", text: JSON.stringify({ count: result.length, markets: result }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "polymarket_details",
      label: "Polymarket Market Details",
      description: "Get detailed info for a specific Polymarket market by condition ID.",
      parameters: Type.Object({
        condition_id: Type.String({ description: "Polymarket condition/market ID" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await getMarketDetails(params.condition_id);
          return { content: [{ type: "text", text: JSON.stringify(result || { error: "Market not found" }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "polymarket_whale_watchlist",
      label: "Polymarket Whale Watchlist",
      description: "Get the current whale watchlist for Polymarket tracking. Shows tracked wallets with composite scores, win rates, ROI.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const wallets = await getWhaleWatchlist();
          return { content: [{ type: "text", text: JSON.stringify({ count: wallets.length, wallets }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "polymarket_whale_activity",
      label: "Polymarket Whale Activity",
      description: "Get recent whale activity (last 24h) from tracked Polymarket wallets.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const activities = await getWhaleActivities();
          return { content: [{ type: "text", text: JSON.stringify({ count: activities.length, activities }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "polymarket_consensus",
      label: "Polymarket Whale Consensus",
      description: "Detect whale consensus \u2014 markets where multiple tracked whales are positioned in the same direction.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const activities = await getWhaleActivities();
          const consensus = await detectConsensus(activities);
          return { content: [{ type: "text", text: JSON.stringify({ consensus_count: consensus.length, consensus }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "polymarket_theses",
      label: "Polymarket Active Theses",
      description: "Get all active Polymarket SCOUT trading theses.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const theses = await getActiveTheses2();
          return { content: [{ type: "text", text: JSON.stringify({ count: theses.length, theses }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "save_pm_thesis",
      label: "Save Polymarket Thesis",
      description: "Persist a Polymarket trading thesis. Requires: condition_id, direction (YES/NO), confidence, whale data, reasoning.",
      parameters: Type.Object({
        condition_id: Type.String({ description: "Polymarket market condition ID" }),
        direction: Type.Union([Type.Literal("YES"), Type.Literal("NO")]),
        confidence: Type.Union([Type.Literal("HIGH"), Type.Literal("MEDIUM"), Type.Literal("LOW"), Type.Literal("SPECULATIVE")]),
        whale_wallets: Type.Array(Type.String(), { description: "Wallet addresses in consensus (empty array OK for LOW volume-weighted fallback)" }),
        whale_avg_score: Type.Number(),
        total_whale_amount: Type.Number(),
        reasoning: Type.String()
      }),
      async execute(_toolCallId, params) {
        try {
          const market = await getMarketDetails(params.condition_id);
          if (!market) return { content: [{ type: "text", text: JSON.stringify({ error: "Market not found" }) }], details: {} };
          const yesPrice = market.tokens.find((t) => t.outcome === "Yes")?.price || 0;
          const noPrice = market.tokens.find((t) => t.outcome === "No")?.price || 0;
          const odds = params.direction === "YES" ? yesPrice : noPrice;
          const hoursToResolution = market.end_date_iso ? (new Date(market.end_date_iso).getTime() - Date.now()) / (60 * 60 * 1e3) : 9999;
          const thresholdResult = await meetsThesisThresholds({
            whale_score: params.whale_avg_score,
            whale_consensus: params.whale_wallets.length,
            market_volume: market.volume,
            market_liquidity: market.liquidity,
            odds,
            hours_to_resolution: hoursToResolution
          });
          console.log(`[pm-scout] save_pm_thesis: ${market.question?.slice(0, 50)} \u2014 threshold ${thresholdResult.meets ? "PASS" : "REJECT"} (tier=${thresholdResult.tier || "none"}, agent_confidence=${params.confidence})`);
          if (!thresholdResult.meets) {
            return { content: [{ type: "text", text: JSON.stringify({ saved: false, rejected: true, failures: thresholdResult.failures }) }], details: {} };
          }
          const resolvedConfidence = thresholdResult.tier || params.confidence;
          const scores = await getSignalQuality();
          const sqMod = getSignalQualityModifier(scores, "polymarket_scout", "polymarket");
          const PM_TIERS = { HIGH: 4, MEDIUM: 3, LOW: 2, SPECULATIVE: 1 };
          const PM_FROM_RANK = { 4: "HIGH", 3: "MEDIUM", 2: "LOW", 1: "SPECULATIVE" };
          let finalConfidence = resolvedConfidence;
          if (sqMod.sampleSize >= 3) {
            let rank = PM_TIERS[finalConfidence] || 2;
            if (sqMod.modifier === "boost") rank = Math.min(rank + 1, 4);
            else if (sqMod.modifier === "penalty") rank = Math.max(rank - 1, 1);
            finalConfidence = PM_FROM_RANK[rank] || finalConfidence;
          }
          const sqNote = `[signal_quality: ${sqMod.modifier}, win_rate=${sqMod.winRate}%, n=${sqMod.sampleSize}${finalConfidence !== resolvedConfidence ? `, adjusted ${resolvedConfidence}\u2192${finalConfidence}` : ""}]`;
          const thesis = buildThesis2({
            market,
            direction: params.direction,
            confidence: finalConfidence,
            whale_consensus: params.whale_wallets.length,
            whale_wallets: params.whale_wallets,
            whale_avg_score: params.whale_avg_score,
            total_whale_amount: params.total_whale_amount,
            sources: ["polymarket_clob", "whale_tracker"],
            reasoning: `${params.reasoning}
${sqNote}`
          });
          await saveTheses2([thesis]);
          console.log(`[save_pm_thesis] ${market.question?.slice(0, 50)} confidence=${resolvedConfidence}\u2192${finalConfidence} ${sqNote}`);
          return { content: [{ type: "text", text: JSON.stringify({ saved: true, thesis_id: thesis.id, threshold: thresholdResult, signal_quality_modifier: sqMod.modifier, original_confidence: resolvedConfidence, final_confidence: finalConfidence }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "retire_pm_thesis",
      label: "Retire Polymarket Thesis",
      description: "Retire a Polymarket thesis by its ID.",
      parameters: Type.Object({
        thesis_id: Type.String({ description: "The PM thesis ID to retire" })
      }),
      async execute(_toolCallId, params) {
        try {
          await retireThesis2(params.thesis_id);
          return { content: [{ type: "text", text: JSON.stringify({ retired: true, thesis_id: params.thesis_id }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "bankr_risk_check",
      label: "BANKR Pre-Trade Risk Check",
      description: "Run pre-execution risk checks before a trade. Returns pass/fail for each check: kill switch, pause, leverage, margin, position limits, exposure, correlation.",
      parameters: Type.Object({
        asset: Type.String({ description: "Asset name" }),
        asset_class: Type.Union([Type.Literal("crypto"), Type.Literal("polymarket")]),
        direction: Type.String({ description: "LONG, SHORT, YES, or NO" }),
        leverage: Type.Number({ description: "Leverage multiplier (max 2)" }),
        entry_price: Type.Number(),
        stop_price: Type.Number(),
        confidence: Type.Optional(Type.Number({ description: "Confidence score 1-5 for tiered approval" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await runPreExecutionChecks(params);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "bankr_open_position",
      label: "BANKR Open Position",
      description: "Open a new position. Runs risk checks with tiered approval (autonomous/dead_zone/human_required), calculates position size (5% risk), executes via BNKR only.",
      parameters: Type.Object({
        thesis_id: Type.String(),
        asset: Type.String(),
        asset_class: Type.Union([Type.Literal("crypto"), Type.Literal("polymarket")]),
        source: Type.Optional(Type.Union([Type.Literal("crypto_scout"), Type.Literal("polymarket_scout"), Type.Literal("manual")])),
        direction: Type.String(),
        leverage: Type.Number(),
        entry_price: Type.Number(),
        stop_price: Type.Number(),
        atr_value: Type.Number(),
        venue: Type.Literal("bnkr"),
        confidence: Type.Optional(Type.Number({ description: "Confidence score 1-5 for tiered approval" })),
        market_id: Type.Optional(Type.String({ description: "Polymarket market ID for BNKR execution" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const riskCheck = await runPreExecutionChecks({
            asset: params.asset,
            asset_class: params.asset_class,
            direction: params.direction,
            leverage: params.leverage,
            entry_price: params.entry_price,
            stop_price: params.stop_price,
            confidence: params.confidence
          });
          if (!riskCheck.passed) {
            return { content: [{ type: "text", text: JSON.stringify({ executed: false, tier: riskCheck.tier, reason: riskCheck.rejection_reason, checks: riskCheck.checks }) }], details: {} };
          }
          const mode = await getMode2();
          if (mode === "SHADOW") {
            return { content: [{ type: "text", text: JSON.stringify({ executed: false, tier: riskCheck.tier, reason: "SHADOW mode \u2014 trade logged but not executed", checks: riskCheck.checks }) }], details: {} };
          }
          if (riskCheck.tier === "human_required") {
            const portfolio = await getPortfolioValue();
            const rc = await getRiskConfig();
            const riskAmount = portfolio * (rc.risk_per_trade_pct / 100);
            const approval = await requestTradeApproval({
              thesisId: params.thesis_id,
              asset: params.asset,
              direction: params.direction,
              leverage: `${params.leverage}x`,
              entryPrice: params.entry_price.toFixed(2),
              stopLoss: params.stop_price.toFixed(2),
              takeProfit: "TBD",
              riskAmount: riskAmount.toFixed(2),
              reason: `Tier: HUMAN REQUIRED. Mode: ${mode}`
            });
            if (approval !== "approve") {
              return { content: [{ type: "text", text: JSON.stringify({ executed: false, tier: "human_required", reason: `Trade ${approval} via Telegram` }) }], details: {} };
            }
          } else if (riskCheck.tier === "dead_zone") {
            await sendTradeAlert({
              type: "flagged",
              asset: params.asset,
              direction: params.direction,
              leverage: `${params.leverage}x`,
              entryPrice: params.entry_price.toFixed(2),
              reason: "Dead zone trade (20-30% capital) \u2014 executing but flagging"
            });
          }
          const result = await openPosition({ ...params, source: params.source });
          await sendTradeAlert({
            type: "executed",
            asset: params.asset,
            direction: params.direction,
            leverage: `${params.leverage}x`,
            entryPrice: params.entry_price.toFixed(2)
          });
          return { content: [{ type: "text", text: JSON.stringify({ executed: true, tier: riskCheck.tier, position_id: result.position.id, size: result.position.size, bnkr_order_id: result.bnkr_order_id }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "bankr_close_position",
      label: "BANKR Close Position",
      description: "Close an open position by ID with a specified exit price and reason.",
      parameters: Type.Object({
        position_id: Type.String(),
        exit_price: Type.Number(),
        close_reason: Type.String({ description: "Reason: manual, take_profit, stop_loss, rsi_exit, kill_switch" })
      }),
      async execute(_toolCallId, params) {
        try {
          const record = await closePosition(params.position_id, params.exit_price, params.close_reason);
          if (!record) return { content: [{ type: "text", text: JSON.stringify({ error: "Position not found" }) }], details: {} };
          await sendTradeAlert({
            type: "closed",
            asset: record.asset,
            direction: record.direction,
            exitPrice: params.exit_price.toFixed(2),
            pnl: record.pnl,
            reason: params.close_reason
          });
          return { content: [{ type: "text", text: JSON.stringify({ closed: true, trade_id: record.id, pnl: record.pnl, pnl_pct: record.pnl_pct }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "bankr_positions",
      label: "BANKR Open Positions",
      description: "Get all open positions with current P&L.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const summary = await getPortfolioSummary();
          return { content: [{ type: "text", text: JSON.stringify(summary) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "bankr_trade_history",
      label: "BANKR Trade History",
      description: "Get recent trade history with P&L and tax lot data.",
      parameters: Type.Object({
        limit: Type.Optional(Type.Number({ description: "Max trades to return (default 20)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const history = await getTradeHistory();
          const limited = history.slice(-(params.limit || 20));
          return { content: [{ type: "text", text: JSON.stringify({ total: history.length, trades: limited }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "bankr_tax_summary",
      label: "BANKR Tax Summary",
      description: "Get YTD tax summary with quarterly breakdown, estimated federal and NY tax.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const summary = await getTaxSummary();
          return { content: [{ type: "text", text: JSON.stringify(summary) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    }
  ];
}
function buildOversightTools() {
  return [
    {
      name: "oversight_health_check",
      label: "Oversight Health Check",
      description: "Run a comprehensive health check on all Wealth Engines subsystems. Evaluates agent freshness, monitor heartbeat, kill switch, circuit breaker, data freshness, and job failures.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const report = await runHealthCheck();
          return { content: [{ type: "text", text: JSON.stringify(report) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_performance_review",
      label: "Oversight Performance Review",
      description: "Generate a performance review for the specified period. Calculates win rate, Sharpe ratio, slippage, source attribution, and thesis conversion rate.",
      parameters: Type.Object({
        period_days: Type.Optional(Type.Number({ description: "Review period in days (default 7)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const review = await runPerformanceReview(params.period_days ?? 7);
          return { content: [{ type: "text", text: JSON.stringify(review) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_cross_domain_exposure",
      label: "Oversight Cross-Domain Exposure",
      description: "Detect correlated exposure between crypto positions and Polymarket positions. Flags when both domains have aligned bets on the same underlying asset or theme.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const alerts = await detectCrossDomainExposure();
          return { content: [{ type: "text", text: JSON.stringify({ count: alerts.length, alerts }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_improvement_queue",
      label: "Oversight Improvement Queue",
      description: "Get all improvement requests captured by the oversight system. Filter by status to see open, resolved, or dismissed items.",
      parameters: Type.Object({
        status: Type.Optional(Type.Union([
          Type.Literal("open"),
          Type.Literal("accepted"),
          Type.Literal("resolved"),
          Type.Literal("dismissed")
        ], { description: "Filter by status. Default: all." }))
      }),
      async execute(_toolCallId, params) {
        try {
          let queue = await getImprovementQueue();
          if (params.status) {
            queue = queue.filter((i) => i.status === params.status);
          }
          return { content: [{ type: "text", text: JSON.stringify({ count: queue.length, items: queue }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_capture_improvement",
      label: "Oversight Capture Improvement",
      description: "Capture a new improvement request. Use when you identify an issue or optimization opportunity.",
      parameters: Type.Object({
        source: Type.Union([
          Type.Literal("health_check"),
          Type.Literal("performance_review"),
          Type.Literal("manual"),
          Type.Literal("circuit_breaker")
        ], { description: "Source of the improvement" }),
        category: Type.Union([
          Type.Literal("risk"),
          Type.Literal("execution"),
          Type.Literal("signal"),
          Type.Literal("infrastructure"),
          Type.Literal("strategy")
        ], { description: "Category of the improvement" }),
        severity: Type.Union([
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
          Type.Literal("critical")
        ], { description: "Severity level" }),
        domain: Type.Optional(Type.Union([
          Type.Literal("crypto"),
          Type.Literal("polymarket"),
          Type.Literal("cross_domain"),
          Type.Literal("system")
        ], { description: "Domain this improvement relates to" })),
        priority: Type.Optional(Type.Number({ description: "Priority (1=critical, 4=low). Auto-derived from severity if omitted." })),
        title: Type.String({ description: "Short title for the improvement" }),
        description: Type.String({ description: "Detailed description of the issue" }),
        pattern_description: Type.Optional(Type.String({ description: "Description of the pattern or trend that led to this improvement" })),
        recommendation: Type.String({ description: "Recommended action to address this" }),
        route: Type.Optional(Type.Union([
          Type.Literal("autoresearch"),
          Type.Literal("manual"),
          Type.Literal("bankr-config")
        ], { description: "Where to route this improvement for resolution" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const item = await captureImprovement(params);
          return { content: [{ type: "text", text: JSON.stringify(item) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_update_improvement",
      label: "Oversight Update Improvement",
      description: "Update the status of an improvement request.",
      parameters: Type.Object({
        id: Type.String({ description: "Improvement request ID" }),
        status: Type.Union([
          Type.Literal("accepted"),
          Type.Literal("resolved"),
          Type.Literal("dismissed")
        ], { description: "New status" }),
        note: Type.Optional(Type.String({ description: "Resolution note" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const item = await updateImprovement(params.id, params.status, params.note);
          if (!item) return { content: [{ type: "text", text: JSON.stringify({ error: "Improvement not found" }) }], details: {} };
          return { content: [{ type: "text", text: JSON.stringify(item) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_shadow_open",
      label: "Oversight Shadow Trade Open",
      description: "Open a hypothetical shadow trade to track what would have happened without real execution.",
      parameters: Type.Object({
        thesis_id: Type.String({ description: "Thesis ID that generated this signal" }),
        asset: Type.String({ description: "Asset name (e.g. BTC, ETH, or Polymarket question)" }),
        asset_class: Type.Union([Type.Literal("crypto"), Type.Literal("polymarket")], { description: "Asset class" }),
        source: Type.Union([Type.Literal("crypto_scout"), Type.Literal("polymarket_scout")], { description: "Signal source" }),
        direction: Type.String({ description: "LONG/SHORT for crypto, YES/NO for polymarket" }),
        entry_price: Type.Number({ description: "Entry price at signal time" })
      }),
      async execute(_toolCallId, params) {
        try {
          const trade = await openShadowTrade(params);
          return { content: [{ type: "text", text: JSON.stringify(trade) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_shadow_close",
      label: "Oversight Shadow Trade Close",
      description: "Close a shadow trade with an exit price and reason.",
      parameters: Type.Object({
        id: Type.String({ description: "Shadow trade ID" }),
        exit_price: Type.Number({ description: "Exit price" }),
        reason: Type.String({ description: "Close reason (e.g. stop_loss, take_profit, thesis_expired)" })
      }),
      async execute(_toolCallId, params) {
        try {
          const trade = await closeShadowTrade(params.id, params.exit_price, params.reason);
          if (!trade) return { content: [{ type: "text", text: JSON.stringify({ error: "Shadow trade not found" }) }], details: {} };
          return { content: [{ type: "text", text: JSON.stringify(trade) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_shadow_trades",
      label: "Oversight Shadow Trades",
      description: "List shadow trades. Optionally filter by status (open or closed).",
      parameters: Type.Object({
        status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")], { description: "Filter by status" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const trades = await getShadowTrades(params.status);
          return { content: [{ type: "text", text: JSON.stringify({ count: trades.length, trades }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_shadow_performance",
      label: "Oversight Shadow Performance",
      description: "Get aggregate shadow trading performance: total trades, win rate, P&L.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const perf = await getShadowPerformance();
          return { content: [{ type: "text", text: JSON.stringify(perf) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_shadow_refresh",
      label: "Oversight Shadow Refresh",
      description: "Fetch live market prices for all open shadow trades and update their hypothetical P&L. Auto-closes trades older than 7 days.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const result = await refreshShadowTradesFromMarket();
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_summary",
      label: "Oversight Summary",
      description: "Get a quick overview of oversight status: latest health report, drawdown status, active improvement details, and shadow trading stats.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const summary = await getOversightSummary();
          return { content: [{ type: "text", text: JSON.stringify(summary) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_daily_summary",
      label: "Oversight Daily Summary",
      description: "Generate and optionally send the daily performance summary via Telegram.",
      parameters: Type.Object({
        send_telegram: Type.Optional(Type.Boolean({ description: "If true, also sends the summary via Telegram (default: false)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          if (params.send_telegram) {
            await sendDailyPerformanceSummary();
            return { content: [{ type: "text", text: JSON.stringify({ sent: true }) }], details: {} };
          }
          const summary = await generateDailyPerformanceSummary();
          return { content: [{ type: "text", text: summary }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_auto_shadow",
      label: "Oversight Auto Shadow Trade",
      description: "Automatically track a shadow trade for a thesis that BANKR chose not to execute (e.g., rejected by approval, outside parameters). Deduplicates by asset+direction. Carries over stop_price and target_price from the thesis for auto-close tracking.",
      parameters: Type.Object({
        thesis_id: Type.String({ description: "Thesis ID to shadow" }),
        asset: Type.String({ description: "Asset symbol" }),
        asset_class: Type.Union([Type.Literal("crypto"), Type.Literal("polymarket")], { description: "Asset class" }),
        source: Type.Union([Type.Literal("crypto_scout"), Type.Literal("polymarket_scout")], { description: "Signal source" }),
        direction: Type.String({ description: "Trade direction (LONG/SHORT/YES/NO)" }),
        entry_price: Type.Number({ description: "Entry price at time of shadow" }),
        reason: Type.String({ description: "Why this is being shadow-tracked instead of executed" }),
        stop_price: Type.Optional(Type.Number({ description: "Stop-loss price from thesis" })),
        target_price: Type.Optional(Type.Number({ description: "Take-profit price from thesis" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const shadow = await autoTrackShadowTrade(params);
          if (shadow) {
            return { content: [{ type: "text", text: JSON.stringify(shadow) }], details: {} };
          }
          return { content: [{ type: "text", text: JSON.stringify({ skipped: true, reason: "Already tracking this thesis/asset" }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_thesis_review",
      label: "Oversight Thesis Review",
      description: "Run adversarial bull/bear review on all active theses from SCOUT and Polymarket SCOUT. Evaluates confidence, track record, and thesis age to produce a verdict (bull_favored, bear_favored, neutral) with recommendation. Auto-captures improvements for bear-favored theses.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const reviews = await reviewTheses();
          return { content: [{ type: "text", text: JSON.stringify({ count: reviews.length, reviews }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "oversight_per_asset_losses",
      label: "Oversight Per-Asset Loss Check",
      description: "Check for concentrated per-asset losses over the last 7 days. Captures improvement requests when any single asset exceeds 10% portfolio loss.",
      parameters: Type.Object({}),
      async execute() {
        try {
          await checkPerAssetLosses();
          return { content: [{ type: "text", text: JSON.stringify({ checked: true }) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "autoresearch_run",
      label: "Autoresearch Run",
      description: "Run autoresearch parameter optimization experiments. Supports crypto, polymarket, or both domains. Backtests parameter mutations against historical data and keeps improvements.",
      parameters: Type.Object({
        domain: Type.Union([Type.Literal("crypto"), Type.Literal("polymarket"), Type.Literal("both")], { description: "Which domain(s) to optimize" }),
        experiments_per_domain: Type.Optional(Type.Number({ description: "Number of experiments per domain (default 15)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const count = params.experiments_per_domain || 15;
          let summaries;
          if (params.domain === "crypto") {
            summaries = [await runCryptoResearch(count)];
          } else if (params.domain === "polymarket") {
            summaries = [await runPolymarketResearch(count)];
          } else {
            summaries = await runFullResearch(count);
          }
          return { content: [{ type: "text", text: JSON.stringify(summaries) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "autoresearch_status",
      label: "Autoresearch Status",
      description: "Get current autoresearch status including active parameters for both crypto and polymarket, recent experiment history, and rollback availability.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const status = await getResearchStatus();
          return { content: [{ type: "text", text: JSON.stringify(status) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "autoresearch_rollback",
      label: "Autoresearch Rollback",
      description: "Roll back parameters to the previous set for a given domain. Maintains up to 5 rollback points per domain.",
      parameters: Type.Object({
        domain: Type.Union([Type.Literal("crypto"), Type.Literal("polymarket")], { description: "Which domain to roll back" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await rollbackParams(params.domain);
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "autoresearch_experiment_log",
      label: "Autoresearch Experiment Log",
      description: "Get the full experiment history showing all parameter mutations, their backtested scores, and whether they were kept or reverted.",
      parameters: Type.Object({
        domain: Type.Optional(Type.Union([Type.Literal("crypto"), Type.Literal("polymarket")], { description: "Filter by domain" })),
        limit: Type.Optional(Type.Number({ description: "Number of recent experiments to return (default 20)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const log = await getExperimentLog();
          let filtered = params.domain ? log.filter((e) => e.domain === params.domain) : log;
          const limit = params.limit || 20;
          filtered = filtered.slice(-limit);
          return { content: [{ type: "text", text: JSON.stringify(filtered) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    },
    {
      name: "autoresearch_params",
      label: "Autoresearch Current Parameters",
      description: "Get the current optimized parameters for crypto signals or polymarket thresholds.",
      parameters: Type.Object({
        domain: Type.Union([Type.Literal("crypto"), Type.Literal("polymarket")], { description: "Which domain's parameters to retrieve" })
      }),
      async execute(_toolCallId, params) {
        try {
          if (params.domain === "crypto") {
            const p2 = await getCryptoParams();
            return { content: [{ type: "text", text: JSON.stringify(p2) }], details: {} };
          }
          const p = await getPolymarketParams();
          return { content: [{ type: "text", text: JSON.stringify(p) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }], details: {} };
        }
      }
    }
  ];
}
var RAPIDAPI_KEY2 = process.env.RAPIDAPI_KEY || "";
var ZILLOW_API_HOST = "private-zillow.p.rapidapi.com";
function buildZillowLocationSlug(location) {
  return location.toLowerCase().replace(/[,]+/g, "").replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
function buildZillowSearchUrl(location, filters) {
  const slug = buildZillowLocationSlug(location);
  const filterState = {
    tow: { value: false },
    mf: { value: false },
    con: { value: false },
    land: { value: false },
    apa: { value: false },
    manu: { value: false },
    apco: { value: false }
  };
  if (filters?.minPrice || filters?.maxPrice) {
    filterState.price = {};
    if (filters.minPrice) filterState.price.min = filters.minPrice;
    if (filters.maxPrice) filterState.price.max = filters.maxPrice;
  }
  if (filters?.minBeds) filterState.beds = { min: filters.minBeds };
  if (filters?.minBaths) filterState.baths = { min: filters.minBaths };
  if (filters?.sort) filterState.sort = { value: filters.sort === "Newest" ? "days" : filters.sort };
  const searchQueryState = { filterState };
  if (filters?.page && filters.page > 1) {
    searchQueryState.pagination = { currentPage: filters.page };
  }
  const qs = encodeURIComponent(JSON.stringify(searchQueryState));
  return `https://www.zillow.com/${slug}/?searchQueryState=${qs}`;
}
function normalizeZillowUrl(url) {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `https://www.zillow.com${url.startsWith("/") ? "" : "/"}${url}`;
}
function getZillowResults(data) {
  return data?.Results || data?.results || [];
}
function getZillowTotalResults(data, fallbackCount) {
  return data?.total_results || data?.totalResultCount || fallbackCount;
}
async function fetchZillow(endpoint, params) {
  const url = `https://${ZILLOW_API_HOST}/${endpoint}?${new URLSearchParams(params)}`;
  let resp = await fetch(url, {
    headers: { "X-RapidAPI-Key": RAPIDAPI_KEY2, "X-RapidAPI-Host": ZILLOW_API_HOST }
  });
  if (resp.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    resp = await fetch(url, {
      headers: { "X-RapidAPI-Key": RAPIDAPI_KEY2, "X-RapidAPI-Host": ZILLOW_API_HOST }
    });
  }
  if (!resp.ok) throw new Error(`Zillow API error: ${resp.status} ${resp.statusText}`);
  return resp.json();
}
function buildRealEstateTools() {
  if (!RAPIDAPI_KEY2) return [];
  return [
    {
      name: "property_search",
      label: "Property Search",
      description: "Search Zillow for property listings by location with filters. Returns structured listing data including address, price, beds, baths, sqft, and listing URLs.",
      parameters: Type.Object({
        location: Type.String({ description: "Location to search \u2014 city and state, zip code, or neighborhood (e.g. 'Montclair, NJ', '07042', 'Garden City, NY')" }),
        minPrice: Type.Optional(Type.Number({ description: "Minimum price filter (e.g. 1500000)" })),
        maxPrice: Type.Optional(Type.Number({ description: "Maximum price filter (e.g. 2000000)" })),
        minBeds: Type.Optional(Type.Number({ description: "Minimum bedrooms (e.g. 5)" })),
        minBaths: Type.Optional(Type.Number({ description: "Minimum bathrooms (e.g. 3)" })),
        sort: Type.Optional(Type.String({ description: "Sort order: 'Newest', 'Price_High_Low', 'Price_Low_High', 'Bedrooms', 'Bathrooms'" })),
        page: Type.Optional(Type.Number({ description: "Page number for pagination (default 1)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const zillowUrl = buildZillowSearchUrl(params.location, {
            minPrice: params.minPrice,
            maxPrice: params.maxPrice,
            minBeds: params.minBeds,
            minBaths: params.minBaths,
            sort: params.sort,
            page: params.page
          });
          const data = await fetchZillow("search/byurl", { url: zillowUrl });
          const props = getZillowResults(data);
          if (props.length === 0) return { content: [{ type: "text", text: `No properties found in ${params.location} matching criteria. Try broadening filters or checking the location name.` }], details: {} };
          const summary = props.slice(0, 20).map((p) => {
            const info = p.hdpData?.homeInfo || {};
            return {
              address: p.address,
              price: p.unformattedPrice ? `$${p.unformattedPrice.toLocaleString()}` : p.price || "N/A",
              beds: p.beds ?? info.bedrooms,
              baths: p.baths ?? info.bathrooms,
              sqft: info.livingArea || p.area,
              lotSize: info.lotAreaValue ? `${info.lotAreaValue} ${info.lotAreaUnit || "sqft"}` : "N/A",
              zpid: p.zpid,
              daysOnZillow: info.daysOnZillow ?? p.variableData?.text,
              listingUrl: normalizeZillowUrl(p.detailUrl),
              propertyType: info.homeType || p.statusType,
              listingStatus: p.statusText || info.homeStatus
            };
          });
          return { content: [{ type: "text", text: JSON.stringify({ totalResults: getZillowTotalResults(data, props.length), resultsReturned: summary.length, properties: summary }, null, 2) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Property search failed: ${err.message}` }], details: {} };
        }
      }
    },
    {
      name: "property_details",
      label: "Property Details",
      description: "Get detailed information about a specific property from Zillow. Provide the zpid and the city/state location from property_search results. Returns price, beds, baths, sqft, zestimate, open house info, and listing details.",
      parameters: Type.Object({
        zpid: Type.Number({ description: "Zillow property ID (from property_search results)" }),
        location: Type.String({ description: "City and state where the property is located (e.g. 'Montclair, NJ') \u2014 needed to search the area and find the property" }),
        address: Type.Optional(Type.String({ description: "Full property address for display (e.g. '10 Mountain Ter, Montclair, NJ 07043')" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const zillowUrl = buildZillowSearchUrl(params.location);
          const data = await fetchZillow("search/byurl", { url: zillowUrl });
          const allResults = getZillowResults(data);
          const match = allResults.find((r) => String(r.zpid) === String(params.zpid));
          if (!match) {
            return { content: [{ type: "text", text: `Property zpid ${params.zpid} not found in ${params.location} listings (searched ${allResults.length} results). The listing may have been removed or the location may not match. Try property_search to find current listings.` }], details: {} };
          }
          const info = match.hdpData?.homeInfo || {};
          const details = {
            address: match.address || info.streetAddress,
            price: match.unformattedPrice ? `$${match.unformattedPrice.toLocaleString()}` : match.price || "N/A",
            beds: match.beds ?? info.bedrooms,
            baths: match.baths ?? info.bathrooms,
            sqft: info.livingArea || match.area,
            lotSize: info.lotAreaValue ? `${info.lotAreaValue} ${info.lotAreaUnit || "sqft"}` : "N/A",
            propertyType: info.homeType,
            daysOnZillow: info.daysOnZillow,
            listingUrl: normalizeZillowUrl(match.detailUrl) || `https://www.zillow.com/homedetails/${params.zpid}_zpid/`,
            zestimate: info.zestimate ? `$${info.zestimate.toLocaleString()}` : "N/A",
            rentZestimate: info.rentZestimate ? `$${info.rentZestimate.toLocaleString()}/mo` : "N/A",
            homeStatus: info.homeStatus || match.statusText,
            listingStatus: match.statusText
          };
          if (info.openHouse || match.flexFieldText) {
            details.openHouse = info.openHouse || match.flexFieldText;
          }
          if (info.open_house_info?.open_house_showing?.length > 0) {
            details.openHouseShowings = info.open_house_info.open_house_showing.map((s) => ({
              start: new Date(s.open_house_start).toLocaleString("en-US", { timeZone: "America/New_York" }),
              end: new Date(s.open_house_end).toLocaleString("en-US", { timeZone: "America/New_York" })
            }));
          }
          if (info.listing_sub_type) {
            details.listingSubType = info.listing_sub_type;
          }
          details.note = "For school ratings, walkability, price history, and tax details, use web_search with the Zillow listing URL or the property address.";
          return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Property details failed: ${err.message}` }], details: {} };
        }
      }
    },
    {
      name: "neighborhood_search",
      label: "Neighborhood Search",
      description: "Search for neighborhood information including demographics, school ratings, and nearby amenities for a given location. Useful for evaluating walkability, schools, and community character.",
      parameters: Type.Object({
        location: Type.String({ description: "Location to research \u2014 city and state or zip code (e.g. 'Montclair, NJ', '07042')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const zillowUrl = buildZillowSearchUrl(params.location);
          const data = await fetchZillow("search/byurl", { url: zillowUrl });
          const props = getZillowResults(data);
          const result = {
            location: params.location,
            totalListings: getZillowTotalResults(data, props.length),
            medianPrice: null
          };
          if (props.length > 0) {
            const prices = props.filter((p) => p.unformattedPrice).map((p) => p.unformattedPrice).sort((a, b) => a - b);
            if (prices.length > 0) result.medianPrice = `$${prices[Math.floor(prices.length / 2)].toLocaleString()}`;
            const sqftPrices = props.filter((p) => p.hdpData?.homeInfo?.livingArea && p.unformattedPrice).map((p) => p.unformattedPrice / p.hdpData.homeInfo.livingArea);
            if (sqftPrices.length > 0) result.avgPricePerSqft = `$${Math.round(sqftPrices.reduce((a, b) => a + b, 0) / sqftPrices.length)}`;
          }
          result.note = "Use web_search for detailed school ratings (GreatSchools), walkability scores, and neighborhood character. Use property_details with a specific zpid for school data near a property.";
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Neighborhood search failed: ${err.message}` }], details: {} };
        }
      }
    },
    {
      name: "redfin_search",
      label: "Redfin Property Search",
      description: "Search Redfin for property listings using a Redfin search URL with filters. Use properties/auto-complete first to get the correct region URL, then build a full search URL. Returns listings with address, price, beds, baths, sqft, listing remarks, key facts, and days on market.",
      parameters: Type.Object({
        url: Type.String({ description: "Full Redfin search URL with filters, e.g. 'https://www.redfin.com/city/35939/NJ/Montclair/filter/min-price=1.5M,max-price=2M,min-beds=5,min-baths=3'. Build from auto-complete results: /city/{id}/{state}/{city}/filter/min-price=X,max-price=X,min-beds=X,min-baths=X" })
      }),
      async execute(_toolCallId, params) {
        try {
          const resp = await fetch(`https://redfin-com-data.p.rapidapi.com/property/search-url?url=${encodeURIComponent(params.url)}`, {
            headers: { "X-RapidAPI-Key": RAPIDAPI_KEY2, "X-RapidAPI-Host": "redfin-com-data.p.rapidapi.com" }
          });
          if (!resp.ok) return { content: [{ type: "text", text: `Redfin API error: ${resp.status} ${resp.statusText}` }], details: {} };
          const data = await resp.json();
          const homes = data?.data?.nearbyHomes?.homes || data?.data?.homes || [];
          if (homes.length === 0) return { content: [{ type: "text", text: `No Redfin listings found for this search. Try broadening filters or checking the URL.` }], details: {} };
          const summary = homes.slice(0, 20).map((h) => ({
            address: `${h.streetLine?.value || ""}, ${h.city || ""}, ${h.state || ""} ${h.zip || ""}`.trim(),
            price: h.price?.value ? `$${h.price.value.toLocaleString()}` : "N/A",
            beds: h.beds,
            baths: h.baths,
            sqft: h.sqFt?.value || null,
            lotSize: h.lotSize?.value ? `${h.lotSize.value.toLocaleString()} sqft` : null,
            daysOnMarket: h.dom?.value ?? null,
            listingId: h.listingId,
            redfinUrl: h.url ? `https://www.redfin.com${h.url}` : null,
            mlsId: h.mlsId?.value || null,
            mlsStatus: h.mlsStatus,
            propertyType: h.propertyType,
            listingRemarks: h.listingRemarks ? h.listingRemarks.substring(0, 300) : null,
            keyFacts: h.keyFacts?.map((f) => f.description) || [],
            listingTags: h.listingTags || [],
            broker: h.listingBroker?.name || null,
            lat: h.latLong?.value?.latitude,
            lng: h.latLong?.value?.longitude
          }));
          return { content: [{ type: "text", text: JSON.stringify({ source: "Redfin", totalResults: homes.length, resultsReturned: summary.length, properties: summary }, null, 2) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Redfin search failed: ${err.message}` }], details: {} };
        }
      }
    },
    {
      name: "redfin_details",
      label: "Redfin Property Details",
      description: "Get detailed Redfin property information including photos, room descriptions, features, and market data. Use the property URL from redfin_search results (e.g. '/NJ/Glen-Ridge/210-Baldwin-St-07028/home/36166097').",
      parameters: Type.Object({
        url: Type.String({ description: "Redfin property URL path from search results (e.g. '/NJ/Glen-Ridge/210-Baldwin-St-07028/home/36166097')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const resp = await fetch(`https://redfin-com-data.p.rapidapi.com/property/detail?url=${encodeURIComponent(params.url)}`, {
            headers: { "X-RapidAPI-Key": RAPIDAPI_KEY2, "X-RapidAPI-Host": "redfin-com-data.p.rapidapi.com" }
          });
          if (!resp.ok) return { content: [{ type: "text", text: `Redfin API error: ${resp.status} ${resp.statusText}` }], details: {} };
          const data = await resp.json();
          if (!data?.data) return { content: [{ type: "text", text: `No details found for this property URL. Ensure the URL is a property path like '/NJ/City/123-Main-St-07028/home/12345678'.` }], details: {} };
          const d = data.data;
          const numericKey = Object.keys(d).find((k) => /^\d+$/.test(k));
          const photoSection = numericKey ? d[numericKey] : null;
          const tagsByPhoto = photoSection && typeof photoSection === "object" && photoSection.tagsByPhotoId ? photoSection.tagsByPhotoId : {};
          const photoSummary = Object.values(tagsByPhoto).slice(0, 10).map((p) => ({
            caption: p.shortCaption || p.longCaption || "",
            tags: p.tags || [],
            url: p.photoUrl || ""
          }));
          const affordability = d.affordability || {};
          const result = {
            source: "Redfin",
            propertyUrl: params.url,
            listingId: photoSection?.listingId || null,
            photoCount: photoSection?.includedFilterTags?.All || Object.keys(tagsByPhoto).length || 0,
            photos: photoSummary.length > 0 ? photoSummary : "No photos available"
          };
          if (affordability.bedroomAggregates) {
            result.marketData = {
              activeListingTrend: affordability.activeListingYearlyTrend != null ? `${affordability.activeListingYearlyTrend.toFixed(1)}%` : null,
              bedroomBreakdown: (affordability.bedroomAggregates || []).filter((b) => b.aggregate?.listPriceMedian).map((b) => ({
                beds: b.aggregationType,
                medianPrice: `$${b.aggregate.listPriceMedian.toLocaleString()}`,
                activeListings: b.aggregate.activeListingsCount
              }))
            };
          }
          const knownKeys = Object.keys(d).filter((k) => k !== numericKey && k !== "affordability");
          if (knownKeys.length > 0) {
            result.additionalSections = knownKeys;
          }
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Redfin details failed: ${err.message}` }], details: {} };
        }
      }
    },
    {
      name: "redfin_autocomplete",
      label: "Redfin Location Lookup",
      description: "Look up a location on Redfin to get the correct region ID and URL path for use with redfin_search. Returns matching cities, neighborhoods, and schools.",
      parameters: Type.Object({
        query: Type.String({ description: "Location to look up (e.g. 'Montclair, NJ', 'Upper Saddle River', 'Princeton NJ')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const resp = await fetch(`https://redfin-com-data.p.rapidapi.com/properties/auto-complete?query=${encodeURIComponent(params.query)}`, {
            headers: { "X-RapidAPI-Key": RAPIDAPI_KEY2, "X-RapidAPI-Host": "redfin-com-data.p.rapidapi.com" }
          });
          if (!resp.ok) return { content: [{ type: "text", text: `Redfin API error: ${resp.status} ${resp.statusText}` }], details: {} };
          const data = await resp.json();
          const rows = data?.data?.flatMap((section) => section.rows || []) || [];
          if (rows.length === 0) return { content: [{ type: "text", text: `No Redfin locations found for "${params.query}". Try a different spelling.` }], details: {} };
          const results = rows.slice(0, 10).map((r) => ({
            name: r.name,
            subName: r.subName,
            url: r.url,
            id: r.id,
            type: r.type
          }));
          return { content: [{ type: "text", text: JSON.stringify({ source: "Redfin", note: "Use the 'url' field to build redfin_search URLs: https://www.redfin.com{url}/filter/min-price=X,max-price=X,min-beds=X,min-baths=X", locations: results }, null, 2) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Redfin autocomplete failed: ${err.message}` }], details: {} };
        }
      }
    }
  ];
}
function buildMapsTools() {
  return [
    {
      name: "maps_directions",
      label: "Directions",
      description: "Get directions between two locations with distance, estimated time, and turn-by-turn steps. Supports driving, walking, and cycling.",
      parameters: Type.Object({
        from: Type.String({ description: "Starting location (address, place name, or landmark)" }),
        to: Type.String({ description: "Destination location (address, place name, or landmark)" }),
        mode: Type.Optional(Type.String({ description: "Travel mode: 'driving' (default), 'walking', or 'cycling'" }))
      }),
      async execute(_toolCallId, params) {
        const result = await getDirections(params.from, params.to, params.mode);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "maps_search_places",
      label: "Search Places",
      description: "Search for places, businesses, or addresses. Optionally search near a specific location.",
      parameters: Type.Object({
        query: Type.String({ description: "What to search for (e.g. 'coffee shops', 'gas stations', 'Central Park')" }),
        near: Type.Optional(Type.String({ description: "Search near this location (e.g. 'Manhattan, NY', 'San Francisco')" }))
      }),
      async execute(_toolCallId, params) {
        const result = await searchPlaces(params.query, params.near);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildInterviewTool(sessionId) {
  return [
    {
      name: "interview",
      label: "Interview",
      description: "Ask the user structured clarification questions via an interactive form. Use this when you need specific choices, preferences, or detailed context from the user before proceeding. Supports single-select (pick one), multi-select (pick many), text (free input), and info (display-only context). The form appears inline in the chat. Returns the user's responses as key-value pairs.",
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: "Title shown at the top of the form" })),
        description: Type.Optional(Type.String({ description: "Brief description or context for the form" })),
        questions: Type.Array(
          Type.Object({
            id: Type.String({ description: "Unique identifier for this question" }),
            type: Type.Union([
              Type.Literal("single"),
              Type.Literal("multi"),
              Type.Literal("text"),
              Type.Literal("info")
            ], { description: "Question type: single (radio), multi (checkbox), text (free input), info (display only)" }),
            question: Type.String({ description: "The question text to display" }),
            options: Type.Optional(Type.Array(Type.String(), { description: "Options for single/multi select questions" })),
            recommended: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Recommended option(s) shown with a badge" })),
            context: Type.Optional(Type.String({ description: "Additional helper text shown below the question" }))
          }),
          { description: "Array of questions to ask the user" }
        )
      }),
      async execute(toolCallId, params) {
        const entry = sessions.get(sessionId);
        if (!entry) {
          return { content: [{ type: "text", text: "Session expired." }], details: {} };
        }
        if (entry.interviewWaiter) {
          return { content: [{ type: "text", text: "An interview form is already active. Wait for the user to respond before sending another." }], details: {} };
        }
        entry.pendingInterviewForm = {
          toolCallId,
          title: params.title,
          description: params.description,
          questions: params.questions
        };
        const interviewEvent = JSON.stringify({
          type: "interview_form",
          toolCallId,
          title: params.title,
          description: params.description,
          questions: params.questions
        });
        for (const sub of entry.subscribers) {
          try {
            sub.write(`data: ${interviewEvent}

`);
          } catch {
          }
        }
        const responses = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (entry.interviewWaiter) {
              entry.interviewWaiter = void 0;
              entry.pendingInterviewForm = void 0;
              const timeoutEvent = JSON.stringify({ type: "interview_timeout" });
              for (const sub of entry.subscribers) {
                try {
                  sub.write(`data: ${timeoutEvent}

`);
                } catch {
                }
              }
              resolve([]);
            }
          }, 15 * 60 * 1e3);
          entry.interviewWaiter = { resolve, reject: () => {
          }, timer };
        });
        if (responses.length === 0) {
          return {
            content: [{ type: "text", text: "The user did not respond to the interview form (timed out after 15 minutes). You can ask them directly in chat instead." }],
            details: { timedOut: true }
          };
        }
        const formatted = responses.map((r) => `**${r.id}**: ${Array.isArray(r.value) ? r.value.join(", ") : r.value}`).join("\n");
        return {
          content: [{ type: "text", text: formatted }],
          details: { responses }
        };
      }
    }
  ];
}
function buildDriveTools() {
  return [
    {
      name: "drive_list",
      label: "Google Drive List",
      description: `List or search files in Google Drive. Use query parameter for Drive search syntax (e.g. "name contains 'report'", "mimeType='application/vnd.google-apps.folder'", "'FOLDER_ID' in parents"). Without query, returns most recently modified files.`,
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Google Drive search query (Drive API q parameter syntax)" })),
        maxResults: Type.Optional(Type.Number({ description: "Max files to return (default 20)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await driveList(params.query, params.maxResults || 20);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "drive_get",
      label: "Google Drive Get",
      description: "Get detailed metadata for a specific file or folder in Google Drive by its ID.",
      parameters: Type.Object({
        fileId: Type.String({ description: "The Google Drive file ID" })
      }),
      async execute(_toolCallId, params) {
        const result = await driveGet(params.fileId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "drive_create_folder",
      label: "Google Drive Create Folder",
      description: "Create a new folder in Google Drive. Optionally specify a parent folder ID to create it inside an existing folder.",
      parameters: Type.Object({
        name: Type.String({ description: "Name for the new folder" }),
        parentId: Type.Optional(Type.String({ description: "Parent folder ID (creates at root if omitted)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await driveCreateFolder(params.name, params.parentId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "drive_move",
      label: "Google Drive Move",
      description: "Move a file or folder to a different folder in Google Drive.",
      parameters: Type.Object({
        fileId: Type.String({ description: "ID of the file/folder to move" }),
        newParentId: Type.String({ description: "ID of the destination folder" })
      }),
      async execute(_toolCallId, params) {
        const result = await driveMove(params.fileId, params.newParentId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "drive_rename",
      label: "Google Drive Rename",
      description: "Rename a file or folder in Google Drive.",
      parameters: Type.Object({
        fileId: Type.String({ description: "ID of the file/folder to rename" }),
        newName: Type.String({ description: "New name for the file/folder" })
      }),
      async execute(_toolCallId, params) {
        const result = await driveRename(params.fileId, params.newName);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "drive_delete",
      label: "Google Drive Delete",
      description: "Move a file or folder to trash in Google Drive. This does not permanently delete \u2014 it can be recovered from trash.",
      parameters: Type.Object({
        fileId: Type.String({ description: "ID of the file/folder to trash" })
      }),
      async execute(_toolCallId, params) {
        const result = await driveDelete(params.fileId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildSheetsTools() {
  return [
    {
      name: "sheets_list",
      label: "Google Sheets List",
      description: "List all Google Sheets spreadsheets in Drive.",
      parameters: Type.Object({}),
      async execute() {
        const result = await sheetsList();
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_read",
      label: "Google Sheets Read",
      description: "Read data from a Google Sheets spreadsheet. Specify a range like 'Sheet1!A1:D10' or just 'Sheet1' for the whole sheet.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID (from the URL or drive_list)" }),
        range: Type.String({ description: "Cell range to read, e.g. 'Sheet1!A1:D10' or 'Sheet1'" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsRead(params.spreadsheetId, params.range);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_append",
      label: "Google Sheets Append",
      description: "Append one or more rows to a Google Sheets spreadsheet. Each row is an array of cell values.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        values: Type.Array(Type.Array(Type.String()), { description: 'Array of rows, each row is an array of cell values. Example: [["Name", "Age"], ["Alice", "30"]]' })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsAppend(params.spreadsheetId, params.values);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_update",
      label: "Google Sheets Update",
      description: "Update specific cells in a Google Sheets spreadsheet. Specify the range and new values.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        range: Type.String({ description: "Cell range to update, e.g. 'Sheet1!A1:B2'" }),
        values: Type.Array(Type.Array(Type.String()), { description: "Array of rows with new values" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsUpdate(params.spreadsheetId, params.range, params.values);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_create",
      label: "Google Sheets Create",
      description: "Create a new Google Sheets spreadsheet.",
      parameters: Type.Object({
        title: Type.String({ description: "Title for the new spreadsheet" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsCreate(params.title);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_add_sheet",
      label: "Google Sheets Add Sheet",
      description: "Add a new sheet (tab) to an existing Google Sheets spreadsheet.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        title: Type.String({ description: "Title for the new sheet tab" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsAddSheet(params.spreadsheetId, params.title);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_delete_sheet",
      label: "Google Sheets Delete Sheet",
      description: "Delete a sheet (tab) from a Google Sheets spreadsheet by its numeric sheet ID.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID to delete (from sheets_read or sheets_add_sheet)" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsDeleteSheet(params.spreadsheetId, params.sheetId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_clear",
      label: "Google Sheets Clear",
      description: "Clear all values from a specified range in a Google Sheets spreadsheet without removing formatting.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        range: Type.String({ description: "Cell range to clear, e.g. 'Sheet1!A1:D10'" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsClear(params.spreadsheetId, params.range);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_format_cells",
      label: "Google Sheets Format",
      description: "Format cells in a Google Sheets spreadsheet. Set bold, background color, text color, and font size for a range of cells.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID (0 for the first sheet)" }),
        startRow: Type.Number({ description: "Start row index (0-based)" }),
        endRow: Type.Number({ description: "End row index (exclusive, 0-based)" }),
        startCol: Type.Number({ description: "Start column index (0-based)" }),
        endCol: Type.Number({ description: "End column index (exclusive, 0-based)" }),
        bold: Type.Optional(Type.Boolean({ description: "Whether to bold the text" })),
        bgColor: Type.Optional(Type.Object({ red: Type.Optional(Type.Number()), green: Type.Optional(Type.Number()), blue: Type.Optional(Type.Number()) }, { description: "Background color as RGB values 0-1" })),
        textColor: Type.Optional(Type.Object({ red: Type.Optional(Type.Number()), green: Type.Optional(Type.Number()), blue: Type.Optional(Type.Number()) }, { description: "Text color as RGB values 0-1" })),
        fontSize: Type.Optional(Type.Number({ description: "Font size in points" }))
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsFormatCells(params.spreadsheetId, params.sheetId, params.startRow, params.endRow, params.startCol, params.endCol, params.bold, params.bgColor, params.textColor, params.fontSize);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_auto_resize",
      label: "Google Sheets Auto Resize",
      description: "Auto-resize columns in a Google Sheets spreadsheet to fit their content.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID (0 for the first sheet)" }),
        startCol: Type.Optional(Type.Number({ description: "Start column index (0-based, optional)" })),
        endCol: Type.Optional(Type.Number({ description: "End column index (exclusive, 0-based, optional)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsAutoResize(params.spreadsheetId, params.sheetId, params.startCol, params.endCol);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_merge_cells",
      label: "Google Sheets Merge",
      description: "Merge a range of cells in a Google Sheets spreadsheet.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID (0 for the first sheet)" }),
        startRow: Type.Number({ description: "Start row index (0-based)" }),
        endRow: Type.Number({ description: "End row index (exclusive, 0-based)" }),
        startCol: Type.Number({ description: "Start column index (0-based)" }),
        endCol: Type.Number({ description: "End column index (exclusive, 0-based)" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsMergeCells(params.spreadsheetId, params.sheetId, params.startRow, params.endRow, params.startCol, params.endCol);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_batch_update",
      label: "Google Sheets Batch Update",
      description: "Execute a raw batchUpdate on a Google Sheets spreadsheet. Accepts an array of Sheets API request objects for complex multi-step operations.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        requests: Type.Array(Type.Any(), { description: "Array of Sheets API request objects (e.g. addSheet, mergeCells, updateBorders, etc.)" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsBatchUpdate(params.spreadsheetId, params.requests);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_sort",
      label: "Google Sheets Sort",
      description: "Sort a sheet by a specific column.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID (0 for the first sheet)" }),
        sortCol: Type.Number({ description: "Column index to sort by (0-based)" }),
        ascending: Type.Optional(Type.Boolean({ description: "Sort ascending (default true). Set false for descending." }))
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsSort(params.spreadsheetId, params.sheetId, params.sortCol, params.ascending);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildDocsTools() {
  return [
    {
      name: "docs_list",
      label: "Google Docs List",
      description: "List all Google Docs documents in Drive. Returns most recently modified documents.",
      parameters: Type.Object({}),
      async execute() {
        const result = await docsList();
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_get",
      label: "Google Docs Read",
      description: "Read the full content of a Google Doc by its document ID. Returns the title and extracted text content.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID (from the URL or drive_list)" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsGet(params.documentId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_create",
      label: "Google Docs Create",
      description: "Create a new blank Google Doc with the given title.",
      parameters: Type.Object({
        title: Type.String({ description: "Title for the new document" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsCreate(params.title);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_append",
      label: "Google Docs Append",
      description: "Append text to the end of an existing Google Doc. For rich formatting, this uses plain text insertion.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        text: Type.String({ description: "Text to append to the document" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsAppend(params.documentId, params.text);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_insert_text",
      label: "Google Docs Insert Text",
      description: "Insert text at a specific position in a Google Doc. If no index is provided, inserts at the end of the document.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        text: Type.String({ description: "Text to insert" }),
        index: Type.Optional(Type.Number({ description: "Character index to insert at (1-based). Omit to insert at end." }))
      }),
      async execute(_toolCallId, params) {
        const result = await docsInsertText(params.documentId, params.text, params.index);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_delete_content",
      label: "Google Docs Delete Content",
      description: "Delete a range of content from a Google Doc by start and end character index.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        startIndex: Type.Number({ description: "Start character index (1-based, inclusive)" }),
        endIndex: Type.Number({ description: "End character index (exclusive)" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsDeleteContent(params.documentId, params.startIndex, params.endIndex);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_insert_table",
      label: "Google Docs Insert Table",
      description: "Insert an empty table at the end of a Google Doc.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        rows: Type.Number({ description: "Number of rows" }),
        cols: Type.Number({ description: "Number of columns" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsInsertTable(params.documentId, params.rows, params.cols);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_format_text",
      label: "Google Docs Format Text",
      description: "Apply formatting (bold, italic, font size, color) to a range of text in a Google Doc.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        startIndex: Type.Number({ description: "Start character index (1-based, inclusive)" }),
        endIndex: Type.Number({ description: "End character index (exclusive)" }),
        bold: Type.Optional(Type.Boolean({ description: "Set text bold" })),
        italic: Type.Optional(Type.Boolean({ description: "Set text italic" })),
        fontSize: Type.Optional(Type.Number({ description: "Font size in points (e.g. 12, 18, 24)" })),
        foregroundColor: Type.Optional(Type.String({ description: "Text color as hex string (e.g. '#FF0000' for red)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await docsFormatText(params.documentId, params.startIndex, params.endIndex, params.bold, params.italic, params.fontSize, params.foregroundColor);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_insert_image",
      label: "Google Docs Insert Image",
      description: "Insert an inline image into a Google Doc from a URL.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        imageUri: Type.String({ description: "Public URL of the image to insert" }),
        index: Type.Optional(Type.Number({ description: "Character index to insert at. Omit to insert at end." }))
      }),
      async execute(_toolCallId, params) {
        const result = await docsInsertImage(params.documentId, params.imageUri, params.index);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_replace_text",
      label: "Google Docs Replace Text",
      description: "Find and replace all occurrences of a text string in a Google Doc.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        findText: Type.String({ description: "Text to find" }),
        replaceText: Type.String({ description: "Replacement text" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsReplaceText(params.documentId, params.findText, params.replaceText);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_insert_heading",
      label: "Google Docs Insert Heading",
      description: "Insert a heading (H1\u2013H6) at the end of a Google Doc.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        text: Type.String({ description: "Heading text" }),
        level: Type.Number({ description: "Heading level 1\u20136 (1 = largest)" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsInsertHeading(params.documentId, params.text, params.level);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_batch_update",
      label: "Google Docs Batch Update",
      description: "Send a raw batchUpdate request to the Google Docs API. Use for complex multi-step document operations not covered by other tools.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        requests: Type.Array(Type.Any(), { description: "Array of Google Docs API request objects (e.g. insertText, updateTextStyle, etc.)" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsBatchUpdate(params.documentId, params.requests);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildSlidesTools() {
  return [
    {
      name: "slides_list",
      label: "Google Slides List",
      description: "List all Google Slides presentations in Drive. Returns most recently modified presentations.",
      parameters: Type.Object({}),
      async execute() {
        const result = await slidesList();
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_get",
      label: "Google Slides Read",
      description: "Read the content of a Google Slides presentation by ID. Returns slide count, page size, and text content from each slide.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID (from the URL or drive_list)" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesGet(params.presentationId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_create",
      label: "Google Slides Create",
      description: "Create a new blank Google Slides presentation with the given title.",
      parameters: Type.Object({
        title: Type.String({ description: "Title for the new presentation" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesCreate(params.title);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_append",
      label: "Google Slides Add Slide",
      description: "Add a new slide with a title and body text to an existing Google Slides presentation. The slide uses a Title and Body layout.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID (from the URL or drive_list)" }),
        title: Type.String({ description: "Title text for the new slide" }),
        body: Type.String({ description: "Body text content for the new slide" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesAppend(params.presentationId, params.title, params.body);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_insert_table",
      label: "Google Slides Insert Table",
      description: "Insert a table on a slide. Optionally populate cells with data.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The slide object ID to insert the table on" }),
        rows: Type.Number({ description: "Number of rows" }),
        cols: Type.Number({ description: "Number of columns" }),
        data: Type.Optional(Type.Array(Type.Array(Type.String()), { description: '2D array of cell values, e.g. [["Header1","Header2"],["A","B"]]' }))
      }),
      async execute(_toolCallId, params) {
        const result = await slidesInsertTable(params.presentationId, params.slideObjectId, params.rows, params.cols, params.data);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_insert_image",
      label: "Google Slides Insert Image",
      description: "Insert an image on a slide from a public URL.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The slide object ID to insert the image on" }),
        imageUrl: Type.String({ description: "Public URL of the image to insert" }),
        width: Type.Optional(Type.Number({ description: "Image width in EMU (default 3000000). 914400 EMU = 1 inch." })),
        height: Type.Optional(Type.Number({ description: "Image height in EMU (default 3000000)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await slidesInsertImage(params.presentationId, params.slideObjectId, params.imageUrl, params.width, params.height);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_insert_shape",
      label: "Google Slides Insert Shape",
      description: "Insert a shape (rectangle, ellipse, etc.) with optional text on a slide. Positions and sizes are in EMU (914400 EMU = 1 inch).",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The slide object ID" }),
        shapeType: Type.String({ description: "Shape type: TEXT_BOX, RECTANGLE, ROUND_RECTANGLE, ELLIPSE, TRIANGLE, ARROW_NORTH, ARROW_EAST, STAR_5, etc." }),
        text: Type.Optional(Type.String({ description: "Text to insert inside the shape" })),
        left: Type.Number({ description: "Left position in EMU" }),
        top: Type.Number({ description: "Top position in EMU" }),
        width: Type.Number({ description: "Shape width in EMU" }),
        height: Type.Number({ description: "Shape height in EMU" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesInsertShape(params.presentationId, params.slideObjectId, params.shapeType, params.text, params.left, params.top, params.width, params.height);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_format_text",
      label: "Google Slides Format Text",
      description: "Format text within a shape or text box on a slide. Specify character range and styling options.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        objectId: Type.String({ description: "The shape/text box object ID containing the text" }),
        startIndex: Type.Number({ description: "Start character index (0-based)" }),
        endIndex: Type.Number({ description: "End character index (exclusive)" }),
        bold: Type.Optional(Type.Boolean({ description: "Set bold" })),
        italic: Type.Optional(Type.Boolean({ description: "Set italic" })),
        fontSize: Type.Optional(Type.Number({ description: "Font size in points" })),
        color: Type.Optional(Type.String({ description: "Text color as hex string, e.g. '#FF0000'" }))
      }),
      async execute(_toolCallId, params) {
        const result = await slidesFormatText(params.presentationId, params.objectId, params.startIndex, params.endIndex, params.bold, params.italic, params.fontSize, params.color);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_delete_slide",
      label: "Google Slides Delete Slide",
      description: "Delete a slide from a presentation by its slide object ID.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The object ID of the slide to delete" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesDeleteSlide(params.presentationId, params.slideObjectId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_duplicate_slide",
      label: "Google Slides Duplicate Slide",
      description: "Duplicate an existing slide in a presentation. Returns the new slide's object ID.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The object ID of the slide to duplicate" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesDuplicateSlide(params.presentationId, params.slideObjectId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_replace_text",
      label: "Google Slides Replace Text",
      description: "Find and replace text across all slides in a presentation.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        findText: Type.String({ description: "Text to find" }),
        replaceText: Type.String({ description: "Replacement text" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesReplaceText(params.presentationId, params.findText, params.replaceText);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_batch_update",
      label: "Google Slides Batch Update",
      description: "Execute raw batch update requests against the Google Slides API. For complex multi-step operations not covered by other slides tools. See Google Slides API batchUpdate documentation for request format.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        requests: Type.Array(Type.Any(), { description: "Array of Slides API request objects" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesBatchUpdate(params.presentationId, params.requests);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildYouTubeTools() {
  return [
    {
      name: "youtube_search",
      label: "YouTube Search",
      description: "Search for YouTube videos by keyword. Returns video titles, channels, publish dates, and URLs.",
      parameters: Type.Object({
        query: Type.String({ description: "Search keywords (e.g. 'TypeScript tutorial', 'SpaceX launch')" }),
        maxResults: Type.Optional(Type.Number({ description: "Max videos to return (default 10, max 25)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await youtubeSearch(params.query, params.maxResults || 10);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "youtube_video",
      label: "YouTube Video Details",
      description: "Get detailed information about a YouTube video \u2014 title, channel, views, likes, comments, duration, and description. Requires the video ID (the part after v= in the URL).",
      parameters: Type.Object({
        videoId: Type.String({ description: "YouTube video ID (e.g. 'dQw4w9WgXcQ' from youtube.com/watch?v=dQw4w9WgXcQ)" })
      }),
      async execute(_toolCallId, params) {
        const result = await youtubeVideoDetails(params.videoId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "youtube_channel",
      label: "YouTube Channel Info",
      description: "Get information about a YouTube channel \u2014 name, subscriber count, video count, total views, and description. Accepts a channel ID (starts with UC) or channel name to search for.",
      parameters: Type.Object({
        channel: Type.String({ description: "Channel ID (e.g. 'UCBcRF18a7Qf58cCRy5xuWwQ') or channel name to search for (e.g. 'MKBHD')" })
      }),
      async execute(_toolCallId, params) {
        const result = await youtubeChannelInfo(params.channel);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "youtube_trending",
      label: "YouTube Trending",
      description: "Get currently trending/popular videos on YouTube. Optionally specify a country code.",
      parameters: Type.Object({
        regionCode: Type.Optional(Type.String({ description: "ISO 3166-1 alpha-2 country code (default 'US', e.g. 'GB', 'IN', 'JP')" })),
        maxResults: Type.Optional(Type.Number({ description: "Max videos to return (default 10, max 25)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await youtubeTrending(params.regionCode || "US", params.maxResults || 10);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildConversationTools() {
  return [
    {
      name: "conversation_search",
      label: "Conversation Search",
      description: "Search past conversations with the user by keyword. Use this when the user asks about previous discussions, e.g. 'what did we talk about last Tuesday?' or 'find our conversation about the trip'. Returns matching conversations with context snippets.",
      parameters: Type.Object({
        query: Type.String({ description: "Search keywords to find in past conversations" }),
        days_ago: Type.Optional(Type.Number({ description: "Only search conversations from the last N days. E.g. 7 for last week." }))
      }),
      async execute(_toolCallId, params) {
        const after = params.days_ago ? Date.now() - params.days_ago * 24 * 60 * 60 * 1e3 : void 0;
        const results = await search(params.query, { after, limit: 8 });
        if (results.length === 0) {
          return { content: [{ type: "text", text: `No past conversations found matching "${params.query}".` }], details: {} };
        }
        const formatted = results.map((r) => {
          const date = new Date(r.createdAt).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
          const snippetText = r.snippets.map((s) => `  ${s}`).join("\n");
          return `**"${r.title}"** (${date}, ${r.messageCount} msgs)
${snippetText}`;
        }).join("\n\n---\n\n");
        return { content: [{ type: "text", text: formatted }], details: {} };
      }
    }
  ];
}
function buildMemoryTools() {
  return [
    {
      name: "memory_recall",
      label: "Memory Recall",
      description: "Search Rickin's long-term semantic memory for relevant context. Use this when you need to remember past conversations, decisions, preferences, or facts about Rickin that might not be in the current session. Returns ranked memory fragments with timestamps. Example queries: 'What does Rickin think about X?', 'What projects is Rickin working on?', 'What decisions were made about Y?'",
      parameters: Type.Object({
        query: Type.String({ description: "Natural language query to search memories. Be specific for better results." }),
        top_k: Type.Optional(Type.Number({ description: "Number of memories to return (default 10, max 25)" }))
      }),
      async execute(_toolCallId, params) {
        if (!isConfigured8()) {
          return { content: [{ type: "text", text: "Memory recall is not configured. Set VECTORIZE_API_KEY, VECTORIZE_ORG_ID, and VECTORIZE_KB_ID to enable." }], details: {} };
        }
        const topK = Math.min(params.top_k || 10, 25);
        const result = await recall({ query: params.query, topK });
        if (result.memories.length === 0) {
          return { content: [{ type: "text", text: `No memories found matching "${params.query}".` }], details: {} };
        }
        const formatted = result.memories.map((m, i) => {
          const score = (m.score * 100).toFixed(0);
          const date = m.createdAt ? new Date(m.createdAt).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : "unknown";
          const meta = m.metadata?.type ? ` [${m.metadata.type}]` : "";
          return `${i + 1}. (${score}% match, ${date}${meta}) ${m.text}`;
        }).join("\n");
        return { content: [{ type: "text", text: `Found ${result.memories.length} relevant memories:

${formatted}` }], details: {} };
      }
    },
    {
      name: "memory_reflect",
      label: "Memory Reflect",
      description: "Consolidate and reflect on accumulated memories. Calls the Hindsight knowledge graph reflect operation to surface patterns, recurring themes, and insights across all stored memories. Use this for weekly memory digests or when asked 'what patterns do you see in my activity?'",
      parameters: Type.Object({}),
      async execute() {
        if (!isConfigured8()) {
          return { content: [{ type: "text", text: "Memory reflect is not configured. Set VECTORIZE_API_KEY, VECTORIZE_ORG_ID, and VECTORIZE_KB_ID to enable." }], details: {} };
        }
        const result = await reflect();
        const lines = [`**Memory Reflection**
`, result.summary, ""];
        if (result.patterns.length > 0) {
          lines.push("**Recurring Patterns:**");
          result.patterns.forEach((p) => lines.push(`- ${p}`));
          lines.push("");
        }
        if (result.insights.length > 0) {
          lines.push("**Insights:**");
          result.insights.forEach((i) => lines.push(`- ${i}`));
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
      }
    }
  ];
}
function buildWebPublishTools() {
  const PUBLISH_SCRIPT = path7.join(PROJECT_ROOT, "scripts", "herenow-publish.sh");
  return [
    {
      name: "web_publish",
      label: "Publish Temp Page",
      description: "Publish a file or folder as a temporary, public shareable link via here.now. Use when the user says: 'temp page', 'temporary', 'quick share', 'send a link', 'share this with someone', 'public link', or needs a URL to send to others. NOT for personal/private pages \u2014 use web_save for those. Sites expire in 24h without an API key. Supports HTML, images, PDFs, any file. Paths resolve from project root first, then vault.",
      parameters: Type.Object({
        path: Type.String({
          description: "Path to the file or directory to publish. Can be a project-relative path or a vault-relative path (e.g. 'bahamas-trip' resolves to data/vault/bahamas-trip). For HTML sites, the directory should contain index.html at its root."
        }),
        slug: Type.Optional(
          Type.String({
            description: "Slug of an existing site to update (e.g. 'bright-canvas-a7k2'). Omit to create a new site."
          })
        )
      }),
      async execute(_toolCallId, params) {
        try {
          let targetPath = path7.resolve(params.path);
          if (!fs6.existsSync(targetPath)) {
            const vaultPath2 = path7.join(VAULT_DIR, params.path);
            if (fs6.existsSync(vaultPath2)) {
              targetPath = vaultPath2;
            } else {
              return {
                content: [{ type: "text", text: `Error: Path "${params.path}" does not exist (checked project root and vault).` }],
                details: {}
              };
            }
          }
          const realTarget = fs6.realpathSync(targetPath);
          const projectReal = fs6.realpathSync(PROJECT_ROOT);
          if (!realTarget.startsWith(projectReal + "/") && realTarget !== projectReal) {
            return {
              content: [{ type: "text", text: `Error: Can only publish files within the project directory.` }],
              details: {}
            };
          }
          const blocked = [".env", "auth.json", "credentials", ".herenow"];
          const relPath = path7.relative(projectReal, realTarget);
          if (blocked.some((b) => relPath.split("/").includes(b) || relPath === b)) {
            return {
              content: [{ type: "text", text: `Error: Cannot publish sensitive files.` }],
              details: {}
            };
          }
          if (params.slug && !/^[a-z0-9][a-z0-9-]*$/.test(params.slug)) {
            return {
              content: [{ type: "text", text: `Error: Invalid slug format. Use only lowercase letters, numbers, and hyphens.` }],
              details: {}
            };
          }
          const args = [PUBLISH_SCRIPT, realTarget];
          if (params.slug) {
            args.push("--slug", params.slug);
          }
          args.push("--client", "darknode");
          const { execFileSync } = await import("child_process");
          const result = execFileSync("bash", args, {
            encoding: "utf-8",
            timeout: 6e4,
            cwd: PROJECT_ROOT
          });
          const urlMatch = result.match(/https:\/\/[^\s]+\.here\.now\/?/);
          const siteUrl = urlMatch ? urlMatch[0] : null;
          let response = result.trim();
          if (siteUrl) {
            response = `Published successfully!

Live URL: ${siteUrl}

${response}`;
          }
          return {
            content: [{ type: "text", text: response }],
            details: { siteUrl }
          };
        } catch (err) {
          const stderr = err.stderr ? err.stderr.toString() : "";
          const stdout = err.stdout ? err.stdout.toString() : "";
          return {
            content: [
              {
                type: "text",
                text: `Publish failed:
${stderr || stdout || err.message}`
              }
            ],
            details: { error: true }
          };
        }
      }
    },
    {
      name: "web_save",
      label: "Save Personal Page",
      description: "Save HTML as a permanent, password-protected personal page on rickin.live/pages/<slug>. Use when the user says: 'personal page', 'my page', 'page on my site', 'private page', 'create a page', 'put on rickin.live', 'dashboard page', 'report page', 'web page', or wants a rendered HTML page (not a note). This is for HTML pages \u2014 NOT for saving text/notes to the knowledge base (use notes_create for that). Default when page-related request has no 'temp'/'share'/'public' keywords. NOT for sharing with others \u2014 use web_publish for temporary public links.",
      parameters: Type.Object({
        slug: Type.String({
          description: "URL-friendly name for the page (lowercase, hyphens, no spaces). E.g. 'moody-report' becomes rickin.live/pages/moody-report"
        }),
        html: Type.String({
          description: "The full HTML content to save. Should be a complete HTML document with <!DOCTYPE html>, <head>, and <body>."
        })
      }),
      async execute(_toolCallId, params) {
        try {
          const slug = params.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/--+/g, "-").replace(/^-|-$/g, "");
          if (!slug) {
            return { content: [{ type: "text", text: "Error: Invalid slug \u2014 must contain at least one alphanumeric character." }], details: {} };
          }
          const pagesDir = path7.join(PROJECT_ROOT, "data", "pages");
          if (!fs6.existsSync(pagesDir)) fs6.mkdirSync(pagesDir, { recursive: true });
          const filePath = path7.join(pagesDir, `${slug}.html`);
          const existed = fs6.existsSync(filePath);
          fs6.writeFileSync(filePath, params.html, "utf-8");
          const domain = "rickin.live";
          const pageUrl = `https://${domain}/pages/${slug}`;
          return {
            content: [{
              type: "text",
              text: `\u2705 Page ${existed ? "updated" : "saved"}!

URL: ${pageUrl}

This page is password-protected behind your login. Visit rickin.live/pages to see all saved pages.`
            }],
            details: { pageUrl, slug }
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Failed to save page: ${err.message}` }],
            details: { error: true }
          };
        }
      }
    },
    {
      name: "web_list_pages",
      label: "List Saved Pages",
      description: "List all saved pages on rickin.live/pages. Returns slugs, file sizes, and last modified dates.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const pagesDir = path7.join(PROJECT_ROOT, "data", "pages");
          if (!fs6.existsSync(pagesDir)) {
            return { content: [{ type: "text", text: "No pages saved yet." }], details: {} };
          }
          const files = fs6.readdirSync(pagesDir).filter((f) => f.endsWith(".html")).sort();
          if (files.length === 0) {
            return { content: [{ type: "text", text: "No pages saved yet." }], details: {} };
          }
          const domain = "rickin.live";
          const list2 = files.map((f) => {
            const slug = f.replace(/\.html$/, "");
            const stat = fs6.statSync(path7.join(pagesDir, f));
            const sizeKB = Math.round(stat.size / 1024);
            const date = stat.mtime.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
            return `- ${slug} (${sizeKB}KB, ${date}) \u2014 https://${domain}/pages/${slug}`;
          }).join("\n");
          return {
            content: [{ type: "text", text: `${files.length} saved page(s):

${list2}

All pages: https://${domain}/pages` }],
            details: {}
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Error listing pages: ${err.message}` }], details: {} };
        }
      }
    },
    {
      name: "web_delete_page",
      label: "Delete Saved Page",
      description: "Delete a previously saved page from rickin.live/pages.",
      parameters: Type.Object({
        slug: Type.String({ description: "The slug of the page to delete." })
      }),
      async execute(_toolCallId, params) {
        try {
          const slug = params.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/--+/g, "-").replace(/^-|-$/g, "");
          if (!slug) {
            return { content: [{ type: "text", text: "Error: Invalid slug." }], details: {} };
          }
          const filePath = path7.join(PROJECT_ROOT, "data", "pages", `${slug}.html`);
          if (!fs6.existsSync(filePath)) {
            return { content: [{ type: "text", text: `Page "${slug}" not found.` }], details: {} };
          }
          fs6.unlinkSync(filePath);
          return { content: [{ type: "text", text: `\u2705 Page "${slug}" deleted.` }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Failed to delete page: ${err.message}` }], details: {} };
        }
      }
    }
  ];
}
function buildAgentTools(allToolsFn, sessionId) {
  return [
    {
      name: "delegate",
      label: "Delegate to Agent",
      description: "Delegate a complex task to a specialist agent. The agent will work independently using its own tools and return a comprehensive result. Use this for multi-step research, project planning, deep analysis, email drafting, or vault organization.",
      parameters: Type.Object({
        agent: Type.String({ description: "The specialist agent ID. Available agents: 'deep-researcher' (web research), 'project-planner' (project plans), 'email-drafter' (compose emails), 'analyst' (markets/stocks), 'moodys' (Moody's/ValidMind/work projects \u2014 use for ANY work-related task), 'real-estate' (property search), 'nutritionist' (meal planning), 'family-planner' (financial/legal planning), 'knowledge-organizer' (vault management), 'mindmap-generator' (create mind maps from vault topics \u2014 use when user says 'map out', 'visualize', 'mind map', or 'mindmap')" }),
        task: Type.String({ description: "Clear description of what the agent should do" }),
        context: Type.Optional(Type.String({ description: "Additional context the agent needs (e.g. previous conversation details, specific requirements)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const sessionEntry = sessions.get(sessionId);
          const modelOverride = sessionEntry?.modelMode === "max" ? MAX_MODEL_ID : void 0;
          const result = await runSubAgent({
            agentId: params.agent,
            task: params.task,
            context: params.context,
            allTools: allToolsFn(),
            apiKey: ANTHROPIC_KEY,
            model: modelOverride
          });
          let savedTo;
          if (result.response && result.response.length > 200) {
            try {
              const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
              savedTo = `Scheduled Reports/Agent Results/${params.agent}-${ts}.md`;
              await kbCreate(savedTo, `# ${params.agent} result
*Task: ${params.task.slice(0, 200)}*
*Duration: ${((result.durationMs || 0) / 1e3).toFixed(0)}s*

${result.response}`);
            } catch {
              savedTo = void 0;
            }
          }
          const sessionEntry2 = sessions.get(sessionId);
          try {
            const pool2 = getPool();
            await pool2.query(
              `INSERT INTO agent_activity (agent, task, conversation_id, conversation_title, duration_ms, saved_to, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [params.agent, params.task.slice(0, 200), sessionEntry2?.conversation?.id || null, sessionEntry2?.conversation?.title || null, result.durationMs || null, savedTo || null, Date.now()]
            );
            await pool2.query(`DELETE FROM agent_activity WHERE id NOT IN (SELECT id FROM agent_activity ORDER BY created_at DESC LIMIT 50)`);
          } catch (e) {
            console.warn("[agent_activity] DB insert failed:", e.message);
          }
          const details = { agent: result.agentId, toolsUsed: result.toolsUsed, durationMs: result.durationMs };
          if (result.error) details.error = result.error;
          if (result.timedOut) details.timedOut = true;
          return {
            content: [{ type: "text", text: result.response }],
            details
          };
        } catch (err) {
          console.error(`[delegate] Unhandled error delegating to agent: ${err.message}`);
          return {
            content: [{ type: "text", text: `Agent delegation failed: ${err.message}. Try running the tools directly instead of delegating.` }],
            details: { error: err.message, unhandled: true }
          };
        }
      }
    },
    {
      name: "list_agents",
      label: "List Agents",
      description: "List all available specialist agents with their names and descriptions. Use when the user asks what agents are available or what your team can do.",
      parameters: Type.Object({}),
      async execute() {
        const agents2 = getEnabledAgents();
        if (agents2.length === 0) {
          return { content: [{ type: "text", text: "No specialist agents are currently configured." }], details: {} };
        }
        const list2 = agents2.map((a) => `- **${a.name}** (${a.id}): ${a.description}`).join("\n");
        return {
          content: [{ type: "text", text: `Available specialist agents:

${list2}` }],
          details: { count: agents2.length }
        };
      }
    }
  ];
}
var sessions = /* @__PURE__ */ new Map();
var FAST_MODEL_ID = "claude-haiku-4-5-20251001";
var FULL_MODEL_ID = "claude-sonnet-4-6";
var MAX_MODEL_ID = "claude-opus-4-6";
var FAST_PATTERNS = [
  /^(hi|hello|hey|yo|sup|good\s*(morning|afternoon|evening)|thanks|thank you|ok|okay|got it|cool|nice|great)\b/i,
  /^what('s| is) (the )?(time|date|day)\b/i,
  /^(show|check|get|list|read)\s+(my\s+)?(tasks?|todos?|email|calendar|events?|weather|stock|price|portfolio|watchlist|notes?)\b/i,
  /^(add|create|complete|delete|remove)\s+(a\s+)?(task|todo|note)\b/i,
  /^(how'?s|what'?s)\s+(the\s+)?(weather|market|stock)\b/i,
  /^(remind|timer|alarm|set)\b/i
];
var MAX_PATTERNS = [
  /\b(project|strategy|architecture|roadmap|proposal|initiative)\b/i,
  /\b(sprint|milestone|deliverable|stakeholder|requirements?)\b/i,
  /\b(analysis|analyze|evaluate|assess|audit|review|compare)\b/i,
  /\b(forecast|budget|revenue|investment|valuation|financial)\b/i,
  /\b(presentation|deck|report|memo|brief|whitepaper)\b/i,
  /\b(moody'?s|validmind|data\s*moat|competitive|acquisition)\b/i,
  /\b(design|implement|build|develop|engineer|refactor)\b/i,
  /\b(plan\s+(out|for|the)|create\s+a\s+plan|help\s+me\s+(plan|think|figure))\b/i,
  /\b(research|deep\s*dive|investigate|explore\s+(the|how|why))\b/i,
  /\b(retirement|estate|wealth|portfolio\s+(review|strategy|allocation))\b/i
];
function classifyIntent(message) {
  const trimmed = message.trim();
  if (trimmed.length < 80) {
    for (const pattern of FAST_PATTERNS) {
      if (pattern.test(trimmed)) return "fast";
    }
  }
  if (trimmed.length < 20 && !trimmed.includes("?")) return "fast";
  for (const pattern of MAX_PATTERNS) {
    if (pattern.test(trimmed)) return "max";
  }
  return "full";
}
var syncedConversations = /* @__PURE__ */ new Set();
async function saveAndCleanSession(id) {
  const entry = sessions.get(id);
  if (!entry) return;
  if (entry.currentAgentText) {
    addMessage(entry.conversation, "agent", entry.currentAgentText);
    entry.currentAgentText = "";
  }
  if (entry.conversation.messages.length > 0) {
    await save(entry.conversation);
    syncConversationToVault(entry.conversation);
  }
  for (const sub of entry.subscribers) {
    try {
      sub.end();
    } catch {
    }
  }
  entry.subscribers.clear();
  sessions.delete(id);
}
async function syncConversationToVault(conv) {
  if (syncedConversations.has(conv.id)) return;
  if (!shouldSync(conv)) return;
  if (!useLocalVault && !isConfigured()) return;
  const existing = await load(conv.id);
  if (existing && existing.syncedAt) {
    syncedConversations.add(conv.id);
    return;
  }
  const userMsgCount = conv.messages.filter((m) => m.role === "user").length;
  const useAI = userMsgCount >= 3;
  try {
    const summary = useAI ? await generateAISummary(conv) : generateSnippetSummary(conv);
    const dateStr = new Date(conv.createdAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    let safeTitle = conv.title.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 50).trim();
    if (!safeTitle) safeTitle = conv.id;
    const notePath = `Conversations/${dateStr} - ${safeTitle}.md`;
    await kbCreate(notePath, summary);
    syncedConversations.add(conv.id);
    conv.syncedAt = Date.now();
    await save(conv);
    console.log(`[sync] Conversation synced to vault: ${notePath} (${useAI ? "AI" : "snippet"} summary)`);
    if (useAI) {
      runInsightExtraction(conv).catch(
        (err) => console.error(`[sync] Insight extraction failed for ${conv.id}:`, err)
      );
    }
  } catch (err) {
    console.error(`[sync] Failed to sync conversation ${conv.id}:`, err);
  }
}
async function runInsightExtraction(conv) {
  try {
    let currentProfile = "";
    try {
      currentProfile = await kbRead("About Me/My Profile.md");
    } catch {
    }
    const result = await extractAndFileInsights(conv.messages, currentProfile);
    if (result.skipReason) {
      console.log(`[memory] Skipped extraction for ${conv.id}: ${result.skipReason}`);
      return;
    }
    if (result.profileUpdates.length > 0) {
      const newEntries = result.profileUpdates.map((u) => `- ${u}`).join("\n");
      const appendText = `

### Learned (${(/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: "America/New_York" })})
${newEntries}`;
      try {
        await kbAppend("About Me/My Profile.md", appendText);
        console.log(`[memory] Appended ${result.profileUpdates.length} profile updates`);
      } catch {
        await kbCreate("About Me/My Profile.md", currentProfile + appendText);
        console.log(`[memory] Created/overwrote profile with ${result.profileUpdates.length} updates`);
      }
    }
    if (result.actionItems.length > 0) {
      const dateStr = (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const items = result.actionItems.map((a) => `- [ ] ${a}`).join("\n");
      const appendText = `

### From conversation (${dateStr}): ${conv.title}
${items}`;
      try {
        await kbAppend("Tasks & TODOs/Extracted Tasks.md", appendText);
      } catch {
        await kbCreate("Tasks & TODOs/Extracted Tasks.md", `# Extracted Tasks
${appendText}`);
      }
      console.log(`[memory] Filed ${result.actionItems.length} action items`);
    }
  } catch (err) {
    console.error(`[memory] Insight extraction error:`, err);
  }
}
var processingQueue = /* @__PURE__ */ new Set();
async function processNextPendingMessage(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry || entry.pendingMessages.length === 0) return;
  if (processingQueue.has(sessionId) || entry.isAgentRunning) return;
  processingQueue.add(sessionId);
  const pending = entry.pendingMessages.shift();
  entry.isAgentRunning = true;
  entry.currentAgentText = "";
  const startEvent = JSON.stringify({ type: "agent_start" });
  for (const sub of entry.subscribers) {
    try {
      sub.write(`data: ${startEvent}

`);
    } catch {
    }
  }
  const queuedPromptStart = Date.now();
  const etNow = (/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
  const queueContext = "[Note: This message was sent while the previous task was still running. The previous task has now completed.]\n\n";
  let augmentedText = `[Current date/time in Rickin's timezone (Eastern): ${etNow}]

${queueContext}`;
  if (entry.planningMode) {
    augmentedText += `[PLANNING MODE] Before taking any action or calling any tools, you must first present a clear, numbered plan of what you intend to do. Explain each step briefly. Then ask for my approval before proceeding. Do NOT execute any tools or actions until I explicitly confirm the plan (e.g. "go ahead", "yes", "approved", "do it"). If I ask you to modify the plan, revise it and ask for approval again.

`;
  }
  augmentedText += pending.text;
  const promptImages = pending.images?.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
  const PROMPT_TIMEOUT = 9e5;
  const actualPromise = entry.session.prompt(augmentedText, promptImages ? { images: promptImages } : void 0);
  const timeoutPromise = new Promise(
    (_, reject) => setTimeout(() => reject(new Error("Response timed out after 15 minutes")), PROMPT_TIMEOUT)
  );
  try {
    await Promise.race([actualPromise, timeoutPromise]);
    console.log(`[prompt] queued prompt completed in ${((Date.now() - queuedPromptStart) / 1e3).toFixed(1)}s`);
  } catch (err) {
    const elapsed = ((Date.now() - queuedPromptStart) / 1e3).toFixed(1);
    const isTimeout = String(err).includes("timed out");
    console.error(`[prompt] queued ${isTimeout ? "timeout" : "error"} after ${elapsed}s:`, err);
    const errEvent = JSON.stringify({ type: isTimeout ? "timeout" : "error", error: String(err) });
    for (const sub of entry.subscribers) {
      try {
        sub.write(`data: ${errEvent}

`);
      } catch {
      }
    }
    if (isTimeout) {
      console.log(`[prompt] queued agent still running in background \u2014 new messages will be queued`);
      actualPromise.then(() => {
        console.log(`[prompt] queued background prompt completed after ${((Date.now() - queuedPromptStart) / 1e3).toFixed(1)}s total`);
        entry.isAgentRunning = false;
        entry.currentToolName = null;
        processingQueue.delete(sessionId);
        processNextPendingMessage(sessionId);
      }).catch(() => {
        console.log(`[prompt] queued background prompt failed after ${((Date.now() - queuedPromptStart) / 1e3).toFixed(1)}s total`);
        entry.isAgentRunning = false;
        entry.currentToolName = null;
        processingQueue.delete(sessionId);
        processNextPendingMessage(sessionId);
      });
      return;
    }
    entry.isAgentRunning = false;
    entry.currentToolName = null;
    processingQueue.delete(sessionId);
    processNextPendingMessage(sessionId);
    return;
  }
  processingQueue.delete(sessionId);
}
setInterval(async () => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1e3;
  for (const [id, entry] of sessions.entries()) {
    if (entry.createdAt < cutoff) {
      await saveAndCleanSession(id);
    }
  }
}, 10 * 60 * 1e3);
setInterval(async () => {
  for (const entry of sessions.values()) {
    if (entry.currentAgentText) {
      addMessage(entry.conversation, "agent", entry.currentAgentText);
      entry.currentAgentText = "";
    }
    if (entry.conversation.messages.length > 0) {
      await save(entry.conversation);
    }
  }
}, 5 * 60 * 1e3);
var TUNNEL_URL_FILE = path7.join(PROJECT_ROOT, "data", "tunnel-url.txt");
function loadPersistedTunnelUrl() {
  try {
    return fs6.readFileSync(TUNNEL_URL_FILE, "utf-8").trim() || null;
  } catch {
    return null;
  }
}
function persistTunnelUrl(url) {
  try {
    fs6.writeFileSync(TUNNEL_URL_FILE, url, "utf-8");
  } catch {
  }
}
(function initTunnelUrl() {
  const envUrl = process.env.OBSIDIAN_API_URL || "";
  if (envUrl) {
    setApiUrl(envUrl);
    if (!useLocalVault) console.log(`[boot] Using tunnel URL from env: ${envUrl}`);
  } else {
    const savedUrl = loadPersistedTunnelUrl();
    if (savedUrl) {
      setApiUrl(savedUrl);
      if (!useLocalVault) console.log(`[boot] Loaded persisted tunnel URL: ${savedUrl}`);
    }
  }
})();
var lastTunnelStatus = useLocalVault;
if (!useLocalVault && isConfigured()) {
  setInterval(async () => {
    if (useLocalVault) return;
    const alive = await ping();
    if (alive && !lastTunnelStatus) {
      console.log("[health] Knowledge base connection recovered");
    } else if (!alive && lastTunnelStatus) {
      console.warn("[health] Knowledge base connection DOWN \u2014 check that Obsidian is running and tunnel service is active");
    }
    lastTunnelStatus = alive;
  }, 30 * 1e3);
  ping().then((ok) => {
    console.log(`[health] Knowledge base: ${ok ? "connected" : "offline"}`);
    lastTunnelStatus = ok;
  });
}
var app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(cookieParser(SESSION_SECRET));
var AUTH_PUBLIC_PATHS = /* @__PURE__ */ new Set(["/login.html", "/login.css", "/api/login", "/health", "/manifest.json", "/baby-manifest.json", "/icons/icon-180.png", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/baby/icon-180.png", "/icons/baby/icon-192.png", "/icons/baby/icon-512.png", "/api/healthcheck"]);
async function authMiddleware(req, res, next) {
  if (!APP_PASSWORD) {
    next();
    return;
  }
  if (AUTH_PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }
  if (req.path === "/api/config/tunnel-url") {
    next();
    return;
  }
  if (req.path === "/api/gmail/callback") {
    next();
    return;
  }
  if (req.path === "/api/gmail/auth") {
    next();
    return;
  }
  if (req.path === "/api/telegram/webhook") {
    next();
    return;
  }
  if (req.path === "/pages/wealth-engines" || req.path === "/api/wealth-engines/data") {
    try {
      const dbMod = await Promise.resolve().then(() => (init_db(), db_exports));
      const pool2 = dbMod.getPool();
      const pubRes = await pool2.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_public'`);
      if (pubRes.rows.length > 0 && (pubRes.rows[0].value === true || pubRes.rows[0].value === "true")) {
        next();
        return;
      }
    } catch {
    }
  }
  const token = req.signedCookies?.auth;
  if (token && USERS[token]) {
    req.user = token;
    next();
    return;
  }
  if (token === "authenticated") {
    req.user = "rickin";
    next();
    return;
  }
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7);
    for (const [uname, u] of Object.entries(USERS)) {
      if (u.password && bearerToken === u.password) {
        req.user = uname;
        next();
        return;
      }
    }
  }
  const queryUser = req.query.user;
  const queryToken = req.query.token;
  if (queryUser && queryToken && USERS[queryUser.toLowerCase()]?.password === queryToken) {
    req.user = queryUser.toLowerCase();
    next();
    return;
  }
  const devToken = process.env.DEV_TOKEN;
  if (devToken && req.query.dev_token === devToken) {
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.cookie("auth", "authenticated", { signed: true, httpOnly: true, secure: isSecure, maxAge: 7 * 24 * 60 * 60 * 1e3 });
    next();
    return;
  }
  if (req.path === "/" && !req.headers.accept?.includes("text/html")) {
    res.status(200).send("ok");
  } else if (req.headers.accept?.includes("text/html") || req.path === "/") {
    res.redirect("/login.html");
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
}
app.use(authMiddleware);
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  let matchedUser = null;
  if (username && USERS[username.toLowerCase()]) {
    const u = USERS[username.toLowerCase()];
    if (password && u.password && password === u.password) matchedUser = username.toLowerCase();
  } else if (!username && password && password === APP_PASSWORD) {
    matchedUser = "rickin";
  }
  if (!matchedUser) {
    res.status(401).json({ error: "ACCESS DENIED" });
    return;
  }
  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie("auth", matchedUser, {
    signed: true,
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1e3
  });
  const user = USERS[matchedUser];
  const redirect = matchedUser === "pooja" ? "/pages/baby-dashboard" : "/";
  res.json({ ok: true, displayName: user.displayName, redirect });
});
app.get("/api/me", (req, res) => {
  const token = req.signedCookies?.auth;
  if (token && USERS[token]) {
    res.json({ username: token, displayName: USERS[token].displayName });
  } else if (token === "authenticated") {
    res.json({ username: "rickin", displayName: "Rickin" });
  } else {
    res.status(401).json({ error: "Not logged in" });
  }
});
app.get("/api/logout", (_req, res) => {
  res.clearCookie("auth");
  res.redirect("/login.html");
});
app.use(express.static(PUBLIC_DIR));
var PAGES_DIR = path7.join(PROJECT_ROOT, "data", "pages");
if (!fs6.existsSync(PAGES_DIR)) fs6.mkdirSync(PAGES_DIR, { recursive: true });
app.get("/pages", (_req, res) => {
  try {
    const files = fs6.readdirSync(PAGES_DIR).filter((f) => f.endsWith(".html")).sort();
    if (files.length === 0) {
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages \u2014 RICKIN</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;padding:2rem;max-width:600px;margin:0 auto}h1{font-size:1.4rem;color:#fff}p{color:#888}</style></head><body><h1>Pages</h1><p>No pages published yet.</p></body></html>`);
      return;
    }
    const items = files.map((f) => {
      const slug = f.replace(/\.html$/, "");
      const stat = fs6.statSync(path7.join(PAGES_DIR, f));
      const date = stat.mtime.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      return `<a href="/pages/${slug}">${slug}</a><span class="date">${date}</span>`;
    }).join("");
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages \u2014 RICKIN</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;padding:2rem;max-width:600px;margin:0 auto}h1{font-size:1.4rem;color:#fff;margin-bottom:1.5rem}a{display:block;color:#7cacf8;text-decoration:none;padding:.75rem 0;border-bottom:1px solid #222;font-size:1rem}a:hover{color:#aac8ff}.date{float:right;color:#666;font-size:.85rem}</style></head><body><h1>Pages</h1>${items}</body></html>`);
  } catch (err) {
    res.status(500).send("Error loading pages.");
  }
});
var dailyBriefCache = null;
var welcomeCache = null;
var WELCOME_CACHE_TTL = 30 * 60 * 1e3;
async function generateWelcomeMessage(context) {
  try {
    if (welcomeCache && Date.now() - welcomeCache.ts < WELCOME_CACHE_TTL) return welcomeCache.message;
    const { default: Anthropic5 } = await import("@anthropic-ai/sdk");
    const client = new Anthropic5({ apiKey: ANTHROPIC_KEY });
    const weatherPart = context.tempC !== null && context.condition ? `Current weather in NYC: ${context.tempC}\xB0C, ${context.condition}.` : "";
    const babyPart = context.babyWeeks !== null ? `His wife is ${context.babyWeeks} weeks pregnant with a baby boy.` : "";
    const prompt = `Generate a friendly morning briefing for Rickin who is checking his daily dashboard. Time: ${context.greeting.toLowerCase()} on ${context.dayOfWeek}. ${weatherPart} He has ${context.taskCount} tasks and ${context.eventCount} calendar events today. ${babyPart}

Format as a short greeting line followed by bullet points summarizing what's ahead. Use this exact format:
[greeting line]
\u2022 [weather note]
\u2022 [tasks/calendar summary]
\u2022 [baby milestone or encouragement]
\u2022 [motivational or day-specific note]

Keep each bullet concise (under 15 words). Don't use emojis. Don't say "I" or reference yourself. 4-5 bullets max.`;
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }]
    });
    const text = response.content[0].text?.trim() || "";
    if (text) {
      welcomeCache = { message: text, ts: Date.now() };
      return text;
    }
  } catch (err) {
    console.error("Welcome message generation failed:", err);
  }
  return `${context.greeting}, Rickin. Here's your brief for ${context.dayOfWeek}.`;
}
var DAILY_BRIEF_TTL = 18e5;
async function fetchQuoteStructured(symbol, type) {
  try {
    if (type === "crypto") {
      const CRYPTO_MAP = { BTCUSD: "bitcoin", ETHUSD: "ethereum" };
      const coinId = CRYPTO_MAP[symbol.toUpperCase()] || symbol.toLowerCase();
      const url = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;
      const res = await fetch(url, { headers: { "User-Agent": "pi-assistant/1.0" } });
      if (!res.ok) return null;
      const data = await res.json();
      const m = data.market_data;
      if (!m?.current_price?.usd) return null;
      return {
        symbol: data.symbol.toUpperCase(),
        name: data.name,
        price: m.current_price.usd,
        change24h: m.price_change_percentage_24h || 0,
        change7d: m.price_change_percentage_7d || 0,
        high24h: m.high_24h?.usd,
        low24h: m.low_24h?.usd,
        marketCap: m.market_cap?.usd
      };
    } else {
      const ticker = symbol.toUpperCase();
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d&includePrePost=false`;
      const res = await fetch(url, { headers: { "User-Agent": "pi-assistant/1.0" } });
      if (!res.ok) return null;
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) return null;
      const meta = result.meta;
      const price = meta.regularMarketPrice;
      if (price == null) return null;
      const prevClose = meta.chartPreviousClose || meta.previousClose;
      const change = prevClose ? price - prevClose : 0;
      const changePct = prevClose ? change / prevClose * 100 : 0;
      return {
        symbol: ticker,
        name: meta.shortName || meta.longName || ticker,
        price,
        change,
        changePct,
        prevClose,
        currency: meta.currency || "USD"
      };
    }
  } catch {
    return null;
  }
}
app.get("/api/vault/reya-school", async (_req, res) => {
  try {
    const tz = "America/New_York";
    const now = /* @__PURE__ */ new Date();
    const dayName = now.toLocaleString("en-US", { timeZone: tz, weekday: "long" });
    const isWeekend = ["Saturday", "Sunday"].includes(dayName);
    if (isWeekend) {
      res.json({ schoolInSession: false, lunch: null, pickupCountdown: null, alert: null });
      return;
    }
    const month = parseInt(now.toLocaleString("en-US", { timeZone: tz, month: "numeric" }));
    const day = parseInt(now.toLocaleString("en-US", { timeZone: tz, day: "numeric" }));
    let lunch = "Menu not available";
    try {
      const mealFile = await kbRead("Family/Reya's Education/Reya - School Meals.md");
      if (mealFile) {
        const datePattern = new RegExp(`\\|\\s*\\w+\\s+${month}/${day}\\s*\\|([^|]+)\\|([^|]+)\\|([^|]+)\\|`, "i");
        const match = mealFile.match(datePattern);
        if (match) {
          const mainDish = match[1].replace(/\*\*/g, "").trim();
          const vegStatus = match[2].trim();
          const sides = match[3].trim();
          const isVeg = vegStatus.includes("\u2705");
          lunch = isVeg ? `\u2705 ${mainDish}` : `\u274C ${mainDish} \u2014 Sides: ${sides}`;
        }
      }
    } catch {
    }
    const etNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const pickupTime = new Date(etNow);
    pickupTime.setHours(16, 30, 0, 0);
    let pickupCountdown = null;
    if (etNow < pickupTime) {
      const diffMs = pickupTime.getTime() - etNow.getTime();
      const h = Math.floor(diffMs / 36e5);
      const m = Math.floor(diffMs % 36e5 / 6e4);
      pickupCountdown = h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
    } else {
      pickupCountdown = "\u2705 Picked up";
    }
    let alert = null;
    try {
      if (isConnected()) {
        const alerts = await searchEmailsStructured("from:kristen OR from:cicio is:unread newer_than:2d", 1);
        if (alerts.length > 0) alert = alerts[0].subject;
      }
    } catch {
    }
    res.json({ schoolInSession: true, lunch, pickupCountdown, alert });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch Reya school data" });
  }
});
app.get("/api/vault/moodys-brief", async (_req, res) => {
  try {
    const tz = "America/New_York";
    const now = /* @__PURE__ */ new Date();
    const year = now.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
    const month = now.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
    const day = now.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
    const dateStr = `${year}-${month}-${day}`;
    const paths = [
      `Scheduled Reports/Moody's Intelligence/Daily/${dateStr}-Brief.md`
    ];
    const etHour = parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
    let briefContent = null;
    let briefDate = dateStr;
    if (etHour >= 6) {
      for (const p of paths) {
        try {
          const content = await kbRead(p);
          if (content && content.length > 100) {
            briefContent = content;
            break;
          }
        } catch {
        }
      }
    }
    if (!briefContent) {
      const yesterday = new Date(now.getTime() - 864e5);
      const yYear = yesterday.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
      const yMonth = yesterday.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
      const yDay = yesterday.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
      const yDateStr = `${yYear}-${yMonth}-${yDay}`;
      try {
        const content = await kbRead(`Scheduled Reports/Moody's Intelligence/Daily/${yDateStr}-Brief.md`);
        if (content && content.length > 100) {
          briefContent = content;
          briefDate = yDateStr;
        }
      } catch {
      }
    }
    if (!briefContent) {
      res.json({ available: false, reason: "missing", message: "Brief unavailable \u2014 check pipeline" });
      return;
    }
    const categories = { corporate: [], banking: [], competitors: [], aiTrends: [], analysts: [] };
    const MAX_PER_CAT = 5;
    const sectionMap = [
      { pattern: /^##\s+🏢\s+Moody/im, key: "corporate" },
      { pattern: /^##\s+🏦\s+Banking/im, key: "banking" },
      { pattern: /^##\s+🔍\s+Competitor/im, key: "competitors" },
      { pattern: /^##\s+🤖\s+Enterprise\s*AI/im, key: "aiTrends" },
      { pattern: /^##\s+📊\s+Industry\s*Analyst/im, key: "analysts" }
    ];
    const bLines = briefContent.split("\n");
    let curKey = null;
    for (const line of bLines) {
      for (const { pattern, key } of sectionMap) {
        if (pattern.test(line)) {
          curKey = key;
          break;
        }
      }
      if (/^##\s+⚡\s+Key\s+Takeaway/i.test(line) || /^##\s+🐦/i.test(line)) {
        curKey = null;
        continue;
      }
      if (curKey && /^-\s+.+/.test(line)) {
        if (categories[curKey].length < MAX_PER_CAT) {
          let text = line.replace(/^-\s+/, "").replace(/🔴|🟡|🟢/g, "").replace(/\*\*/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
          if (text.length > 160) text = text.slice(0, 157) + "...";
          if (text) categories[curKey].push(text);
        }
      }
    }
    let totalItems = Object.values(categories).reduce((s, a) => s + a.length, 0);
    if (totalItems === 0) {
      const catKeywords = [
        { pattern: /moody'?s\s*corporate/i, key: "corporate" },
        { pattern: /banking/i, key: "banking" },
        { pattern: /competitor/i, key: "competitors" },
        { pattern: /enterprise\s*ai/i, key: "aiTrends" },
        { pattern: /industry\s*analyst/i, key: "analysts" }
      ];
      const tableRows = briefContent.match(/^\|[^|]*\|[^|]*\|[^|]*\|/gm) || [];
      for (const row of tableRows) {
        const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
        if (cells.length < 3 || /^[#-]+$/.test(cells[0])) continue;
        const item = cells[1].replace(/\*\*/g, "").replace(/\(?\[.*?\]\(.*?\)\)?/g, "").trim();
        const catCell = cells[2];
        if (!item || !catCell || /^Category$/i.test(catCell) || /^-+$/.test(catCell)) continue;
        for (const { pattern, key } of catKeywords) {
          if (pattern.test(catCell)) {
            if (categories[key].length < MAX_PER_CAT) {
              const clean = item.length > 160 ? item.slice(0, 157) + "..." : item;
              categories[key].push(clean);
            }
            break;
          }
        }
      }
      totalItems = Object.values(categories).reduce((s, a) => s + a.length, 0);
    }
    if (totalItems === 0) {
      const bullets = briefContent.match(/^- .+$/gm) || [];
      if (bullets.length === 0) {
        res.json({ available: false, reason: "unstructured", message: "Brief format not recognized" });
        return;
      }
      for (const b of bullets.slice(0, 5)) {
        let text = b.replace(/^- /, "").replace(/\*\*/g, "").trim();
        if (text.length > 160) text = text.slice(0, 157) + "...";
        categories.corporate.push(text);
      }
    }
    const tsMatch = briefContent.match(/Generated:\s*(.+)/);
    res.json({ available: true, date: briefDate, categories, timestamp: tsMatch ? tsMatch[1].trim() : null });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch Moody's brief" });
  }
});
app.get("/api/vault/real-estate-scan", async (_req, res) => {
  try {
    const tz = "America/New_York";
    const now = /* @__PURE__ */ new Date();
    const year = now.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
    const month = now.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
    const day = now.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
    const dateStr = `${year}-${month}-${day}`;
    let scanContent = null;
    let scanDate = dateStr;
    try {
      const content = await kbRead(`Scheduled Reports/Real Estate/${dateStr}-Property-Scan.md`);
      if (content) scanContent = content;
    } catch {
    }
    if (!scanContent) {
      const yesterday = new Date(now.getTime() - 864e5);
      const yDateStr = `${yesterday.toLocaleString("en-US", { timeZone: tz, year: "numeric" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, month: "2-digit" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, day: "2-digit" })}`;
      try {
        const content = await kbRead(`Scheduled Reports/Real Estate/${yDateStr}-Property-Scan.md`);
        if (content) {
          scanContent = content;
          scanDate = yDateStr;
        }
      } catch {
      }
    }
    if (!scanContent) {
      res.json({ available: false });
      return;
    }
    const scannedMatch = scanContent.match(/\*\*(\d+)\+?\s*listings?\s*scanned\*\*/i);
    const totalListings = scannedMatch ? parseInt(scannedMatch[1]) : 0;
    const newMatch = scanContent.match(/\*\*(\d+)\s*new\s*listings?\*\*/i);
    const newListings = newMatch ? parseInt(newMatch[1]) : 0;
    const tsMatch = scanContent.match(/Generated:\s*(.+)/);
    const scanTime = tsMatch ? tsMatch[1].trim() : null;
    res.json({ available: true, date: scanDate, totalListings, newListings, scanTime });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch real estate scan" });
  }
});
var xIntelCache = null;
var X_INTEL_TTL = 30 * 60 * 1e3;
var AI_FILTER_THRESHOLD = 7;
async function filterTweetsWithAI(sectionName, tweets) {
  if (!tweets || tweets.length === 0 || !ANTHROPIC_KEY) return tweets;
  try {
    const { default: Anthropic5 } = await import("@anthropic-ai/sdk");
    const client = new Anthropic5({ apiKey: ANTHROPIC_KEY, timeout: 5e3 });
    const tweetList = tweets.map((t, i) => `[${i}] @${t.handle}: ${(t.text || "").slice(0, 280)}`).join("\n");
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      messages: [{ role: "user", content: `Score these ${sectionName} tweets 1-10 for importance/newsworthiness.
Score 7+ = breaking news, significant development, novel expert insight.
Score <7 = opinion, self-promotion, old news, noise, engagement bait.
For each scoring 7+, write a one-line insight (max 15 words) explaining why it matters.
Return ONLY valid JSON array: [{"index":0,"score":8,"insight":"..."}]

${tweetList}` }],
      system: "You are a senior intelligence analyst. Return ONLY a JSON array, no other text."
    });
    const text = response.content.map((b) => b.type === "text" ? b.text : "").join("");
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return tweets;
    const scores = JSON.parse(jsonMatch[0]);
    const filtered = [];
    for (const s of scores) {
      if (s.score >= AI_FILTER_THRESHOLD && s.index >= 0 && s.index < tweets.length) {
        filtered.push({ ...tweets[s.index], score: s.score, insight: s.insight || "" });
      }
    }
    return filtered;
  } catch (err) {
    console.warn(`[x-intel] AI filter failed for ${sectionName}:`, err.message);
    return tweets;
  }
}
async function fetchXIntelData() {
  const xIntelSections = {
    breaking: {
      visionaries: ["DeItaone", "unusual_whales", "sentdefender", "pmarca", "IntelCrab", "spectatorindex", "zeynep", "BillAckman", "ElbridgeColby", "adam_tooze"],
      headlines: ["Reuters", "AP", "BBCBreaking", "business", "CNN", "CNBC", "AJEnglish", "axios", "politico", "FT"]
    },
    global: {
      visionaries: ["ianbremmer", "michaelxpettis", "RnaudBertrand", "Jkylebass", "FareedZakaria", "RichardHaass", "PeterZeihan", "anneapplebaum", "nouriel", "BrankoMilan"],
      headlines: ["BBCWorld", "nytimes", "TheEconomist", "ForeignPolicy", "ForeignAffairs", "guardian", "CFR_org", "AJEnglish", "FRANCE24", "DWNews"]
    },
    macro: {
      visionaries: ["LynAldenContact", "NickTimiraos", "LukeGromen", "josephwang", "RaoulGMI", "biancoresearch", "elerianm", "naval", "KobeissiLetter", "balajis"],
      headlines: ["FT", "WSJ", "business", "TheEconomist", "IMFNews", "federalreserve", "BISbank", "CNBC", "axios", "markets"]
    },
    techAi: {
      visionaries: ["karpathy", "sama", "DarioAmodei", "emollick", "AndrewYNg", "AravSrinivas", "ylecun", "DrJimFan", "gdb", "alexandr_wang"],
      headlines: ["Wired", "TechCrunch", "verge", "ArsTechnica", "VentureBeat", "NewScientist", "axios", "CNBC"]
    },
    bitcoin: {
      visionaries: ["saylor", "LynAldenContact", "APompliano", "PrestonPysh", "dergigi", "pete_rizzo_", "bitfinexed", "KobeissiLetter", "balajis", "naval"],
      headlines: ["CoinDesk", "Cointelegraph", "theblockCrypto", "BitcoinMagazine", "DecryptMedia", "TheDefiant", "WuBlockchain", "cryptobriefing"]
    }
  };
  function pickRandom(arr, n) {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  }
  const xIntelResult = {};
  const sections = Object.entries(xIntelSections);
  for (const [section] of sections) {
    xIntelResult[section] = { visionaries: [], headlines: [] };
  }
  const allFetches = [];
  for (const [section, handles] of sections) {
    const pickedVis = pickRandom(handles.visionaries, 7);
    const pickedHead = pickRandom(handles.headlines, 7);
    for (const h of pickedVis) allFetches.push({ section, type: "visionaries", handle: h });
    for (const h of pickedHead) allFetches.push({ section, type: "headlines", handle: h });
  }
  let fetchOk = 0, fetchFail = 0;
  const BATCH = 8;
  for (let i = 0; i < allFetches.length; i += BATCH) {
    if (i > 0) await new Promise((r) => setTimeout(r, 500));
    const batch = allFetches.slice(i, i + BATCH);
    await Promise.all(batch.map(async (f) => {
      try {
        const tweets = await getUserTimelineStructured(f.handle, 2);
        if (tweets.length > 0) {
          xIntelResult[f.section][f.type].push(...tweets);
          fetchOk++;
        } else {
          fetchFail++;
        }
      } catch {
        fetchFail++;
      }
    }));
  }
  console.log(`[x-intel] Fetched ${allFetches.length} handles: ${fetchOk} ok, ${fetchFail} empty/failed`);
  const filterStatus = {};
  const filterPromises = [];
  for (const [section, data] of Object.entries(xIntelResult)) {
    filterStatus[section] = false;
    if (data.visionaries.length > 0) {
      filterPromises.push(
        filterTweetsWithAI(`${section}/visionaries`, data.visionaries).then((filtered) => {
          if (filtered.some((t) => t.score !== void 0)) filterStatus[section] = true;
          data.visionaries = filtered;
        })
      );
    }
    if (data.headlines.length > 0) {
      filterPromises.push(
        filterTweetsWithAI(`${section}/headlines`, data.headlines).then((filtered) => {
          if (filtered.some((t) => t.score !== void 0)) filterStatus[section] = true;
          data.headlines = filtered;
        })
      );
    }
  }
  await Promise.all(filterPromises);
  for (const [section, data] of Object.entries(xIntelResult)) {
    data.filtered = filterStatus[section];
  }
  return xIntelResult;
}
app.get("/api/wealth-engines/theses", async (_req, res) => {
  try {
    const theses = await getActiveTheses();
    res.json({ count: theses.length, theses });
  } catch (err) {
    console.error("[wealth-engines] theses error:", err);
    res.status(500).json({ error: "Failed to fetch theses" });
  }
});
app.get("/api/wealth-engines/watchlist", async (_req, res) => {
  try {
    const watchlist = await getWatchlist();
    res.json({ count: watchlist.length, assets: watchlist });
  } catch (err) {
    console.error("[wealth-engines] watchlist error:", err);
    res.status(500).json({ error: "Failed to fetch watchlist" });
  }
});
app.get("/api/wealth-engines/positions", async (_req, res) => {
  try {
    const summary = await getPortfolioSummary();
    res.json(summary);
  } catch (err) {
    console.error("[wealth-engines] positions error:", err);
    res.status(500).json({ error: "Failed to fetch positions" });
  }
});
app.get("/api/wealth-engines/trades", async (_req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(String(_req.query.limit)) || 50, 1), 200);
    const history = await getTradeHistory();
    res.json({ total: history.length, trades: history.slice(-limit) });
  } catch (err) {
    console.error("[wealth-engines] trades error:", err);
    res.status(500).json({ error: "Failed to fetch trades" });
  }
});
app.get("/api/wealth-engines/tax/summary", async (_req, res) => {
  try {
    const summary = await getTaxSummary();
    res.json(summary);
  } catch (err) {
    console.error("[wealth-engines] tax summary error:", err);
    res.status(500).json({ error: "Failed to fetch tax summary" });
  }
});
app.get("/api/wealth-engines/tax/8949", async (_req, res) => {
  try {
    const csv = await generateForm8949CSV();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="form-8949-${(/* @__PURE__ */ new Date()).getFullYear()}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error("[wealth-engines] 8949 error:", err);
    res.status(500).json({ error: "Failed to generate Form 8949" });
  }
});
app.get("/api/wealth-engines/export", async (_req, res) => {
  try {
    const [positions, trades, taxSummary, cryptoTheses, pmTheses, watchlist, portfolio] = await Promise.all([
      getPositions(),
      getTradeHistory(),
      getTaxSummary(),
      getActiveTheses(),
      getActiveTheses2(),
      getWatchlist(),
      getPortfolioValue()
    ]);
    res.json({
      exported_at: (/* @__PURE__ */ new Date()).toISOString(),
      portfolio_value: portfolio,
      positions,
      trade_history: trades,
      tax_summary: taxSummary,
      crypto_theses: cryptoTheses,
      polymarket_theses: pmTheses,
      watchlist
    });
  } catch (err) {
    console.error("[wealth-engines] export error:", err);
    res.status(500).json({ error: "Failed to export data" });
  }
});
app.get("/api/wealth-engines/polymarket/theses", async (_req, res) => {
  try {
    const theses = await getActiveTheses2();
    res.json({ count: theses.length, theses });
  } catch (err) {
    console.error("[wealth-engines] pm theses error:", err);
    res.status(500).json({ error: "Failed to fetch polymarket theses" });
  }
});
app.get("/api/wealth-engines/oversight", async (_req, res) => {
  try {
    const summary = await getOversightSummary();
    res.json(summary);
  } catch (err) {
    console.error("[wealth-engines] oversight error:", err);
    res.status(500).json({ error: "Failed to fetch oversight data" });
  }
});
var weDashboardCache = null;
var WE_DASHBOARD_TTL = 3e4;
async function buildWealthEnginesDashboardData() {
  const [summary, tradeHistory, pmTheses, cryptoTheses, oversightData, shadowPerf, researchStatus, fearGreed] = await Promise.all([
    getPortfolioSummary(),
    getTradeHistory(),
    getActiveTheses2().catch(() => []),
    getActiveTheses().catch(() => []),
    getOversightSummary().catch(() => null),
    getShadowPerformance().catch(() => ({ total_trades: 0, open_trades: 0, closed_trades: 0, total_pnl: 0, win_rate: 0, avg_pnl: 0, trades: [] })),
    getResearchStatus().catch(() => null),
    getFearGreedIndex().catch(() => null)
  ]);
  const recentTrades = tradeHistory.slice(-20).reverse();
  const totalRealizedPnl = tradeHistory.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const pool2 = (await Promise.resolve().then(() => (init_db(), db_exports))).getPool();
  let scoutLastRun = null;
  let scoutSummary = null;
  let monitorLastTick = null;
  let pmLastRun = null;
  let scoutRegime = null;
  try {
    const scoutRes = await pool2.query(`SELECT created_at, summary FROM job_history WHERE job_id IN ('scout-micro-scan', 'scout-full-cycle') ORDER BY created_at DESC LIMIT 1`);
    if (scoutRes.rows.length > 0) {
      scoutLastRun = scoutRes.rows[0].created_at;
      const raw = scoutRes.rows[0].summary || "";
      scoutSummary = raw.length > 500 ? raw.slice(0, 500) + "..." : raw;
      const regimeMatch = raw.match(/(?:Regime\s*[:\|]\s*|[\|]\s*)(TRENDING|RANGING|VOLATILE|BEARISH|BULLISH)(?:\s*[\|])/i);
      if (regimeMatch) scoutRegime = regimeMatch[1].toUpperCase();
    }
  } catch (err) {
    console.warn("[wealth-engines] scout query failed:", err instanceof Error ? err.message : err);
  }
  try {
    const pmRes = await pool2.query(`SELECT created_at FROM job_history WHERE job_id IN ('polymarket-activity-scan', 'polymarket-full-cycle') ORDER BY created_at DESC LIMIT 1`);
    if (pmRes.rows.length > 0) pmLastRun = pmRes.rows[0].created_at;
  } catch (err) {
    console.warn("[wealth-engines] pm last run query failed:", err instanceof Error ? err.message : err);
  }
  try {
    const tickRes = await pool2.query(`SELECT value FROM app_config WHERE key = 'bankr_monitor_last_tick'`);
    if (tickRes.rows.length > 0) monitorLastTick = new Date(parseInt(String(tickRes.rows[0].value))).toISOString();
  } catch (err) {
    console.warn("[wealth-engines] monitor tick query failed:", err instanceof Error ? err.message : err);
  }
  let oversightLastRun = null;
  try {
    const osRes = await pool2.query(`SELECT created_at FROM job_history WHERE job_id = 'oversight-health' ORDER BY created_at DESC LIMIT 1`);
    if (osRes.rows.length > 0) oversightLastRun = osRes.rows[0].created_at;
  } catch {
  }
  let agentActivity = [];
  try {
    const actRes = await pool2.query(`SELECT job_id, created_at, summary, status FROM job_history ORDER BY created_at DESC LIMIT 15`);
    agentActivity = actRes.rows.map((r) => ({ job_id: r.job_id, created_at: r.created_at, summary: (r.summary || "").slice(0, 200), status: r.status || "completed" }));
  } catch {
  }
  const now = Date.now();
  const scoutHealthy = scoutLastRun ? now - new Date(scoutLastRun).getTime() < 6 * 60 * 6e4 : false;
  const monitorHealthy = monitorLastTick ? now - new Date(monitorLastTick).getTime() < 30 * 6e4 : false;
  const oversightHealthy = oversightLastRun ? now - new Date(oversightLastRun).getTime() < 8 * 60 * 6e4 : false;
  const topPmThesis = pmTheses.length > 0 ? (pmTheses[0].question || pmTheses[0].market_question || "").slice(0, 100) : null;
  const now24h = now - 24 * 60 * 6e4;
  const now7d = now - 7 * 24 * 60 * 6e4;
  const dailyTrades = tradeHistory.filter((t) => new Date(t.closed_at).getTime() > now24h);
  const weeklyTrades = tradeHistory.filter((t) => new Date(t.closed_at).getTime() > now7d);
  const dailyPnl = dailyTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const weeklyPnl = weeklyTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const totalWins = tradeHistory.filter((t) => (t.pnl || 0) > 0).length;
  const winRate = tradeHistory.length > 0 ? totalWins / tradeHistory.length * 100 : 0;
  const availableUsdc = Math.max(0, summary.portfolio_value - summary.total_exposure);
  return {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    portfolio_value: summary.portfolio_value,
    peak_portfolio_value: summary.peak_portfolio_value,
    peak_drawdown_pct: summary.peak_drawdown_pct,
    consecutive_losses: summary.consecutive_losses,
    total_exposure: summary.total_exposure,
    unrealized_pnl: summary.unrealized_pnl,
    total_realized_pnl: totalRealizedPnl,
    daily_pnl: parseFloat(dailyPnl.toFixed(4)),
    weekly_pnl: parseFloat(weeklyPnl.toFixed(4)),
    available_usdc: parseFloat(availableUsdc.toFixed(2)),
    initial_capital: summary.initial_capital || 1e3,
    total_trades: tradeHistory.length,
    win_rate: parseFloat(winRate.toFixed(1)),
    mode: summary.mode,
    paused: summary.paused,
    kill_switch: summary.kill_switch,
    positions: summary.positions,
    recent_trades: recentTrades,
    crypto_theses: cryptoTheses.slice(0, 10).map((t) => ({
      id: t.id,
      asset: t.asset,
      direction: t.direction,
      confidence: t.confidence,
      entry_price: t.entry_price,
      stop_loss: t.stop_price || t.stop_loss,
      take_profit: t.exit_price || t.take_profit,
      reasoning: t.reasoning || "",
      created_at: t.created_at,
      status: t.status,
      vote_count: t.vote_count || null,
      time_horizon: t.time_horizon || null,
      sources: t.sources || [],
      market_regime: t.market_regime || null,
      technical_score: t.technical_score || null
    })),
    polymarket_theses: pmTheses.slice(0, 10).map((t) => ({
      id: t.id,
      question: t.asset || t.question || t.market_question,
      direction: t.direction,
      confidence: t.confidence,
      whale_consensus: t.whale_consensus,
      current_odds: t.current_odds,
      entry_odds: t.entry_odds,
      exit_odds: t.exit_odds,
      volume: t.volume,
      category: t.category,
      reasoning: t.reasoning || "",
      sources: t.sources || [],
      created_at: t.created_at,
      expires_at: t.expires_at,
      status: t.status
    })),
    scout: {
      crypto_last_run: scoutLastRun,
      crypto_regime: scoutRegime,
      crypto_summary: scoutSummary,
      crypto_theses_count: cryptoTheses.length,
      pm_theses_count: pmTheses.length,
      pm_top_thesis: topPmThesis,
      pm_last_run: pmLastRun,
      fear_greed: fearGreed ? { value: fearGreed.value, classification: fearGreed.classification, regime_signal: fearGreed.regime_signal } : null
    },
    oversight: oversightData ? {
      health_status: oversightData.health?.overall_status || "unknown",
      health_checks: oversightData.health?.checks || [],
      drawdown: oversightData.drawdown,
      improvements: oversightData.improvements,
      last_check: oversightData.last_check,
      last_run: oversightLastRun
    } : null,
    shadow: {
      total_trades: shadowPerf.total_trades,
      open_trades: shadowPerf.open_trades,
      closed_trades: shadowPerf.closed_trades,
      total_pnl: shadowPerf.total_pnl,
      win_rate: shadowPerf.win_rate,
      avg_pnl: shadowPerf.avg_pnl,
      best_trade: shadowPerf.trades.length > 0 ? Math.max(...shadowPerf.trades.map((t) => t.hypothetical_pnl || 0)) : 0,
      worst_trade: shadowPerf.trades.length > 0 ? Math.min(...shadowPerf.trades.map((t) => t.hypothetical_pnl || 0)) : 0,
      trades: shadowPerf.trades.slice(-10).reverse()
    },
    autoresearch: researchStatus ? {
      crypto_params: researchStatus.crypto_params,
      polymarket_params: researchStatus.polymarket_params,
      recent_experiments: researchStatus.recent_experiments.slice(-5),
      crypto_history_count: researchStatus.crypto_history_count,
      polymarket_history_count: researchStatus.polymarket_history_count
    } : null,
    signal_quality: await (async () => {
      try {
        const scores = await getSignalQuality();
        return scores.map((s) => ({
          source: s.source,
          asset_class: s.asset_class,
          win_rate: s.win_rate,
          wins: s.wins,
          losses: s.losses,
          total_pnl: s.total_pnl,
          avg_pnl: s.avg_pnl,
          sample_size: s.recent_results.length,
          modifier: getSignalQualityModifier(scores, s.source, s.asset_class).modifier
        }));
      } catch {
        return [];
      }
    })(),
    agent_activity: agentActivity,
    health: {
      kill_switch: summary.kill_switch,
      paused: summary.paused,
      mode: summary.mode,
      scout_last_run: scoutLastRun,
      scout_healthy: scoutHealthy,
      monitor_last_tick: monitorLastTick,
      monitor_healthy: monitorHealthy,
      oversight_last_run: oversightLastRun,
      oversight_healthy: oversightHealthy,
      deadman_healthy: monitorHealthy,
      bnkr_configured: summary.bnkr_configured
    }
  };
}
app.get("/api/wealth-engines/data", async (req, res) => {
  try {
    const forceRefresh = req.query.force === "1";
    if (!forceRefresh && weDashboardCache && Date.now() - weDashboardCache.ts < WE_DASHBOARD_TTL) {
      res.json(weDashboardCache.data);
      return;
    }
    const data = await buildWealthEnginesDashboardData();
    weDashboardCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    console.error("[wealth-engines] dashboard data error:", err);
    res.status(500).json({ error: "Failed to fetch dashboard data" });
  }
});
var WE_CONTROL_USERS = /* @__PURE__ */ new Set(["rickin", "darknode"]);
app.post("/api/wealth-engines/pause", async (req, res) => {
  if (!WE_CONTROL_USERS.has(req.user)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const pool2 = (await Promise.resolve().then(() => (init_db(), db_exports))).getPool();
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(true), Date.now()]
    );
    weDashboardCache = null;
    res.json({ ok: true, paused: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.post("/api/wealth-engines/resume", async (req, res) => {
  if (!WE_CONTROL_USERS.has(req.user)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const pool2 = (await Promise.resolve().then(() => (init_db(), db_exports))).getPool();
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(false), Date.now()]
    );
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_kill_switch', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(false), Date.now()]
    );
    weDashboardCache = null;
    res.json({ ok: true, paused: false, kill_switch: false });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.post("/api/wealth-engines/kill", async (req, res) => {
  if (!WE_CONTROL_USERS.has(req.user)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const pool2 = (await Promise.resolve().then(() => (init_db(), db_exports))).getPool();
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_kill_switch', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(true), Date.now()]
    );
    weDashboardCache = null;
    res.json({ ok: true, kill_switch: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.get("/api/wealth-engine/config", async (req, res) => {
  if (!WE_CONTROL_USERS.has(req.user)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const config3 = await getRiskConfig();
    const portfolio = await getPortfolioValue();
    const peak = await getPeakPortfolioValue();
    const mode = await getMode2();
    const paused = await isPaused();
    const killSwitch = await isKillSwitchActive();
    const positions = await getPositions();
    const pool2 = getPool();
    let bootTime = 0;
    try {
      const bt = await pool2.query(`SELECT value FROM app_config WHERE key = 'system_boot_time'`);
      if (bt.rows.length > 0) bootTime = typeof bt.rows[0].value === "number" ? bt.rows[0].value : 0;
    } catch {
    }
    let monitorTick = 0;
    try {
      const mt = await pool2.query(`SELECT value FROM app_config WHERE key = 'bankr_monitor_last_tick'`);
      if (mt.rows.length > 0) monitorTick = typeof mt.rows[0].value === "number" ? mt.rows[0].value : 0;
    } catch {
    }
    let shadowOpen = 0, shadowClosed = 0;
    try {
      const { getShadowTrades: getShadowTrades2 } = await Promise.resolve().then(() => (init_oversight(), oversight_exports));
      const openShadows = await getShadowTrades2("open");
      const closedShadows = await getShadowTrades2("closed");
      shadowOpen = openShadows.length;
      shadowClosed = closedShadows.length;
    } catch {
    }
    const weJobs = getJobs().filter(
      (j) => ["scout-micro-scan", "scout-full-cycle", "polymarket-activity-scan", "polymarket-full-cycle", "bankr-execute", "oversight-health", "oversight-weekly", "oversight-daily-summary", "oversight-shadow-refresh", "autoresearch-weekly"].includes(j.id)
    ).map((j) => ({
      id: j.id,
      name: j.name,
      enabled: j.enabled,
      schedule_type: j.schedule.type,
      interval_minutes: j.schedule.intervalMinutes || null,
      hour: j.schedule.hour ?? null,
      minute: j.schedule.minute ?? null,
      last_run: j.lastRun || null,
      last_status: j.lastStatus || null
    }));
    res.json({
      risk: config3,
      portfolio,
      peak,
      mode,
      paused,
      kill_switch: killSwitch,
      bnkr_configured: (await Promise.resolve().then(() => (init_bnkr(), bnkr_exports))).isConfigured(),
      positions_count: positions.length,
      boot_time: bootTime,
      monitor_tick: monitorTick,
      shadow_open: shadowOpen,
      shadow_closed: shadowClosed,
      jobs: weJobs
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.post("/api/wealth-engine/config", async (req, res) => {
  if (!WE_CONTROL_USERS.has(req.user)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const updates = req.body;
    if (!updates || typeof updates !== "object") {
      res.status(400).json({ error: "Body must be a JSON object" });
      return;
    }
    const allowed = ["max_leverage", "risk_per_trade_pct", "max_positions", "exposure_cap_pct", "correlation_limit", "circuit_breaker_7d_pct", "circuit_breaker_drawdown_pct", "notification_mode"];
    const filtered = {};
    for (const k of Object.keys(updates)) {
      if (allowed.includes(k)) filtered[k] = updates[k];
    }
    if (Object.keys(filtered).length === 0) {
      res.status(400).json({ error: "No valid config keys provided" });
      return;
    }
    const result = await setRiskConfig(filtered);
    if (filtered.notification_mode) {
      const pool2 = getPool();
      await pool2.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        ["we_notification_mode", JSON.stringify(filtered.notification_mode), Date.now()]
      );
    }
    weDashboardCache = null;
    res.json({ ok: true, config: result });
  } catch (err) {
    res.status(400).json({ error: err.message || String(err) });
  }
});
app.post("/api/wealth-engine/portfolio", async (req, res) => {
  if (!WE_CONTROL_USERS.has(req.user)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const { value, reset_peak } = req.body;
    const pool2 = getPool();
    if (typeof value === "number" && value > 0) {
      await pool2.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        ["wealth_engines_portfolio_value", JSON.stringify(value), Date.now()]
      );
    }
    if (reset_peak) {
      const currentPortfolio = await getPortfolioValue();
      await pool2.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        ["wealth_engines_peak_portfolio", JSON.stringify(currentPortfolio), Date.now()]
      );
    }
    weDashboardCache = null;
    res.json({ ok: true, portfolio: await getPortfolioValue(), peak: await getPeakPortfolioValue() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.post("/api/wealth-engine/mode", async (req, res) => {
  if (!WE_CONTROL_USERS.has(req.user)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const { mode } = req.body;
    if (!["SHADOW", "LIVE", "BETA"].includes(mode)) {
      res.status(400).json({ error: "Invalid mode" });
      return;
    }
    const pool2 = getPool();
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      ["wealth_engines_mode", JSON.stringify(mode), Date.now()]
    );
    weDashboardCache = null;
    res.json({ ok: true, mode });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.post("/api/wealth-engine/jobs/:jobId", async (req, res) => {
  if (!WE_CONTROL_USERS.has(req.user)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const WE_JOB_IDS = /* @__PURE__ */ new Set(["scout-micro-scan", "scout-full-cycle", "polymarket-activity-scan", "polymarket-full-cycle", "bankr-execute", "oversight-health", "oversight-weekly", "oversight-daily-summary", "oversight-shadow-refresh", "autoresearch-weekly"]);
  try {
    const { jobId } = req.params;
    if (!WE_JOB_IDS.has(jobId)) {
      res.status(403).json({ error: "Not a Wealth Engine job" });
      return;
    }
    const { enabled, interval_minutes } = req.body;
    const updates = {};
    if (typeof enabled === "boolean") updates.enabled = enabled;
    if (typeof interval_minutes === "number" && interval_minutes >= 5) {
      updates.schedule = { intervalMinutes: interval_minutes };
    }
    const result = updateJob(jobId, updates);
    if (!result) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json({ ok: true, job: { id: result.id, name: result.name, enabled: result.enabled, schedule: result.schedule } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.get("/api/x-intelligence/data", async (_req, res) => {
  try {
    const forceRefresh = _req.query.force === "1";
    if (!forceRefresh && xIntelCache && Date.now() - xIntelCache.ts < X_INTEL_TTL) {
      res.json(xIntelCache.data);
      return;
    }
    const data = await fetchXIntelData();
    xIntelCache = { data, ts: Date.now() };
    res.json(data);
  } catch (err) {
    console.error("[x-intelligence] Error:", err);
    res.status(500).json({ error: "Failed to fetch X intelligence data" });
  }
});
app.get("/api/daily-brief/data", async (_req, res) => {
  try {
    const forceRefresh = _req.query.force === "1";
    if (!forceRefresh && dailyBriefCache && Date.now() - dailyBriefCache.ts < DAILY_BRIEF_TTL) {
      res.json(dailyBriefCache.data);
      return;
    }
    const cfg = getConfig();
    const tz = cfg.timezone || "America/New_York";
    const loc = cfg.location || "10016";
    const now = /* @__PURE__ */ new Date();
    const result = {
      timestamp: now.toISOString(),
      greeting: "",
      date: "",
      welcomeMessage: "",
      weather: null,
      commuteAlert: null,
      markets: [],
      tasks: [],
      calendars: { rickin: [], pooja: [], reya: [], other: [] },
      headlines: [],
      xIntel: null,
      familyCards: [],
      baby: null,
      reya: null,
      moodys: null,
      realEstate: null,
      focusToday: null,
      jobs: null
    };
    try {
      const etHour = parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
      result.greeting = etHour < 12 ? "Good morning" : etHour < 17 ? "Good afternoon" : "Good evening";
      result.date = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric" });
      result.timeStr = now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
    } catch {
    }
    const promises = [];
    promises.push((async () => {
      try {
        const raw = await getWeather(loc, 5);
        const tempMatch = raw.match(/Temperature:\s*([\d.-]+)°C\s*\((-?\d+)°F\)/);
        const condMatch = raw.match(/Condition:\s*(.+)/);
        const feelsMatch = raw.match(/Feels like:\s*([\d.-]+)°C\s*\((-?\d+)°F\)/);
        const humMatch = raw.match(/Humidity:\s*(\d+)%/);
        const windMatch = raw.match(/Wind:\s*(.+)/);
        if (tempMatch && condMatch) {
          const condition = condMatch[1].trim();
          const etHour = parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
          const isNight = etHour >= 18 || etHour < 6;
          let icon = "\u{1F321}\uFE0F";
          const cl = condition.toLowerCase();
          if (cl.includes("clear") || cl.includes("sunny")) icon = isNight ? "\u{1F319}" : "\u2600\uFE0F";
          else if (cl.includes("partly")) icon = isNight ? "\u2601\uFE0F" : "\u26C5";
          else if (cl.includes("cloud") || cl.includes("overcast")) icon = "\u2601\uFE0F";
          else if (cl.includes("rain") || cl.includes("drizzle") || cl.includes("shower")) icon = "\u{1F327}\uFE0F";
          else if (cl.includes("snow")) icon = "\u2744\uFE0F";
          else if (cl.includes("thunder")) icon = "\u26C8\uFE0F";
          else if (cl.includes("fog")) icon = "\u{1F32B}\uFE0F";
          const w = { tempC: Math.round(parseFloat(tempMatch[1])), tempF: parseInt(tempMatch[2]), condition, icon };
          if (feelsMatch) {
            w.feelsLikeC = Math.round(parseFloat(feelsMatch[1]));
            w.feelsLikeF = parseInt(feelsMatch[2]);
          }
          if (humMatch) w.humidity = parseInt(humMatch[1]);
          if (windMatch) w.wind = windMatch[1].trim();
          const forecastLines = raw.match(/\d{4}-\d{2}-\d{2}:\s*.+/g);
          if (forecastLines) {
            w.forecast = forecastLines.map((line) => {
              const m = line.match(/(\d{4}-\d{2}-\d{2}):\s*(.+?),\s*([\d-]+)-([\d-]+)°C.*?Rain:\s*(\d+)%/);
              if (!m) return null;
              const lowC = parseInt(m[3]), highC = parseInt(m[4]);
              return { date: m[1], condition: m[2].trim(), lowC, highC, lowF: Math.round(lowC * 9 / 5 + 32), highF: Math.round(highC * 9 / 5 + 32), rainPct: parseInt(m[5]) };
            }).filter(Boolean);
          }
          const hourlyPrecip = raw.match(/Hourly Precipitation:\n([\s\S]*?)(?:\n\d+-Day|\n$|$)/);
          if (hourlyPrecip) {
            const lines = hourlyPrecip[1].match(/\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):\s*(\d+)%/g) || [];
            for (const line of lines) {
              const m = line.match(/T(\d{2}):(\d{2}):\s*(\d+)%/);
              if (m) {
                const hour = parseInt(m[1]);
                const minute = parseInt(m[2]);
                const pct = parseInt(m[3]);
                const timeMinutes = hour * 60 + minute;
                if (timeMinutes >= 450 && timeMinutes <= 540 && pct > 40) {
                  const cond = (w.condition || "").toLowerCase();
                  const label = cond.includes("snow") || cond.includes("sleet") ? "snow" : "rain";
                  const timeLabel = hour > 12 ? `${hour - 12}:${m[2]} PM` : `${hour}:${m[2]} AM`;
                  result.commuteAlert = `\u2602\uFE0F ${pct}% chance of ${label} at school drop-off (~${timeLabel})`;
                  break;
                }
              }
            }
          }
          result.weather = w;
        }
      } catch {
      }
    })());
    const watchlistSymbols = [
      { symbol: "BTCUSD", type: "crypto", display: "BTC", emoji: "\u20BF" },
      { symbol: "MSTR", type: "stock", display: "MSTR", emoji: "\u{1F4CA}" },
      { symbol: "^GSPC", type: "stock", display: "SPX", emoji: "\u{1F4C8}" },
      { symbol: "GC=F", type: "stock", display: "GOLD", emoji: "\u{1F947}" },
      { symbol: "SI=F", type: "stock", display: "SILVER", emoji: "\u{1F948}" },
      { symbol: "CL=F", type: "stock", display: "OIL", emoji: "\u{1F6E2}\uFE0F" }
    ];
    promises.push((async () => {
      const quotePromises = watchlistSymbols.map(async (w) => {
        const q = await fetchQuoteStructured(w.symbol, w.type);
        if (q) return { ...q, display: w.display, emoji: w.emoji, type: w.type };
        return null;
      });
      const quotes = await Promise.all(quotePromises);
      result.markets = quotes.filter(Boolean);
    })());
    promises.push((async () => {
      try {
        const active = await getActiveTasks();
        result.tasks = active.slice(0, 8);
      } catch {
      }
    })());
    if (isConfigured4()) {
      promises.push((async () => {
        try {
          const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
          const tzStr = now.toLocaleString("en-US", { timeZone: tz });
          const tzOffsetMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
          const nowShifted = new Date(now.getTime() + tzOffsetMs);
          const eodTomorrowInTz = new Date(Date.UTC(nowShifted.getUTCFullYear(), nowShifted.getUTCMonth(), nowShifted.getUTCDate() + 1, 23, 59, 59, 999));
          const endOfTomorrowUTC = new Date(eodTomorrowInTz.getTime() - tzOffsetMs);
          const events = await listEventsStructured({ maxResults: 15, timeMax: endOfTomorrowUTC.toISOString() });
          const cals = { rickin: [], pooja: [], reya: [], other: [] };
          for (const ev of events) {
            const calName = (ev.calendar || "").toLowerCase();
            if (calName.includes("rickin") || calName.includes("primary") || calName === "" || calName.includes("rickin.patel")) cals.rickin.push(ev);
            else if (calName.includes("pooja")) cals.pooja.push(ev);
            else if (calName.includes("reya")) cals.reya.push(ev);
            else cals.other.push(ev);
          }
          result.calendars = cals;
        } catch {
        }
      })());
    }
    promises.push((async () => {
      try {
        if (xIntelCache && Date.now() - xIntelCache.ts < X_INTEL_TTL) {
          result.xIntel = xIntelCache.data;
        } else {
          const xData = await fetchXIntelData();
          xIntelCache = { data: xData, ts: Date.now() };
          result.xIntel = xData;
        }
      } catch {
      }
    })());
    promises.push((async () => {
      try {
        const [globalHeadlines, nycHeadlines] = await Promise.all([
          getTopHeadlines(8),
          searchHeadlines("New York City", 5)
        ]);
        const globalTagged = globalHeadlines.map((h) => ({ ...h, category: "global" }));
        const nycTagged = nycHeadlines.map((h) => ({ ...h, category: "nyc" }));
        const seen = /* @__PURE__ */ new Set();
        const deduped = [];
        for (const h of [...globalTagged, ...nycTagged]) {
          const key = h.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
          if (!seen.has(key)) {
            seen.add(key);
            deduped.push(h);
          }
        }
        result.headlines = deduped;
      } catch {
        result.headlines = [];
      }
    })());
    promises.push((async () => {
      try {
        const dueDate = /* @__PURE__ */ new Date("2026-07-07");
        const daysLeft = Math.ceil((dueDate.getTime() - now.getTime()) / 864e5);
        const weeksPregnant = 40 - Math.ceil(daysLeft / 7);
        let nextAppt = null;
        if (isConnected()) {
          try {
            const readTab = async (range) => {
              try {
                const r = await sheetsRead(BABY_SHEET_ID2, range);
                if (r.includes("Error") || r.includes("not connected")) return "";
                return r;
              } catch {
                return "";
              }
            };
            const apptResult = await readTab("Appointments!A1:E14");
            if (apptResult && !apptResult.includes("No data")) {
              const apptRows = apptResult.split("\n").filter((l) => l.startsWith("Row ")).map((l) => l.replace(/^Row \d+: /, "").split(" | "));
              const today = now.toISOString().split("T")[0];
              for (let i = 1; i < apptRows.length; i++) {
                const r = apptRows[i];
                const date = (r[0] || "").trim();
                if (date && date >= today) {
                  nextAppt = { date, title: (r[1] || "").trim() };
                  break;
                }
              }
            }
          } catch {
          }
        }
        result.baby = { weeksPregnant, daysLeft, nextAppt };
      } catch {
      }
    })());
    promises.push((async () => {
      try {
        const dayName = now.toLocaleString("en-US", { timeZone: tz, weekday: "long" });
        const isWeekend = ["Saturday", "Sunday"].includes(dayName);
        if (!isWeekend) {
          const month = parseInt(now.toLocaleString("en-US", { timeZone: tz, month: "numeric" }));
          const day = parseInt(now.toLocaleString("en-US", { timeZone: tz, day: "numeric" }));
          let lunch = "Menu not available";
          try {
            const mealFile = await kbRead("Family/Reya's Education/Reya - School Meals.md");
            if (mealFile) {
              const datePattern = new RegExp(`\\|\\s*\\w+\\s+${month}/${day}\\s*\\|([^|]+)\\|([^|]+)\\|([^|]+)\\|`, "i");
              const match = mealFile.match(datePattern);
              if (match) {
                const mainDish = match[1].replace(/\*\*/g, "").trim();
                const vegStatus = match[2].trim();
                const sides = match[3].trim();
                const isVeg = vegStatus.includes("\u2705");
                lunch = isVeg ? `\u2705 ${mainDish}` : `\u274C ${mainDish} \u2014 Sides: ${sides}`;
              }
            }
          } catch {
          }
          const etNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
          const pickupTime = new Date(etNow);
          pickupTime.setHours(16, 30, 0, 0);
          let pickupCountdown;
          if (etNow < pickupTime) {
            const diffMs = pickupTime.getTime() - etNow.getTime();
            const h = Math.floor(diffMs / 36e5);
            const m = Math.floor(diffMs % 36e5 / 6e4);
            pickupCountdown = h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
          } else {
            pickupCountdown = "\u2705 Picked up";
          }
          let schoolAlert = null;
          try {
            if (isConnected()) {
              const a = await searchEmailsStructured("from:kristen OR from:cicio is:unread newer_than:2d", 1);
              if (a.length > 0) schoolAlert = a[0].subject;
            }
          } catch {
          }
          result.reya = { schoolInSession: true, lunch, pickupCountdown, alert: schoolAlert };
        } else {
          result.reya = { schoolInSession: false, isWeekend: true };
        }
      } catch {
      }
    })());
    promises.push((async () => {
      try {
        const year = now.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
        const month = now.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
        const day = now.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
        const dateStr = `${year}-${month}-${day}`;
        const etHour = parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
        let briefContent = null;
        let briefDate = dateStr;
        if (etHour >= 6) {
          try {
            const content = await kbRead(`Scheduled Reports/Moody's Intelligence/Daily/${dateStr}-Brief.md`);
            if (content && content.length > 100) briefContent = content;
          } catch {
          }
        }
        if (!briefContent) {
          const yesterday = new Date(now.getTime() - 864e5);
          const yDateStr = `${yesterday.toLocaleString("en-US", { timeZone: tz, year: "numeric" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, month: "2-digit" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, day: "2-digit" })}`;
          try {
            const content = await kbRead(`Scheduled Reports/Moody's Intelligence/Daily/${yDateStr}-Brief.md`);
            if (content && content.length > 100) {
              briefContent = content;
              briefDate = yDateStr;
            }
          } catch {
          }
        }
        if (!briefContent) {
          result.moodys = { available: false, reason: etHour < 6 ? "pending" : "missing", message: etHour < 6 ? "Daily brief generates at 6:00 AM" : "Brief unavailable \u2014 check pipeline" };
          return;
        }
        const categories = { corporate: [], banking: [], competitors: [], aiTrends: [], analysts: [] };
        const MAX_PER_CAT = 5;
        const sectionMap = [
          { pattern: /^##\s+🏢\s+Moody/im, key: "corporate" },
          { pattern: /^##\s+🏦\s+Banking/im, key: "banking" },
          { pattern: /^##\s+🔍\s+Competitor/im, key: "competitors" },
          { pattern: /^##\s+🤖\s+Enterprise\s*AI/im, key: "aiTrends" },
          { pattern: /^##\s+📊\s+Industry\s*Analyst/im, key: "analysts" }
        ];
        const lines = briefContent.split("\n");
        let currentKey = null;
        for (const line of lines) {
          for (const { pattern, key } of sectionMap) {
            if (pattern.test(line)) {
              currentKey = key;
              break;
            }
          }
          if (/^##\s+⚡\s+Key\s+Takeaway/i.test(line) || /^##\s+🐦/i.test(line)) {
            currentKey = null;
            continue;
          }
          if (currentKey && /^-\s+.+/.test(line)) {
            if (categories[currentKey].length < MAX_PER_CAT) {
              let text = line.replace(/^-\s+/, "").replace(/🔴|🟡|🟢/g, "").replace(/\*\*/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
              if (text.length > 160) text = text.slice(0, 157) + "...";
              if (text) categories[currentKey].push(text);
            }
          }
        }
        let totalItems = Object.values(categories).reduce((s, a) => s + a.length, 0);
        if (totalItems === 0) {
          const catKeywords = [
            { pattern: /moody'?s\s*corporate/i, key: "corporate" },
            { pattern: /banking/i, key: "banking" },
            { pattern: /competitor/i, key: "competitors" },
            { pattern: /enterprise\s*ai/i, key: "aiTrends" },
            { pattern: /industry\s*analyst/i, key: "analysts" }
          ];
          const tableRows = briefContent.match(/^\|[^|]*\|[^|]*\|[^|]*\|/gm) || [];
          for (const row of tableRows) {
            const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
            if (cells.length < 3 || /^[#-]+$/.test(cells[0])) continue;
            const item = cells[1].replace(/\*\*/g, "").replace(/\(?\[.*?\]\(.*?\)\)?/g, "").trim();
            const catCell = cells[2];
            if (!item || !catCell || /^Category$/i.test(catCell) || /^-+$/.test(catCell)) continue;
            for (const { pattern, key } of catKeywords) {
              if (pattern.test(catCell)) {
                if (categories[key].length < MAX_PER_CAT) {
                  const clean = item.length > 160 ? item.slice(0, 157) + "..." : item;
                  categories[key].push(clean);
                }
                break;
              }
            }
          }
          totalItems = Object.values(categories).reduce((s, a) => s + a.length, 0);
        }
        if (totalItems === 0) {
          const bullets = briefContent.match(/^- .+$/gm) || [];
          for (const b of bullets.slice(0, 5)) {
            let text = b.replace(/^- /, "").replace(/\*\*/g, "").trim();
            if (text.length > 160) text = text.slice(0, 157) + "...";
            categories.corporate.push(text);
          }
          totalItems = categories.corporate.length;
        }
        const takeaways = briefContent.match(/^\d+\.\s+\*\*.+$/gm) || [];
        if (totalItems === 0 && takeaways.length === 0) {
          result.moodys = { available: false, reason: "unstructured", message: "Brief format not recognized" };
          return;
        }
        const tsMatch = briefContent.match(/Generated:\s*(.+)/);
        result.moodys = { available: true, date: briefDate, categories, timestamp: tsMatch ? tsMatch[1].trim() : null };
      } catch {
      }
    })());
    promises.push((async () => {
      try {
        const year = now.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
        const month = now.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
        const day = now.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
        const dateStr = `${year}-${month}-${day}`;
        let scanContent = null;
        let scanDate = dateStr;
        try {
          const content = await kbRead(`Scheduled Reports/Real Estate/${dateStr}-Property-Scan.md`);
          if (content) scanContent = content;
        } catch {
        }
        if (!scanContent) {
          const yesterday = new Date(now.getTime() - 864e5);
          const yDateStr = `${yesterday.toLocaleString("en-US", { timeZone: tz, year: "numeric" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, month: "2-digit" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, day: "2-digit" })}`;
          try {
            const content = await kbRead(`Scheduled Reports/Real Estate/${yDateStr}-Property-Scan.md`);
            if (content) {
              scanContent = content;
              scanDate = yDateStr;
            }
          } catch {
          }
        }
        if (scanContent) {
          const scannedMatch = scanContent.match(/\*\*(\d+)\+?\s*listings?\s*scanned\*\*/i);
          const totalListings = scannedMatch ? parseInt(scannedMatch[1]) : 0;
          const newMatch = scanContent.match(/\*\*(\d+)\s*new\s*listings?\*\*/i);
          const newListings = newMatch ? parseInt(newMatch[1]) : 0;
          const tsMatch = scanContent.match(/Generated:\s*(.+)/);
          result.realEstate = { available: true, date: scanDate, totalListings, newListings, scanTime: tsMatch ? tsMatch[1].trim() : null };
        }
      } catch {
      }
    })());
    promises.push((async () => {
      try {
        const active = await getActiveTasks();
        const today = now.toISOString().split("T")[0];
        const urgent = active.filter((t) => t.priority === "high" || t.dueDate && t.dueDate <= today);
        const urgentIds = new Set(urgent.map((t) => t.id));
        const rest = active.filter((t) => !urgentIds.has(t.id));
        const focusTasks = [...urgent, ...rest].slice(0, 3);
        let actionEmails = [];
        let actionCount = 0;
        try {
          if (isConnected()) {
            const [emails, countResult] = await Promise.all([
              searchEmailsStructured("label:Action-Required is:unread", 3),
              countUnread ? countUnread("label:Action-Required is:unread") : Promise.resolve(-1)
            ]);
            actionEmails = emails;
            actionCount = typeof countResult === "number" && countResult >= 0 ? countResult : emails.length;
          }
        } catch {
        }
        if (actionEmails.length > 0 && ANTHROPIC_KEY) {
          try {
            const { default: Anthropic5 } = await import("@anthropic-ai/sdk");
            const client = new Anthropic5({ apiKey: ANTHROPIC_KEY, timeout: 5e3 });
            const emailList = actionEmails.map(
              (e, i) => `[${i}] From: ${e.from} | Subject: ${e.subject}${e.snippet ? ` | Preview: ${e.snippet}` : ""}`
            ).join("\n");
            const response = await client.messages.create({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 500,
              messages: [{ role: "user", content: `For each email below, write a brief action insight (max 12 words) describing what the recipient likely needs to do.
Focus on the action: approve, reply, review, schedule, follow up, etc.
Return ONLY valid JSON array: [{"index":0,"insight":"..."}]

${emailList}` }],
              system: "You are a concise executive assistant. Return ONLY a JSON array, no other text."
            });
            const text = response.content.map((b) => b.type === "text" ? b.text : "").join("");
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
              const insights = JSON.parse(jsonMatch[0]);
              for (const ins of insights) {
                if (ins.index >= 0 && ins.index < actionEmails.length && ins.insight) {
                  const words = ins.insight.split(/\s+/);
                  actionEmails[ins.index].insight = words.length > 12 ? words.slice(0, 12).join(" ") : ins.insight;
                }
              }
            }
          } catch (err) {
            console.warn("[daily-brief] Email insight AI failed:", err.message);
          }
        }
        result.focusToday = { tasks: focusTasks, actionEmails, actionCount };
      } catch {
      }
    })());
    await Promise.all(promises);
    try {
      const etHourForCards = parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
      const cals = result.calendars || { rickin: [], pooja: [], reya: [], other: [] };
      const familyCards = [];
      const rickinCard = { name: "Rickin", emoji: "\u{1F468}\u200D\u{1F4BB}", headline: "", subtext: "" };
      const rickinEvents = [...cals.rickin || [], ...cals.other || []];
      if (etHourForCards < 12 && rickinEvents.length > 0) {
        const next = rickinEvents[0];
        rickinCard.headline = next.title || "Meeting";
        rickinCard.subtext = next.time || "";
      } else if (etHourForCards < 17 && result.focusToday) {
        const tc = result.focusToday.tasks?.length || 0;
        const ec = result.focusToday.actionCount || 0;
        rickinCard.headline = `${tc} task${tc !== 1 ? "s" : ""}, ${ec} email${ec !== 1 ? "s" : ""}`;
        rickinCard.subtext = "to action";
      } else if (rickinEvents.length > 0) {
        rickinCard.headline = rickinEvents[0].title || "Event tomorrow";
        rickinCard.subtext = rickinEvents[0].time || "";
      } else {
        rickinCard.headline = "";
        rickinCard.subtext = "";
      }
      familyCards.push(rickinCard);
      const poojaCard = { name: "Pooja", emoji: "\u{1F930}", headline: "", subtext: "" };
      if (result.baby) {
        if (etHourForCards < 12) {
          poojaCard.headline = `Week ${result.baby.weeksPregnant}`;
          poojaCard.subtext = `${result.baby.daysLeft} days to go`;
        } else if (result.baby.nextAppt) {
          poojaCard.headline = `Next appt: ${result.baby.nextAppt.date}`;
          poojaCard.subtext = result.baby.nextAppt.title || "";
        } else {
          poojaCard.headline = `Week ${result.baby.weeksPregnant}`;
          poojaCard.subtext = `${result.baby.daysLeft} days to go`;
        }
      }
      const poojaEvents = cals.pooja || [];
      if (!poojaCard.headline && poojaEvents.length > 0) {
        poojaCard.headline = poojaEvents[0].title || "Event";
        poojaCard.subtext = poojaEvents[0].time || "";
      }
      familyCards.push(poojaCard);
      const reyaCard = { name: "Reya", emoji: "\u{1F467}", headline: "", subtext: "" };
      if (result.reya && result.reya.schoolInSession) {
        if (etHourForCards < 12) {
          reyaCard.headline = result.reya.lunch || "School day";
          reyaCard.subtext = "Today's lunch";
        } else if (etHourForCards < 17) {
          reyaCard.headline = `Pickup ${result.reya.pickupCountdown}`;
          reyaCard.subtext = "4:30 PM";
        } else {
          reyaCard.headline = "School day done";
          reyaCard.subtext = result.reya.alert || "";
        }
      } else {
        const reyaEvents = cals.reya || [];
        if (reyaEvents.length > 0) {
          reyaCard.headline = reyaEvents[0].title || "Event";
          reyaCard.subtext = reyaEvents[0].time || "";
        } else if (result.reya && result.reya.isWeekend) {
          reyaCard.headline = "No school today!";
          reyaCard.subtext = "Enjoy the weekend!";
        }
      }
      familyCards.push(reyaCard);
      const needsTips = familyCards.filter((c) => !c.headline);
      if (needsTips.length > 0) {
        try {
          const tipPrompt = needsTips.map((c) => {
            if (c.name === "Rickin") return "A short productivity or market insight for a tech strategist";
            if (c.name === "Pooja") return `A pregnancy wellness tip for week ${result.baby?.weeksPregnant || 24}`;
            return "A fun fact or learning prompt for a 4-year-old girl";
          }).join("\n");
          const tipResp = await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 200,
            messages: [{ role: "user", content: `Generate ${needsTips.length} micro-tips (one per line, max 40 chars each, no numbering, no quotes):
${tipPrompt}` }]
          });
          const tips = tipResp.content[0].text.split("\n").filter((l) => l.trim());
          needsTips.forEach((c, i) => {
            c.headline = tips[i]?.trim().slice(0, 50) || "Have a great day!";
            c.subtext = "Daily tip";
          });
        } catch {
          needsTips.forEach((c) => {
            c.headline = "Have a great day!";
            c.subtext = "";
          });
        }
      }
      result.familyCards = familyCards;
    } catch {
    }
    try {
      const dayOfWeek = now.toLocaleString("en-US", { timeZone: tz, weekday: "long" });
      const cals = result.calendars || { rickin: [], pooja: [], reya: [], other: [] };
      const eventCount = cals.rickin.length + cals.pooja.length + cals.reya.length + (cals.other || []).length;
      const taskCount = result.tasks ? result.tasks.length : 0;
      result.welcomeMessage = await generateWelcomeMessage({
        greeting: result.greeting,
        dayOfWeek,
        tempC: result.weather?.tempC ?? null,
        condition: result.weather?.condition ?? null,
        taskCount,
        eventCount,
        babyWeeks: result.baby?.weeksPregnant ?? null
      });
    } catch {
      const dayOfWeek = now.toLocaleString("en-US", { timeZone: tz, weekday: "long" });
      result.welcomeMessage = `${result.greeting}, Rickin. Here's your brief for ${dayOfWeek}.`;
    }
    const allJobs = getJobs();
    const enabledJobs = allJobs.filter((j) => j.enabled);
    const okCount = enabledJobs.filter((j) => j.lastStatus === "success").length;
    const failedCount = enabledJobs.filter((j) => j.lastStatus === "error").length;
    result.jobs = { total: enabledJobs.length, ok: okCount, failed: failedCount };
    result.nextJob = getNextJob();
    dailyBriefCache = { data: result, ts: Date.now() };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch daily brief data" });
  }
});
var BABY_SHEET_ID2 = "1fhtMkDSTUlRCFqY4hQiSdZg7cOe4FYNkmOIIHWo4KSU";
var babyDashboardCache = null;
var BABY_CACHE_TTL = 6e4;
app.get("/api/baby-dashboard/data", async (_req, res) => {
  try {
    let parseRows2 = function(raw) {
      if (!raw || raw.includes("No data") || raw.includes("Error") || raw.includes("not connected")) return [];
      return raw.split("\n").filter((l) => l.startsWith("Row ")).map((l) => {
        const content = l.replace(/^Row \d+: /, "");
        return content.split(" | ");
      });
    };
    var parseRows = parseRows2;
    if (babyDashboardCache && Date.now() - babyDashboardCache.timestamp < BABY_CACHE_TTL) {
      res.json(babyDashboardCache.data);
      return;
    }
    if (!isConnected()) {
      res.status(503).json({ error: "google_disconnected", message: "Google not connected" });
      return;
    }
    const tabErrors = [];
    const readTab = async (range) => {
      try {
        const result2 = await sheetsRead(BABY_SHEET_ID2, range);
        if (result2.includes("Error") || result2.includes("not connected") || result2.includes("expired")) {
          tabErrors.push(range.split("!")[0]);
          return "";
        }
        return result2;
      } catch {
        tabErrors.push(range.split("!")[0]);
        return "";
      }
    };
    const [timelineResult, apptResult, tasksResult, shoppingResult, namesResult] = await Promise.all([
      readTab("Timeline!A1:F19"),
      readTab("Appointments!A1:E14"),
      readTab("To-Do List!A1:F23"),
      readTab("Shopping List!A1:F40"),
      readTab("Baby Names!A1:F16")
    ]);
    const timelineRows = parseRows2(timelineResult);
    let currentWeekData = null;
    const timelineWeeks = [];
    timelineRows.slice(1).forEach((r) => {
      const week = parseInt(r[0]?.trim()) || 0;
      const status = (r[5] || "").trim();
      const entry = {
        week,
        dates: r[1]?.trim() || "",
        trimester: r[2]?.trim() || "",
        development: r[3]?.trim() || "",
        rickin: r[4]?.trim() || "",
        status
      };
      timelineWeeks.push(entry);
      if (status.includes("\u2705") && status.toLowerCase().includes("current")) {
        currentWeekData = entry;
      }
    });
    const apptRows = parseRows2(apptResult);
    const appointments = apptRows.slice(1).filter((r) => r[0]).map((r) => {
      const status = (r[4] || "").trim();
      return {
        date: r[0]?.trim() || "",
        type: r[1]?.trim() || "",
        provider: r[2]?.trim() || "",
        notes: r[3]?.trim() || "",
        status,
        done: status.includes("\u2705")
      };
    });
    const taskRows = parseRows2(tasksResult);
    const tasks = taskRows.slice(1).filter((r) => r[0]).map((r) => {
      const status = (r[4] || "").trim();
      return {
        text: r[0]?.trim() || "",
        category: r[1]?.trim() || "",
        dueWeek: r[2]?.trim() || "",
        owner: r[3]?.trim() || "",
        status,
        notes: r[5]?.trim() || "",
        done: status.includes("\u2705"),
        inProgress: status.includes("\u{1F504}")
      };
    });
    const shoppingRows = parseRows2(shoppingResult);
    const shoppingItems = shoppingRows.slice(1).filter((r) => r[1]);
    const shopping = shoppingItems.map((r) => {
      const status = (r[3] || "").trim();
      return {
        category: r[0]?.trim() || "",
        item: r[1]?.trim() || "",
        priority: r[2]?.trim() || "",
        status,
        budget: r[4]?.trim() || "",
        notes: r[5]?.trim() || "",
        done: status.includes("\u2705"),
        inProgress: status.includes("\u{1F504}")
      };
    });
    const nameRows = parseRows2(namesResult);
    const favNames = [];
    const otherNames = [];
    nameRows.slice(1).filter((r) => r[0]).forEach((r) => {
      const nameVal = (r[0] || "").trim();
      if (nameVal === "\u2B50 FAVORITES" || nameVal === "\u{1F4CB} SHORTLIST" || !nameVal) return;
      const entry = {
        name: nameVal,
        meaning: r[1]?.trim() || "",
        origin: r[2]?.trim() || "",
        notes: r[5]?.trim() || ""
      };
      const rickinFav = (r[3] || "").trim();
      const poojaFav = (r[4] || "").trim();
      if (rickinFav.includes("\u2B50") || rickinFav.includes("\u{1F195}") || poojaFav.includes("\u2B50")) {
        favNames.push(entry);
      } else {
        otherNames.push(entry);
      }
    });
    const tasksDone = tasks.filter((t) => t.done).length;
    const shoppingDone = shopping.filter((s) => s.done).length;
    const apptsUpcoming = appointments.filter((a) => !a.done && !a.status.includes("\u{1F38A}")).length;
    const allFailed = tabErrors.length === 5;
    if (allFailed) {
      res.status(502).json({ error: "sheets_unavailable", message: "All sheet reads failed", errors: tabErrors });
      return;
    }
    const result = {
      timeline: { currentWeek: currentWeekData, weeks: timelineWeeks },
      appointments,
      tasks,
      shopping,
      names: { fav: favNames, other: otherNames },
      counters: {
        shoppingDone: `${shoppingDone}/${shoppingItems.length}`,
        tasksDone: `${tasksDone}/${tasks.length}`,
        apptsUpcoming
      },
      sync: {
        source: "live",
        partial: tabErrors.length > 0,
        errors: tabErrors
      },
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    babyDashboardCache = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (err) {
    console.error("[baby-dashboard] API error:", err.message);
    res.status(500).json({ error: "fetch_failed", message: "Failed to fetch dashboard data" });
  }
});
app.get("/api/baby-dashboard/status", async (_req, res) => {
  const connected = isConnected();
  let tokenValid = false;
  if (connected) {
    try {
      const token = await getAccessToken();
      tokenValid = !!token;
    } catch {
    }
  }
  res.json({
    googleConnected: connected,
    tokenValid,
    cacheAge: babyDashboardCache ? Math.round((Date.now() - babyDashboardCache.timestamp) / 1e3) : null,
    reconnectUrl: !tokenValid ? "/api/gmail/auth" : null
  });
});
app.get("/pages/:slug", async (req, res) => {
  const slug = req.params.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!slug) {
    res.status(400).send("Invalid page slug.");
    return;
  }
  const filePath = path7.join(PAGES_DIR, `${slug}.html`);
  if (!fs6.existsSync(filePath)) {
    res.status(404).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not Found</title><style>body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}h1{font-size:1.2rem;color:#888}</style></head><body><h1>Page not found.</h1></body></html>`);
    return;
  }
  const isTokenAuth = !!(req.query.user && req.query.token) || !!req.headers.authorization?.startsWith("Bearer ");
  if (slug === "wealth-engines") {
    try {
      let html = fs6.readFileSync(filePath, "utf-8");
      const data = await buildWealthEnginesDashboardData();
      const safeJson = JSON.stringify(data).replace(/<\//g, "<\\/");
      html = html.replace(
        "var SSR_DATA = null;",
        `var SSR_DATA = ${safeJson};`
      );
      res.type("html").send(html);
      return;
    } catch (err) {
      console.error("[wealth-engines] SSR error:", err);
    }
  }
  if (slug === "baby-dashboard" && isTokenAuth && isConnected()) {
    try {
      let html = fs6.readFileSync(filePath, "utf-8");
      let data = babyDashboardCache?.data;
      if (!data || Date.now() - (babyDashboardCache?.timestamp || 0) > BABY_CACHE_TTL) {
        let parseRows2 = function(raw) {
          if (!raw || raw.includes("No data")) return [];
          return raw.split("\n").filter((l) => l.startsWith("Row ")).map((l) => l.replace(/^Row \d+: /, "").split(" | "));
        };
        var parseRows = parseRows2;
        const readTab = async (range) => {
          try {
            const result = await sheetsRead(BABY_SHEET_ID2, range);
            if (result.includes("Error") || result.includes("not connected")) return "";
            return result;
          } catch {
            return "";
          }
        };
        const [timelineResult, apptResult, tasksResult, shoppingResult, namesResult] = await Promise.all([
          readTab("Timeline!A1:F19"),
          readTab("Appointments!A1:E14"),
          readTab("To-Do List!A1:F23"),
          readTab("Shopping List!A1:F40"),
          readTab("Baby Names!A1:F16")
        ]);
        const apptRows = parseRows2(apptResult);
        const appointments = apptRows.slice(1).filter((r) => r[0]).map((r) => ({
          title: (r[1] || "").trim(),
          date: (r[0] || "").trim(),
          time: "",
          detail: (r[3] || "").trim(),
          status: (r[4] || "").trim()
        }));
        const taskRows = parseRows2(tasksResult);
        const tasks = taskRows.slice(1).filter((r) => r[0]).map((r) => {
          const status = (r[4] || "").trim();
          return { text: (r[0] || "").trim(), priority: "medium", week: parseInt(r[2]) || 0, done: status.includes("\u2705"), owner: (r[3] || "").trim(), category: (r[1] || "").trim() };
        });
        const shoppingRows = parseRows2(shoppingResult);
        const shoppingItems = shoppingRows.slice(1).filter((r) => r[1]);
        const shoppingDone = shoppingItems.filter((r) => (r[3] || "").includes("\u2705")).length;
        const tasksDone = tasks.filter((t) => t.done).length;
        const timelineRows = parseRows2(timelineResult);
        let currentWeekData = null;
        timelineRows.slice(1).forEach((r) => {
          const status = (r[5] || "").trim();
          if (status.includes("\u2705") && status.toLowerCase().includes("current")) {
            currentWeekData = { week: parseInt(r[0]) || 0, development: (r[3] || "").trim(), rickin: (r[4] || "").trim() };
          }
        });
        const nameRows = parseRows2(namesResult);
        const favNames = [], otherNames = [];
        nameRows.slice(1).filter((r) => r[0]).forEach((r) => {
          const n = (r[0] || "").trim();
          if (n === "\u2B50 FAVORITES" || n === "\u{1F4CB} SHORTLIST" || !n) return;
          const entry = { name: n, meaning: (r[1] || "").trim() };
          if ((r[3] || "").includes("\u2B50") || (r[3] || "").includes("\u{1F195}") || (r[4] || "").includes("\u2B50")) favNames.push(entry);
          else otherNames.push(entry);
        });
        const apptJson = JSON.stringify(appointments);
        const tasksJson = JSON.stringify(tasks);
        const checklistJson = JSON.stringify({ shoppingDone: `${shoppingDone}/${shoppingItems.length}`, tasksDone: `${tasksDone}/${tasks.length}` });
        html = html.replace(/<script id="appt-data"[^>]*>.*?<\/script>/s, `<script id="appt-data" type="application/json">${apptJson}</script>`);
        html = html.replace(/<script id="tasks-data"[^>]*>.*?<\/script>/s, `<script id="tasks-data" type="application/json">${tasksJson}</script>`);
        html = html.replace(/<script id="checklist-data"[^>]*>.*?<\/script>/s, `<script id="checklist-data" type="application/json">${checklistJson}</script>`);
        if (currentWeekData) {
          html = html.replace(/id="devNote">[^<]*</s, `id="devNote">${currentWeekData.development}<`);
          html = html.replace(/id="milestoneNote">[^<]*</s, `id="milestoneNote">${currentWeekData.milestone}<`);
        }
        if (favNames.length) {
          const favStr = favNames.map((n) => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${n.meaning.replace(/'/g, "\\'")}'}`).join(",");
          html = html.replace(/var defaultFavNames\s*=\s*\[.*?\];/s, `var defaultFavNames = [${favStr}];`);
        }
        if (otherNames.length) {
          const otherStr = otherNames.map((n) => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${n.meaning.replace(/'/g, "\\'")}'}`).join(",");
          html = html.replace(/var defaultOtherNames\s*=\s*\[.*?\];/s, `var defaultOtherNames = [${otherStr}];`);
        }
      } else {
        const apptJson = JSON.stringify((data.appointments || []).map((a) => ({
          title: a.type || a.title,
          date: a.date,
          time: a.time || "",
          detail: a.notes || a.detail || "",
          status: a.status || ""
        })));
        const tasksJson = JSON.stringify((data.tasks || []).map((t) => ({
          text: t.text,
          priority: "medium",
          week: parseInt(t.dueWeek) || 0,
          done: t.done,
          owner: t.owner || "",
          category: t.category || ""
        })));
        const checklistJson = JSON.stringify(data.counters || {});
        html = html.replace(/<script id="appt-data"[^>]*>.*?<\/script>/s, `<script id="appt-data" type="application/json">${apptJson}</script>`);
        html = html.replace(/<script id="tasks-data"[^>]*>.*?<\/script>/s, `<script id="tasks-data" type="application/json">${tasksJson}</script>`);
        html = html.replace(/<script id="checklist-data"[^>]*>.*?<\/script>/s, `<script id="checklist-data" type="application/json">${checklistJson}</script>`);
        if (data.timeline?.currentWeek) {
          html = html.replace(/id="devNote">[^<]*</s, `id="devNote">${data.timeline.currentWeek.development || ""}<`);
          html = html.replace(/id="milestoneNote">[^<]*</s, `id="milestoneNote">${data.timeline.currentWeek.milestone || ""}<`);
        }
        if (data.names?.fav?.length) {
          const favStr = data.names.fav.map((n) => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${(n.meaning || "").replace(/'/g, "\\'")}'}`).join(",");
          html = html.replace(/var defaultFavNames\s*=\s*\[.*?\];/s, `var defaultFavNames = [${favStr}];`);
        }
        if (data.names?.other?.length) {
          const otherStr = data.names.other.map((n) => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${(n.meaning || "").replace(/'/g, "\\'")}'}`).join(",");
          html = html.replace(/var defaultOtherNames\s*=\s*\[.*?\];/s, `var defaultOtherNames = [${otherStr}];`);
        }
      }
      res.type("html").send(html);
      return;
    } catch (err) {
      console.error("[baby-dashboard] SSR error:", err);
    }
  }
  res.sendFile(filePath);
});
app.post("/api/pages/:slug/share", async (req, res) => {
  const slug = req.params.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!["daily-brief", "baby-dashboard", "x-intelligence", "wealth-engines"].includes(slug)) {
    res.status(400).json({ error: "Sharing not supported for this page" });
    return;
  }
  try {
    const filePath = path7.join(PAGES_DIR, `${slug}.html`);
    if (!fs6.existsSync(filePath)) {
      res.status(404).json({ error: "Page not found" });
      return;
    }
    let html = fs6.readFileSync(filePath, "utf-8");
    const now = /* @__PURE__ */ new Date();
    const cfg = getConfig();
    const tz = cfg.timezone || "America/New_York";
    const snapTime = now.toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
    const titleDate = now.toLocaleDateString("en-US", { timeZone: tz, month: "long", day: "numeric", year: "numeric" });
    if (slug === "daily-brief") {
      let data = dailyBriefCache?.data;
      if (!data) {
        try {
          const resp = await fetch(`http://localhost:${process.env.PORT || 5e3}/api/daily-brief/data?user=darknode&token=${encodeURIComponent(process.env.APP_PASSWORD || "")}`);
          if (resp.ok) data = await resp.json();
        } catch {
        }
      }
      if (!data) {
        res.status(500).json({ error: "Could not fetch daily brief data" });
        return;
      }
      const dataJson = JSON.stringify(data);
      html = html.replace(
        /fetchData\(\);\s*setInterval\(fetchData,\s*\d+\);/,
        `var SNAPSHOT_DATA = ${dataJson};
render(SNAPSHOT_DATA);`
      );
      html = html.replace(/<button[^>]*onclick="fetchData\(true\)"[^>]*>Refresh<\/button>/g, "");
    } else if (slug === "baby-dashboard") {
      if (isConnected()) {
        try {
          let parseRows2 = function(raw) {
            if (!raw || raw.includes("No data")) return [];
            return raw.split("\n").filter((l) => l.startsWith("Row ")).map((l) => l.replace(/^Row \d+: /, "").split(" | "));
          };
          var parseRows = parseRows2;
          const readTab = async (range) => {
            try {
              const result = await sheetsRead(BABY_SHEET_ID2, range);
              if (result.includes("Error") || result.includes("not connected")) return "";
              return result;
            } catch {
              return "";
            }
          };
          const [timelineResult, apptResult, tasksResult, shoppingResult, namesResult] = await Promise.all([
            readTab("Timeline!A1:F19"),
            readTab("Appointments!A1:E14"),
            readTab("To-Do List!A1:F23"),
            readTab("Shopping List!A1:F40"),
            readTab("Baby Names!A1:F16")
          ]);
          const apptRows = parseRows2(apptResult);
          const appointments = apptRows.slice(1).filter((r) => r[0]).map((r) => ({
            title: (r[1] || "").trim(),
            date: (r[0] || "").trim(),
            time: "",
            detail: (r[3] || "").trim(),
            status: (r[4] || "").trim()
          }));
          const taskRows = parseRows2(tasksResult);
          const tasks = taskRows.slice(1).filter((r) => r[0]).map((r) => {
            const status = (r[4] || "").trim();
            return { text: (r[0] || "").trim(), priority: "medium", week: parseInt(r[2]) || 0, done: status.includes("\u2705"), owner: (r[3] || "").trim(), category: (r[1] || "").trim() };
          });
          const shoppingRows = parseRows2(shoppingResult);
          const shoppingItems = shoppingRows.slice(1).filter((r) => r[1]);
          const shoppingDone = shoppingItems.filter((r) => (r[3] || "").includes("\u2705")).length;
          const tasksDone = tasks.filter((t) => t.done).length;
          const apptJson = JSON.stringify(appointments);
          const tasksJson = JSON.stringify(tasks);
          const checklistJson = JSON.stringify({ shoppingDone: `${shoppingDone}/${shoppingItems.length}`, tasksDone: `${tasksDone}/${tasks.length}` });
          html = html.replace(/<script id="appt-data"[^>]*>.*?<\/script>/s, `<script id="appt-data" type="application/json">${apptJson}</script>`);
          html = html.replace(/<script id="tasks-data"[^>]*>.*?<\/script>/s, `<script id="tasks-data" type="application/json">${tasksJson}</script>`);
          html = html.replace(/<script id="checklist-data"[^>]*>.*?<\/script>/s, `<script id="checklist-data" type="application/json">${checklistJson}</script>`);
          const timelineRows = parseRows2(timelineResult);
          let currentWeekData = null;
          timelineRows.slice(1).forEach((r) => {
            const status = (r[5] || "").trim();
            if (status.includes("\u2705") && status.toLowerCase().includes("current")) {
              currentWeekData = { week: parseInt(r[0]) || 0, development: (r[3] || "").trim(), rickin: (r[4] || "").trim() };
            }
          });
          if (currentWeekData) {
            html = html.replace(/id="devNote">[^<]*</s, `id="devNote">${currentWeekData.development}<`);
          }
          const nameRows = parseRows2(namesResult);
          const favNames = [], otherNames = [];
          nameRows.slice(1).filter((r) => r[0]).forEach((r) => {
            const n = (r[0] || "").trim();
            if (n === "\u2B50 FAVORITES" || n === "\u{1F4CB} SHORTLIST" || !n) return;
            const entry = { name: n, meaning: (r[1] || "").trim() };
            if ((r[3] || "").includes("\u2B50") || (r[3] || "").includes("\u{1F195}") || (r[4] || "").includes("\u2B50")) favNames.push(entry);
            else otherNames.push(entry);
          });
          if (favNames.length) {
            const favStr = favNames.map((n) => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${n.meaning.replace(/'/g, "\\'")}'}`).join(",");
            html = html.replace(/var defaultFavNames\s*=\s*\[.*?\];/s, `var defaultFavNames = [${favStr}];`);
          }
          if (otherNames.length) {
            const otherStr = otherNames.map((n) => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${n.meaning.replace(/'/g, "\\'")}'}`).join(",");
            html = html.replace(/var defaultOtherNames\s*=\s*\[.*?\];/s, `var defaultOtherNames = [${otherStr}];`);
          }
        } catch (err) {
          console.error("[share] baby-dashboard SSR error:", err);
        }
      }
      html = html.replace(
        /fetchLiveData\(\);\s*setInterval\(fetchLiveData,\s*\d+\);/,
        "// snapshot mode - no live fetching"
      );
      html = html.replace(/\(async function loadUser\(\)[\s\S]*?\}\)\(\);/, "// snapshot mode");
    } else if (slug === "wealth-engines") {
      try {
        const weData = await buildWealthEnginesDashboardData();
        const safeJson = JSON.stringify(weData).replace(/<\//g, "<\\/");
        html = html.replace(
          "var SSR_DATA = null;",
          `var SSR_DATA = ${safeJson};`
        );
      } catch (err) {
        console.error("[share] wealth-engines data error:", err);
      }
      html = html.replace(/setInterval\(function\(\)\s*\{\s*fetchData\(\);\s*\}\s*,\s*\d+\);/, "");
      html = html.replace(/id="refreshBtn"[^>]*>[^<]*<\/button>/g, 'id="refreshBtn" style="display:none"></button>');
      html = html.replace(/id="shareBtn"[^>]*>[^<]*<\/button>/g, 'id="shareBtn" style="display:none"></button>');
      html = html.replace(/id="shareModal"/, 'id="shareModal" style="display:none !important"');
    } else if (slug === "x-intelligence") {
      let xData = xIntelCache?.data || dailyBriefCache?.data?.xIntel;
      if (!xData) {
        try {
          xData = await fetchXIntelData();
          xIntelCache = { data: xData, ts: Date.now() };
        } catch {
        }
      }
      if (!xData) {
        res.status(500).json({ error: "Could not fetch X intelligence data" });
        return;
      }
      const dataJson = JSON.stringify(xData);
      html = html.replace(
        /fetchData\(\);\s*setInterval\(fetchData,\s*\d+\);/,
        `var SNAPSHOT_DATA = ${dataJson};
render(SNAPSHOT_DATA);`
      );
      html = html.replace(/<button[^>]*onclick="fetchData\(true\)"[^>]*>Refresh<\/button>/g, "");
    }
    html = html.replace(/<div class="share-btn-wrap">.*?<\/div>/gs, "");
    html = html.replace(/<div class="share-overlay"[^]*?<!-- \/share-overlay -->/g, "");
    html = html.replace(/function shareSnapshot\(\)[^]*?function copyShareUrl\(\)[^]*?\n\}/g, "");
    const snapshotFooter = `<div style="text-align:center;color:#555;font-size:0.65rem;padding:1.5rem 1rem 2rem;line-height:1.6;font-family:-apple-system,sans-serif;">
      <div style="margin-bottom:2px;">\u{1F4F8} Snapshot \xB7 ${snapTime}</div>
      <div style="color:#444;">This link expires in 24 hours</div>
    </div>`;
    html = html.replace(/<\/body>/, `${snapshotFooter}
</body>`);
    const tmpFile = `/tmp/snapshot-${slug}-${Date.now()}.html`;
    fs6.writeFileSync(tmpFile, html);
    const publishScript = path7.join(PROJECT_ROOT, "scripts", "herenow-publish.sh");
    const titleStr = slug === "daily-brief" ? `Daily Brief \u2014 ${titleDate}` : slug === "x-intelligence" ? `X Intelligence \u2014 ${titleDate}` : `Baby Dashboard \u2014 ${titleDate}`;
    const output = execSync(`bash "${publishScript}" "${tmpFile}" --title "${titleStr}" --client "darknode"`, {
      encoding: "utf-8",
      timeout: 3e4
    });
    try {
      fs6.unlinkSync(tmpFile);
    } catch {
    }
    const lines = output.trim().split("\n");
    const url = lines[0]?.trim();
    if (!url || !url.startsWith("http")) {
      res.status(500).json({ error: "Failed to publish snapshot" });
      return;
    }
    console.log(`[share] Published ${slug} snapshot: ${url}`);
    res.json({ url, expiresIn: "24h" });
  } catch (err) {
    console.error("[share] Error:", err);
    res.status(500).json({ error: err.message || "Failed to generate snapshot" });
  }
});
app.get("/api/gmail/auth", (_req, res) => {
  if (!isConfigured3()) {
    res.status(500).json({ error: "Gmail not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET." });
    return;
  }
  const url = getAuthUrl();
  res.redirect(url);
});
app.get("/api/gmail/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) {
    res.status(400).send("Missing authorization code.");
    return;
  }
  try {
    await handleCallback(code);
    res.send(`<html><body style="background:#000;color:#0f0;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>[GMAIL CONNECTED]</h2><p>Authorization successful. You can close this tab.</p><script>setTimeout(()=>window.close(),2000)</script></div></body></html>`);
  } catch (err) {
    console.error("Gmail callback error:", err);
    res.status(500).send("Gmail authorization failed. Please try again.");
  }
});
app.get("/api/gmail/status", async (_req, res) => {
  const status = {
    configured: isConfigured3(),
    connected: isConnected()
  };
  if (status.connected) {
    try {
      status.email = await getConnectedEmail();
    } catch {
    }
  }
  res.json(status);
});
var cachedStaticTools = [
  ...buildGmailTools(),
  ...buildCalendarTools(),
  ...buildWeatherTools(),
  ...buildSearchTools(),
  ...buildWebFetchTools(),
  ...buildImageTools(),
  ...buildRenderPageTools(),
  ...buildTaskTools(),
  ...buildNewsTools(),
  ...buildTwitterTools(),
  ...buildStockTools(),
  ...buildCoinGeckoTools(),
  ...buildSignalSourceTools(),
  ...buildMapsTools(),
  ...buildDriveTools(),
  ...buildSheetsTools(),
  ...buildDocsTools(),
  ...buildSlidesTools(),
  ...buildYouTubeTools(),
  ...buildRealEstateTools(),
  ...buildConversationTools(),
  ...buildMemoryTools(),
  ...buildWebPublishTools(),
  ...buildOversightTools()
];
{
  const kbToolNames = buildKnowledgeBaseTools().map((t) => t.name);
  const staticToolNames = cachedStaticTools.map((t) => t.name);
  setRegisteredTools([...kbToolNames, ...staticToolNames]);
}
app.post("/api/session", async (req, res) => {
  try {
    const { resumeConversationId } = req.body || {};
    const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const authStorage = AuthStorage.create(path7.join(AGENT_DIR, "auth.json"));
    authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_KEY);
    const modelRegistry = new ModelRegistry(authStorage, path7.join(AGENT_DIR, "models.json"));
    const fullModel = modelRegistry.find("anthropic", FULL_MODEL_ID);
    if (!fullModel) throw new Error(`Model ${FULL_MODEL_ID} not found in registry`);
    const coreTools = [
      ...buildKnowledgeBaseTools(),
      ...cachedStaticTools,
      ...buildInterviewTool(sessionId)
    ];
    const allTools = [
      ...coreTools,
      ...buildAgentTools(() => coreTools, sessionId)
    ];
    console.log(`[session] ${allTools.length} tools registered`);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: PROJECT_ROOT,
      agentDir: AGENT_DIR,
      settingsManager,
      noSkills: true,
      noExtensions: true
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      agentDir: AGENT_DIR,
      authStorage,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      resourceLoader,
      modelRegistry,
      model: fullModel,
      tools: [],
      customTools: allTools
    });
    const conv = createConversation(sessionId);
    let resumedMessages = [];
    if (resumeConversationId) {
      const oldConv = await load(resumeConversationId);
      if (oldConv && oldConv.messages.length > 0) {
        for (const msg of oldConv.messages) {
          addMessage(conv, msg.role, msg.text);
        }
        resumedMessages = oldConv.messages;
        conv.title = oldConv.title;
        console.log(`[session] Resuming conversation "${oldConv.title}" with ${oldConv.messages.length} messages`);
        await remove(resumeConversationId);
      }
    }
    const entry = {
      session,
      subscribers: /* @__PURE__ */ new Set(),
      createdAt: Date.now(),
      conversation: conv,
      currentAgentText: "",
      currentToolName: null,
      modelMode: "auto",
      planningMode: false,
      activeModelName: FULL_MODEL_ID,
      isAgentRunning: false,
      pendingMessages: []
    };
    sessions.set(sessionId, entry);
    session.subscribe((event) => {
      const data = JSON.stringify(event);
      for (const sub of entry.subscribers) {
        try {
          sub.write(`data: ${data}

`);
        } catch {
        }
      }
      if (event.type === "message_update") {
        const ae = event.assistantMessageEvent;
        if (ae?.type === "text_delta" && ae.delta) {
          entry.currentAgentText += ae.delta;
        }
      }
      if (event.type === "tool_execution_start") {
        const toolName = event.toolName || null;
        if (toolName === "delegate" && event.input) {
          const agentId = event.input.agent || "";
          entry.currentToolName = `delegate:${agentId}`;
          event.toolInput = { agent: agentId };
        } else {
          entry.currentToolName = toolName;
        }
      } else if (event.type === "tool_execution_end") {
        entry.currentToolName = null;
      }
      if (event.type === "agent_end") {
        entry.isAgentRunning = false;
        entry.currentToolName = null;
        if (entry.currentAgentText) {
          addMessage(entry.conversation, "agent", entry.currentAgentText);
          entry.currentAgentText = "";
        }
        save(entry.conversation).catch((err) => console.error("[conversations] save error:", err));
        syncConversationToVault(entry.conversation);
        const nonSystem = entry.conversation.messages.filter((m) => m.role !== "system");
        if (nonSystem.length >= 2 && nonSystem.length <= 4) {
          generateTitle(entry.conversation).then((title) => {
            if (title) {
              save(entry.conversation).catch((err) => console.error("[conversations] title save error:", err));
            }
          }).catch((err) => console.warn("[conversations] title generation error:", err));
        }
        processNextPendingMessage(sessionId);
      }
    });
    let combinedContext;
    if (resumeConversationId && resumedMessages.length > 0) {
      const lastN = resumedMessages.slice(-20);
      const formatted = lastN.map((m) => {
        const role = m.role === "user" ? "RICKIN" : m.role === "agent" ? "YOU" : "SYSTEM";
        const text = m.text.length > 800 ? m.text.slice(0, 800) + "\u2026" : m.text;
        return `${role}: ${text}`;
      }).join("\n\n");
      const resumeContext = `[RESUMED CONVERSATION: "${conv.title}"]
Rickin is picking up exactly where you left off. This is a continuation \u2014 treat any references like "it", "that", "this" as referring to the topic below. Here are the last ${lastN.length} messages:

${formatted}

IMPORTANT: When Rickin says something brief like "test it", "try again", "do it", etc., it refers to whatever you were last discussing above. Do NOT start a new unrelated topic.`;
      const vaultIndex = await getVaultIndex();
      combinedContext = [resumeContext, vaultIndex].filter(Boolean).join("\n\n---\n\n");
    } else {
      const recentSummary = await getRecentSummary(5);
      const lastConvoContext = await getLastConversationContext(10);
      const vaultIndex = await getVaultIndex();
      let hindsightContext = null;
      if (isConfigured8()) {
        try {
          const memResult = await recall({ query: "What has Rickin been working on and talking about recently? Important decisions, preferences, and context.", topK: 8 });
          if (memResult.memories.length > 0) {
            const memLines = memResult.memories.map((m) => `- ${m.text}`).join("\n");
            hindsightContext = `[Long-term Memory Context]
Relevant memories from past sessions:
${memLines}`;
          }
        } catch (err) {
          console.warn("[session] Hindsight recall for greeting failed:", err);
        }
      }
      combinedContext = [lastConvoContext, recentSummary, hindsightContext, vaultIndex].filter(Boolean).join("\n\n---\n\n") || null;
    }
    entry.startupContext = combinedContext || void 0;
    res.json({ sessionId, recentContext: combinedContext, messages: resumedMessages });
  } catch (err) {
    console.error("Failed to create session:", err);
    res.status(500).json({ error: String(err) });
  }
});
app.get("/api/session/:id/stream", (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ type: "ping" })}

`);
  }, 15e3);
  entry.subscribers.add(res);
  req.on("close", () => {
    clearInterval(heartbeat);
    entry.subscribers.delete(res);
    if (entry.subscribers.size === 0 && entry.isAgentRunning && entry.currentAgentText) {
      console.log(`[sse] All subscribers dropped while agent running \u2014 saving partial text (${entry.currentAgentText.length} chars)`);
      addMessage(entry.conversation, "agent", entry.currentAgentText + "\n\n\u26A0\uFE0F *Connection dropped \u2014 response may be incomplete. Ask me to continue if needed.*");
      entry.currentAgentText = "";
      save(entry.conversation).catch((err) => console.error("[conversations] partial save error:", err));
    }
  });
});
app.get("/api/session/:id/status", (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.json({ alive: false });
    return;
  }
  res.json({
    alive: true,
    agentRunning: entry.isAgentRunning,
    currentAgentText: entry.currentAgentText,
    currentToolName: entry.currentToolName,
    messages: entry.conversation.messages,
    pendingCount: entry.pendingMessages.length,
    pendingInterview: entry.pendingInterviewForm || null
  });
});
app.post("/api/session/:id/prompt", async (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const { message, images } = req.body;
  if (!message?.trim() && (!images || images.length === 0)) {
    res.status(400).json({ error: "message or images required" });
    return;
  }
  const ALLOWED_MIME = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const MAX_IMAGES = 5;
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  if (images && images.length > MAX_IMAGES) {
    res.status(400).json({ error: `Maximum ${MAX_IMAGES} images allowed` });
    return;
  }
  if (images) {
    for (const img of images) {
      if (!ALLOWED_MIME.has(img.mimeType)) {
        res.status(400).json({ error: `Unsupported image type: ${img.mimeType}` });
        return;
      }
      const sizeBytes = Math.ceil(img.data.length * 3 / 4);
      if (sizeBytes > MAX_IMAGE_BYTES) {
        res.status(400).json({ error: "Image too large (max 10MB)" });
        return;
      }
    }
  }
  const text = message?.trim() || "(image attached)";
  const imgAttachments = images?.map((i) => ({ mimeType: i.mimeType, data: i.data }));
  addMessage(entry.conversation, "user", text, imgAttachments);
  await save(entry.conversation);
  if (entry.isAgentRunning) {
    entry.pendingMessages.push({ text, images, timestamp: Date.now() });
    const queuedEvent = JSON.stringify({ type: "message_queued", position: entry.pendingMessages.length });
    for (const sub of entry.subscribers) {
      try {
        sub.write(`data: ${queuedEvent}

`);
      } catch {
      }
    }
    res.json({ ok: true, queued: true, position: entry.pendingMessages.length });
    return;
  }
  let chosenModelId = FULL_MODEL_ID;
  const hasImages = images && images.length > 0;
  if (entry.modelMode === "max") {
    chosenModelId = MAX_MODEL_ID;
  } else if (hasImages) {
    chosenModelId = FULL_MODEL_ID;
  } else if (entry.modelMode === "fast") {
    chosenModelId = FAST_MODEL_ID;
  } else if (entry.modelMode === "auto") {
    const intent = classifyIntent(text);
    chosenModelId = intent === "fast" ? FAST_MODEL_ID : intent === "max" ? MAX_MODEL_ID : FULL_MODEL_ID;
  }
  if (chosenModelId !== entry.activeModelName) {
    try {
      const authStorage = AuthStorage.create(path7.join(AGENT_DIR, "auth.json"));
      authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_KEY);
      const modelRegistry = new ModelRegistry(authStorage, path7.join(AGENT_DIR, "models.json"));
      const newModel = modelRegistry.find("anthropic", chosenModelId);
      if (newModel) {
        await entry.session.setModel(newModel);
        entry.activeModelName = chosenModelId;
      } else {
        console.warn(`[model] ${chosenModelId} not found, staying on ${entry.activeModelName}`);
        chosenModelId = entry.activeModelName;
      }
    } catch (err) {
      console.error(`[model] Failed to switch to ${chosenModelId}:`, err);
      chosenModelId = entry.activeModelName;
    }
  }
  const modelEvent = JSON.stringify({ type: "model_info", model: entry.activeModelName });
  for (const sub of entry.subscribers) {
    try {
      sub.write(`data: ${modelEvent}

`);
    } catch {
    }
  }
  res.json({ ok: true });
  entry.isAgentRunning = true;
  entry.currentAgentText = "";
  const startEvent = JSON.stringify({ type: "agent_start" });
  for (const sub of entry.subscribers) {
    try {
      sub.write(`data: ${startEvent}

`);
    } catch {
    }
  }
  if (hasImages) {
    const totalB64 = images.reduce((sum, i) => sum + i.data.length, 0);
    const mimeTypes = images.map((i) => i.mimeType).join(", ");
    console.log(`[prompt] ${images.length} image(s), ~${Math.round(totalB64 / 1024)}KB base64, types: ${mimeTypes}`);
  }
  const promptStart = Date.now();
  const sessionId = req.params["id"];
  const etNow = (/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
  let augmentedText = `[Current date/time in Rickin's timezone (Eastern): ${etNow}]

`;
  if (entry.startupContext) {
    augmentedText += `[Session Context]
${entry.startupContext}

`;
    entry.startupContext = void 0;
  }
  if (entry.planningMode) {
    augmentedText += `[PLANNING MODE] Before taking any action or calling any tools, you must first present a clear, numbered plan of what you intend to do. Explain each step briefly. Then ask for my approval before proceeding. Do NOT execute any tools or actions until I explicitly confirm the plan (e.g. "go ahead", "yes", "approved", "do it"). If I ask you to modify the plan, revise it and ask for approval again.

`;
  }
  augmentedText += text;
  const promptImages = images?.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
  const PROMPT_TIMEOUT = 9e5;
  const actualPromise = entry.session.prompt(augmentedText, promptImages ? { images: promptImages } : void 0);
  const timeoutPromise = new Promise(
    (_, reject) => setTimeout(() => reject(new Error("Response timed out after 15 minutes")), PROMPT_TIMEOUT)
  );
  try {
    await Promise.race([actualPromise, timeoutPromise]);
    console.log(`[prompt] completed in ${((Date.now() - promptStart) / 1e3).toFixed(1)}s`);
    entry.isAgentRunning = false;
    entry.currentToolName = null;
    processNextPendingMessage(sessionId);
  } catch (err) {
    const elapsed = ((Date.now() - promptStart) / 1e3).toFixed(1);
    const isTimeout = String(err).includes("timed out");
    console.error(`[prompt] ${isTimeout ? "timeout" : "error"} after ${elapsed}s:`, err);
    const errEvent = JSON.stringify({ type: isTimeout ? "timeout" : "error", error: String(err) });
    for (const sub of entry.subscribers) {
      try {
        sub.write(`data: ${errEvent}

`);
      } catch {
      }
    }
    if (isTimeout) {
      console.log(`[prompt] agent still running in background \u2014 new messages will be queued`);
      actualPromise.then(() => {
        console.log(`[prompt] background prompt finally completed after ${((Date.now() - promptStart) / 1e3).toFixed(1)}s total`);
        entry.isAgentRunning = false;
        entry.currentToolName = null;
        processNextPendingMessage(sessionId);
      }).catch(() => {
        console.log(`[prompt] background prompt failed after ${((Date.now() - promptStart) / 1e3).toFixed(1)}s total`);
        entry.isAgentRunning = false;
        entry.currentToolName = null;
        processNextPendingMessage(sessionId);
      });
    } else {
      entry.isAgentRunning = false;
      entry.currentToolName = null;
    }
  }
});
app.put("/api/session/:id/model-mode", (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const { mode } = req.body;
  if (!mode || !["auto", "fast", "full", "max"].includes(mode)) {
    res.status(400).json({ error: "mode must be auto, fast, full, or max" });
    return;
  }
  entry.modelMode = mode;
  console.log(`[model] Session ${req.params["id"]} mode set to: ${mode}`);
  res.json({ ok: true, mode, activeModel: entry.activeModelName });
});
app.get("/api/session/:id/model-mode", (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({ mode: entry.modelMode, activeModel: entry.activeModelName });
});
app.put("/api/session/:id/planning-mode", (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const { enabled } = req.body;
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "enabled must be a boolean" });
    return;
  }
  entry.planningMode = enabled;
  console.log(`[planning] Session ${req.params["id"]} planning mode: ${enabled}`);
  res.json({ ok: true, planningMode: enabled });
});
app.get("/api/session/:id/planning-mode", (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({ planningMode: entry.planningMode });
});
app.post("/api/session/:id/interview-response", (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const { responses } = req.body;
  if (!responses || !Array.isArray(responses)) {
    res.status(400).json({ error: "responses array required" });
    return;
  }
  if (entry.interviewWaiter) {
    clearTimeout(entry.interviewWaiter.timer);
    entry.interviewWaiter.resolve(responses);
    entry.interviewWaiter = void 0;
    entry.pendingInterviewForm = void 0;
    console.log(`[interview] Received ${responses.length} responses for session ${req.params["id"]}`);
    res.json({ ok: true });
  } else {
    res.status(410).json({ error: "Form expired or already submitted" });
  }
});
app.delete("/api/session/:id", async (req, res) => {
  await saveAndCleanSession(req.params["id"]);
  res.json({ ok: true });
});
app.get("/api/conversations/search", async (req, res) => {
  const q = req.query["q"] || "";
  if (!q.trim()) {
    res.json([]);
    return;
  }
  const before = req.query["before"] ? Number(req.query["before"]) : void 0;
  const after = req.query["after"] ? Number(req.query["after"]) : void 0;
  const results = await search(q, { before, after });
  res.json(results);
});
app.get("/api/conversations", async (_req, res) => {
  res.json(await list());
});
app.get("/api/conversations/:id", async (req, res) => {
  const conv = await load(req.params["id"]);
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.json(conv);
});
app.delete("/api/conversations/:id", async (req, res) => {
  await remove(req.params["id"]);
  res.json({ ok: true });
});
app.get("/api/tasks", async (_req, res) => {
  try {
    const active = await getActiveTasks();
    res.json(active);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.post("/api/tasks", async (req, res) => {
  try {
    const { title, priority, dueDate } = req.body;
    if (!title || !title.trim()) {
      res.status(400).json({ error: "title required" });
      return;
    }
    await addTask(title.trim(), { priority, dueDate });
    glanceCache = null;
    const active = await getActiveTasks();
    const created = active.find((t) => t.title === title.trim());
    res.json({ ok: true, task: created || { title: title.trim(), priority: priority || "medium", dueDate } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.patch("/api/tasks/:id/complete", async (req, res) => {
  try {
    const result = await completeTask(req.params["id"]);
    glanceCache = null;
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.delete("/api/tasks/:id", async (req, res) => {
  try {
    const result = await deleteTask(req.params["id"]);
    glanceCache = null;
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.get("/api/tasks/completed", async (_req, res) => {
  try {
    const completed = await getCompletedTasks();
    res.json(completed);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.get("/api/agents/status", async (_req, res) => {
  const runningJob = getRunningJob();
  const activeSessions = [];
  for (const [id, entry] of sessions.entries()) {
    if (entry.isAgentRunning) {
      activeSessions.push({
        id,
        running: true,
        tool: entry.currentToolName || void 0,
        conversationId: entry.conversation?.id,
        conversationTitle: entry.conversation?.title
      });
    }
  }
  let recentCompletions = [];
  try {
    const pool2 = getPool();
    const result = await pool2.query(`SELECT agent, task, conversation_id, conversation_title, duration_ms, saved_to, created_at FROM agent_activity ORDER BY created_at DESC LIMIT 5`);
    recentCompletions = result.rows.map((r) => ({
      timestamp: Number(r.created_at),
      agent: r.agent,
      task: r.task,
      conversationId: r.conversation_id,
      conversationTitle: r.conversation_title,
      duration: r.duration_ms,
      savedTo: r.saved_to
    }));
  } catch (e) {
    console.warn("[agent_activity] DB query failed:", e.message);
  }
  res.json({
    job: runningJob,
    sessions: activeSessions,
    anyActive: runningJob.running || activeSessions.length > 0,
    recentCompletions
  });
});
app.post("/api/vault-inbox", async (req, res) => {
  const { url, tag, source } = req.body;
  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "URL is required" });
    return;
  }
  try {
    new URL(url);
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }
  const pool2 = getPool();
  try {
    const existing = await pool2.query(`SELECT id, title, file_path, tags, status, created_at FROM vault_inbox WHERE url = $1`, [url]);
    if (existing.rows.length > 0 && existing.rows[0].status === "filed") {
      const row = existing.rows[0];
      res.json({
        status: "duplicate",
        title: row.title,
        filePath: row.file_path,
        tags: row.tags || [],
        filedAt: Number(row.created_at)
      });
      return;
    }
  } catch {
  }
  const now = Date.now();
  let inboxId;
  try {
    const ins = await pool2.query(
      `INSERT INTO vault_inbox (url, source, status, created_at) VALUES ($1, $2, 'processing', $3) ON CONFLICT (url) DO UPDATE SET status = 'processing', created_at = $3 RETURNING id`,
      [url, source || "drop-box", now]
    );
    inboxId = ins.rows[0].id;
  } catch (e) {
    res.status(500).json({ error: "Database error" });
    return;
  }
  res.json({ status: "processing", id: inboxId });
  let linkType = "article";
  if (/youtube\.com\/watch|youtu\.be\//i.test(url)) linkType = "youtube";
  else if (/twitter\.com|x\.com/i.test(url)) linkType = "tweet";
  else if (/github\.com/i.test(url)) linkType = "github";
  const tagHint = tag ? `
IMPORTANT: The user tagged this as "${tag}" \u2014 use this to determine the vault folder.` : "";
  const taskPrompt = `Extract and file content from this URL into the knowledge base vault.

URL: ${url}
Link type: ${linkType}
${tagHint}

Instructions:
1. Use the appropriate tool to extract content:
   - YouTube: use youtube_video to get title, channel, description
   - Tweet: use x_read_tweet to get tweet content
   - Article/GitHub: try web_fetch first. If the content is empty, incomplete, or clearly truncated (e.g. just nav/footer text), retry with render_page which uses a full cloud browser with anti-bot protection to get the real page content
2. Determine the best vault folder based on content topic:
   - Moody's / competitor / banking / work \u2192 Projects/Moody's/Competitive Intelligence/
   - Consciousness / spirituality / health \u2192 Health/
   - Real estate / housing \u2192 Real Estate/
   - AI / tech / agentic systems \u2192 Resources/AI Education/
   - Finance / markets / investing \u2192 Finances/
   - Career / professional \u2192 Career Development/
   - General reference \u2192 Resources/
3. Create a structured note using notes_create with this format:
   - Frontmatter: source, type (${linkType}), author/speaker, date_filed (today), tags
   - Title heading
   - Summary (2-3 sentences)
   - Key Takeaways (3-5 bullets)
   - Frameworks/Models (if applicable, use [[wikilinks]])
   - Related Vault Nodes (if applicable, use [[wikilinks]])
   - Footer: "Filed via: Vault Inbox"
4. Filename: use format "{YYYY-MM-DD} - {Cleaned Title}.md" in the chosen folder

IMPORTANT: After filing, respond with EXACTLY this format on the FIRST LINE of your response:
FILED|{title}|{full/vault/path.md}|{comma,separated,tags}

Then add a brief summary below.`;
  try {
    const agentTools = [
      ...buildKnowledgeBaseTools(),
      ...cachedStaticTools
    ];
    const result = await runSubAgent({
      agentId: "knowledge-organizer",
      task: taskPrompt,
      allTools: agentTools,
      apiKey: ANTHROPIC_KEY
    });
    let title = "";
    let filePath = "";
    let tags = [];
    let summary = result.response;
    const firstLine = result.response.split("\n")[0];
    if (firstLine.startsWith("FILED|")) {
      const parts = firstLine.split("|");
      title = parts[1] || "";
      filePath = parts[2] || "";
      tags = (parts[3] || "").split(",").map((t) => t.trim()).filter(Boolean);
      summary = result.response.split("\n").slice(1).join("\n").trim();
    }
    await pool2.query(
      `UPDATE vault_inbox SET title = $1, file_path = $2, tags = $3, summary = $4, status = 'filed' WHERE id = $5`,
      [title || "Untitled", filePath, JSON.stringify(tags), summary.slice(0, 500), inboxId]
    );
    try {
      const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 16).replace("T", " ");
      const logLine = `- ${date} | ${linkType} | ${title || url} | \u2192 ${filePath}
`;
      const logPath = "Resources/Vault-Inbox-Log.md";
      try {
        await kbAppend(logPath, logLine);
      } catch {
        await kbCreate(logPath, `# Vault Inbox Log

${logLine}`);
      }
    } catch {
    }
    try {
      await pool2.query(
        `INSERT INTO agent_activity (agent, task, saved_to, created_at) VALUES ($1, $2, $3, $4)`,
        ["knowledge-organizer", `Vault Inbox: ${title || url}`.slice(0, 200), filePath || null, Date.now()]
      );
    } catch {
    }
  } catch (err) {
    console.error("[vault-inbox] Processing failed:", err.message);
    await pool2.query(
      `UPDATE vault_inbox SET status = 'error', error = $1 WHERE id = $2`,
      [err.message?.slice(0, 500) || "Unknown error", inboxId]
    );
  }
});
app.get("/api/vault-inbox/history", async (_req, res) => {
  try {
    const pool2 = getPool();
    const result = await pool2.query(
      `SELECT id, url, title, file_path, tags, summary, source, status, error, created_at FROM vault_inbox ORDER BY created_at DESC LIMIT 10`
    );
    res.json(result.rows.map((r) => ({
      id: r.id,
      url: r.url,
      title: r.title,
      filePath: r.file_path,
      tags: r.tags || [],
      summary: r.summary,
      source: r.source,
      status: r.status,
      error: r.error,
      createdAt: Number(r.created_at)
    })));
  } catch (err) {
    res.status(500).json({ error: "Failed to load history" });
  }
});
app.get("/api/vault-inbox/:id", async (req, res) => {
  try {
    const pool2 = getPool();
    const result = await pool2.query(
      `SELECT id, url, title, file_path, tags, summary, source, status, error, created_at FROM vault_inbox WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const r = result.rows[0];
    res.json({
      id: r.id,
      url: r.url,
      title: r.title,
      filePath: r.file_path,
      tags: r.tags || [],
      summary: r.summary,
      source: r.source,
      status: r.status,
      error: r.error,
      createdAt: Number(r.created_at)
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load item" });
  }
});
app.get("/api/scheduled-jobs", (_req, res) => {
  res.json(getJobs());
});
app.put("/api/scheduled-jobs", (req, res) => {
  try {
    const body = req.body;
    if (body.jobs) {
      updateConfig2({ jobs: body.jobs });
    }
    res.json({ ok: true, jobs: getJobs() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.put("/api/scheduled-jobs/:id", (req, res) => {
  try {
    const body = req.body;
    if (body.schedule) {
      const { hour, minute } = body.schedule;
      if (hour !== void 0 && (hour < 0 || hour > 23)) {
        res.status(400).json({ error: "hour must be 0-23" });
        return;
      }
      if (minute !== void 0 && (minute < 0 || minute > 59)) {
        res.status(400).json({ error: "minute must be 0-59" });
        return;
      }
    }
    if (body.name && body.name.length > 100) {
      res.status(400).json({ error: "name too long" });
      return;
    }
    if (body.prompt && body.prompt.length > 5e3) {
      res.status(400).json({ error: "prompt too long" });
      return;
    }
    const result = updateJob(req.params["id"], body);
    if (!result) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json({ ok: true, job: result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.post("/api/scheduled-jobs", (req, res) => {
  try {
    const { name, agentId, prompt, schedule, enabled } = req.body;
    if (!name || !agentId || !prompt) {
      res.status(400).json({ error: "name, agentId, and prompt required" });
      return;
    }
    if (name.length > 100) {
      res.status(400).json({ error: "name too long" });
      return;
    }
    if (prompt.length > 5e3) {
      res.status(400).json({ error: "prompt too long" });
      return;
    }
    const sched = schedule || { type: "daily", hour: 8, minute: 0 };
    if (sched.hour < 0 || sched.hour > 23 || sched.minute < 0 || sched.minute > 59) {
      res.status(400).json({ error: "invalid schedule time" });
      return;
    }
    const job = addJob({ name, agentId, prompt, schedule: sched, enabled: enabled || false });
    res.json({ ok: true, job });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.get("/api/kb/read", async (req, res) => {
  try {
    const path8 = req.query.path;
    if (!path8) {
      res.status(400).json({ error: "path required" });
      return;
    }
    const content = await kbRead(path8);
    res.json({ content });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to read" });
  }
});
app.delete("/api/scheduled-jobs/:id", (req, res) => {
  try {
    const removed = removeJob(req.params["id"]);
    if (!removed) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.get("/api/cost-summary", async (_req, res) => {
  try {
    const summary = await getCostSummary();
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.get("/api/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "claude-sonnet-4-6", object: "model", created: 17e8, owned_by: "anthropic" },
      { id: "claude-haiku-4-5-20251001", object: "model", created: 17e8, owned_by: "anthropic" },
      { id: "claude-opus-4-6", object: "model", created: 17e8, owned_by: "anthropic" }
    ]
  });
});
app.post("/api/v1/chat/completions", async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) {
      res.status(500).json({ error: { message: "Anthropic API key not configured", type: "server_error" } });
      return;
    }
    const { model, messages, max_tokens, temperature, stream } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: { message: "messages array is required", type: "invalid_request_error" } });
      return;
    }
    const modelId = model || "claude-sonnet-4-6";
    const validModels = ["claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-opus-4-6"];
    const anthropicModel = validModels.includes(modelId) ? modelId : "claude-sonnet-4-6";
    let systemPrompt = "";
    const anthropicMessages = [];
    for (const msg of messages) {
      if (msg.role === "system") {
        systemPrompt += (systemPrompt ? "\n\n" : "") + msg.content;
      } else if (msg.role === "user" || msg.role === "assistant") {
        anthropicMessages.push({ role: msg.role, content: msg.content });
      }
    }
    if (anthropicMessages.length === 0) {
      anthropicMessages.push({ role: "user", content: "Hello" });
    }
    const Anthropic5 = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic5({ apiKey: ANTHROPIC_KEY });
    const response = await client.messages.create({
      model: anthropicModel,
      max_tokens: max_tokens || 4096,
      ...temperature !== void 0 ? { temperature } : {},
      ...systemPrompt ? { system: systemPrompt } : {},
      messages: anthropicMessages
    });
    const textContent = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const completionId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    res.json({
      id: completionId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1e3),
      model: anthropicModel,
      choices: [{
        index: 0,
        message: { role: "assistant", content: textContent },
        finish_reason: response.stop_reason === "end_turn" ? "stop" : response.stop_reason === "max_tokens" ? "length" : "stop"
      }],
      usage: {
        prompt_tokens: response.usage?.input_tokens || 0,
        completion_tokens: response.usage?.output_tokens || 0,
        total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0)
      }
    });
  } catch (err) {
    console.error("[openai-proxy] Error:", err.message || err);
    const status = err.status || 500;
    res.status(status).json({ error: { message: err.message || "Internal server error", type: "server_error" } });
  }
});
app.get("/api/scheduled-jobs/history", async (_req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(_req.query.limit) || 20, 100));
    const history = await getJobHistory(limit);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.post("/api/scheduled-jobs/:id/trigger", async (req, res) => {
  try {
    res.json({ ok: true, status: "started" });
    triggerJob(req.params["id"]).catch((err) => {
      console.error(`[scheduled-jobs] Manual trigger failed:`, err);
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.patch("/api/tasks/:id/restore", async (req, res) => {
  try {
    const result = await restoreTask(req.params["id"]);
    glanceCache = null;
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.post("/api/config/tunnel-url", (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.OBSIDIAN_API_KEY}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { url } = req.body;
  if (!url?.startsWith("https://")) {
    res.status(400).json({ error: "url must be an https:// URL" });
    return;
  }
  setApiUrl(url);
  persistTunnelUrl(url);
  console.log(`Tunnel URL updated to: ${url}`);
  res.json({ ok: true, url });
});
app.get("/api/alerts/config", (_req, res) => {
  res.json(getConfig());
});
app.put("/api/alerts/config", (req, res) => {
  const updated = updateConfig(req.body);
  res.json(updated);
});
app.post("/api/alerts/trigger/:type", async (req, res) => {
  const type = req.params["type"];
  if (!["morning", "afternoon", "evening"].includes(type)) {
    res.status(400).json({ error: "Invalid brief type. Use morning, afternoon, or evening." });
    return;
  }
  try {
    const event = await triggerBrief(type);
    res.json({ ok: true, event });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
var glanceCache = null;
var GLANCE_TTL = 5 * 60 * 1e3;
app.get("/api/glance", async (_req, res) => {
  try {
    if (glanceCache && Date.now() - glanceCache.ts < GLANCE_TTL) {
      res.json(glanceCache.data);
      return;
    }
    const cfg = getConfig();
    const tz = cfg.timezone || "America/New_York";
    const loc = cfg.location || "10016";
    const now = /* @__PURE__ */ new Date();
    let timeStr;
    try {
      timeStr = now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", weekday: "short", month: "short", day: "numeric" });
    } catch {
      timeStr = now.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", weekday: "short", month: "short", day: "numeric" });
    }
    const result = { time: timeStr, weather: null, emails: null, tasks: null, nextEvent: null };
    const promises = [];
    promises.push((async () => {
      try {
        const raw = await getWeather(loc);
        const tempMatch = raw.match(/Temperature:\s*([\d.-]+)°C\s*\((\d+)°F\)/);
        const condMatch = raw.match(/Condition:\s*(.+)/);
        const feelsMatch = raw.match(/Feels like:\s*([\d.-]+)°C/);
        if (tempMatch && condMatch) {
          const condition = condMatch[1].trim();
          const etHour = new Date((/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York" })).getHours();
          const isNight = etHour >= 18 || etHour < 6;
          let icon = "\u{1F321}\uFE0F";
          const cl = condition.toLowerCase();
          if (cl.includes("clear") || cl.includes("sunny")) icon = isNight ? "\u{1F319}" : "\u2600\uFE0F";
          else if (cl.includes("partly")) icon = isNight ? "\u2601\uFE0F" : "\u26C5";
          else if (cl.includes("cloud") || cl.includes("overcast")) icon = "\u2601\uFE0F";
          else if (cl.includes("rain") || cl.includes("drizzle") || cl.includes("shower")) icon = "\u{1F327}\uFE0F";
          else if (cl.includes("snow")) icon = "\u2744\uFE0F";
          else if (cl.includes("thunder")) icon = "\u26C8\uFE0F";
          else if (cl.includes("fog")) icon = "\u{1F32B}\uFE0F";
          const w = { tempC: Math.round(parseFloat(tempMatch[1])), condition, icon };
          if (feelsMatch) w.feelsLikeC = Math.round(parseFloat(feelsMatch[1]));
          const forecastLines = raw.match(/\d{4}-\d{2}-\d{2}:\s*.+/g);
          if (forecastLines) {
            w.forecast = forecastLines.map((line) => {
              const m = line.match(/(\d{4}-\d{2}-\d{2}):\s*(.+?),\s*([\d-]+)-([\d-]+)°C.*?Rain:\s*(\d+)%/);
              if (!m) return null;
              return { date: m[1], condition: m[2].trim(), lowC: parseInt(m[3]), highC: parseInt(m[4]), rainPct: parseInt(m[5]) };
            }).filter(Boolean);
          }
          result.weather = w;
        }
      } catch {
      }
    })());
    if (isConfigured3() && isConnected()) {
      promises.push((async () => {
        try {
          const unread = await getUnreadCount();
          result.emails = { unread };
        } catch {
        }
      })());
    }
    promises.push((async () => {
      try {
        const active = await getActiveTasks();
        result.tasks = { active: active.length, items: active };
      } catch {
      }
    })());
    if (isConfigured4()) {
      promises.push((async () => {
        try {
          const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
          const tzStr = now.toLocaleString("en-US", { timeZone: tz });
          const tzOffsetMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
          const nowShifted = new Date(now.getTime() + tzOffsetMs);
          const eodTomorrowInTz = new Date(Date.UTC(nowShifted.getUTCFullYear(), nowShifted.getUTCMonth(), nowShifted.getUTCDate() + 1, 23, 59, 59, 999));
          const endOfTomorrowUTC = new Date(eodTomorrowInTz.getTime() - tzOffsetMs);
          const events = await listEventsStructured({ maxResults: 5, timeMax: endOfTomorrowUTC.toISOString() });
          if (events.length > 0) {
            result.nextEvent = events[0];
            result.upcomingEvents = events.slice(0, 5);
          }
        } catch {
        }
      })());
    }
    promises.push((async () => {
      try {
        const headlines = await getTopHeadlines(3);
        if (headlines.length > 0) result.headlines = headlines;
      } catch {
      }
    })());
    await Promise.all(promises);
    const allJobs = getJobs();
    const enabledJobs = allJobs.filter((j) => j.enabled);
    const jobItems = enabledJobs.map((j) => ({
      name: j.name,
      id: j.id,
      status: j.lastStatus || null,
      lastRun: j.lastRun || null
    }));
    const okCount = jobItems.filter((j) => j.status === "success").length;
    const partialCount = jobItems.filter((j) => j.status === "partial").length;
    const failedCount = jobItems.filter((j) => j.status === "error").length;
    result.jobs = { total: enabledJobs.length, ok: okCount, partial: partialCount, failed: failedCount, items: jobItems };
    result.nextJob = getNextJob();
    glanceCache = { data: result, ts: Date.now() };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch glance data" });
  }
});
app.get("/api/kb-status", (_req, res) => {
  res.json({ online: useLocalVault || lastTunnelStatus, mode: useLocalVault ? "local" : "remote" });
});
var obSyncProcess = null;
function startObSync() {
  const vaultPath2 = path7.join(process.cwd(), "data", "vault");
  const logPath = "/tmp/obsidian-sync.log";
  if (obSyncProcess) {
    try {
      obSyncProcess.kill();
    } catch {
    }
    obSyncProcess = null;
  }
  try {
    execSync("pgrep -f 'ob sync' 2>/dev/null && pkill -f 'ob sync'", { encoding: "utf-8" });
  } catch {
  }
  const logFd = fs6.openSync(logPath, "a");
  const child = spawn("ob", ["sync", "--continuous", "--path", vaultPath2], {
    stdio: ["ignore", logFd, logFd],
    detached: false
  });
  child.on("error", (err) => {
    console.error("[sync] ob sync failed to start:", err.message);
    obSyncProcess = null;
  });
  child.on("exit", (code) => {
    console.warn(`[sync] ob sync exited with code ${code} \u2014 restarting in 10s`);
    obSyncProcess = null;
    setTimeout(() => {
      if (!obSyncProcess) startObSync();
    }, 1e4);
  });
  obSyncProcess = child;
  console.log(`[sync] ob sync started (pid ${child.pid})`);
}
function getSyncStatus() {
  const logPath = "/tmp/obsidian-sync.log";
  const lastChecked = (/* @__PURE__ */ new Date()).toISOString();
  try {
    const content = fs6.readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.trim());
    if (lines.length === 0) return { running: false, status: "not_running", lastLine: "", lastChecked };
    const lastLine = lines[lines.length - 1].trim();
    let running = true;
    let status = "unknown";
    if (/fully synced/i.test(lastLine)) status = "synced";
    else if (/upload complete/i.test(lastLine)) status = "synced";
    else if (/uploading/i.test(lastLine)) status = "uploading";
    else if (/download complete/i.test(lastLine)) status = "synced";
    else if (/downloading/i.test(lastLine)) status = "downloading";
    else if (/connection successful/i.test(lastLine)) status = "connected";
    else if (/connecting/i.test(lastLine)) status = "connecting";
    else if (/error|failed|disconnect/i.test(lastLine)) {
      status = "error";
      running = false;
    }
    try {
      const { execSync: execSync2 } = __require("child_process");
      const ps = execSync2("pgrep -f 'ob sync' 2>/dev/null", { encoding: "utf-8" }).trim();
      running = ps.length > 0;
    } catch {
      running = false;
    }
    return { running, status, lastLine, lastChecked };
  } catch {
    return { running: false, status: "not_running", lastLine: "no log file", lastChecked };
  }
}
app.get("/api/sync-status", (_req, res) => {
  res.json(getSyncStatus());
});
var lastSyncLogStatus = "";
setInterval(() => {
  const sync = getSyncStatus();
  const key = `${sync.running}:${sync.status}`;
  if (key !== lastSyncLogStatus) {
    const icon = sync.running ? "\u25CF" : "\u25CB";
    console.log(`[sync] ${icon} ob sync ${sync.running ? "running" : "stopped"} \u2014 ${sync.status}${sync.status === "error" ? ": " + sync.lastLine : ""}`);
    lastSyncLogStatus = key;
  }
}, 6e4);
app.get("/api/agents", (_req, res) => {
  const agents2 = getAgents().map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    enabled: a.enabled,
    tools: a.tools,
    timeout: a.timeout,
    model: a.model
  }));
  res.json({ agents: agents2 });
});
async function buildVaultTree(dir) {
  const entries = await fs6.promises.readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const children = await buildVaultTree(path7.join(dir, entry.name));
      result.push({ name: entry.name, type: "folder", children });
    } else {
      result.push({ name: entry.name, type: "file" });
    }
  }
  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
function formatVaultIndex(entries, indent = 0) {
  const lines = [];
  for (const entry of entries) {
    const prefix = "  ".repeat(indent);
    if (entry.type === "folder") {
      lines.push(`${prefix}${entry.name}/`);
      if (entry.children) {
        lines.push(formatVaultIndex(entry.children, indent + 1));
      }
    } else {
      lines.push(`${prefix}${entry.name}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}
async function getVaultIndex() {
  try {
    const tree = await buildVaultTree(VAULT_DIR);
    return `## Vault Index (all folders and files)
${formatVaultIndex(tree)}`;
  } catch {
    return "";
  }
}
app.get("/api/vault-tree", async (_req, res) => {
  try {
    const tree = await buildVaultTree(VAULT_DIR);
    res.json({ vault: tree });
  } catch (err) {
    res.status(500).json({ error: "Failed to read vault structure" });
  }
});
app.post("/api/telegram/webhook", express.json(), async (req, res) => {
  const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
  if (secretHeader !== getWebhookSecret()) {
    res.sendStatus(403);
    return;
  }
  try {
    await handleWebhookUpdate(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error("[telegram] Webhook handler error:", err);
    res.sendStatus(200);
  }
});
app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: sessions.size, ts: Date.now() });
});
app.use((err, _req, res, _next) => {
  console.error("Express error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));
var server = createServer(app);
var isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.error(`Got ${signal} \u2014 closing server...`);
  if (obSyncProcess) {
    try {
      obSyncProcess.kill();
    } catch {
    }
    obSyncProcess = null;
  }
  stopJobSystem();
  stop();
  const ids = [...sessions.keys()];
  if (ids.length > 0) {
    console.error(`[shutdown] Saving ${ids.length} active session(s)...`);
    const results = await Promise.allSettled(ids.map((id) => saveAndCleanSession(id)));
    const saved = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    console.error(`[shutdown] Sessions saved: ${saved}, failed: ${failed}`);
  }
  server.close(() => {
    console.error("[shutdown] Server closed cleanly");
    setTimeout(() => process.exit(0), 500);
  });
  setTimeout(() => {
    console.error("[shutdown] Forced exit after timeout");
    process.exit(1);
  }, 8e3);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));
function killPort(port) {
  try {
    execSync(`fuser -k -9 ${port}/tcp`, { stdio: "ignore" });
  } catch {
  }
  try {
    execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, { stdio: "ignore" });
  } catch {
  }
}
function getPortPids(port) {
  try {
    const out = execSync(`lsof -t -iTCP:${port} -sTCP:LISTEN 2>/dev/null`, { encoding: "utf-8" });
    return out.trim().split(/\s+/).map((s) => parseInt(s)).filter((n) => !isNaN(n) && n > 0 && n !== port);
  } catch {
    return [];
  }
}
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitForPort(port, maxWaitMs = 3e4) {
  const start = Date.now();
  let attempt = 0;
  killPort(port);
  await new Promise((r) => setTimeout(r, 1e3));
  while (Date.now() - start < maxWaitMs) {
    const pids = getPortPids(port);
    if (pids.length === 0) return true;
    attempt++;
    const alivePids = pids.filter(isPidAlive);
    if (alivePids.length === 0) {
      await new Promise((r) => setTimeout(r, 500));
      return true;
    }
    console.warn(`[boot] Port ${port} still held by PIDs: ${alivePids.join(", ")} \u2014 killing (attempt ${attempt})`);
    for (const pid of alivePids) {
      try {
        process.kill(pid, 9);
      } catch {
      }
    }
    killPort(port);
    await new Promise((r) => setTimeout(r, 2e3));
  }
  return false;
}
async function runStartupRecovery() {
  const startupTime = Date.now();
  console.log("[recovery] Running startup recovery checks...");
  try {
    const migPool = getPool();
    const portfolioRes = await migPool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_portfolio_value'`);
    if (portfolioRes.rows.length > 0 && portfolioRes.rows[0].value === 50) {
      await migPool.query(
        `UPDATE app_config SET value = $1, updated_at = $2 WHERE key = 'wealth_engines_portfolio_value'`,
        [JSON.stringify(1e3), Date.now()]
      );
      console.log("[recovery] Migrated portfolio value: $50 \u2192 $1,000");
    }
    const peakRes = await migPool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_peak_portfolio'`);
    if (peakRes.rows.length > 0 && peakRes.rows[0].value === 50) {
      await migPool.query(
        `UPDATE app_config SET value = $1, updated_at = $2 WHERE key = 'wealth_engines_peak_portfolio'`,
        [JSON.stringify(1e3), Date.now()]
      );
      console.log("[recovery] Migrated peak portfolio: $50 \u2192 $1,000");
    }
  } catch (migErr) {
    console.error("[recovery] Portfolio migration check failed:", migErr instanceof Error ? migErr.message : migErr);
  }
  let previousLastTick = 0;
  try {
    const pool2 = getPool();
    const lastMonitorRes = await pool2.query(`SELECT value FROM app_config WHERE key = 'bankr_monitor_last_tick'`);
    if (lastMonitorRes.rows.length > 0) {
      previousLastTick = typeof lastMonitorRes.rows[0].value === "number" ? lastMonitorRes.rows[0].value : parseInt(String(lastMonitorRes.rows[0].value));
    }
  } catch {
  }
  if (previousLastTick > 0) {
    const downMinutes = Math.floor((startupTime - previousLastTick) / 6e4);
    if (downMinutes > 10) {
      console.warn(`[recovery] System was down for ~${downMinutes} minutes (last monitor tick: ${new Date(previousLastTick).toISOString()})`);
    }
  }
  try {
    const monitorResult = await runPositionMonitor();
    const monitorPool = getPool();
    await monitorPool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('bankr_monitor_last_tick', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(Date.now()), Date.now()]
    );
    console.log(`[recovery] Position monitor: ${monitorResult.checked} checked, ${monitorResult.closed.length} closed`);
    if (monitorResult.closed.length > 0) {
      for (const trade of monitorResult.closed) {
        await sendTradeAlert({
          type: trade.close_reason === "kill_switch" ? "emergency" : "stopped",
          asset: trade.asset,
          direction: trade.direction,
          exitPrice: trade.exit_price.toFixed(2),
          pnl: trade.pnl,
          reason: trade.close_reason
        });
      }
    }
  } catch (err) {
    console.error("[recovery] Position monitor failed:", err instanceof Error ? err.message : err);
  }
  try {
    const { refreshShadowTradesFromMarket: refreshShadowTradesFromMarket2 } = await Promise.resolve().then(() => (init_oversight(), oversight_exports));
    const shadowResult = await refreshShadowTradesFromMarket2();
    console.log(`[recovery] Shadow prices refreshed: ${shadowResult.updated} updated, ${shadowResult.closed} closed`);
  } catch (err) {
    console.error("[recovery] Shadow price refresh failed:", err instanceof Error ? err.message : err);
  }
  try {
    const jobs = getJobs();
    const missedJobs = [];
    for (const job of jobs) {
      if (!job.enabled || !job.lastRun) continue;
      const lastRunTime = new Date(job.lastRun).getTime();
      if (isNaN(lastRunTime)) continue;
      let expectedIntervalMs = 0;
      if (job.schedule.type === "interval" && job.schedule.intervalMinutes) {
        expectedIntervalMs = job.schedule.intervalMinutes * 60 * 1e3;
      } else if (job.schedule.type === "daily") {
        expectedIntervalMs = 24 * 60 * 60 * 1e3;
      } else if (job.schedule.type === "weekly") {
        expectedIntervalMs = 7 * 24 * 60 * 60 * 1e3;
      }
      if (expectedIntervalMs > 0) {
        const elapsed = startupTime - lastRunTime;
        if (elapsed > expectedIntervalMs * 2) {
          const missedWindows = Math.floor(elapsed / expectedIntervalMs) - 1;
          missedJobs.push(`${job.name} (missed ~${missedWindows} window${missedWindows > 1 ? "s" : ""}, last ran ${Math.floor(elapsed / 6e4)}m ago)`);
        }
      }
    }
    if (missedJobs.length > 0) {
      console.warn(`[recovery] Missed job windows detected:
  - ${missedJobs.join("\n  - ")}`);
      sendMessage(`\u26A0\uFE0F *Missed Job Windows*

${missedJobs.map((j) => `\u2022 ${j}`).join("\n")}`).catch(() => {
      });
    } else {
      console.log("[recovery] No missed job windows detected");
    }
  } catch (err) {
    console.error("[recovery] Missed job check failed:", err instanceof Error ? err.message : err);
  }
}
async function sendStartupNotification(googleStatus) {
  const jobs = getJobs();
  const enabledJobs = jobs.filter((j) => j.enabled).length;
  const bnkrStatus = (await Promise.resolve().then(() => (init_bnkr(), bnkr_exports))).isConfigured() ? "Live" : "Shadow";
  const googleLine = googleStatus.connected ? `\u2705 ${googleStatus.email}` : `\u274C Disconnected`;
  const now = (/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York" });
  const msg = [
    `\u{1F7E2} *DarkNode Online*`,
    ``,
    `\u23F0 ${now} ET`,
    `\u{1F4CB} Jobs: ${enabledJobs} active`,
    `\u{1F3E6} BNKR: ${bnkrStatus}`,
    `\u{1F4E7} Google: ${googleLine}`
  ].join("\n");
  await sendMessage(msg);
}
async function startServer(maxRetries = 5) {
  await init2();
  await init3();
  await init4();
  await init5();
  await init7();
  await init6();
  setTelegramNotifier(async (msg) => {
    await sendMessage(msg);
  });
  await init8();
  try {
    const pool2 = (await Promise.resolve().then(() => (init_db(), db_exports))).getPool();
    await pool2.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_public', $1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [JSON.stringify(false), Date.now()]
    );
  } catch {
  }
  console.log("[boot] PostgreSQL ready (shared pool, 4 tables)");
  let googleStatus = { connected: false };
  try {
    googleStatus = await checkConnectionStatus();
    if (googleStatus.connected) {
      console.log(`[boot] Google connected: ${googleStatus.email} (Gmail, Calendar, Drive, Sheets)`);
    } else {
      console.warn(`[boot] Google not connected: ${googleStatus.error}`);
      sendMessage(`\u26A0\uFE0F *Google Disconnected*

Gmail, Calendar, Drive, Sheets are offline.
Reconnect: /api/gmail/auth`).catch(() => {
      });
    }
  } catch {
  }
  let lastGoogleAlertSent = 0;
  setInterval(async () => {
    try {
      const token = await getAccessToken();
      if (token) {
        console.log("[google-health] Token valid \u2014 auto-refreshed successfully");
        lastGoogleAlertSent = 0;
      } else {
        console.warn("[google-health] Token refresh failed \u2014 Google auth needs reconnection at /api/gmail/auth");
        const now = Date.now();
        if (now - lastGoogleAlertSent > 12 * 60 * 60 * 1e3) {
          lastGoogleAlertSent = now;
          sendMessage(`\u26A0\uFE0F *Google Auth Failed*

Token refresh failed. Gmail jobs are silently failing.
Reconnect: /api/gmail/auth`).catch(() => {
          });
        }
      }
    } catch (err) {
      console.error("[google-health] Auth check failed:", err.message);
      const now = Date.now();
      if (now - lastGoogleAlertSent > 12 * 60 * 60 * 1e3) {
        lastGoogleAlertSent = now;
        sendMessage(`\u26A0\uFE0F *Google Auth Error*

${err.message}
Reconnect: /api/gmail/auth`).catch(() => {
        });
      }
    }
  }, 6 * 60 * 60 * 1e3);
  const portReady = await waitForPort(PORT);
  if (!portReady) {
    console.error(`[boot] Port ${PORT} could not be freed after 30s \u2014 exiting`);
    process.exit(1);
  }
  function broadcastToAll(event) {
    const data = `data: ${JSON.stringify(event)}

`;
    for (const entry of sessions.values()) {
      for (const sub of entry.subscribers) {
        try {
          sub.write(data);
        } catch {
          entry.subscribers.delete(sub);
        }
      }
    }
    forwardAlertToTelegram(event).catch((err) => {
      console.error("[telegram] Forward failed:", err instanceof Error ? err.message : err);
    });
  }
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    killPort(PORT);
    await new Promise((r) => setTimeout(r, attempt === 1 ? 500 : 1e3));
    try {
      await new Promise((resolve, reject) => {
        server = createServer(app);
        server.once("error", (err) => {
          if (err.code === "EADDRINUSE" && attempt < maxRetries) {
            console.warn(`[boot] EADDRINUSE on attempt ${attempt}/${maxRetries} \u2014 killing port and retrying...`);
            server.close();
            killPort(PORT);
            reject(err);
          } else {
            console.error(`[boot] Fatal server error:`, err);
            process.exit(1);
          }
        });
        server.listen({ port: PORT, host: "0.0.0.0", exclusive: false }, async () => {
          console.log(`[ready] pi-replit listening on http://localhost:${PORT}`);
          try {
            const bootPool = getPool();
            await bootPool.query(
              `INSERT INTO app_config (key, value, updated_at) VALUES ('system_boot_time', $1, $2)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
              [JSON.stringify(Date.now()), Date.now()]
            );
          } catch {
          }
          startObSync();
          startAlertSystem(broadcastToAll, async (briefPath, content) => {
            try {
              await kbCreate(briefPath, content);
            } catch (err) {
              console.error(`[alerts] Vault save failed for ${briefPath}:`, err);
            }
          });
          startJobSystem(
            async (agentId, task, onProgress) => {
              const agentTools = [
                ...buildKnowledgeBaseTools(),
                ...cachedStaticTools
              ];
              const result = await runSubAgent({
                agentId,
                task,
                allTools: agentTools,
                apiKey: ANTHROPIC_KEY,
                onProgress
              });
              return result;
            },
            broadcastToAll,
            async (path8, content) => {
              try {
                await kbCreate(path8, content);
              } catch (err) {
                console.error(`[scheduled-jobs] Vault save failed for ${path8}:`, err);
              }
            },
            async (path8) => kbList(path8),
            async (from, to) => kbMove(from, to),
            () => getPool()
          );
          setInterval(async () => {
            try {
              const result = await runPositionMonitor();
              const monitorPool = getPool();
              await monitorPool.query(
                `INSERT INTO app_config (key, value, updated_at) VALUES ('bankr_monitor_last_tick', $1, $2)
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
                [JSON.stringify(Date.now()), Date.now()]
              );
              if (result.closed.length > 0) {
                for (const trade of result.closed) {
                  await sendTradeAlert({
                    type: trade.close_reason === "kill_switch" ? "emergency" : "stopped",
                    asset: trade.asset,
                    direction: trade.direction,
                    exitPrice: trade.exit_price.toFixed(2),
                    pnl: trade.pnl,
                    reason: trade.close_reason
                  });
                }
              }
              if (result.errors.length > 0) {
                console.warn("[bankr-monitor] Errors:", result.errors.join("; "));
              }
            } catch (err) {
              console.error("[bankr-monitor] Position monitor error:", err);
            }
          }, 5 * 60 * 1e3);
          console.log("[boot] BANKR position monitor started (5-min interval)");
          runStartupRecovery().catch((err) => {
            console.error("[recovery] Startup recovery failed:", err instanceof Error ? err.message : err);
          });
          sendStartupNotification(googleStatus).catch((err) => {
            console.error("[boot] Startup notification failed:", err instanceof Error ? err.message : err);
          });
          resolve();
        });
      });
      return;
    } catch {
      killPort(PORT);
      const delay = Math.min(3e3 * attempt, 1e4);
      console.log(`[boot] Waiting ${delay}ms before retry...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  console.error(`[boot] Could not bind port ${PORT} after ${maxRetries} attempts \u2014 exiting`);
  process.exit(1);
}
startServer();
