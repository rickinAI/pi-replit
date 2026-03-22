import { getPool } from "./db.js";
import Anthropic from "@anthropic-ai/sdk";

const POLYMARKET_API = "https://clob.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";

interface PolymarketCache {
  data: any;
  ts: number;
}

const cache: Map<string, PolymarketCache> = new Map();
const MARKET_TTL = 5 * 60 * 1000;
const WALLET_TTL = 15 * 60 * 1000;

function getCached(key: string, ttl: number): any | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
  return null;
}

function setCache(key: string, data: any): void {
  cache.set(key, { data, ts: Date.now() });
}

async function fetchJson(url: string, options?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export interface PolymarketMarket {
  condition_id: string;
  question: string;
  description: string;
  market_slug: string;
  outcomes: string[];
  outcome_prices: string[];
  tokens: { token_id: string; outcome: string; price: number }[];
  volume: number;
  volume_24h: number;
  liquidity: number;
  end_date_iso: string;
  active: boolean;
  closed: boolean;
  category: string;
  tags: string[];
}

export interface WhaleWallet {
  address: string;
  alias: string;
  niche: string;
  win_rate: number;
  roi: number;
  total_volume: number;
  total_trades: number;
  total_markets: number;
  resolved_markets: number;
  category_scores: Record<string, number>;
  composite_score: number;
  last_active: number;
  last_checked: number;
  added_at: number;
  source: "trade_mining" | "anomaly" | "manual";
  enabled: boolean;
  observation_only: boolean;
  degraded_count: number;
  pending_eviction: boolean;
  status: "active" | "probation" | "removed";
}

export interface WhaleActivity {
  wallet_address: string;
  wallet_alias: string;
  wallet_score: number;
  market_id: string;
  market_question: string;
  activity_type: "new_entry" | "position_increase" | "position_exit" | "consensus_shift";
  direction: "YES" | "NO";
  amount_usd: number;
  current_odds: number;
  detected_at: number;
}

export async function searchMarkets(query: string, limit: number = 20): Promise<PolymarketMarket[]> {
  const cacheKey = `markets_search_${query}_${limit}`;
  const cached = getCached(cacheKey, MARKET_TTL);
  if (cached) return cached;

  try {
    const url = `${GAMMA_API}/markets?closed=false&limit=${limit}&order=volume&ascending=false${query ? `&tag=${encodeURIComponent(query)}` : ""}`;
    const data = await fetchJson(url);
    const markets = Array.isArray(data) ? data : [];
    const result = markets.map(normalizeMarket);
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error("[polymarket] searchMarkets error:", err);
    return [];
  }
}

export async function getTrendingMarkets(limit: number = 20): Promise<PolymarketMarket[]> {
  const cacheKey = `markets_trending_${limit}`;
  const cached = getCached(cacheKey, MARKET_TTL);
  if (cached) return cached;

  try {
    const url = `${GAMMA_API}/markets?closed=false&limit=${limit}&order=volume24hr&ascending=false`;
    const data = await fetchJson(url);
    const markets = Array.isArray(data) ? data : [];
    const result = markets.map(normalizeMarket);
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error("[polymarket] getTrendingMarkets error:", err);
    return [];
  }
}

export async function getMarketDetails(conditionId: string): Promise<PolymarketMarket | null> {
  const cacheKey = `market_${conditionId}`;
  const cached = getCached(cacheKey, MARKET_TTL);
  if (cached) return cached;

  try {
    const isHex = /^0x[0-9a-fA-F]+$/.test(conditionId);
    const url = isHex
      ? `${GAMMA_API}/markets?condition_id=${conditionId}&limit=1`
      : `${GAMMA_API}/markets/${conditionId}`;
    const data = await fetchJson(url);
    const raw = isHex ? (Array.isArray(data) && data.length > 0 ? data[0] : null) : data;
    if (!raw) return null;
    const result = normalizeMarket(raw);
    setCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error("[polymarket] getMarketDetails error:", err);
    return null;
  }
}

function normalizeMarket(raw: any): PolymarketMarket {
  const outcomes = raw.outcomes ? (typeof raw.outcomes === "string" ? JSON.parse(raw.outcomes) : raw.outcomes) : ["Yes", "No"];
  const outcomePrices = raw.outcomePrices ? (typeof raw.outcomePrices === "string" ? JSON.parse(raw.outcomePrices) : raw.outcomePrices) : [];

  const tokens: { token_id: string; outcome: string; price: number }[] = [];
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
    tags: raw.tags ? (typeof raw.tags === "string" ? JSON.parse(raw.tags) : raw.tags) : [],
  };
}

