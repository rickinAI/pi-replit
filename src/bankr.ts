import { getPool } from "./db.js";
import { analyzeAsset, checkCooldown, recordSignal, type OHLCVCandle } from "./technical-signals.js";
import { getHistoricalOHLCV } from "./coingecko.js";
import * as polymarket from "./polymarket.js";
import * as bnkr from "./bnkr.js";
import * as coinbaseWallet from "./coinbase-wallet.js";
import type { PolymarketThesis } from "./polymarket-scout.js";

export interface Position {
  id: string;
  thesis_id: string;
  asset: string;
  asset_class: "crypto" | "polymarket";
  source: "crypto_scout" | "polymarket_scout" | "manual";
  direction: string;
  leverage: string;
  entry_price: number;
  current_price: number;
  size: number;
  unrealized_pnl: number;
  peak_price: number;
  atr_value: number;
  atr_stop_price: number;
  opened_at: string;
  venue: "bnkr" | "coinbase" | "kreo";
  exposure_bucket: string;
  bnkr_order_id?: string;
  fill_quantity?: number;
}

export interface TradeRecord {
  id: string;
  thesis_id: string;
  asset: string;
  asset_class: "crypto" | "polymarket";
  source: "crypto_scout" | "polymarket_scout" | "manual";
  direction: string;
  leverage: string;
  entry_price: number;
  exit_price: number;
  expected_entry_price: number;
  size: number;
  pnl: number;
  pnl_pct: number;
  fees: number;
  opened_at: string;
  closed_at: string;
  close_reason: string;
  tax_lot: TaxLot;
}

export interface TaxLot {
  id: string;
  asset: string;
  asset_class: "crypto" | "polymarket";
  quantity: number;
  cost_basis: number;
  cost_per_unit: number;
  acquired_at: string;
  disposed_at: string | null;
  proceeds: number | null;
  gain_loss: number | null;
  holding_period: "short" | "long";
  wash_sale_flagged: boolean;
  wash_sale_disallowed: number;
  venue: string;
  tx_hash: string | null;
}

export type ApprovalTier = "autonomous" | "dead_zone" | "human_required";

export interface RiskCheckResult {
  passed: boolean;
  tier: ApprovalTier;
  checks: { name: string; passed: boolean; detail: string }[];
  rejection_reason: string | null;
}

const PORTFOLIO_VALUE_KEY = "wealth_engines_portfolio_value";
const PEAK_PORTFOLIO_KEY = "wealth_engines_peak_portfolio";
const CONSECUTIVE_LOSSES_KEY = "wealth_engines_consecutive_losses";
const DEFAULT_PORTFOLIO = 50;

export async function getPortfolioValue(): Promise<number> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = $1`, [PORTFOLIO_VALUE_KEY]);
    if (res.rows.length > 0 && typeof res.rows[0].value === "number") {
      return res.rows[0].value;
    }
  } catch {}
  return DEFAULT_PORTFOLIO;
}

async function setPortfolioValue(value: number): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [PORTFOLIO_VALUE_KEY, JSON.stringify(value), Date.now()]
  );
  const peak = await getPeakPortfolioValue();
  if (value > peak) {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [PEAK_PORTFOLIO_KEY, JSON.stringify(value), Date.now()]
    );
  }
}

export async function getPeakPortfolioValue(): Promise<number> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = $1`, [PEAK_PORTFOLIO_KEY]);
    if (res.rows.length > 0 && typeof res.rows[0].value === "number") {
      return res.rows[0].value;
    }
  } catch {}
  return DEFAULT_PORTFOLIO;
}

