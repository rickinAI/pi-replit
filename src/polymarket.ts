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
    const url = `${GAMMA_API}/markets/${conditionId}`;
    const data = await fetchJson(url);
    const result = normalizeMarket(data);
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

  const monthsSinceAdded = Math.max(1, (Date.now() - (wallet as any).added_at) / (30 * 24 * 60 * 60 * 1000));
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
