import type { OHLCVCandle } from "./coingecko.js";

export type MarketRegime = "TRENDING" | "RANGING" | "VOLATILE";

export interface SignalResult {
  name: string;
  score: number;
  enabled: boolean;
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
  active_signal_count: number;
  data_quality: "sufficient" | "insufficient";
  reason?: string;
}

export interface SignalConfig {
  ema_fast: number;
  ema_slow: number;
  rsi_period: number;
  rsi_overbought: number;
  rsi_oversold: number;
  momentum_short_hours: number;
  momentum_long_hours: number;
  macd_fast: number;
  macd_slow: number;
  macd_signal: number;
  bb_period: number;
  bb_percentile_threshold: number;
  vol_lookback_bars: number;
  atr_period: number;
  atr_stop_multiplier: number;
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
  momentum_short_hours: 12,
  momentum_long_hours: 24,
  macd_fast: 14,
  macd_slow: 23,
  macd_signal: 9,
  bb_period: 7,
  bb_percentile_threshold: 90,
  vol_lookback_bars: 24,
  atr_period: 14,
  atr_stop_multiplier: 5.5,
  enable_macd: false,
  enable_bb: false,
  enable_volatility_regime: false,
};

function ema(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = [data[0]];
  for (let i = 1; i < data.length; i++) {
    result.push(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function sma(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(sum / period);
  }
  return result;
}

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}

export function computeEMACrossover(closes: number[], cfg: SignalConfig): SignalResult {
  const name = "ema_crossover";
  if (closes.length < cfg.ema_slow + 5) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for EMA" };
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

  const detail = `EMA${cfg.ema_fast}=${fastVal.toFixed(4)} vs EMA${cfg.ema_slow}=${slowVal.toFixed(4)}, diff=${(diff * 100).toFixed(2)}%${crossingUp ? " [CROSS UP]" : ""}`;
  return { name, score: clamp(score), enabled: true, detail };
}

export function computeRSI(closes: number[], cfg: SignalConfig): SignalResult {
  const name = "rsi";
  const period = cfg.rsi_period;
  if (closes.length < period + 2) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for RSI" };
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

  const detail = `RSI(${period})=${rsi.toFixed(1)} [oversold<${cfg.rsi_oversold}, overbought>${cfg.rsi_overbought}]`;
  return { name, score: clamp(score), enabled: true, detail };
}

export function computeMomentum(closes: number[], cfg: SignalConfig): SignalResult {
  const name = "momentum";
  const longH = cfg.momentum_long_hours;
  if (closes.length < longH + 1) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for momentum" };
  }

  const current = closes[closes.length - 1];
  const shortIdx = closes.length - 1 - cfg.momentum_short_hours;
  const longIdx = closes.length - 1 - longH;

  const shortReturn = shortIdx >= 0 ? (current - closes[shortIdx]) / closes[shortIdx] : 0;
  const longReturn = longIdx >= 0 ? (current - closes[longIdx]) / closes[longIdx] : 0;

  const avgReturn = (shortReturn + longReturn) / 2;

  let score: number;
  if (avgReturn > 0.05) {
    score = clamp(0.7 + avgReturn * 3, 0.7, 0.95);
  } else if (avgReturn > 0.01) {
    score = clamp(0.5 + avgReturn * 5, 0.5, 0.7);
  } else if (avgReturn > -0.01) {
    score = 0.45;
  } else if (avgReturn > -0.05) {
    score = clamp(0.3 + (avgReturn + 0.05) * 5, 0.2, 0.4);
  } else {
    score = clamp(0.1 + (avgReturn + 0.1) * 2, 0, 0.2);
  }

  const shortPct = (shortReturn * 100).toFixed(2);
  const longPct = (longReturn * 100).toFixed(2);
  const detail = `Momentum: ${cfg.momentum_short_hours}h=${shortPct}%, ${longH}h=${longPct}%, avg=${(avgReturn * 100).toFixed(2)}%`;
  return { name, score: clamp(score), enabled: true, detail };
}

export function computeMACD(closes: number[], cfg: SignalConfig): SignalResult {
  const name = "macd";
  if (!cfg.enable_macd) {
    return { name, score: 0, enabled: false, detail: "DISABLED — enable post-beta after validation" };
  }
  if (closes.length < cfg.macd_slow + cfg.macd_signal + 5) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for MACD" };
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

  const detail = `MACD(${cfg.macd_fast},${cfg.macd_slow},${cfg.macd_signal}): line=${macdLine[idx].toFixed(4)}, signal=${signalLine[idx].toFixed(4)}, hist=${histogram.toFixed(4)}${crossingUp ? " [CROSS UP]" : ""}`;
  return { name, score: clamp(score), enabled: true, detail };
}