export async function getConsecutiveLosses(): Promise<number> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = $1`, [CONSECUTIVE_LOSSES_KEY]);
    if (res.rows.length > 0 && typeof res.rows[0].value === "number") {
      return res.rows[0].value;
    }
  } catch {}
  return 0;
}

async function updateConsecutiveLosses(pnl: number): Promise<number> {
  const pool = getPool();
  const current = await getConsecutiveLosses();
  const newCount = pnl < 0 ? current + 1 : 0;
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [CONSECUTIVE_LOSSES_KEY, JSON.stringify(newCount), Date.now()]
  );
  return newCount;
}

async function isFirstTradeForAsset(asset: string, assetClass: string): Promise<boolean> {
  const history = await getTradeHistory();
  return !history.some(t => t.asset === asset && t.asset_class === assetClass);
}

export function determineApprovalTier(params: {
  capitalPct: number;
  confidence: number;
  consecutiveLosses: number;
  drawdownPct: number;
  isFirstForAsset: boolean;
  leverageIncrease: boolean;
}): ApprovalTier {
  if (
    params.capitalPct > 30 ||
    params.consecutiveLosses >= 3 ||
    params.drawdownPct < -25 ||
    params.isFirstForAsset ||
    params.leverageIncrease
  ) {
    return "human_required";
  }
  if (params.capitalPct > 20 || params.confidence < 3.5) {
    return "dead_zone";
  }
  return "autonomous";
}

export async function getPositions(): Promise<Position[]> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_positions'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      return res.rows[0].value;
    }
  } catch {}
  return [];
}

async function savePositions(positions: Position[]): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_positions', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(positions), Date.now()]
  );
}

export async function getTradeHistory(): Promise<TradeRecord[]> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_trade_history'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      return res.rows[0].value;
    }
  } catch {}
  return [];
}

async function appendTradeHistory(record: TradeRecord): Promise<void> {
  const pool = getPool();
  const history = await getTradeHistory();
  history.push(record);
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_trade_history', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [JSON.stringify(history), Date.now()]
  );
}

export async function isKillSwitchActive(): Promise<boolean> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_kill_switch'`);
    return res.rows.length > 0 && res.rows[0].value === true;
  } catch { return false; }
}

export async function isPaused(): Promise<boolean> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_paused'`);
    return res.rows.length > 0 && res.rows[0].value === true;
  } catch { return false; }
}

export async function getMode(): Promise<"BETA" | "LIVE" | "SHADOW"> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_mode'`);
    if (res.rows.length > 0 && typeof res.rows[0].value === "string") {
      return res.rows[0].value as "BETA" | "LIVE" | "SHADOW";
    }
  } catch {}
  return "BETA";
}

function getExposureBucket(asset: string, assetClass: string): string {
  const lower = asset.toLowerCase();
  if (assetClass === "polymarket" && !lower.includes("btc") && !lower.includes("eth") && !lower.includes("sol")) {
    return "prediction-only";
  }
  if (lower.includes("btc") || lower.includes("bitcoin")) return "btc";
  if (lower.includes("eth") || lower.includes("ethereum")) return "eth";
  if (lower.includes("sol") || lower.includes("solana")) return "sol";
  return "general-crypto";
}

