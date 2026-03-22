import { getPool } from "./db.js";
import * as bnkr from "./bnkr.js";

export interface TradeThesis {
  id: string;
  asset: string;
  asset_id: string;
  asset_class: "crypto" | "polymarket";
  direction: "LONG" | "SHORT";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  technical_score: number;
  vote_count: string;
  market_regime: string;
  entry_price: number;
  exit_price: number;
  stop_price: number;
  atr_value: number;
  time_horizon: string;
  sources: string[];
  backtest_score: number | null;
  nansen_flow_direction: string | null;
  created_at: number;
  expires_at: number;
  status: "active" | "executed" | "expired" | "retired";
  reasoning: string;
}

const THESIS_EXPIRY_MS = 72 * 60 * 60 * 1000;

export function createThesisId(asset: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "_");
  const rand = Math.random().toString(36).slice(2, 8);
  return `scout_${date}_${asset.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${rand}`;
}

export async function saveTheses(theses: TradeThesis[]): Promise<void> {
  const pool = getPool();
  const existing = await getActiveTheses();

  const expiredIds = new Set<string>();
  const now = Date.now();
  for (const t of existing) {
    if (t.expires_at < now) {
      expiredIds.add(t.id);
    }
  }

  const activeExisting = existing.filter(t => !expiredIds.has(t.id) && t.status === "active");

  const newAssetIds = new Set(theses.map(t => t.asset_id));
  const kept = activeExisting.filter(t => !newAssetIds.has(t.asset_id));

  const merged = [...kept, ...theses];

  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('scout_active_theses', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(merged), Date.now()]
  );
}

export async function getActiveTheses(): Promise<TradeThesis[]> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'scout_active_theses'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      const now = Date.now();
      return res.rows[0].value.filter((t: TradeThesis) => t.status === "active" && t.expires_at > now);
    }
  } catch (err) {
    console.error("[crypto-scout] getActiveTheses failed:", err);
  }
  return [];
}

export async function retireThesis(thesisId: string): Promise<void> {
  const pool = getPool();
  const theses = await getActiveTheses();
  const updated = theses.map(t => t.id === thesisId ? { ...t, status: "retired" as const } : t);
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('scout_active_theses', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(updated), Date.now()]
  );
}

export async function getWatchlist(): Promise<string[]> {
  const pool = getPool();
  const defaults = ["bitcoin", "ethereum", "solana", "bankr"];
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'scout_watchlist'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      const wl = res.rows[0].value as string[];
      const merged = new Set([...defaults, ...wl]);
      return Array.from(merged);
    }
  } catch {}
  return defaults;
}

export async function updateWatchlist(assets: string[]): Promise<void> {
  const pool = getPool();
  const defaults = ["bitcoin", "ethereum", "solana", "bankr"];
  const merged = Array.from(new Set([...defaults, ...assets]));
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('scout_watchlist', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(merged), Date.now()]
  );
}

export async function saveLatestBrief(brief: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('scout_latest_brief', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(brief), Date.now()]
  );
}

export async function getSignalParameters(): Promise<Record<string, any> | null> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'crypto_signal_parameters'`);
    if (res.rows.length > 0 && res.rows[0].value) {
      return res.rows[0].value as Record<string, any>;
    }
  } catch {}
  return null;
}

export function buildThesis(params: {
  asset: string;
  asset_id: string;
  direction: "LONG" | "SHORT";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  technical_score: number;
  vote_count: string;
  market_regime: string;
  entry_price: number;
  exit_price: number;
  stop_price: number;
  atr_value: number;
  sources: string[];
  backtest_score?: number | null;
  nansen_flow_direction?: string | null;
  reasoning: string;
  time_horizon?: string;
}): TradeThesis {
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
    reasoning: params.reasoning,
  };
}

export function formatThesis(t: TradeThesis): string {
  const conf = { HIGH: "🟢", MEDIUM: "🟡", LOW: "🔴" }[t.confidence] || "⚪";
  const dir = t.direction === "LONG" ? "📈 LONG" : "📉 SHORT";
  const age = Math.round((Date.now() - t.created_at) / (60 * 60 * 1000));
  const expiry = Math.round((t.expires_at - Date.now()) / (60 * 60 * 1000));

  const lines = [
    `${conf} *${t.asset}* — ${dir}`,
    `   Score: ${t.technical_score.toFixed(3)} | Votes: ${t.vote_count} | Regime: ${t.market_regime}`,
    `   Entry: $${t.entry_price.toFixed(2)} | Stop: $${t.stop_price.toFixed(2)} | Target: $${t.exit_price.toFixed(2)}`,
    `   Sources: ${t.sources.join(", ")}`,
  ];
  if (t.nansen_flow_direction) lines.push(`   Nansen: ${t.nansen_flow_direction}`);
  if (t.backtest_score != null) lines.push(`   Backtest: ${t.backtest_score.toFixed(2)}`);
  lines.push(`   Age: ${age}h | Expires: ${expiry}h | ID: \`${t.id}\``);

  return lines.join("\n");
}

export function formatThesesSummary(theses: TradeThesis[]): string {
  if (theses.length === 0) return "No active theses.";
  return theses.map(formatThesis).join("\n\n");
}

export async function enrichThesesWithBnkr(theses: TradeThesis[]): Promise<{ theses: TradeThesis[]; chartUrls: string[] }> {
  if (!bnkr.isPromptConfigured() || theses.length === 0) {
    return { theses, chartUrls: [] };
  }

  const chartUrls: string[] = [];
  const enriched: TradeThesis[] = [];

  for (const thesis of theses.slice(0, 5)) {
    let updated = { ...thesis };
    try {
      const research = await bnkr.researchToken(thesis.asset);
      if (research.analysis) {
        const summary = research.analysis.length > 300 ? research.analysis.slice(0, 300) + '...' : research.analysis;
        updated.reasoning = `${updated.reasoning}\n\nBNKR Research: ${summary}`;
        if (!updated.sources.includes("bnkr_research")) {
          updated.sources = [...updated.sources, "bnkr_research"];
        }
      }
      if (research.chartUrl) {
        chartUrls.push(research.chartUrl);
      }
    } catch (err) {
      console.warn(`[crypto-scout] BNKR enrichment for ${thesis.asset} failed:`, err instanceof Error ? err.message : err);
    }
    enriched.push(updated);
  }

  return { theses: [...enriched, ...theses.slice(5)], chartUrls };
}

export async function getBnkrTrendingCandidates(): Promise<string[]> {
  if (!bnkr.isPromptConfigured()) return [];
  try {
    const trending = await bnkr.getTrendingTokens();
    if (trending.tokens && trending.tokens.length > 0) {
      return trending.tokens.map(t => t.symbol.toLowerCase());
    }
  } catch (err) {
    console.warn("[crypto-scout] BNKR trending fetch failed:", err instanceof Error ? err.message : err);
  }
  return [];
}
