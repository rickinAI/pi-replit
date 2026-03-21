import { getPool } from "./db.js";
import * as polymarket from "./polymarket.js";

export interface PolymarketThesis {
  id: string;
  asset: string;
  asset_class: "polymarket";
  market_id: string;
  market_slug: string;
  direction: "YES" | "NO";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  current_odds: number;
  entry_odds: number;
  exit_odds: number;
  whale_consensus: number;
  whale_wallets: string[];
  whale_avg_score: number;
  total_whale_amount: number;
  volume: number;
  liquidity: number;
  end_date: string;
  category: string;
  sources: string[];
  reasoning: string;
  created_at: number;
  expires_at: number;
  status: "active" | "executed" | "expired" | "retired";
}

const PM_THESIS_EXPIRY_MS = 72 * 60 * 60 * 1000;

export function createPMThesisId(marketSlug: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "_");
  const rand = Math.random().toString(36).slice(2, 8);
  const slug = marketSlug.replace(/[^a-z0-9]/gi, "_").slice(0, 20);
  return `pm_${date}_${slug}_${rand}`;
}

export async function getActiveTheses(): Promise<PolymarketThesis[]> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      const now = Date.now();
      return res.rows[0].value.filter((t: PolymarketThesis) => t.status === "active" && t.expires_at > now);
    }
  } catch (err) {
    console.error("[polymarket-scout] getActiveTheses error:", err);
  }
  return [];
}

export async function saveTheses(theses: PolymarketThesis[]): Promise<void> {
  const pool = getPool();
  const existing = await getActiveTheses();
  const now = Date.now();

  const activeExisting = existing.filter(t => t.expires_at > now && t.status === "active");
  const newMarketIds = new Set(theses.map(t => t.market_id));
  const kept = activeExisting.filter(t => !newMarketIds.has(t.market_id));
  const merged = [...kept, ...theses];

  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('polymarket_scout_active_theses', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(merged), Date.now()]
  );
}

export async function retireThesis(thesisId: string): Promise<void> {
  const pool = getPool();
  const theses = await getActiveTheses();
  const updated = theses.map(t => t.id === thesisId ? { ...t, status: "retired" as const } : t);
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('polymarket_scout_active_theses', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(updated), Date.now()]
  );
}

export function buildThesis(params: {
  market: polymarket.PolymarketMarket;
  direction: "YES" | "NO";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  whale_consensus: number;
  whale_wallets: string[];
  whale_avg_score: number;
  total_whale_amount: number;
  sources: string[];
  reasoning: string;
}): PolymarketThesis {
  const now = Date.now();
  const market = params.market;

  const yesPrice = market.tokens.find(t => t.outcome === "Yes")?.price || 0;
  const noPrice = market.tokens.find(t => t.outcome === "No")?.price || 0;
  const currentOdds = params.direction === "YES" ? yesPrice : noPrice;

  const entryOdds = currentOdds;
  const exitOdds = params.direction === "YES"
    ? Math.min(currentOdds + 0.15, 0.95)
    : Math.max(currentOdds - 0.15, 0.05);

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
    status: "active",
  };
}

export function formatThesis(t: PolymarketThesis): string {
  const conf = { HIGH: "🟢", MEDIUM: "🟡", LOW: "🔴" }[t.confidence] || "⚪";
  const dir = t.direction === "YES" ? "✅ YES" : "❌ NO";
  const age = Math.round((Date.now() - t.created_at) / (60 * 60 * 1000));
  const expiry = Math.round((t.expires_at - Date.now()) / (60 * 60 * 1000));

  const lines = [
    `${conf} *${t.asset.slice(0, 80)}*`,
    `   Direction: ${dir} | Odds: ${(t.current_odds * 100).toFixed(0)}%`,
    `   Confidence: ${t.confidence} | Whales: ${t.whale_consensus} wallets`,
    `   Avg Score: ${t.whale_avg_score.toFixed(2)} | Amount: $${t.total_whale_amount.toFixed(0)}`,
    `   Volume: $${(t.volume / 1000).toFixed(0)}K | Category: ${t.category}`,
    `   Age: ${age}h | Expires: ${expiry}h | ID: \`${t.id}\``,
  ];

  return lines.join("\n");
}

export function formatThesesSummary(theses: PolymarketThesis[]): string {
  if (theses.length === 0) return "No active Polymarket theses.";
  return theses.map(formatThesis).join("\n\n");
}

async function loadPolymarketThresholds(): Promise<{
  min_wallet_score: number;
  min_whale_consensus: number;
  min_volume: number;
  min_odds: number;
  max_odds: number;
}> {
  try {
    const pool = getPool();
    const res = await pool.query("SELECT value FROM app_config WHERE key = 'polymarket_scout_parameters'");
    if (res.rows.length > 0) {
      const parsed = typeof res.rows[0].value === "string" ? JSON.parse(res.rows[0].value) : res.rows[0].value;
      return {
        min_wallet_score: parsed.min_wallet_score ?? 0.6,
        min_whale_consensus: parsed.min_whale_consensus ?? 2,
        min_volume: parsed.min_volume ?? 50000,
        min_odds: parsed.min_odds ?? 0.15,
        max_odds: parsed.max_odds ?? 0.85,
      };
    }
  } catch {
  }
  return { min_wallet_score: 0.6, min_whale_consensus: 2, min_volume: 50000, min_odds: 0.15, max_odds: 0.85 };
}

export async function meetsThesisThresholds(params: {
  whale_score: number;
  whale_consensus: number;
  market_volume: number;
  market_liquidity: number;
  odds: number;
  hours_to_resolution: number;
}): Promise<{ meets: boolean; failures: string[] }> {
  const thresholds = await loadPolymarketThresholds();
  const failures: string[] = [];

  if (params.whale_score < thresholds.min_wallet_score) failures.push(`Wallet score ${params.whale_score.toFixed(2)} < ${thresholds.min_wallet_score}`);
  if (params.whale_consensus < thresholds.min_whale_consensus) failures.push(`Consensus ${params.whale_consensus} < ${thresholds.min_whale_consensus} whales`);
  if (params.market_volume < thresholds.min_volume) failures.push(`Volume $${params.market_volume.toFixed(0)} < $${thresholds.min_volume}`);
  if (params.odds < thresholds.min_odds || params.odds > thresholds.max_odds) failures.push(`Odds ${(params.odds * 100).toFixed(0)}% outside ${(thresholds.min_odds * 100).toFixed(0)}-${(thresholds.max_odds * 100).toFixed(0)}% range`);
  if (params.hours_to_resolution < 24) failures.push(`Resolution in ${params.hours_to_resolution.toFixed(0)}h < 24h minimum`);

  return { meets: failures.length === 0, failures };
}