export async function runPreExecutionChecks(params: {
  asset: string;
  asset_class: "crypto" | "polymarket";
  direction: string;
  leverage: number;
  entry_price: number;
  stop_price: number;
  risk_amount?: number;
  confidence?: number;
}): Promise<RiskCheckResult> {
  const checks: { name: string; passed: boolean; detail: string }[] = [];
  let allPassed = true;

  const killActive = await isKillSwitchActive();
  checks.push({ name: "kill_switch", passed: !killActive, detail: killActive ? "Kill switch is ACTIVE" : "Kill switch inactive" });
  if (killActive) allPassed = false;

  const paused = await isPaused();
  checks.push({ name: "pause_state", passed: !paused, detail: paused ? "System is PAUSED" : "System active" });
  if (paused) allPassed = false;

  const mode = await getMode();
  checks.push({ name: "mode_check", passed: true, detail: `Mode: ${mode}${mode === "SHADOW" ? " (shadow trades only)" : ""}` });

  const levOk = params.leverage <= 2;
  checks.push({ name: "leverage_cap", passed: levOk, detail: `Requested: ${params.leverage}x, Max: 2x` });
  if (!levOk) allPassed = false;

  const portfolio = await getPortfolioValue();
  const maxRisk = portfolio * 0.02;
  const riskDistance = Math.abs(params.entry_price - params.stop_price);
  const riskAmount = params.risk_amount || (riskDistance > 0 ? maxRisk : 0);
  const riskOk = riskAmount <= maxRisk;
  checks.push({ name: "risk_per_trade", passed: riskOk, detail: `Risk: $${riskAmount.toFixed(2)}, Max: $${maxRisk.toFixed(2)} (2% of $${portfolio.toFixed(2)})` });
  if (!riskOk) allPassed = false;

  if (params.leverage > 1) {
    const marginPerUnit = params.entry_price / params.leverage;
    const liquidationDistance = marginPerUnit;
    const bufferOk = riskDistance < liquidationDistance * 0.8;
    checks.push({ name: "margin_buffer", passed: bufferOk, detail: bufferOk ? "20% buffer above liquidation maintained" : "Insufficient margin buffer — liquidation too close to stop" });
    if (!bufferOk) allPassed = false;
  } else {
    checks.push({ name: "margin_buffer", passed: true, detail: "No leverage — no liquidation risk" });
  }

  const positions = await getPositions();
  const posCountOk = positions.length < 5;
  checks.push({ name: "max_positions", passed: posCountOk, detail: `Open: ${positions.length}/5` });
  if (!posCountOk) allPassed = false;

  const totalExposure = positions.reduce((sum, p) => sum + (p.size * p.entry_price), 0);
  const newPositionSize = riskDistance > 0 ? riskAmount / riskDistance : 0;
  const newExposure = newPositionSize * params.entry_price;
  const totalAfter = totalExposure + newExposure;
  const exposureLimit = portfolio * 0.80;
  const exposureOk = totalAfter <= exposureLimit;
  checks.push({ name: "total_exposure", passed: exposureOk, detail: `After: $${totalAfter.toFixed(2)} / $${exposureLimit.toFixed(2)} (80% of portfolio)` });
  if (!exposureOk) allPassed = false;

  const bucket = getExposureBucket(params.asset, params.asset_class);
  const bucketCount = positions.filter(p => p.exposure_bucket === bucket).length;
  const correlationOk = bucketCount < 2;
  checks.push({ name: "correlation_limit", passed: correlationOk, detail: `Bucket "${bucket}": ${bucketCount}/2 positions` });
  if (!correlationOk) allPassed = false;

  const consecutiveLosses = await getConsecutiveLosses();
  checks.push({ name: "consecutive_losses", passed: consecutiveLosses < 3, detail: `Consecutive losses: ${consecutiveLosses}/3` });

  const peakPortfolio = await getPeakPortfolioValue();
  const drawdownPct = peakPortfolio > 0 ? ((portfolio - peakPortfolio) / peakPortfolio) * 100 : 0;
  const drawdownOk = drawdownPct > -25;
  checks.push({ name: "peak_drawdown", passed: drawdownOk, detail: `Drawdown from peak: ${drawdownPct.toFixed(1)}% (limit: -25%)` });

  const capitalPct = portfolio > 0 ? (newExposure / portfolio) * 100 : 0;
  const firstForAsset = await isFirstTradeForAsset(params.asset, params.asset_class);
  const tier = determineApprovalTier({
    capitalPct,
    confidence: params.confidence || 3.5,
    consecutiveLosses,
    drawdownPct,
    isFirstForAsset: firstForAsset,
    leverageIncrease: false,
  });
  checks.push({ name: "approval_tier", passed: true, detail: `Tier: ${tier} (capital: ${capitalPct.toFixed(1)}%, losses: ${consecutiveLosses}, drawdown: ${drawdownPct.toFixed(1)}%, first: ${firstForAsset})` });

  const rejectionReason = allPassed ? null : checks.filter(c => !c.passed).map(c => c.detail).join("; ");

  return { passed: allPassed, tier, checks, rejection_reason: rejectionReason };
}

export async function openPosition(params: {
  thesis_id: string;
  asset: string;
  asset_class: "crypto" | "polymarket";
  source?: "crypto_scout" | "polymarket_scout" | "manual";
  direction: string;
  leverage: number;
  entry_price: number;
  stop_price: number;
  atr_value: number;
  venue: "bnkr" | "coinbase" | "kreo";
  tx_hash?: string;
  market_id?: string;
}): Promise<{ position: Position; trade_id: string; bnkr_order_id?: string }> {
  const portfolio = await getPortfolioValue();
  const maxRisk = portfolio * 0.02;
  const riskDistance = Math.abs(params.entry_price - params.stop_price);
  const size = riskDistance > 0 ? maxRisk / riskDistance : 0;

  const posId = `pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tradeId = `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let bnkrOrderId: string | undefined;
  let fillQuantity: number | undefined;
  const source = params.source || (params.asset_class === "polymarket" ? "polymarket_scout" : "crypto_scout");

  if (params.venue === "bnkr" && bnkr.isConfigured()) {
    if (params.asset_class === "crypto") {
      const order = await bnkr.openCryptoPosition({
        asset: params.asset,
        direction: params.direction as "LONG" | "SHORT",
        leverage: params.leverage,
        size,
        stop_price: params.stop_price,
      });
      bnkrOrderId = order.order_id;
      if (order.entry_price > 0) params.entry_price = order.entry_price;
    } else if (params.asset_class === "polymarket") {
      if (!params.market_id) {
        throw new Error("market_id is required for Polymarket positions via BNKR");
      }
      const order = await bnkr.openPolymarketPosition({
        market_id: params.market_id,
        direction: params.direction as "YES" | "NO",
        amount_usd: size * params.entry_price,
      });
      bnkrOrderId = order.order_id;
      if (order.entry_odds > 0) params.entry_price = order.entry_odds;
    }
  } else if (params.venue === "coinbase" && coinbaseWallet.isConfigured()) {
    const order = await coinbaseWallet.buySpot({
      asset: params.asset,
      amount_usd: size * params.entry_price,
    });
    if (order.price > 0) params.entry_price = order.price;
    if (order.quantity > 0) fillQuantity = order.quantity;
  }

  const position: Position = {
    id: posId,
    thesis_id: params.thesis_id,
    asset: params.asset,
    asset_class: params.asset_class,
    source,
    direction: params.direction,
    leverage: `${params.leverage}x`,
    entry_price: params.entry_price,
    current_price: params.entry_price,
    size: fillQuantity || size,
    fill_quantity: fillQuantity || undefined,
    unrealized_pnl: 0,
    peak_price: params.entry_price,
    atr_value: params.atr_value,
    atr_stop_price: params.direction === "SHORT" || params.direction === "NO"
      ? params.entry_price + params.atr_value * 5.5
      : params.entry_price - params.atr_value * 5.5,
    opened_at: new Date().toISOString(),
    venue: params.venue,
    exposure_bucket: getExposureBucket(params.asset, params.asset_class),
    bnkr_order_id: bnkrOrderId,
  };

  const positions = await getPositions();
  positions.push(position);
  await savePositions(positions);

  recordSignal(params.asset.toLowerCase(), "entry");

  return { position, trade_id: tradeId, bnkr_order_id: bnkrOrderId };
}