export function scoreWallet(wallet: Omit<WhaleWallet, "composite_score">): number {
  const winRateScore = Math.min(wallet.win_rate, 1) * 0.30;
  const roiScore = Math.min(Math.max(wallet.roi, 0), 2) / 2 * 0.30;

  const categoryValues = Object.values(wallet.category_scores);
  const avgCategory = categoryValues.length > 0 ? categoryValues.reduce((a, b) => a + b, 0) / categoryValues.length : 0;
  const categoryScore = Math.min(avgCategory, 1) * 0.20;

  const monthsSinceAdded = Math.max(1, (Date.now() - wallet.added_at) / (30 * 24 * 60 * 60 * 1000));
  const marketsPerMonth = wallet.total_markets / monthsSinceAdded;
  const volumeScore = Math.min(marketsPerMonth / 10, 1) * 0.10;

  const daysSinceActive = (Date.now() - wallet.last_active) / (24 * 60 * 60 * 1000);
  const recencyScore = Math.max(0, 1 - daysSinceActive / 30) * 0.10;

  return parseFloat((winRateScore + roiScore + categoryScore + volumeScore + recencyScore).toFixed(3));
}

export async function getWhaleWatchlist(): Promise<WhaleWallet[]> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'polymarket_whale_watchlist'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      return res.rows[0].value;
    }
  } catch (err) {
    console.error("[polymarket] getWhaleWatchlist error:", err);
  }
  return [];
}

export async function saveWhaleWatchlist(wallets: WhaleWallet[]): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('polymarket_whale_watchlist', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(wallets), Date.now()]
  );
}

export async function getWhaleActivities(): Promise<WhaleActivity[]> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'polymarket_whale_activities'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      const now = Date.now();
      const recentCutoff = 24 * 60 * 60 * 1000;
      return res.rows[0].value.filter((a: WhaleActivity) => now - a.detected_at < recentCutoff);
    }
  } catch {}
  return [];
}

export async function saveWhaleActivities(activities: WhaleActivity[]): Promise<void> {
  const pool = getPool();
  const now = Date.now();
  const recentCutoff = 48 * 60 * 60 * 1000;
  const filtered = activities.filter(a => now - a.detected_at < recentCutoff);
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('polymarket_whale_activities', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(filtered), Date.now()]
  );
}

export async function detectConsensus(activities: WhaleActivity[]): Promise<{ market_id: string; question: string; direction: "YES" | "NO"; whale_count: number; total_amount: number; avg_score: number }[]> {
  const byMarket: Record<string, { yes: WhaleActivity[]; no: WhaleActivity[] }> = {};

  for (const a of activities) {
    if (a.activity_type === "position_exit") continue;
    if (!byMarket[a.market_id]) byMarket[a.market_id] = { yes: [], no: [] };
    if (a.direction === "YES") byMarket[a.market_id].yes.push(a);
    else byMarket[a.market_id].no.push(a);
  }

  const results: { market_id: string; question: string; direction: "YES" | "NO"; whale_count: number; total_amount: number; avg_score: number }[] = [];

  for (const [marketId, sides] of Object.entries(byMarket)) {
    for (const [dir, acts] of [["YES", sides.yes], ["NO", sides.no]] as const) {
      if (acts.length >= 2) {
        const totalAmount = acts.reduce((s, a) => s + a.amount_usd, 0);
        const avgScore = acts.reduce((s, a) => s + a.wallet_score, 0) / acts.length;
        results.push({
          market_id: marketId,
          question: acts[0].market_question,
          direction: dir,
          whale_count: acts.length,
          total_amount: totalAmount,
          avg_score: parseFloat(avgScore.toFixed(3)),
        });
      }
    }
  }

  return results.sort((a, b) => b.whale_count - a.whale_count || b.avg_score - a.avg_score);
}

