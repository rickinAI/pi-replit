import { getPool } from "./db.js";
import { analyzeAsset, checkCooldown, recordSignal, type OHLCVCandle } from "./technical-signals.js";
import { getHistoricalOHLCV } from "./coingecko.js";

export interface Position {
  id: string;
  thesis_id: string;
  asset: string;
  asset_class: "crypto" | "polymarket";
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
}

export interface TradeRecord {
  id: string;
  thesis_id: string;
  asset: string;
  asset_class: "crypto" | "polymarket";
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

export interface RiskCheckResult {
  passed: boolean;
  checks: { name: string; passed: boolean; detail: string }[];
  rejection_reason: string | null;
}

const PORTFOLIO_VALUE_KEY = "wealth_engines_portfolio_value";
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
  const isLiveOrBeta = mode === "LIVE" || mode === "BETA";
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

  const rejectionReason = allPassed ? null : checks.filter(c => !c.passed).map(c => c.detail).join("; ");

  return { passed: allPassed, checks, rejection_reason: rejectionReason };
}

export async function openPosition(params: {
  thesis_id: string;
  asset: string;
  asset_class: "crypto" | "polymarket";
  direction: string;
  leverage: number;
  entry_price: number;
  stop_price: number;
  atr_value: number;
  venue: "bnkr" | "coinbase" | "kreo";
  tx_hash?: string;
}): Promise<{ position: Position; trade_id: string }> {
  const portfolio = await getPortfolioValue();
  const maxRisk = portfolio * 0.02;
  const riskDistance = Math.abs(params.entry_price - params.stop_price);
  const size = riskDistance > 0 ? maxRisk / riskDistance : 0;

  const posId = `pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tradeId = `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const position: Position = {
    id: posId,
    thesis_id: params.thesis_id,
    asset: params.asset,
    asset_class: params.asset_class,
    direction: params.direction,
    leverage: `${params.leverage}x`,
    entry_price: params.entry_price,
    current_price: params.entry_price,
    size,
    unrealized_pnl: 0,
    peak_price: params.entry_price,
    atr_value: params.atr_value,
    atr_stop_price: params.entry_price - params.atr_value * 5.5,
    opened_at: new Date().toISOString(),
    venue: params.venue,
    exposure_bucket: getExposureBucket(params.asset, params.asset_class),
  };

  const positions = await getPositions();
  positions.push(position);
  await savePositions(positions);

  recordSignal(params.asset.toLowerCase(), "entry");

  return { position, trade_id: tradeId };
}

export async function closePosition(positionId: string, exitPrice: number, closeReason: string, txHash?: string): Promise<TradeRecord | null> {
  const positions = await getPositions();
  const idx = positions.findIndex(p => p.id === positionId);
  if (idx === -1) return null;

  const pos = positions[idx];
  const isLong = pos.direction === "LONG" || pos.direction === "YES";
  const priceDiff = isLong ? exitPrice - pos.entry_price : pos.entry_price - exitPrice;
  const pnl = priceDiff * pos.size;
  const pnlPct = pos.entry_price > 0 ? (priceDiff / pos.entry_price) * 100 : 0;
  const fees = pos.size * exitPrice * 0.001;

  const taxLot: TaxLot = {
    id: `lot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    asset: pos.asset,
    asset_class: pos.asset_class,
    quantity: pos.size,
    cost_basis: pos.size * pos.entry_price + fees,
    cost_per_unit: pos.entry_price,
    acquired_at: pos.opened_at,
    disposed_at: new Date().toISOString(),
    proceeds: pos.size * exitPrice - fees,
    gain_loss: pnl - fees * 2,
    holding_period: "short",
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
    closed_at: new Date().toISOString(),
    close_reason: closeReason,
    tax_lot: taxLot,
  };

  positions.splice(idx, 1);
  await savePositions(positions);
  await appendTradeHistory(tradeRecord);

  const portfolio = await getPortfolioValue();
  await setPortfolioValue(portfolio + pnl - fees * 2);

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

export async function checkCircuitBreaker(): Promise<{ triggered: boolean; rolling7dayPnl: number; pnlPct: number }> {
  const history = await getTradeHistory();
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const recentTrades = history.filter(t => new Date(t.closed_at).getTime() > sevenDaysAgo);
  const rolling7dayPnl = recentTrades.reduce((sum, t) => sum + t.pnl, 0);
  const portfolio = await getPortfolioValue();
  const pnlPct = portfolio > 0 ? (rolling7dayPnl / portfolio) * 100 : 0;

  const triggered = pnlPct < -15;

  if (triggered) {
    const pool = getPool();
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(true), Date.now()]
    );
    console.log(`[bankr] Circuit breaker TRIGGERED: 7-day P&L ${pnlPct.toFixed(1)}% < -15%`);
  }

  return { triggered, rolling7dayPnl: parseFloat(rolling7dayPnl.toFixed(4)), pnlPct: parseFloat(pnlPct.toFixed(2)) };
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
}

export async function getPortfolioSummary(): Promise<{
  portfolio_value: number;
  open_positions: number;
  total_exposure: number;
  unrealized_pnl: number;
  mode: string;
  paused: boolean;
  kill_switch: boolean;
  positions: Position[];
}> {
  const [portfolio, positions, mode, paused, killSwitch] = await Promise.all([
    getPortfolioValue(),
    getPositions(),
    getMode(),
    isPaused(),
    isKillSwitchActive(),
  ]);

  const totalExposure = positions.reduce((sum, p) => sum + p.size * p.entry_price, 0);
  const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealized_pnl, 0);

  return {
    portfolio_value: portfolio,
    open_positions: positions.length,
    total_exposure: parseFloat(totalExposure.toFixed(2)),
    unrealized_pnl: parseFloat(unrealizedPnl.toFixed(4)),
    mode,
    paused,
    kill_switch: killSwitch,
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