export async function closePosition(positionId: string, exitPrice: number, closeReason: string, txHash?: string): Promise<TradeRecord | null> {
  const positions = await getPositions();
  const idx = positions.findIndex(p => p.id === positionId);
  if (idx === -1) return null;

  const pos = positions[idx];

  if (pos.bnkr_order_id && bnkr.isConfigured()) {
    try {
      if (pos.asset_class === "crypto") {
        const result = await bnkr.closeCryptoPosition(pos.bnkr_order_id);
        if (result.exit_price > 0) exitPrice = result.exit_price;
        txHash = txHash || result.tx_hash;
      } else if (pos.asset_class === "polymarket") {
        const result = await bnkr.closePolymarketPosition(pos.bnkr_order_id);
        if (result.exit_odds > 0) exitPrice = result.exit_odds;
        txHash = txHash || result.tx_hash;
      }
    } catch (err) {
      console.error(`[bankr] BNKR close failed for ${pos.bnkr_order_id}:`, err instanceof Error ? err.message : err);
      return null;
    }
  } else if (pos.venue === "coinbase" && coinbaseWallet.isConfigured() && pos.asset_class === "crypto") {
    try {
      const actualQty = pos.fill_quantity || pos.size;
      await coinbaseWallet.sellSpot({ asset: pos.asset, quantity: actualQty });
    } catch (err) {
      console.error(`[bankr] Coinbase sell failed for ${pos.asset}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  const isLong = pos.direction === "LONG" || pos.direction === "YES";
  const priceDiff = isLong ? exitPrice - pos.entry_price : pos.entry_price - exitPrice;
  const pnl = priceDiff * pos.size;
  const pnlPct = pos.entry_price > 0 ? (priceDiff / pos.entry_price) * 100 : 0;
  const fees = pos.size * exitPrice * 0.001;

  const acquiredDate = new Date(pos.opened_at);
  const disposedDate = new Date();
  const holdingMs = disposedDate.getTime() - acquiredDate.getTime();
  const holdingPeriod: "short" | "long" = holdingMs > 365 * 24 * 60 * 60 * 1000 ? "long" : "short";

  const taxLot: TaxLot = {
    id: `lot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    asset: pos.asset,
    asset_class: pos.asset_class,
    quantity: pos.size,
    cost_basis: pos.size * pos.entry_price + fees,
    cost_per_unit: pos.entry_price,
    acquired_at: pos.opened_at,
    disposed_at: disposedDate.toISOString(),
    proceeds: pos.size * exitPrice - fees,
    gain_loss: pnl - fees * 2,
    holding_period: holdingPeriod,
    wash_sale_flagged: false,
    wash_sale_disallowed: 0,
    venue: pos.venue,
    tx_hash: txHash || null,
  };

  const tradeRecord: TradeRecord = {
    id: `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    thesis_id: pos.thesis_id,
    asset: pos.asset,
    asset_class: pos.asset_class,
    source: pos.source || "manual",
    direction: pos.direction,
    leverage: pos.leverage,
    entry_price: pos.entry_price,
    exit_price: exitPrice,
    expected_entry_price: pos.entry_price,
    size: pos.size,
    pnl: parseFloat(pnl.toFixed(4)),
    pnl_pct: parseFloat(pnlPct.toFixed(2)),
    fees: parseFloat(fees.toFixed(4)),
    opened_at: pos.opened_at,
    closed_at: disposedDate.toISOString(),
    close_reason: closeReason,
    tax_lot: taxLot,
  };

  positions.splice(idx, 1);
  await savePositions(positions);
  await appendTradeHistory(tradeRecord);

  const portfolio = await getPortfolioValue();
  await setPortfolioValue(portfolio + pnl - fees * 2);

  await updateConsecutiveLosses(pnl);

  recordSignal(pos.asset.toLowerCase(), "exit");

  return tradeRecord;
}

export async function closeAllPositions(reason: string): Promise<TradeRecord[]> {
  const positions = await getPositions();
  const records: TradeRecord[] = [];
  for (const pos of positions) {
    const record = await closePosition(pos.id, pos.current_price, reason);
    if (record) records.push(record);
  }
  return records;
}

export async function checkCircuitBreaker(): Promise<{ triggered: boolean; rolling7dayPnl: number; pnlPct: number; peakDrawdownPct: number }> {
  const history = await getTradeHistory();
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const recentTrades = history.filter(t => new Date(t.closed_at).getTime() > sevenDaysAgo);
  const rolling7dayPnl = recentTrades.reduce((sum, t) => sum + t.pnl, 0);
  const portfolio = await getPortfolioValue();
  const pnlPct = portfolio > 0 ? (rolling7dayPnl / portfolio) * 100 : 0;

  const peakPortfolio = await getPeakPortfolioValue();
  const peakDrawdownPct = peakPortfolio > 0 ? ((portfolio - peakPortfolio) / peakPortfolio) * 100 : 0;

  const triggered = pnlPct < -15 || peakDrawdownPct < -25;

  if (triggered) {
    const pool = getPool();
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(true), Date.now()]
    );
    const reason = peakDrawdownPct < -25
      ? `Peak drawdown ${peakDrawdownPct.toFixed(1)}% < -25%`
      : `7-day P&L ${pnlPct.toFixed(1)}% < -15%`;
    console.log(`[bankr] Circuit breaker TRIGGERED: ${reason}`);
  }

  return {
    triggered,
    rolling7dayPnl: parseFloat(rolling7dayPnl.toFixed(4)),
    pnlPct: parseFloat(pnlPct.toFixed(2)),
    peakDrawdownPct: parseFloat(peakDrawdownPct.toFixed(2)),
  };
}

export async function runPositionMonitor(): Promise<{ checked: number; closed: TradeRecord[]; errors: string[] }> {
  const killActive = await isKillSwitchActive();
  const positions = await getPositions();
  const closed: TradeRecord[] = [];
  const errors: string[] = [];

  if (killActive && positions.length > 0) {
    console.log("[bankr] Kill switch active — closing ALL positions");
    const records = await closeAllPositions("kill_switch");
    return { checked: positions.length, closed: records, errors: [] };
  }

  if (positions.length === 0) {
    return { checked: 0, closed: [], errors: [] };
  }

  for (const pos of positions) {
    try {
      if (pos.asset_class === "crypto") {
        await monitorCryptoPosition(pos, closed);
      } else if (pos.asset_class === "polymarket") {
        await monitorPolymarketPosition(pos, closed);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${pos.asset}: ${msg}`);
    }
  }

  const cb = await checkCircuitBreaker();
  if (cb.triggered) {
    console.log("[bankr] Circuit breaker triggered during monitor — closing remaining positions");
    const remaining = await getPositions();
    for (const p of remaining) {
      const record = await closePosition(p.id, p.current_price, "circuit_breaker");
      if (record) closed.push(record);
    }
  }

  return { checked: positions.length, closed, errors };
}

