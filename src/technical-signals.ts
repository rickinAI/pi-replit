import type { OHLCVCandle } from "./coingecko.js";
import { getPool } from "./db.js";

export type MarketRegime = "TRENDING" | "RANGING" | "VOLATILE";

export interface SignalResult {
  name: string;
  score: number;
  enabled: boolean;
  detail: string;
  bull_vote: boolean;
  bear_vote: boolean;
}

export interface VoteResult {
  bull_votes: number;
  bear_votes: number;
  total_signals: number;
  vote_summary: string;
  entry_signal: boolean;
  exit_long_signal: boolean;
  exit_short_signal: boolean;
  rsi_overbought: boolean;
  rsi_oversold: boolean;
}

export interface BTCConfirmation {
  btc_momentum_bull: boolean;
  btc_momentum_bear: boolean;
  alt_entry_allowed: boolean;
  detail: string;
}

export interface EnsembleResult {
  technical_score: number;
  regime: MarketRegime;
  atr_value: number;
  atr_stop_price: number;
  atr_stop_multiplier: number;
  current_price: number;
  signals: SignalResult[];
  votes: VoteResult;
  active_signal_count: number;
  data_quality: "sufficient" | "insufficient";
  parameters_validated: boolean;
  vol_adjusted_threshold: number;
  btc_confirmation?: BTCConfirmation;
  cooldown?: { in_cooldown: boolean; detail: string };
  reason?: string;
}

export interface SignalConfig {
  ema_fast: number;
  ema_slow: number;
  rsi_period: number;
  rsi_overbought: number;
  rsi_oversold: number;
  momentum_lookback: number;
  very_short_momentum_lookback: number;
  macd_fast: number;
  macd_slow: number;
  macd_signal: number;
  bb_period: number;
  bb_percentile_threshold: number;
  vol_lookback_bars: number;
  atr_period: number;
  atr_stop_multiplier: number;
  vote_threshold: number;
  cooldown_bars: number;
  enable_ema: boolean;
  enable_rsi: boolean;
  enable_momentum: boolean;
  enable_very_short_momentum: boolean;
  enable_macd: boolean;
  enable_bb: boolean;
  enable_volatility_regime: boolean;
}

const DEFAULT_CONFIG: SignalConfig = {
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
  enable_volatility_regime: true,
};

let _dbParamsCache: Partial<SignalConfig> | null = null;
let _dbParamsCacheTime = 0;
const DB_PARAMS_CACHE_TTL = 300_000;

export async function loadCryptoSignalParams(): Promise<Partial<SignalConfig>> {
  const now = Date.now();
  if (_dbParamsCache && (now - _dbParamsCacheTime) < DB_PARAMS_CACHE_TTL) {
    return _dbParamsCache;
  }
  try {
    const pool = getPool();
    const res = await pool.query("SELECT value FROM app_config WHERE key = 'crypto_signal_parameters'");
    if (res.rows.length > 0) {
      const parsed = typeof res.rows[0].value === "string" ? JSON.parse(res.rows[0].value) : res.rows[0].value;
      _dbParamsCache = parsed as Partial<SignalConfig>;
      _dbParamsCacheTime = now;
      return _dbParamsCache;
    }
  } catch {
  }
  return {};
}

export function invalidateCryptoParamsCache(): void {
  _dbParamsCache = null;
  _dbParamsCacheTime = 0;
}

const cooldownTracker: Map<string, { lastSignalTime: number; lastSignalType: "entry" | "exit" }> = new Map();
const BAR_INTERVAL_MS = 60 * 60 * 1000;

export function checkCooldown(assetId: string, cooldownBars: number = DEFAULT_CONFIG.cooldown_bars): { inCooldown: boolean; detail: string } {
  const entry = cooldownTracker.get(assetId);
  if (!entry) return { inCooldown: false, detail: "No recent signals" };
  const cooldownMs = cooldownBars * BAR_INTERVAL_MS;
  const elapsed = Date.now() - entry.lastSignalTime;
  if (elapsed < cooldownMs) {
    const remaining = Math.ceil((cooldownMs - elapsed) / (60 * 1000));
    return { inCooldown: true, detail: `Cooldown active (${remaining}min remaining after ${entry.lastSignalType}, ${cooldownBars}-bar)` };
  }
  return { inCooldown: false, detail: "Cooldown expired" };
}