const MACRO_CATEGORIES = ["politics", "economics", "geopolitics", "regulation", "elections", "trade", "government", "federal-reserve", "central-bank", "tariffs", "policy"];
const EXCLUDE_KEYWORDS = ["crypto", "bitcoin", "ethereum", "solana", "nft", "defi", "token", "sports", "nba", "nfl", "mlb", "soccer", "football", "entertainment", "celebrity", "movie", "music", "tv show", "reality tv", "meme"];

function isMacroRelevant(market: PolymarketMarket): boolean {
  const text = `${market.question} ${market.description} ${market.category}`.toLowerCase();
  for (const kw of EXCLUDE_KEYWORDS) {
    if (text.includes(kw)) return false;
  }
  const cat = market.category.toLowerCase();
  for (const mc of MACRO_CATEGORIES) {
    if (cat.includes(mc)) return true;
  }
  const macroSignals = ["president", "election", "fed ", "federal reserve", "interest rate", "inflation", "gdp", "tariff", "trade war", "regulation", "congress", "senate", "supreme court", "geopolit", "nato", "war", "sanction", "central bank", "imf", "world bank", "recession", "unemployment"];
  for (const sig of macroSignals) {
    if (text.includes(sig)) return true;
  }
  return false;
}

function macroInterestScore(market: PolymarketMarket): number {
  const yesPrice = market.tokens.find(t => t.outcome === "Yes")?.price ?? 0.5;
  const uncertainty = 1 - Math.abs(yesPrice - 0.5) * 2;
  const vol24hNorm = Math.min(market.volume_24h / 500000, 1);
  const totalVolNorm = Math.min(market.volume / 5000000, 1);
  return uncertainty * 0.4 + vol24hNorm * 0.35 + totalVolNorm * 0.25;
}

export async function getMacroMarkets(count: number = 5): Promise<PolymarketMarket[]> {
  const searchTags = ["politics", "economics", "elections", "geopolitics", "regulation"];
  const fetches: Promise<PolymarketMarket[]>[] = [
    getTrendingMarkets(50),
    ...searchTags.map(tag => searchMarkets(tag, 20)),
  ];
  const results = await Promise.all(fetches);
  const all = results.flat();

  const seen = new Set<string>();
  const deduped: PolymarketMarket[] = [];
  for (const m of all) {
    if (!m.active || m.closed) continue;
    const key = m.condition_id || m.market_slug;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(m);
  }

  const macro = deduped.filter(isMacroRelevant);
  macro.sort((a, b) => macroInterestScore(b) - macroInterestScore(a));
  return macro.slice(0, count);
}