async function monitorCryptoPosition(pos: Position, closed: TradeRecord[]): Promise<void> {
  let currentPrice: number;
  try {
    const candles = await getHistoricalOHLCV(pos.asset, 7);
    if (candles.length === 0) return;
    currentPrice = candles[candles.length - 1].close;
  } catch {
    return;
  }

  const positions = await getPositions();
  const livePos = positions.find(p => p.id === pos.id);
  if (!livePos) return;

  livePos.current_price = currentPrice;
  const isLong = livePos.direction === "LONG";

  if (isLong && currentPrice > livePos.peak_price) {
    livePos.peak_price = currentPrice;
    livePos.atr_stop_price = currentPrice - livePos.atr_value * 5.5;
  } else if (!isLong && currentPrice < livePos.peak_price) {
    livePos.peak_price = currentPrice;
    livePos.atr_stop_price = currentPrice + livePos.atr_value * 5.5;
  }

  const priceDiff = isLong ? currentPrice - livePos.entry_price : livePos.entry_price - currentPrice;
  livePos.unrealized_pnl = parseFloat((priceDiff * livePos.size).toFixed(4));

  await savePositions(positions);

  if (isLong && currentPrice <= livePos.atr_stop_price) {
    console.log(`[bankr] Trailing stop hit for ${pos.asset} at $${currentPrice}`);
    const record = await closePosition(pos.id, currentPrice, "trailing_stop");
    if (record) closed.push(record);
    return;
  }
  if (!isLong && currentPrice >= livePos.atr_stop_price) {
    console.log(`[bankr] Trailing stop hit for ${pos.asset} SHORT at $${currentPrice}`);
    const record = await closePosition(pos.id, currentPrice, "trailing_stop");
    if (record) closed.push(record);
    return;
  }

  try {
    const candles = await getHistoricalOHLCV(pos.asset, 14);
    if (candles.length >= 30) {
      const result = analyzeAsset(candles);
      if (isLong && result.votes.rsi_overbought) {
        console.log(`[bankr] RSI exit (overbought) for ${pos.asset}`);
        const record = await closePosition(pos.id, currentPrice, "rsi_exit");
        if (record) closed.push(record);
        return;
      }
      if (!isLong && result.votes.rsi_oversold) {
        console.log(`[bankr] RSI exit (oversold) for ${pos.asset} SHORT`);
        const record = await closePosition(pos.id, currentPrice, "rsi_exit");
        if (record) closed.push(record);
        return;
      }
    }
  } catch {}

  const hoursOpen = (Date.now() - new Date(pos.opened_at).getTime()) / (60 * 60 * 1000);
  if (hoursOpen > 72) {
    console.log(`[bankr] Time exit (${hoursOpen.toFixed(0)}h > 72h) for ${pos.asset}`);
    const record = await closePosition(pos.id, currentPrice, "time_exit");
    if (record) closed.push(record);
    return;
  }
}