export function recordSignal(assetId: string, signalType: "entry" | "exit"): void {
  cooldownTracker.set(assetId, { lastSignalTime: Date.now(), lastSignalType: signalType });
}

export function clearCooldown(assetId: string): void {
  cooldownTracker.delete(assetId);
}

function ema(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

const BULL_THRESHOLD = 0.5;

export function computeEMACrossover(closes: number[], cfg: SignalConfig): SignalResult {
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

  let score: number;
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

export function computeRSI(closes: number[], cfg: SignalConfig): SignalResult & { rsi_value: number } {
  const name = "rsi";
  if (!cfg.enable_rsi) {
    return { name, score: 0, enabled: false, detail: "DISABLED", bull_vote: false, bear_vote: false, rsi_value: 50 };
  }
  const period = cfg.rsi_period;
  if (closes.length < period + 2) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for RSI", bull_vote: false, bear_vote: false, rsi_value: 50 };
  }

  const changes: number[] = [];
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

  let rsi: number;
  if (avgLoss === 0 && avgGain === 0) {
    rsi = 50;
  } else if (avgLoss === 0) {
    rsi = 100;
  } else {
    const rs = avgGain / avgLoss;
    rsi = 100 - 100 / (1 + rs);
  }

  let score: number;
  if (rsi <= cfg.rsi_oversold) {
    score = clamp(0.7 + (cfg.rsi_oversold - rsi) / cfg.rsi_oversold * 0.3, 0.7, 1.0);
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

export function computeMomentum(closes: number[], cfg: SignalConfig): SignalResult {
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

  let score: number;
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

  const threshold = 0.005;
  const bull_vote = ret > threshold;
  const bear_vote = ret < -threshold;

  const retPct = (ret * 100).toFixed(2);
  const detail = `Momentum(${lookback}-bar): ${retPct}%`;
  return { name, score: clamp(score), enabled: true, detail, bull_vote, bear_vote };
}

export function computeVeryShortMomentum(closes: number[], cfg: SignalConfig): SignalResult {
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

  let score: number;
  if (ret > 0.03) {
    score = clamp(0.7 + ret * 5, 0.7, 0.95);
  } else if (ret > 0.005) {
    score = clamp(0.5 + ret * 8, 0.5, 0.7);
  } else if (ret > -0.005) {
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

export function computeMACD(closes: number[], cfg: SignalConfig): SignalResult {
  const name = "macd";
  if (!cfg.enable_macd) {
    return { name, score: 0, enabled: false, detail: "DISABLED", bull_vote: false, bear_vote: false };
  }
  if (closes.length < cfg.macd_slow + cfg.macd_signal + 5) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for MACD", bull_vote: false, bear_vote: false };
  }

  const fastEMA = ema(closes, cfg.macd_fast);
  const slowEMA = ema(closes, cfg.macd_slow);
  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(fastEMA[i] - slowEMA[i]);
  }
  const signalLine = ema(macdLine, cfg.macd_signal);
  const idx = closes.length - 1;
  const histogram = macdLine[idx] - signalLine[idx];
  const prevHistogram = idx > 0 ? macdLine[idx - 1] - signalLine[idx - 1] : histogram;
  const crossingUp = prevHistogram <= 0 && histogram > 0;

  let score: number;
  const normHist = histogram / closes[idx];
  if (crossingUp) {
    score = 0.8;
  } else if (normHist > 0.001) {
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

export function computeBBWidth(closes: number[], cfg: SignalConfig): SignalResult {
  const name = "bb_width";
  if (!cfg.enable_bb) {
    return { name, score: 0, enabled: false, detail: "DISABLED", bull_vote: false, bear_vote: false };
  }
  if (closes.length < cfg.bb_period + 50) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for BB width", bull_vote: false, bear_vote: false };
  }

  const period = cfg.bb_period;
  const widths: number[] = [];
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - mean) ** 2;
    const std = Math.sqrt(variance / period);
    widths.push((2 * 2 * std) / mean);
  }

  const currentWidth = widths[widths.length - 1];

  const sortedWidths = [...widths].sort((a, b) => a - b);
  const percentileIdx = Math.floor(sortedWidths.length * (1 - cfg.bb_percentile_threshold / 100));
  const isCompressed = currentWidth <= sortedWidths[Math.max(0, percentileIdx)];

  let score: number;
  if (isCompressed) {
    const rank = sortedWidths.indexOf(sortedWidths.find(w => w >= currentWidth) || currentWidth);
    const percentile = rank / sortedWidths.length;
    score = clamp(0.6 + (1 - percentile) * 0.35, 0.6, 0.95);
  } else {
    score = clamp(0.3 + (1 - currentWidth / sortedWidths[sortedWidths.length - 1]) * 0.2, 0.2, 0.45);
  }

  const bull_vote = isCompressed;
  const bear_vote = !isCompressed;

  const pctile = ((widths.filter(w => w <= currentWidth).length / widths.length) * 100).toFixed(0);
  const detail = `BB Width(${period}): ${(currentWidth * 100).toFixed(2)}%, percentile=${pctile}%${isCompressed ? " [COMPRESSED]" : ""}`;
  return { name, score: clamp(score), enabled: true, detail, bull_vote, bear_vote };
}

export function computeVolatilityRegime(closes: number[], cfg: SignalConfig): SignalResult {
  const name = "volatility_regime";
  if (!cfg.enable_volatility_regime) {
    return { name, score: 0, enabled: false, detail: "DISABLED", bull_vote: false, bear_vote: false };
  }
  const lookback = cfg.vol_lookback_bars;
  if (closes.length < lookback + 10) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for volatility regime", bull_vote: false, bear_vote: false };
  }

  const returns: number[] = [];
  for (let i = closes.length - lookback; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  const vol = Math.sqrt(variance);

  const annualizedVol = vol * Math.sqrt(24 * 365);

  let score: number;
  if (annualizedVol < 0.5) {
    score = 0.6;
  } else if (annualizedVol < 1.0) {
    score = 0.5;
  } else if (annualizedVol < 2.0) {
    score = 0.4;
  } else {
    score = clamp(0.3 - (annualizedVol - 2.0) * 0.1, 0.05, 0.3);
  }

  const bull_vote = annualizedVol < 1.0;
  const bear_vote = annualizedVol > 2.0;

  const detail = `Realized Vol (${lookback}h): ${(vol * 100).toFixed(3)}% hourly, ${(annualizedVol * 100).toFixed(1)}% annualized`;
  return { name, score: clamp(score), enabled: true, detail, bull_vote, bear_vote };
}

export function computeATR(candles: OHLCVCandle[], period: number = 14): number {
  if (candles.length < period + 1) return 0;

  const trueRanges: number[] = [];
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

export function classifyRegime(closes: number[], cfg: SignalConfig): MarketRegime {
  if (closes.length < cfg.ema_slow + 10) return "RANGING";

  const fast = ema(closes, cfg.ema_fast);
  const slow = ema(closes, cfg.ema_slow);
  const idx = closes.length - 1;

  const slopeWindow = Math.min(10, idx);
  const slopeStart = fast[idx - slopeWindow];
  const slopeEnd = fast[idx];
  const slope = (slopeEnd - slopeStart) / slopeStart;

  const lookback = Math.min(cfg.vol_lookback_bars, closes.length - 1);
  const returns: number[] = [];
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

export function computeVolAdjustedThreshold(closes: number[], cfg: SignalConfig): number {
  const lookback = Math.min(cfg.vol_lookback_bars, closes.length - 1);
  if (lookback < 5) return cfg.vote_threshold;

  const returns: number[] = [];
  for (let i = closes.length - lookback; i < closes.length; i++) {
    if (i > 0) returns.push(Math.abs((closes[i] - closes[i - 1]) / closes[i - 1]));
  }
  if (returns.length === 0) return cfg.vote_threshold;

  const avgAbsReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const annualizedVol = avgAbsReturn * Math.sqrt(24 * 365);

  if (annualizedVol > 2.0) return Math.min(cfg.vote_threshold + 1, 6);
  if (annualizedVol < 0.5) return Math.max(cfg.vote_threshold - 1, 3);
  return cfg.vote_threshold;
}

export function computeBTCConfirmation(btcCandles: OHLCVCandle[], cfg: SignalConfig): { btc_momentum_bull: boolean; btc_momentum_bear: boolean; detail: string } {
  if (btcCandles.length < cfg.momentum_lookback + 1) {
    return { btc_momentum_bull: false, btc_momentum_bear: false, detail: "Insufficient BTC data" };
  }

  const closes = btcCandles.map(c => c.close);
  const current = closes[closes.length - 1];
  const pastIdx = closes.length - 1 - cfg.momentum_lookback;
  const ret = pastIdx >= 0 ? (current - closes[pastIdx]) / closes[pastIdx] : 0;

  return {
    btc_momentum_bull: ret > 0,
    btc_momentum_bear: ret < -0.01,
    detail: `BTC momentum(${cfg.momentum_lookback}-bar): ${(ret * 100).toFixed(2)}%`,
  };
}

export function analyzeAsset(candles: OHLCVCandle[], config?: Partial<SignalConfig>, btcCandles?: OHLCVCandle[], assetId?: string): EnsembleResult {
  const cfg: SignalConfig = { ...DEFAULT_CONFIG, ...config };

  const closes = candles.map(c => c.close);
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
      reason: `Only ${closes.length} candles available, need at least 30`,
    };
  }

  const rsiResult = computeRSI(closes, cfg);
  const rsiValue = rsiResult.rsi_value;

  const signals: SignalResult[] = [
    computeEMACrossover(closes, cfg),
    rsiResult,
    computeMomentum(closes, cfg),
    computeVeryShortMomentum(closes, cfg),
    computeMACD(closes, cfg),
    computeBBWidth(closes, cfg),
  ];

  const activeSignals = signals.filter(s => s.enabled);
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
      reason: "Fewer than 2 active signals with data",
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

  const votes: VoteResult = {
    bull_votes,
    bear_votes,
    total_signals,
    vote_summary: `${bull_votes}/${total_signals}`,
    entry_signal,
    exit_long_signal,
    exit_short_signal,
    rsi_overbought,
    rsi_oversold,
  };

  const SIGNAL_WEIGHTS: Record<string, number> = {
    ema_crossover: 0.40,
    rsi: 0.25,
    momentum: 0.15,
    very_short_momentum: 0.05,
    macd: 0.10,
    bb_width: 0.03,
    volatility_regime: 0.02,
  };

  let weightedSum = 0;
  let totalWeight = 0;
  for (const sig of activeSignals) {
    const w = SIGNAL_WEIGHTS[sig.name] ?? 0.05;
    weightedSum += sig.score * w;
    totalWeight += w;
  }
  const technicalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  let btcConfirmation: BTCConfirmation | undefined;
  if (btcCandles && btcCandles.length > cfg.momentum_lookback + 1) {
    const btcResult = computeBTCConfirmation(btcCandles, cfg);
    btcConfirmation = {
      ...btcResult,
      alt_entry_allowed: !btcResult.btc_momentum_bear,
    };
    if (btcResult.btc_momentum_bear && entry_signal) {
      votes.entry_signal = false;
    }
  }

  let cooldownResult: { in_cooldown: boolean; detail: string } | undefined;
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
    cooldown: cooldownResult,
  };
}

export function formatAnalysis(result: EnsembleResult, assetName: string): string {
  const lines = [
    `Technical Analysis: ${assetName}`,
    `Score: ${result.technical_score.toFixed(3)} | Regime: ${result.regime} | Data: ${result.data_quality}`,
    `Votes: ${result.votes.vote_summary} bull (threshold: ${result.vol_adjusted_threshold}) ${result.votes.entry_signal ? "✅ ENTRY" : "❌ NO ENTRY"}`,
    `Price: $${result.current_price.toFixed(result.current_price >= 1 ? 2 : 8)}`,
    `ATR: ${result.atr_value.toFixed(6)} | Stop (${result.atr_stop_multiplier}x ATR): $${result.atr_stop_price.toFixed(result.atr_stop_price >= 1 ? 2 : 8)}`,
    "",
    "Signals:",
  ];

  for (const s of result.signals) {
    const status = s.enabled ? `${s.score.toFixed(3)}` : "OFF";
    const vote = s.enabled ? (s.bull_vote ? " 🟢BULL" : s.bear_vote ? " 🔴BEAR" : " ⚪NEUTRAL") : "";
    lines.push(`  [${status}] ${s.name}: ${s.detail}${vote}`);
  }

  if (result.votes.rsi_overbought) lines.push("\n⚠️ RSI OVERBOUGHT — exit long signal");
  if (result.votes.rsi_oversold) lines.push("\n⚠️ RSI OVERSOLD — exit short signal");

  if (result.reason) {
    lines.push("", `Note: ${result.reason}`);
  }

  return lines.join("\n");
}

export { DEFAULT_CONFIG };