export async function summarizeMacroMarkets(markets: PolymarketMarket[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (markets.length === 0) return result;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    for (const m of markets) result.set(m.condition_id, "");
    return result;
  }

  const marketsText = markets.map((m, i) => {
    const yesPrice = m.tokens.find(t => t.outcome === "Yes")?.price ?? 0;
    const noPrice = m.tokens.find(t => t.outcome === "No")?.price ?? 0;
    return `Market ${i + 1} (ID: ${m.condition_id}):
Question: ${m.question}
Description: ${(m.description || "").slice(0, 300)}
Yes: ${(yesPrice * 100).toFixed(0)}% / No: ${(noPrice * 100).toFixed(0)}%
24h Volume: $${m.volume_24h.toLocaleString()}
Total Volume: $${m.volume.toLocaleString()}
Category: ${m.category}`;
  }).join("\n\n");

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `For each prediction market below, write a 1-2 sentence summary: what is this market about and why is it noteworthy right now? Include context on recent events that may be driving the odds. Be concise and insightful.

Format your response as:
Market 1: <summary>
Market 2: <summary>
...

${marketsText}`,
      }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text : "";
    const blocks = text.split(/(?=Market\s+\d+:)/i).filter(b => b.trim());
    for (const block of blocks) {
      const match = block.match(/^Market\s+(\d+):\s*([\s\S]+)/i);
      if (match) {
        const idx = parseInt(match[1]) - 1;
        if (idx >= 0 && idx < markets.length) {
          const summary = match[2].trim().replace(/\n/g, " ").replace(/\s+/g, " ");
          result.set(markets[idx].condition_id, summary);
        }
      }
    }
  } catch (err) {
    console.error("[polymarket] summarizeMacroMarkets error:", err);
  }

  for (const m of markets) {
    if (!result.has(m.condition_id)) result.set(m.condition_id, "");
  }
  return result;
}

export async function getAppConfig(key: string): Promise<any> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = $1`, [key]);
    if (res.rows.length > 0) return res.rows[0].value;
  } catch {}
  return null;
}

export async function setAppConfig(key: string, value: any): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), Date.now()]
  );
}

const DEFAULT_BLACKLIST = [
  '0xeb25c749e9ddcbf93af9c70c7c6c2388364dcd4f',
  '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e',
  '0xc5d563a36ae78145c45a50134d48a1215220f80a',
  '0xd91e80cf2e7be2e162c6513ced06f1dd0da35296',
  '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
  '0xaacfeea03eb1561c4e67d661e40682bd20e3541b',
  '0xab45c5a4b0c941a2f231c04c3f49182e1a254052',
  '0x6a9d222616c90fca5754cd1333cfd9b7fb6a4f74',
  '0xcb1822859cef82cd2eb4e6276c7916e692995130',
  '0xd36ec33c8bed5a9f7b6630855f1533455b98a418',
  '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
];

export async function getBlacklist(): Promise<string[]> {
  return (await getAppConfig('wallet_blacklist')) || [];
}

export async function saveBlacklist(list: string[]): Promise<void> {
  await setAppConfig('wallet_blacklist', list);
}

export async function initBlacklist(): Promise<void> {
  const existing: string[] = (await getAppConfig('wallet_blacklist')) || [];
  const missing = DEFAULT_BLACKLIST.filter(a => !existing.includes(a.toLowerCase()));
  if (missing.length > 0) {
    const updated = [...existing, ...missing.map(a => a.toLowerCase())];
    await saveBlacklist(updated);
    console.log(`[blacklist] Added ${missing.length} default entries. Total: ${updated.length}`);
  }
}

export async function isBlacklisted(address: string): Promise<boolean> {
  const bl = await getBlacklist();
  return bl.includes(address.toLowerCase());
}

export function categorizeMarketTitle(title: string): string {
  const t = title.toLowerCase();
  if (/temperature|weather|rain|snow|heat|cold|°[fc]|fahrenheit|celsius/.test(t)) return 'weather';
  if (/president|election|congress|senate|governor|political|trump|biden|vote/.test(t)) return 'politics';
  if (/nfl|nba|mlb|nhl|soccer|football|basketball|baseball|hockey|sport|game|match/.test(t)) return 'sports';
  if (/bitcoin|ethereum|crypto|btc|eth|token|defi|blockchain/.test(t)) return 'crypto';
  if (/esport|league of legends|dota|csgo|valorant|gaming/.test(t)) return 'esports';
  return 'general';
}

export function determineNiche(categoryScores: Record<string, number>): string {
  const entries = Object.entries(categoryScores).filter(([k]) => k !== 'general');
  if (entries.length === 0) return 'general';
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][1] > 0.3 ? entries[0][0] : 'general';
}

export async function fetchWalletPositionsDirect(address: string): Promise<any[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(
        `${DATA_API}/positions?user=${address}&sizeThreshold=0`,
        { signal: controller.signal }
      );
      clearTimeout(timeout);
      if (res.ok) return await res.json();
      if (res.status === 429) {
        console.warn(`[polymarket] Rate limited on positions for ${address.slice(0, 10)}`);
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.error(`[polymarket] fetchWalletPositionsDirect error for ${address.slice(0, 10)}:`, err instanceof Error ? err.message : err);
  }
  return [];
}

export async function fetchRecentTrades(opts: { limit?: number; hoursBack?: number; conditionId?: string } = {}): Promise<any[]> {
  const limit = opts.limit || 500;
  const hoursBack = opts.hoursBack || 0.5;
  const startDate = Math.floor(Date.now() / 1000) - Math.floor(hoursBack * 3600);
  let url = `${DATA_API}/trades?limit=${limit}&startDate=${startDate}`;
  if (opts.conditionId) url += `&market=${opts.conditionId}`;
  try {
    return await fetchJson(url);
  } catch (err) {
    console.error("[polymarket] fetchRecentTrades error:", err instanceof Error ? err.message : err);
    return [];
  }
}

export async function fetchWalletActivity(address: string, limit: number = 100): Promise<any[]> {
  try {
    return await fetchJson(`${DATA_API}/activity?user=${address}&limit=${limit}`);
  } catch (err) {
    console.error(`[polymarket] fetchWalletActivity error for ${address.slice(0, 10)}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