async function monitorPolymarketPosition(pos: Position, closed: TradeRecord[]): Promise<void> {
  let thesis: PolymarketThesis | null = null;
  try {
    const pool = getPool();
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      const found = (res.rows[0].value as PolymarketThesis[]).find(t => t.id === pos.thesis_id);
      if (found) thesis = found;
    }
  } catch {}
  if (!thesis) {
    console.warn(`[bankr] Polymarket thesis ${pos.thesis_id} not found — applying conservative stop loss`);
    const stopLoss = 0.10;
    const isYesFallback = pos.direction === "YES";
    if (isYesFallback && pos.current_price <= pos.entry_price - stopLoss) {
      const record = await closePosition(pos.id, pos.current_price, "pm_stop_loss_no_thesis");
      if (record) closed.push(record);
    } else if (!isYesFallback && pos.current_price >= pos.entry_price + stopLoss) {
      const record = await closePosition(pos.id, pos.current_price, "pm_stop_loss_no_thesis");
      if (record) closed.push(record);
    }
    return;
  }

  const market = await polymarket.getMarketDetails(thesis.market_id);
  if (!market) return;

  const yesPrice = market.tokens.find(t => t.outcome === "Yes")?.price || 0;
  const noPrice = market.tokens.find(t => t.outcome === "No")?.price || 0;
  const isYes = pos.direction === "YES";
  const currentOdds = isYes ? yesPrice : noPrice;

  const positions = await getPositions();
  const livePos = positions.find(p => p.id === pos.id);
  if (!livePos) return;

  livePos.current_price = currentOdds;
  const priceDiff = isYes ? currentOdds - livePos.entry_price : livePos.entry_price - currentOdds;
  livePos.unrealized_pnl = parseFloat((priceDiff * livePos.size).toFixed(4));
  if ((isYes && currentOdds > livePos.peak_price) || (!isYes && currentOdds < livePos.peak_price)) {
    livePos.peak_price = currentOdds;
  }
  await savePositions(positions);

  if (market.closed) {
    console.log(`[bankr] Polymarket resolved for ${pos.asset.slice(0, 60)}`);
    const record = await closePosition(pos.id, currentOdds, "market_resolved");
    if (record) closed.push(record);
    return;
  }

  const endDate = new Date(market.end_date_iso);
  const hoursToResolution = (endDate.getTime() - Date.now()) / (60 * 60 * 1000);
  if (hoursToResolution < 4 && hoursToResolution > 0) {
    console.log(`[bankr] Polymarket near resolution (${hoursToResolution.toFixed(1)}h) for ${pos.asset.slice(0, 60)}`);
    const record = await closePosition(pos.id, currentOdds, "resolution_proximity");
    if (record) closed.push(record);
    return;
  }

  const targetOdds = thesis.exit_odds;
  if (isYes && currentOdds >= targetOdds) {
    console.log(`[bankr] Polymarket target reached (${(currentOdds * 100).toFixed(0)}% >= ${(targetOdds * 100).toFixed(0)}%) for ${pos.asset.slice(0, 60)}`);
    const record = await closePosition(pos.id, currentOdds, "odds_target");
    if (record) closed.push(record);
    return;
  }
  if (!isYes && currentOdds <= targetOdds) {
    console.log(`[bankr] Polymarket target reached (${(currentOdds * 100).toFixed(0)}% <= ${(targetOdds * 100).toFixed(0)}%) for ${pos.asset.slice(0, 60)}`);
    const record = await closePosition(pos.id, currentOdds, "odds_target");
    if (record) closed.push(record);
    return;
  }

  const stopLoss = 0.10;
  if (isYes && currentOdds <= livePos.entry_price - stopLoss) {
    console.log(`[bankr] Polymarket stop loss (${(currentOdds * 100).toFixed(0)}%) for ${pos.asset.slice(0, 60)}`);
    const record = await closePosition(pos.id, currentOdds, "pm_stop_loss");
    if (record) closed.push(record);
    return;
  }
  if (!isYes && currentOdds >= livePos.entry_price + stopLoss) {
    console.log(`[bankr] Polymarket stop loss (${(currentOdds * 100).toFixed(0)}%) for ${pos.asset.slice(0, 60)}`);
    const record = await closePosition(pos.id, currentOdds, "pm_stop_loss");
    if (record) closed.push(record);
    return;
  }

  const daysOpen = (Date.now() - new Date(pos.opened_at).getTime()) / (24 * 60 * 60 * 1000);
  if (daysOpen > 30 && livePos.unrealized_pnl < 0) {
    console.log(`[bankr] Polymarket time exit (${daysOpen.toFixed(0)}d underwater) for ${pos.asset.slice(0, 60)}`);
    const record = await closePosition(pos.id, currentOdds, "pm_time_exit_underwater");
    if (record) closed.push(record);
    return;
  }

  try {
    const activities = await polymarket.getWhaleActivities();
    const marketActivities = activities.filter(a => a.market_id === thesis.market_id);
    if (marketActivities.length >= 2) {
      const flipped = marketActivities.filter(a =>
        a.activity_type !== "position_exit" && a.direction !== pos.direction
      );
      if (flipped.length >= 2) {
        console.log(`[bankr] Polymarket whale consensus flipped for ${pos.asset.slice(0, 60)}`);
        const record = await closePosition(pos.id, currentOdds, "whale_consensus_flip");
        if (record) closed.push(record);
        return;
      }
    }
  } catch {}
}

