import * as fs from "fs";
import * as path from "path";

const TIMEOUT_MS = 15_000;
const BASE_URL = "https://api.coingecko.com/api/v3";
const CACHE_DIR = path.join(process.env.HOME || "/tmp", ".cache", "coingecko");

const CRYPTO_ALIASES: Record<string, string> = {
  btc: "bitcoin", bitcoin: "bitcoin",
  eth: "ethereum", ethereum: "ethereum",
  sol: "solana", solana: "solana",
  doge: "dogecoin", dogecoin: "dogecoin",
  ada: "cardano", cardano: "cardano",
  xrp: "ripple", ripple: "ripple",
  dot: "polkadot", polkadot: "polkadot",
  matic: "matic-network", polygon: "matic-network",
  avax: "avalanche-2", avalanche: "avalanche-2",
  link: "chainlink", chainlink: "chainlink",
  bnb: "binancecoin", binancecoin: "binancecoin",
  ltc: "litecoin", litecoin: "litecoin",
  shib: "shiba-inu",
  uni: "uniswap", uniswap: "uniswap",
  atom: "cosmos", cosmos: "cosmos",
  near: "near",
  apt: "aptos", aptos: "aptos",
  arb: "arbitrum", arbitrum: "arbitrum",
  op: "optimism", optimism: "optimism",
  sui: "sui",
  pepe: "pepe",
  bnkr: "bankr", bankr: "bankr",
  virtual: "virtual-protocol", virtuals: "virtual-protocol",
};

class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;
  private lastRefill: number;
  private queue: Array<() => void> = [];
  private processing = false;

  constructor(maxPerMinute: number) {
    this.maxTokens = maxPerMinute;
    this.tokens = maxPerMinute;
    this.refillRate = maxPerMinute / 60;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        const next = this.queue.shift();
        if (next) next();
      } else {
        const waitMs = Math.ceil((1 - this.tokens) / this.refillRate * 1000);
        await new Promise(r => setTimeout(r, Math.max(waitMs, 100)));
      }
    }

    this.processing = false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

const rateLimiter = new RateLimiter(10);

function getApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": "darknode/1.0" };
  const apiKey = process.env.COINGECKO_API_KEY;
  if (apiKey) {
    headers["x-cg-demo-api-key"] = apiKey;
  }
  return headers;
}

async function cgFetch(urlPath: string): Promise<any> {
  await rateLimiter.acquire();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${BASE_URL}${urlPath}`;
    const res = await fetch(url, {
      headers: getApiHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      throw new Error(`CoinGecko API error ${res.status}: ${res.statusText}`);
    }
    return await res.json();
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("CoinGecko request timed out");
    throw err;
  }
}

function resolveId(input: string): string {
  const key = input.toLowerCase().trim().replace(/^\$/, "");
  return CRYPTO_ALIASES[key] || key;
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function formatNum(n: number): string {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatPrice(n: number): string {
  if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(8)}`;
}

export interface TrendingResult {
  coins: Array<{ name: string; symbol: string; market_cap_rank: number | null; price_usd: number | null; change_24h_pct: number | null }>;
  categories: Array<{ name: string; market_cap_change_24h_pct: number | null }>;
}

export async function getTrending(): Promise<TrendingResult> {
  const data = await cgFetch("/search/trending");
  const rawCoins = data.coins?.slice(0, 15) || [];
  const coins = rawCoins.map((item: any) => {
    const c = item.item;
    return {
      name: c.name,
      symbol: c.symbol?.toUpperCase() || "",
      market_cap_rank: c.market_cap_rank || null,
      price_usd: c.data?.price ? parseFloat(c.data.price) : null,
      change_24h_pct: c.data?.price_change_percentage_24h?.usd ?? null,
    };
  });
  const rawCats = data.categories?.slice(0, 5) || [];
  const categories = rawCats.map((cat: any) => ({
    name: cat.name,
    market_cap_change_24h_pct: cat.data?.market_cap_change_percentage_24h ?? null,
  }));
  return { coins, categories };
}

export interface MoverEntry {
  name: string; symbol: string; price_usd: number; change_24h_pct: number | null; change_7d_pct: number | null; market_cap: number;
}

export async function getMovers(direction: "gainers" | "losers" = "gainers", limit: number = 20): Promise<{ direction: string; coins: MoverEntry[] }> {
  const data = await cgFetch(`/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false&price_change_percentage=24h,7d`);
  if (!Array.isArray(data) || data.length === 0) return { direction, coins: [] };

  const sorted = [...data].sort((a: any, b: any) => {
    const aChange = a.price_change_percentage_24h ?? 0;
    const bChange = b.price_change_percentage_24h ?? 0;
    return direction === "gainers" ? bChange - aChange : aChange - bChange;
  });

  const coins: MoverEntry[] = sorted.slice(0, limit).map((coin: any) => ({
    name: coin.name,
    symbol: (coin.symbol || "").toUpperCase(),
    price_usd: coin.current_price,
    change_24h_pct: coin.price_change_percentage_24h ?? null,
    change_7d_pct: coin.price_change_percentage_7d_in_currency ?? null,
    market_cap: coin.market_cap,
  }));

  return { direction, coins };
}