export async function buildWalletFromActivity(address: string, source: "trade_mining" | "anomaly" | "manual" = "trade_mining"): Promise<WhaleWallet> {
  const activities = await fetchWalletActivity(address, 100);
  const posData = await fetchWalletPositionsDirect(address);

  const trades = activities.filter((a: any) => a.type === 'TRADE' || a.type === 'BUY' || a.type === 'SELL');
  const resolvedPositions = posData.filter((p: any) => p.redeemable || p.currentValue === 0);
  const wins = resolvedPositions.filter((p: any) => (p.cashPnl || 0) > 0).length;
  const winRate = resolvedPositions.length > 0 ? wins / resolvedPositions.length : 0;

  const totalPnl = posData.reduce((sum: number, p: any) => sum + (p.cashPnl || 0), 0);
  const totalVolume = posData.reduce((sum: number, p: any) => sum + (parseFloat(p.totalBought) || 0), 0);
  const uniqueMarkets = new Set(posData.map((p: any) => p.conditionId)).size;

  const categoryTrades: Record<string, { wins: number; total: number }> = {};
  for (const p of resolvedPositions) {
    const cat = categorizeMarketTitle(p.title || '');
    if (!categoryTrades[cat]) categoryTrades[cat] = { wins: 0, total: 0 };
    categoryTrades[cat].total++;
    if ((p.cashPnl || 0) > 0) categoryTrades[cat].wins++;
  }
  const categoryScores: Record<string, number> = {};
  for (const [cat, data] of Object.entries(categoryTrades)) {
    categoryScores[cat] = data.total > 0 ? data.wins / data.total : 0;
  }

  const now = Date.now();
  const lastActive = activities.length > 0 ? (activities[0].timestamp || 0) * 1000 || now : now;

  const wallet: WhaleWallet = {
    address: address.toLowerCase(),
    alias: `Whale-${address.slice(2, 8)}`,
    niche: determineNiche(categoryScores),
    win_rate: winRate,
    roi: totalPnl,
    total_volume: totalVolume,
    total_trades: trades.length,
    total_markets: uniqueMarkets,
    resolved_markets: resolvedPositions.length,
    category_scores: categoryScores,
    composite_score: 0,
    last_active: lastActive,
    last_checked: 0,
    added_at: now,
    source,
    enabled: true,
    observation_only: source === 'anomaly',
    degraded_count: 0,
    pending_eviction: false,
    status: 'active',
  };
  wallet.composite_score = scoreWallet(wallet);
  return wallet;
}