export async function getPortfolioSummary(): Promise<{
  portfolio_value: number;
  peak_portfolio_value: number;
  peak_drawdown_pct: number;
  consecutive_losses: number;
  open_positions: number;
  total_exposure: number;
  unrealized_pnl: number;
  mode: string;
  paused: boolean;
  kill_switch: boolean;
  bnkr_configured: boolean;
  coinbase_configured: boolean;
  positions: Position[];
}> {
  const [portfolio, peakPortfolio, consecutiveLosses, positions, mode, paused, killSwitch] = await Promise.all([
    getPortfolioValue(),
    getPeakPortfolioValue(),
    getConsecutiveLosses(),
    getPositions(),
    getMode(),
    isPaused(),
    isKillSwitchActive(),
  ]);

  const totalExposure = positions.reduce((sum, p) => sum + p.size * p.entry_price, 0);
  const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealized_pnl, 0);
  const peakDrawdownPct = peakPortfolio > 0 ? ((portfolio - peakPortfolio) / peakPortfolio) * 100 : 0;

  return {
    portfolio_value: portfolio,
    peak_portfolio_value: peakPortfolio,
    peak_drawdown_pct: parseFloat(peakDrawdownPct.toFixed(2)),
    consecutive_losses: consecutiveLosses,
    open_positions: positions.length,
    total_exposure: parseFloat(totalExposure.toFixed(2)),
    unrealized_pnl: parseFloat(unrealizedPnl.toFixed(4)),
    mode,
    paused,
    kill_switch: killSwitch,
    bnkr_configured: bnkr.isConfigured(),
    coinbase_configured: coinbaseWallet.isConfigured(),
    positions,
  };
}