export function computeBBWidth(closes: number[], cfg: SignalConfig): SignalResult {
  const name = "bb_width";
  if (!cfg.enable_bb) {
    return { name, score: 0, enabled: false, detail: "DISABLED — enable post-beta after validation" };
  }
  if (closes.length < cfg.bb_period + 50) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for BB width" };
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

  const pctile = ((widths.filter(w => w <= currentWidth).length / widths.length) * 100).toFixed(0);
  const detail = `BB Width(${period}): ${(currentWidth * 100).toFixed(2)}%, percentile=${pctile}%${isCompressed ? " [COMPRESSED]" : ""}`;
  return { name, score: clamp(score), enabled: true, detail };
}

export function computeVolatilityRegime(closes: number[], cfg: SignalConfig): SignalResult {
  const name = "volatility_regime";
  if (!cfg.enable_volatility_regime) {
    return { name, score: 0, enabled: false, detail: "DISABLED — enable post-beta after validation" };
  }
  const lookback = cfg.vol_lookback_bars;
  if (closes.length < lookback + 10) {
    return { name, score: 0, enabled: false, detail: "Insufficient data for volatility regime" };
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

  const detail = `Realized Vol (${lookback}h): ${(vol * 100).toFixed(3)}% hourly, ${(annualizedVol * 100).toFixed(1)}% annualized`;
  return { name, score: clamp(score), enabled: true, detail };
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

export function analyzeAsset(candles: OHLCVCandle[], config?: Partial<SignalConfig>): EnsembleResult {
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
      active_signal_count: 0,
      data_quality: "insufficient",
      reason: `Only ${closes.length} candles available, need at least 30`,
    };
  }

  const signals: SignalResult[] = [
    computeEMACrossover(closes, cfg),
    computeRSI(closes, cfg),
    computeMomentum(closes, cfg),
    computeMACD(closes, cfg),
    computeBBWidth(closes, cfg),
    computeVolatilityRegime(closes, cfg),
  ];

  const activeSignals = signals.filter(s => s.enabled);
  const regime = classifyRegime(closes, cfg);
  const atrValue = computeATR(candles, cfg.atr_period);
  const atrStopPrice = currentPrice - atrValue * cfg.atr_stop_multiplier;

  if (activeSignals.length < 2) {
    return {
      technical_score: 0,
      regime,
      atr_value: atrValue,
      atr_stop_price: atrStopPrice,
      atr_stop_multiplier: cfg.atr_stop_multiplier,
      current_price: currentPrice,
      signals,
      active_signal_count: activeSignals.length,
      data_quality: "insufficient",
      reason: "Fewer than 2 active signals with data",
    };
  }

  const SIGNAL_WEIGHTS: Record<string, number> = {
    ema_crossover: 0.40,
    rsi: 0.25,
    momentum: 0.20,
    macd: 0.10,
    bb_width: 0.03,
    volatility_regime: 0.02,
  };

  let weightedSum = 0;
  let totalWeight = 0;
  for (const sig of activeSignals) {
    const w = SIGNAL_WEIGHTS[sig.name] ?? 0.1;
    weightedSum += sig.score * w;
    totalWeight += w;
  }
  const technicalScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

  return {
    technical_score: parseFloat(technicalScore.toFixed(3)),
    regime,
    atr_value: parseFloat(atrValue.toFixed(6)),
    atr_stop_price: parseFloat(atrStopPrice.toFixed(6)),
    atr_stop_multiplier: cfg.atr_stop_multiplier,
    current_price: currentPrice,
    signals,
    active_signal_count: activeSignals.length,
    data_quality: "sufficient",
  };
}

export function formatAnalysis(result: EnsembleResult, assetName: string): string {
  const lines = [
    `Technical Analysis: ${assetName}`,
    `Score: ${result.technical_score.toFixed(3)} | Regime: ${result.regime} | Data: ${result.data_quality}`,
    `Price: $${result.current_price.toFixed(result.current_price >= 1 ? 2 : 8)}`,
    `ATR: ${result.atr_value.toFixed(6)} | Stop (${result.atr_stop_multiplier}x ATR): $${result.atr_stop_price.toFixed(result.atr_stop_price >= 1 ? 2 : 8)}`,
    "",
    "Signals:",
  ];

  for (const s of result.signals) {
    const status = s.enabled ? `${s.score.toFixed(3)}` : "OFF";
    lines.push(`  [${status}] ${s.name}: ${s.detail}`);
  }

  if (result.reason) {
    lines.push("", `Note: ${result.reason}`);
  }

  lines.push("", "⚠️ All parameters are UNVALIDATED starting points from Nunchi research. Not yet proven on spot small-cap tokens.");

  return lines.join("\n");
}

export { DEFAULT_CONFIG };