export async function calculateVPIN(conditionId: string): Promise<number> {
  const trades = await fetchRecentTrades({ conditionId, hoursBack: 2, limit: 200 });
  if (trades.length < 10) return 0;

  let buyVol = 0, sellVol = 0;
  for (const t of trades) {
    const vol = parseFloat(t.size || '0') * parseFloat(t.price || '0');
    if (t.side === 'BUY') buyVol += vol;
    else sellVol += vol;
  }
  const total = buyVol + sellVol;
  if (total === 0) return 0;
  return Math.abs(buyVol - sellVol) / total;
}

export async function getMarketPriceStats(conditionId: string): Promise<{ mean: number; sigma: number } | null> {
  const stats = await getAppConfig('market_price_stats');
  if (!stats || !stats[conditionId]) return null;
  return stats[conditionId];
}

export async function updateMarketPriceStats(conditionId: string, currentPrice: number): Promise<void> {
  const stats = (await getAppConfig('market_price_stats')) || {};
  const entry = stats[conditionId] || { prices: [], lastUpdated: 0 };
  entry.prices.push(currentPrice);

  const cutoff72h = Date.now() - 72 * 60 * 60 * 1000;
  if (entry.prices.length > 864) entry.prices = entry.prices.slice(-864);

  const n = entry.prices.length;
  const mean = entry.prices.reduce((s: number, v: number) => s + v, 0) / n;
  const variance = entry.prices.reduce((s: number, v: number) => s + (v - mean) ** 2, 0) / n;
  const sigma = Math.sqrt(variance);

  entry.mean = mean;
  entry.sigma = sigma;
  entry.lastUpdated = Date.now();
  stats[conditionId] = entry;
  await setAppConfig('market_price_stats', stats);
}

const NOAA_CITIES: Record<string, { lat: number; lon: number }> = {
  'nyc': { lat: 40.7128, lon: -74.0060 },
  'new york': { lat: 40.7128, lon: -74.0060 },
  'chicago': { lat: 41.8781, lon: -87.6298 },
  'seattle': { lat: 47.6062, lon: -122.3321 },
  'atlanta': { lat: 33.7490, lon: -84.3880 },
  'dallas': { lat: 32.7767, lon: -96.7970 },
  'miami': { lat: 25.7617, lon: -80.1918 },
};

export async function checkNOAAEdge(market: PolymarketMarket): Promise<number | null> {
  const title = market.question.toLowerCase();
  let city: { lat: number; lon: number } | null = null;
  for (const [name, coords] of Object.entries(NOAA_CITIES)) {
    if (title.includes(name)) { city = coords; break; }
  }
  if (!city) return null;

  const tempMatch = title.match(/(\d+)\s*°?\s*[fc]/);
  if (!tempMatch) return null;
  const threshold = parseInt(tempMatch[1]);

  try {
    const pointsRes = await fetchJson(`https://api.weather.gov/points/${city.lat},${city.lon}`);
    const forecastUrl = pointsRes?.properties?.forecastHourly;
    if (!forecastUrl) return null;

    const forecastRes = await fetchJson(forecastUrl);
    const periods = forecastRes?.properties?.periods;
    if (!Array.isArray(periods) || periods.length === 0) return null;

    const temps = periods.slice(0, 24).map((p: any) => p.temperature);
    const maxTemp = Math.max(...temps);
    const exceedProb = title.includes('exceed') || title.includes('above') || title.includes('over')
      ? (maxTemp >= threshold ? 0.94 : maxTemp >= threshold - 3 ? 0.5 : 0.06)
      : (maxTemp < threshold ? 0.94 : maxTemp < threshold + 3 ? 0.5 : 0.06);

    const yesPrice = market.tokens.find(t => t.outcome === "Yes")?.price || 0.5;
    return exceedProb - yesPrice;
  } catch (err) {
    console.error("[polymarket] NOAA check error:", err instanceof Error ? err.message : err);
    return null;
  }
}
