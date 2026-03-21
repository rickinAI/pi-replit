import { getPool } from "./db.js";
import { analyzeAsset, invalidateCryptoParamsCache, type SignalConfig } from "./technical-signals.js";
import { getHistoricalOHLCV, type OHLCVCandle } from "./coingecko.js";

const DB_KEYS = {
  cryptoParams: "crypto_signal_parameters",
  polymarketParams: "polymarket_scout_parameters",
  experimentLog: "autoresearch_experiment_log",
  cryptoHistory: "autoresearch_crypto_history",
  polymarketHistory: "autoresearch_polymarket_history",
};

const MAX_EXPERIMENTS_LOG = 500;
const MAX_PARAM_HISTORY = 5;
const MIN_IMPROVEMENT_PCT = 0.5;
const MAX_DRIFT_PCT = 30;

export interface ParameterDef {
  name: string;
  min: number;
  max: number;
  step: number;
  type: "int" | "float";
}

export interface ExperimentResult {
  experiment_id: string;
  domain: "crypto" | "polymarket";
  parameters_changed: Record<string, { old: number; new: number }>;
  hypothesis: string;
  old_score: number;
  new_score: number;
  delta: number;
  delta_pct: number;
  outcome: "kept" | "reverted";
  timestamp: number;
  details?: Record<string, number>;
}

export interface BacktestResult {
  score: number;
  trades: number;
  wins: number;
  losses: number;
  total_pnl: number;
  max_drawdown_pct: number;
  sharpe?: number;
  win_rate: number;
  details: Record<string, number>;
}

export interface ResearchRunSummary {
  domain: "crypto" | "polymarket";
  experiments_run: number;
  improvements_found: number;
  best_delta: number;
  score_before: number;
  score_after: number;
  parameters_changed: string[];
  duration_ms: number;
}

export interface PolymarketParams {
  min_wallet_score: number;
  min_whale_consensus: number;
  min_odds: number;
  max_odds: number;
  min_volume: number;
  exit_odds_threshold: number;
  stale_position_hours: number;
  conviction_lookback_days: number;
  tier1_size_pct: number;
  tier2_size_pct: number;
  tier3_size_pct: number;
  category_weight_politics: number;
  category_weight_crypto: number;
  category_weight_sports: number;
  category_weight_other: number;
}