export interface CategoryEntry {
  name: string; change_24h_pct: number | null; market_cap: number | null; volume_24h: number | null;
}

export async function getCategories(limit: number = 20): Promise<{ categories: CategoryEntry[] }> {
  const data = await cgFetch("/coins/categories?order=market_cap_change_percentage_24h_desc");
  if (!Array.isArray(data) || data.length === 0) return { categories: [] };

  const categories: CategoryEntry[] = data.slice(0, limit).map((cat: any) => ({
    name: cat.name,
    change_24h_pct: cat.market_cap_change_percentage_24h ?? null,
    market_cap: cat.market_cap ?? null,
    volume_24h: cat.total_volume ?? null,
  }));

  return { categories };
}

export interface MarketOverviewResult {
  total_market_cap_usd: number;
  total_volume_24h_usd: number;
  btc_dominance_pct: number;
  eth_dominance_pct: number;
  active_cryptocurrencies: number;
  market_cap_change_24h_pct: number;
}

export async function getMarketOverview(): Promise<MarketOverviewResult> {
  const data = await cgFetch("/global");
  const g = data.data;
  if (!g) throw new Error("No global market data available");

  return {
    total_market_cap_usd: g.total_market_cap?.usd || 0,
    total_volume_24h_usd: g.total_volume?.usd || 0,
    btc_dominance_pct: g.market_cap_percentage?.btc || 0,
    eth_dominance_pct: g.market_cap_percentage?.eth || 0,
    active_cryptocurrencies: g.active_cryptocurrencies || 0,
    market_cap_change_24h_pct: g.market_cap_change_percentage_24h_usd ?? 0,
  };
}

export interface OHLCVCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CacheEntry {
  fetchedAt: number;
  candles: OHLCVCandle[];
}

export async function getHistoricalOHLCV(coin: string, days: number = 90): Promise<OHLCVCandle[]> {
  const coinId = resolveId(coin);
  ensureCacheDir();

  const cacheFile = path.join(CACHE_DIR, `${coinId}_${days}d_hourly.json`);

  if (fs.existsSync(cacheFile)) {
    try {
      const raw = fs.readFileSync(cacheFile, "utf-8");
      const cached: CacheEntry = JSON.parse(raw);
      const ageMs = Date.now() - cached.fetchedAt;
      if (ageMs < 3600_000 && cached.candles.length > 0) {
        return cached.candles;
      }
    } catch {
    }
  }

  const data = await cgFetch(`/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}`);

  const prices: [number, number][] = data.prices || [];
  const volumes: [number, number][] = data.total_volumes || [];

  const volumeMap = new Map<number, number>();
  for (const [ts, vol] of volumes) {
    const hourKey = Math.floor(ts / 3600_000) * 3600_000;
    volumeMap.set(hourKey, vol);
  }

  const hourBuckets = new Map<number, { prices: number[]; volume: number }>();
  for (const [ts, price] of prices) {
    const hourKey = Math.floor(ts / 3600_000) * 3600_000;
    if (!hourBuckets.has(hourKey)) {
      hourBuckets.set(hourKey, { prices: [], volume: volumeMap.get(hourKey) || 0 });
    }
    hourBuckets.get(hourKey)!.prices.push(price);
  }

  const candles: OHLCVCandle[] = [];
  const sortedKeys = Array.from(hourBuckets.keys()).sort((a, b) => a - b);
  for (const hourKey of sortedKeys) {
    const bucket = hourBuckets.get(hourKey)!;
    const p = bucket.prices;
    candles.push({
      timestamp: hourKey,
      open: p[0],
      high: Math.max(...p),
      low: Math.min(...p),
      close: p[p.length - 1],
      volume: bucket.volume,
    });
  }

  const cacheEntry: CacheEntry = { fetchedAt: Date.now(), candles };
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(cacheEntry));
  } catch (err) {
    console.warn("[coingecko] cache write error:", err);
  }

  return candles;
}

export interface HistoricalSummary {
  coin_id: string;
  days: number;
  candle_count: number;
  period_start: string;
  period_end: string;
  current_price: number;
  period_high: number;
  period_low: number;
  period_return_pct: number;
}

export async function getHistoricalOHLCVFormatted(coin: string, days: number = 90): Promise<HistoricalSummary> {
  const candles = await getHistoricalOHLCV(coin, days);
  if (candles.length === 0) throw new Error(`No historical data found for "${coin}"`);

  const coinId = resolveId(coin);
  const last = candles[candles.length - 1];
  const first = candles[0];
  const periodReturn = (last.close - first.open) / first.open * 100;
  const periodHigh = Math.max(...candles.map(c => c.high));
  const periodLow = Math.min(...candles.map(c => c.low));

  return {
    coin_id: coinId,
    days,
    candle_count: candles.length,
    period_start: new Date(first.timestamp).toISOString().slice(0, 10),
    period_end: new Date(last.timestamp).toISOString().slice(0, 10),
    current_price: last.close,
    period_high: periodHigh,
    period_low: periodLow,
    period_return_pct: parseFloat(periodReturn.toFixed(2)),
  };
}