export async function getTaxSummary(): Promise<{
  year: number;
  total_trades: number;
  realized_pnl: number;
  short_term_gains: number;
  short_term_losses: number;
  wash_sale_adjustments: number;
  net_taxable: number;
  estimated_federal_tax: number;
  estimated_ny_tax: number;
  total_estimated_tax: number;
  quarterly: Record<string, { trades: number; pnl: number }>;
}> {
  const history = await getTradeHistory();
  const year = new Date().getFullYear();
  const yearStart = new Date(year, 0, 1).getTime();

  const yearTrades = history.filter(t => new Date(t.closed_at).getTime() >= yearStart);

  let gains = 0;
  let losses = 0;
  let washSaleAdj = 0;
  const quarterly: Record<string, { trades: number; pnl: number }> = {};

  for (const t of yearTrades) {
    const q = `Q${Math.floor(new Date(t.closed_at).getMonth() / 3) + 1}`;
    if (!quarterly[q]) quarterly[q] = { trades: 0, pnl: 0 };
    quarterly[q].trades++;
    quarterly[q].pnl += t.pnl;

    if (t.pnl >= 0) gains += t.pnl;
    else losses += t.pnl;

    if (t.tax_lot.wash_sale_flagged) {
      washSaleAdj += t.tax_lot.wash_sale_disallowed;
    }
  }

  const netTaxable = gains + losses + washSaleAdj;
  const federalRate = 0.24;
  const nyRate = 0.0685;

  return {
    year,
    total_trades: yearTrades.length,
    realized_pnl: parseFloat((gains + losses).toFixed(2)),
    short_term_gains: parseFloat(gains.toFixed(2)),
    short_term_losses: parseFloat(losses.toFixed(2)),
    wash_sale_adjustments: parseFloat(washSaleAdj.toFixed(2)),
    net_taxable: parseFloat(netTaxable.toFixed(2)),
    estimated_federal_tax: parseFloat((Math.max(0, netTaxable) * federalRate).toFixed(2)),
    estimated_ny_tax: parseFloat((Math.max(0, netTaxable) * nyRate).toFixed(2)),
    total_estimated_tax: parseFloat((Math.max(0, netTaxable) * (federalRate + nyRate)).toFixed(2)),
    quarterly,
  };
}

export async function generateForm8949CSV(): Promise<string> {
  const history = await getTradeHistory();
  const year = new Date().getFullYear();
  const yearStart = new Date(year, 0, 1).getTime();
  const yearTrades = history.filter(t => new Date(t.closed_at).getTime() >= yearStart);

  const lines = [
    '"Description of Property","Date Acquired","Date Sold","Proceeds","Cost or Other Basis","Code","Amount of Adjustment","Gain or (Loss)"',
  ];

  for (const t of yearTrades) {
    const lot = t.tax_lot;
    const desc = `${t.size.toFixed(6)} ${t.asset}`;
    const acquired = new Date(lot.acquired_at).toLocaleDateString("en-US");
    const disposed = lot.disposed_at ? new Date(lot.disposed_at).toLocaleDateString("en-US") : "";
    const proceeds = lot.proceeds?.toFixed(2) || "0.00";
    const costBasis = lot.cost_basis.toFixed(2);
    const code = lot.wash_sale_flagged ? "W" : "";
    const adjustment = lot.wash_sale_disallowed > 0 ? lot.wash_sale_disallowed.toFixed(2) : "";
    const gainLoss = lot.gain_loss?.toFixed(2) || "0.00";

    lines.push(`"${desc}","${acquired}","${disposed}","${proceeds}","${costBasis}","${code}","${adjustment}","${gainLoss}"`);
  }

  return lines.join("\n");
}

export async function detectWashSales(): Promise<TaxLot[]> {
  const history = await getTradeHistory();
  const flagged: TaxLot[] = [];
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;

  for (let i = 0; i < history.length; i++) {
    const trade = history[i];
    if (trade.pnl >= 0) continue;

    const closedAt = new Date(trade.closed_at).getTime();

    for (let j = 0; j < history.length; j++) {
      if (i === j) continue;
      const other = history[j];
      if (other.asset !== trade.asset) continue;

      const otherOpened = new Date(other.opened_at).getTime();
      if (Math.abs(otherOpened - closedAt) <= thirtyDays) {
        const lot = { ...trade.tax_lot };
        lot.wash_sale_flagged = true;
        lot.wash_sale_disallowed = Math.abs(trade.pnl);
        flagged.push(lot);
        break;
      }
    }
  }

  return flagged;
}
