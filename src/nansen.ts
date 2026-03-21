import * as fs from "fs";
import * as path from "path";

const NANSEN_API_KEY = process.env.NANSEN_API_KEY || "";
const BASE_URL = "https://api.nansen.ai/v1";
const CACHE_DIR = path.join(process.env.HOME || "/tmp", ".cache", "nansen");
const TIMEOUT_MS = 15_000;

interface CacheEntry<T> {
  fetchedAt: number;
  data: T;
}

const CACHE_TTL: Record<string, number> = {
  smart_money: 30 * 60 * 1000,
  token_holders: 60 * 60 * 1000,
  hot_contracts: 15 * 60 * 1000,
};

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getCached<T>(key: string, ttlMs: number): T | null {
  ensureCacheDir();
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(cacheFile)) return null;
  try {
    const raw = fs.readFileSync(cacheFile, "utf-8");
    const entry: CacheEntry<T> = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt < ttlMs) return entry.data;
  } catch {}
  return null;
}

function setCache<T>(key: string, data: T): void {
  ensureCacheDir();
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: Date.now(), data }));
  } catch (err) {
    console.warn("[nansen] cache write error:", err);
  }
}

export function isConfigured(): boolean {
  return NANSEN_API_KEY.length > 0;
}

async function nansenFetch(endpoint: string): Promise<any> {
  if (!isConfigured()) {
    throw new Error("Nansen API key not configured. Set NANSEN_API_KEY environment variable.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${BASE_URL}${endpoint}`;
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${NANSEN_API_KEY}`,
        "Content-Type": "application/json",
        "User-Agent": "darknode/1.0",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Nansen API error ${res.status}: ${text}`);
    }
    return await res.json();
  } catch (err: any) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Nansen request timed out");
    throw err;
  }
}

export interface SmartMoneyFlow {
  token: string;
  net_flow_usd: number;
  inflow_usd: number;
  outflow_usd: number;
  smart_money_wallets_buying: number;
  smart_money_wallets_selling: number;
  direction: "inflow" | "outflow" | "neutral";
  confidence: "high" | "medium" | "low";
}

export async function getSmartMoneyFlow(token: string): Promise<SmartMoneyFlow> {
  const cacheKey = `smart_money_${token.toLowerCase()}`;
  const cached = getCached<SmartMoneyFlow>(cacheKey, CACHE_TTL.smart_money);
  if (cached) return cached;

  if (!isConfigured()) {
    return {
      token,
      net_flow_usd: 0,
      inflow_usd: 0,
      outflow_usd: 0,
      smart_money_wallets_buying: 0,
      smart_money_wallets_selling: 0,
      direction: "neutral",
      confidence: "low",
    };
  }

  try {
    const data = await nansenFetch(`/smart-money/token/${encodeURIComponent(token)}`);
    const result: SmartMoneyFlow = {
      token,
      net_flow_usd: data.net_flow_usd || 0,
      inflow_usd: data.inflow_usd || 0,
      outflow_usd: data.outflow_usd || 0,
      smart_money_wallets_buying: data.wallets_buying || 0,
      smart_money_wallets_selling: data.wallets_selling || 0,
      direction: (data.net_flow_usd || 0) > 0 ? "inflow" : (data.net_flow_usd || 0) < 0 ? "outflow" : "neutral",
      confidence: Math.abs(data.net_flow_usd || 0) > 1_000_000 ? "high" : Math.abs(data.net_flow_usd || 0) > 100_000 ? "medium" : "low",
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
      confidence: "low",
    };
  }
}

export interface TokenHolderInfo {
  token: string;
  total_holders: number;
  whale_holders: number;
  whale_concentration_pct: number;
  holder_change_24h: number;
  whale_activity: "accumulating" | "distributing" | "stable";
}

export async function getTokenHolders(token: string): Promise<TokenHolderInfo> {
  const cacheKey = `token_holders_${token.toLowerCase()}`;
  const cached = getCached<TokenHolderInfo>(cacheKey, CACHE_TTL.token_holders);
  if (cached) return cached;

  if (!isConfigured()) {
    return {
      token,
      total_holders: 0,
      whale_holders: 0,
      whale_concentration_pct: 0,
      holder_change_24h: 0,
      whale_activity: "stable",
    };
  }

  try {
    const data = await nansenFetch(`/token/${encodeURIComponent(token)}/holders`);
    const result: TokenHolderInfo = {
      token,
      total_holders: data.total_holders || 0,
      whale_holders: data.whale_holders || 0,
      whale_concentration_pct: data.whale_concentration_pct || 0,
      holder_change_24h: data.holder_change_24h || 0,
      whale_activity: (data.holder_change_24h || 0) > 5 ? "accumulating" : (data.holder_change_24h || 0) < -5 ? "distributing" : "stable",
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
      whale_activity: "stable",
    };
  }
}

export interface HotContract {
  address: string;
  name: string;
  chain: string;
  interaction_count_24h: number;
  unique_wallets_24h: number;
  smart_money_interactions: number;
  category: string;
}

export async function getHotContracts(chain: string = "ethereum", limit: number = 10): Promise<HotContract[]> {
  const cacheKey = `hot_contracts_${chain.toLowerCase()}`;
  const cached = getCached<HotContract[]>(cacheKey, CACHE_TTL.hot_contracts);
  if (cached) return cached;

  if (!isConfigured()) {
    return [];
  }

  try {
    const data = await nansenFetch(`/hot-contracts?chain=${encodeURIComponent(chain)}&limit=${limit}`);
    const contracts: HotContract[] = (data.contracts || []).map((c: any) => ({
      address: c.address || "",
      name: c.name || "Unknown",
      chain: c.chain || chain,
      interaction_count_24h: c.interaction_count_24h || 0,
      unique_wallets_24h: c.unique_wallets_24h || 0,
      smart_money_interactions: c.smart_money_interactions || 0,
      category: c.category || "unknown",
    }));
    setCache(cacheKey, contracts);
    return contracts;
  } catch (err) {
    console.error(`[nansen] hot contracts failed for ${chain}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

export function formatSmartMoney(flow: SmartMoneyFlow): string {
  const arrow = flow.direction === "inflow" ? "🟢 INFLOW" : flow.direction === "outflow" ? "🔴 OUTFLOW" : "⚪ NEUTRAL";
  return [
    `Nansen Smart Money: ${flow.token}`,
    `${arrow} (confidence: ${flow.confidence})`,
    `Net flow: $${(flow.net_flow_usd / 1e6).toFixed(2)}M`,
    `Inflow: $${(flow.inflow_usd / 1e6).toFixed(2)}M | Outflow: $${(flow.outflow_usd / 1e6).toFixed(2)}M`,
    `Wallets buying: ${flow.smart_money_wallets_buying} | Selling: ${flow.smart_money_wallets_selling}`,
  ].join("\n");
}