async function getConfigValue<T>(key: string, fallback: T): Promise<T> {
  try {
    const pool = getPool();
    const res = await pool.query("SELECT value FROM app_config WHERE key = $1", [key]);
    if (res.rows.length > 0) {
      const parsed = typeof res.rows[0].value === "string" ? JSON.parse(res.rows[0].value) : res.rows[0].value;
      return parsed as T;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

async function setConfigValue(key: string, value: unknown): Promise<void> {
  const pool = getPool();
  const json = JSON.stringify(value);
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3`,
    [key, json, new Date().toISOString()]
  );
}

const CRYPTO_PARAM_SPACE: ParameterDef[] = [
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
  { name: "atr_stop_multiplier", min: 2.0, max: 8.0, step: 0.5, type: "float" },
  { name: "vote_threshold", min: 2, max: 6, step: 1, type: "int" },
  { name: "cooldown_bars", min: 1, max: 5, step: 1, type: "int" },
];

const POLYMARKET_PARAM_SPACE: ParameterDef[] = [
  { name: "min_wallet_score", min: 0.3, max: 0.9, step: 0.05, type: "float" },
  { name: "min_whale_consensus", min: 1, max: 5, step: 1, type: "int" },
  { name: "min_odds", min: 0.05, max: 0.30, step: 0.05, type: "float" },
  { name: "max_odds", min: 0.70, max: 0.95, step: 0.05, type: "float" },
  { name: "min_volume", min: 10000, max: 100000, step: 10000, type: "int" },
  { name: "exit_odds_threshold", min: 0.05, max: 0.25, step: 0.05, type: "float" },
  { name: "stale_position_hours", min: 24, max: 168, step: 24, type: "int" },
  { name: "conviction_lookback_days", min: 7, max: 90, step: 7, type: "int" },
  { name: "tier1_size_pct", min: 1, max: 5, step: 0.5, type: "float" },
  { name: "tier2_size_pct", min: 2, max: 8, step: 0.5, type: "float" },
  { name: "tier3_size_pct", min: 3, max: 12, step: 0.5, type: "float" },
  { name: "category_weight_politics", min: 0.5, max: 2.0, step: 0.1, type: "float" },
  { name: "category_weight_crypto", min: 0.5, max: 2.0, step: 0.1, type: "float" },
  { name: "category_weight_sports", min: 0.5, max: 2.0, step: 0.1, type: "float" },
  { name: "category_weight_other", min: 0.5, max: 2.0, step: 0.1, type: "float" },
];

const DEFAULT_CRYPTO_PARAMS: Partial<SignalConfig> = {
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
};

const DEFAULT_POLYMARKET_PARAMS: PolymarketParams = {
  min_wallet_score: 0.6,
  min_whale_consensus: 2,
  min_odds: 0.15,
  max_odds: 0.85,
  min_volume: 50000,
  exit_odds_threshold: 0.10,
  stale_position_hours: 72,
  conviction_lookback_days: 30,
  tier1_size_pct: 2,
  tier2_size_pct: 3,
  tier3_size_pct: 5,
  category_weight_politics: 1.0,
  category_weight_crypto: 1.2,
  category_weight_sports: 0.8,
  category_weight_other: 0.9,
};

function clampToRange(value: number, def: ParameterDef): number {
  const clamped = Math.max(def.min, Math.min(def.max, value));
  if (def.type === "int") return Math.round(clamped);
  return Math.round(clamped / def.step) * def.step;
}

function checkDrift(oldVal: number, newVal: number, maxDriftPct: number): boolean {
  if (oldVal === 0) return Math.abs(newVal) <= 1;
  return Math.abs((newVal - oldVal) / oldVal) * 100 <= maxDriftPct;
}

function mutateParams(
  current: Record<string, number>,
  paramSpace: ParameterDef[],
  count: number = 2
): { mutated: Record<string, number>; changed: Record<string, { old: number; new: number }> } {
  const mutated = { ...current };
  const changed: Record<string, { old: number; new: number }> = {};
  const numericParams = paramSpace.filter(p => current[p.name] !== undefined);
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

function generateHypothesis(changed: Record<string, { old: number; new: number }>, domain: string): string {
  const parts: string[] = [];
  for (const [name, { old: o, new: n }] of Object.entries(changed)) {
    const dir = n > o ? "increasing" : "decreasing";
    parts.push(`${dir} ${name} from ${o} to ${n}`);
  }
  return `${domain} parameter mutation: ${parts.join(", ")}`;
}

interface SimTrade {
  entry_bar: number;
  exit_bar: number;
  entry_price: number;
  exit_price: number;
  direction: "LONG" | "SHORT";
  pnl: number;
  pnl_pct: number;
}

function runCryptoBacktest(candles: OHLCVCandle[], params: Partial<SignalConfig>): BacktestResult {
  if (candles.length < 50) {
    return { score: 0, trades: 0, wins: 0, losses: 0, total_pnl: 0, max_drawdown_pct: 0, sharpe: 0, win_rate: 0, details: {} };
  }

  const trades: SimTrade[] = [];
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
      const heldTooLong = (i - entryBar) > 72;

      if (hitStop || exitSignal || heldTooLong) {
        const pnl = currentPrice - entryPrice;
        const pnl_pct = (pnl / entryPrice) * 100;
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
    trades.push({ entry_bar: entryBar, exit_bar: candles.length - 1, entry_price: entryPrice, exit_price: finalPrice, direction: "LONG", pnl, pnl_pct: (pnl / entryPrice) * 100 });
  }

  return scoreCryptoResult(trades);
}

function scoreCryptoResult(trades: SimTrade[]): BacktestResult {
  if (trades.length === 0) {
    return { score: 0, trades: 0, wins: 0, losses: 0, total_pnl: 0, max_drawdown_pct: 0, sharpe: 0, win_rate: 0, details: {} };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl_pct, 0);
  const winRate = wins.length / trades.length;

  const returns = trades.map(t => t.pnl_pct);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252 / Math.max(1, trades.length)) : 0;

  let peak = 0;
  let equity = 0;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.pnl_pct;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : (equity < 0 ? Math.abs(equity) : 0);
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
      turnover_penalty: turnoverPenalty,
    },
  };
}

interface PMSimMarket {
  market_id: string;
  question: string;
  outcome: "YES" | "NO";
  entry_odds: number;
  resolution_odds: number;
  whale_count: number;
  avg_whale_score: number;
  volume: number;
  category: string;
}

function runPolymarketBacktest(markets: PMSimMarket[], params: PolymarketParams): BacktestResult {
  if (markets.length === 0) {
    return { score: 0, trades: 0, wins: 0, losses: 0, total_pnl: 0, max_drawdown_pct: 0, win_rate: 0, details: {} };
  }

  const trades: { pnl_pct: number; won: boolean }[] = [];

  for (const m of markets) {
    if (m.avg_whale_score < params.min_wallet_score) continue;
    if (m.whale_count < params.min_whale_consensus) continue;
    if (m.entry_odds < params.min_odds || m.entry_odds > params.max_odds) continue;
    if (m.volume < params.min_volume) continue;

    const categoryKey = `category_weight_${m.category.toLowerCase()}` as keyof PolymarketParams;
    const categoryWeight = (typeof params[categoryKey] === "number" ? params[categoryKey] : params.category_weight_other) as number;
    if (categoryWeight < 0.5) continue;

    let sizePct: number;
    if (m.avg_whale_score >= 0.8) sizePct = params.tier3_size_pct;
    else if (m.avg_whale_score >= 0.65) sizePct = params.tier2_size_pct;
    else sizePct = params.tier1_size_pct;

    const won = m.resolution_odds >= 0.95;
    const exitOdds = won ? 1.0 : Math.max(0, m.entry_odds - params.exit_odds_threshold);
    const pnlPerUnit = won ? (1.0 - m.entry_odds) : (exitOdds - m.entry_odds);
    const pnl_pct = pnlPerUnit * sizePct * categoryWeight;

    trades.push({ pnl_pct, won });
  }

  if (trades.length === 0) {
    return { score: 0, trades: 0, wins: 0, losses: 0, total_pnl: 0, max_drawdown_pct: 0, win_rate: 0, details: {} };
  }

  const wins = trades.filter(t => t.won);
  const totalPnl = trades.reduce((s, t) => s + t.pnl_pct, 0);
  const winRate = wins.length / trades.length;

  let peak = 0;
  let equity = 0;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.pnl_pct;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : (equity < 0 ? Math.abs(equity) : 0);
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
      drawdown_penalty: drawdownPenalty,
    },
  };
}

export async function getCryptoParams(): Promise<Partial<SignalConfig>> {
  return getConfigValue<Partial<SignalConfig>>(DB_KEYS.cryptoParams, DEFAULT_CRYPTO_PARAMS);
}

export async function getPolymarketParams(): Promise<PolymarketParams> {
  return getConfigValue<PolymarketParams>(DB_KEYS.polymarketParams, DEFAULT_POLYMARKET_PARAMS);
}

export async function getExperimentLog(): Promise<ExperimentResult[]> {
  return getConfigValue<ExperimentResult[]>(DB_KEYS.experimentLog, []);
}

async function appendExperiment(exp: ExperimentResult): Promise<void> {
  const log = await getExperimentLog();
  log.push(exp);
  if (log.length > MAX_EXPERIMENTS_LOG) log.splice(0, log.length - MAX_EXPERIMENTS_LOG);
  await setConfigValue(DB_KEYS.experimentLog, log);
}

async function pushParamHistory(domain: "crypto" | "polymarket", params: Record<string, number>): Promise<void> {
  const key = domain === "crypto" ? DB_KEYS.cryptoHistory : DB_KEYS.polymarketHistory;
  const history = await getConfigValue<Record<string, number>[]>(key, []);
  history.push(params);
  if (history.length > MAX_PARAM_HISTORY) history.splice(0, history.length - MAX_PARAM_HISTORY);
  await setConfigValue(key, history);
}

export async function getParamHistory(domain: "crypto" | "polymarket"): Promise<Record<string, number>[]> {
  const key = domain === "crypto" ? DB_KEYS.cryptoHistory : DB_KEYS.polymarketHistory;
  return getConfigValue<Record<string, number>[]>(key, []);
}

export async function rollbackParams(domain: "crypto" | "polymarket"): Promise<{ success: boolean; message: string }> {
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

async function buildPMSimMarkets(): Promise<PMSimMarket[]> {
  const pool = getPool();
  try {
    const res = await pool.query(
      `SELECT value FROM app_config WHERE key = 'wealth_engines_trade_history'`
    );
    if (res.rows.length === 0) return [];

    const trades = typeof res.rows[0].value === "string"
      ? JSON.parse(res.rows[0].value)
      : res.rows[0].value;

    const pmTrades = (trades as Array<{
      asset_class?: string;
      market_id?: string;
      asset?: string;
      direction?: string;
      entry_price?: number;
      exit_price?: number;
      pnl?: number;
      source?: string;
      closed_at?: string;
    }>).filter(
      (t) => t.asset_class === "polymarket" && t.closed_at
    );

    const markets: PMSimMarket[] = pmTrades.map((t) => ({
      market_id: t.market_id || "unknown",
      question: t.asset || "Unknown Market",
      outcome: (t.direction === "YES" || t.direction === "NO" ? t.direction : "YES") as "YES" | "NO",
      entry_odds: t.entry_price || 0.5,
      resolution_odds: (t.pnl || 0) > 0 ? 1.0 : 0.0,
      whale_count: 2,
      avg_whale_score: 0.7,
      volume: 100000,
      category: "other",
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

function generateSyntheticPMMarkets(count: number): PMSimMarket[] {
  const categories = ["politics", "crypto", "sports", "other"];
  const markets: PMSimMarket[] = [];

  for (let i = 0; i < count; i++) {
    const odds = 0.2 + Math.random() * 0.6;
    const won = Math.random() > (1 - odds);
    markets.push({
      market_id: `synthetic_${i}`,
      question: `Synthetic market ${i}`,
      outcome: "YES",
      entry_odds: odds,
      resolution_odds: won ? 1.0 : 0.0,
      whale_count: 1 + Math.floor(Math.random() * 4),
      avg_whale_score: 0.4 + Math.random() * 0.5,
      volume: 20000 + Math.random() * 200000,
      category: categories[Math.floor(Math.random() * categories.length)],
    });
  }

  return markets;
}

export async function runCryptoResearch(experimentsCount: number = 15): Promise<ResearchRunSummary> {
  const start = Date.now();
  const currentParams = await getCryptoParams();
  const currentRecord = currentParams as Record<string, number>;

  let candles: OHLCVCandle[];
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
        duration_ms: Date.now() - start,
      };
    }
  }

  const baseline = runCryptoBacktest(candles, currentParams);
  let bestScore = baseline.score;
  let bestParams = { ...currentRecord };
  let improvements = 0;
  const allChanged: string[] = [];

  for (let i = 0; i < experimentsCount; i++) {
    const muteCount = 1 + Math.floor(Math.random() * 3);
    const { mutated, changed } = mutateParams(bestParams, CRYPTO_PARAM_SPACE, muteCount);
    if (Object.keys(changed).length === 0) continue;

    const hypothesis = generateHypothesis(changed, "crypto");
    const result = runCryptoBacktest(candles, mutated as Partial<SignalConfig>);
    const delta = result.score - bestScore;
    const deltaPct = bestScore > 0 ? (delta / bestScore) * 100 : (result.score > 0 ? 100 : 0);

    const experiment: ExperimentResult = {
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
      details: result.details,
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
    duration_ms: Date.now() - start,
  };
}

export async function runPolymarketResearch(experimentsCount: number = 15): Promise<ResearchRunSummary> {
  const start = Date.now();
  const currentParams = await getPolymarketParams();
  const currentRecord = currentParams as unknown as Record<string, number>;

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
      duration_ms: Date.now() - start,
    };
  }

  const baseline = runPolymarketBacktest(markets, currentParams);
  let bestScore = baseline.score;
  let bestParams = { ...currentRecord };
  let improvements = 0;
  const allChanged: string[] = [];

  for (let i = 0; i < experimentsCount; i++) {
    const muteCount = 1 + Math.floor(Math.random() * 3);
    const { mutated, changed } = mutateParams(bestParams, POLYMARKET_PARAM_SPACE, muteCount);
    if (Object.keys(changed).length === 0) continue;

    const hypothesis = generateHypothesis(changed, "polymarket");
    const result = runPolymarketBacktest(markets, mutated as unknown as PolymarketParams);
    const delta = result.score - bestScore;
    const deltaPct = bestScore > 0 ? (delta / bestScore) * 100 : (result.score > 0 ? 100 : 0);

    const experiment: ExperimentResult = {
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
      details: result.details,
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
    duration_ms: Date.now() - start,
  };
}

export async function runFullResearch(experimentsPerDomain: number = 15): Promise<ResearchRunSummary[]> {
  const crypto = await runCryptoResearch(experimentsPerDomain);
  const pm = await runPolymarketResearch(experimentsPerDomain);
  return [crypto, pm];
}

export function formatResearchSummary(summaries: ResearchRunSummary[]): string {
  const lines: string[] = ["🔬 *Autoresearch Results*\n"];

  for (const s of summaries) {
    const domain = s.domain === "crypto" ? "📊 Crypto Signals" : "🎯 Polymarket";
    lines.push(`*${domain}*`);
    lines.push(`  Experiments: ${s.experiments_run}`);
    lines.push(`  Improvements: ${s.improvements_found}`);
    lines.push(`  Score: ${s.score_before.toFixed(3)} → ${s.score_after.toFixed(3)} (${s.best_delta >= 0 ? "+" : ""}${s.best_delta.toFixed(3)})`);
    if (s.parameters_changed.length > 0) {
      lines.push(`  Changed: ${s.parameters_changed.join(", ")}`);
    }
    lines.push(`  Duration: ${(s.duration_ms / 1000).toFixed(1)}s`);
    lines.push("");
  }

  return lines.join("\n");
}

export async function getResearchStatus(): Promise<{
  crypto_params: Partial<SignalConfig>;
  polymarket_params: PolymarketParams;
  recent_experiments: ExperimentResult[];
  crypto_history_count: number;
  polymarket_history_count: number;
}> {
  const [cryptoParams, pmParams, log, cryptoHist, pmHist] = await Promise.all([
    getCryptoParams(),
    getPolymarketParams(),
    getExperimentLog(),
    getParamHistory("crypto"),
    getParamHistory("polymarket"),
  ]);

  return {
    crypto_params: cryptoParams,
    polymarket_params: pmParams,
    recent_experiments: log.slice(-20),
    crypto_history_count: cryptoHist.length,
    polymarket_history_count: pmHist.length,
  };
}
