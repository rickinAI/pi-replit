import type { OHLCVCandle } from "./coingecko.js";
import {
  computeEMACrossover,
  computeRSI,
  computeMomentum,
  computeVeryShortMomentum,
  computeMACD,
  computeBBWidth,
  computeATR,
  type SignalConfig,
  type SignalResult,
} from "./technical-signals.js";

export interface BacktestTrade {
  entry_bar: number;
  exit_bar: number;
  entry_price: number;
  exit_price: number;
  direction: "LONG" | "SHORT";
  pnl_pct: number;
  exit_reason: "stop_loss" | "rsi_exit" | "end_of_data";
  bars_held: number;
}

export interface BacktestResult {
  asset: string;
  period_days: number;
  total_bars: number;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  total_return_pct: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  avg_bars_held: number;
  nunchi_score: number;
  trades: BacktestTrade[];
  parameters_used: Partial<SignalConfig>;
}

const DEFAULT_BACKTEST_CONFIG: SignalConfig = {
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

function getVotesAtBar(closes: number[], barIdx: number, cfg: SignalConfig): { bull: number; bear: number; rsiOB: boolean; rsiOS: boolean } {
  const slice = closes.slice(0, barIdx + 1);
  if (slice.length < 30) return { bull: 0, bear: 0, rsiOB: false, rsiOS: false };

  const signals: SignalResult[] = [
    computeEMACrossover(slice, cfg),
    computeRSI(slice, cfg),
    computeMomentum(slice, cfg),
    computeVeryShortMomentum(slice, cfg),
    computeMACD(slice, cfg),
    computeBBWidth(slice, cfg),
  ];

  let bull = 0, bear = 0;
  let rsiOB = false, rsiOS = false;

  for (const s of signals) {
    if (!s.enabled) continue;
    if (s.bull_vote) bull++;
    if (s.bear_vote) bear++;
  }

  const rsiSig = signals.find(s => s.name === "rsi" && s.enabled);
  if (rsiSig) {
    const rsiResult = computeRSI(slice, cfg);
    rsiOB = rsiResult.rsi_value >= cfg.rsi_overbought;
    rsiOS = rsiResult.rsi_value <= cfg.rsi_oversold;
  }

  return { bull, bear, rsiOB, rsiOS };
}

export function runBacktest(candles: OHLCVCandle[], assetName: string, config?: Partial<SignalConfig>): BacktestResult {
  const cfg: SignalConfig = { ...DEFAULT_BACKTEST_CONFIG, ...config };
  const closes = candles.map(c => c.close);
  const trades: BacktestTrade[] = [];

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
      parameters_used: config || {},
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

      let exitReason: "stop_loss" | "rsi_exit" | null = null;
      if (price <= stopPrice) exitReason = "stop_loss";
      else if (rsiOB) exitReason = "rsi_exit";

      if (exitReason) {
        const pnl_pct = ((price - entryPrice) / entryPrice) * 100;
        trades.push({
          entry_bar: entryBar,
          exit_bar: i,
          entry_price: entryPrice,
          exit_price: price,
          direction: "LONG",
          pnl_pct,
          exit_reason: exitReason,
          bars_held: i - entryBar,
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
    const pnl_pct = ((lastPrice - entryPrice) / entryPrice) * 100;
    trades.push({
      entry_bar: entryBar,
      exit_bar: closes.length - 1,
      entry_price: entryPrice,
      exit_price: lastPrice,
      direction: "LONG",
      pnl_pct,
      exit_reason: "end_of_data",
      bars_held: closes.length - 1 - entryBar,
    });
  }

  const winningTrades = trades.filter(t => t.pnl_pct > 0);
  const losingTrades = trades.filter(t => t.pnl_pct <= 0);
  const winRate = trades.length > 0 ? winningTrades.length / trades.length : 0;
  const totalReturnPct = trades.reduce((sum, t) => sum + t.pnl_pct, 0);

  const returns = trades.map(t => t.pnl_pct / 100);
  let maxDD = 0;
  let peak = 1;
  let equity = 1;
  for (const r of returns) {
    equity *= (1 + r);
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
      sharpe = (meanReturn / stdDev) * Math.sqrt(252);
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
    parameters_used: config || {},
  };
}

export function formatBacktestResult(result: BacktestResult): string {
  const lines = [
    `Backtest: ${result.asset} (${result.period_days}d, ${result.total_bars} bars)`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `Trades: ${result.total_trades} (${result.winning_trades}W / ${result.losing_trades}L)`,
    `Win Rate: ${(result.win_rate * 100).toFixed(1)}%`,
    `Total Return: ${result.total_return_pct >= 0 ? "+" : ""}${result.total_return_pct.toFixed(2)}%`,
    `Max Drawdown: ${result.max_drawdown_pct.toFixed(2)}%`,
    `Sharpe Ratio: ${result.sharpe_ratio.toFixed(3)}`,
    `Nunchi Score: ${result.nunchi_score.toFixed(3)}`,
    `Avg Hold: ${result.avg_bars_held.toFixed(0)} bars`,
  ];

  if (result.trades.length > 0) {
    lines.push("", "Recent trades:");
    for (const t of result.trades.slice(-5)) {
      const pnl = t.pnl_pct >= 0 ? `+${t.pnl_pct.toFixed(2)}%` : `${t.pnl_pct.toFixed(2)}%`;
      lines.push(`  ${t.pnl_pct >= 0 ? "🟢" : "🔴"} ${pnl} (${t.bars_held} bars, ${t.exit_reason})`);
    }
  }

  return lines.join("\n");
}
