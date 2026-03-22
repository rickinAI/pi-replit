import { getPool } from "./db.js";
import { analyzeAsset, checkCooldown, recordSignal, loadCryptoSignalParams, type OHLCVCandle } from "./technical-signals.js";
import { getHistoricalOHLCV } from "./coingecko.js";
import * as polymarket from "./polymarket.js";
import * as bnkr from "./bnkr.js";
import type { PolymarketThesis } from "./polymarket-scout.js";
import { autoTrackShadowTrade, closeShadowTrade, updateShadowPrices, getShadowTrades } from "./oversight.js";

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
  venue: "bnkr";
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
const RISK_CONFIG_KEY = "wealth_engine_config";
const DEFAULT_PORTFOLIO = 10000;

export interface RiskConfig {
  max_leverage: number;
  risk_per_trade_pct: number;
  max_positions: number;
  exposure_cap_pct: number;
  correlation_limit: number;
  circuit_breaker_7d_pct: number;
  circuit_breaker_drawdown_pct: number;
  notification_mode: "all" | "trades-only" | "silent";
}

const DEFAULT_RISK_CONFIG: RiskConfig = {
  max_leverage: 5,
  risk_per_trade_pct: 5,
  max_positions: 3,
  exposure_cap_pct: 60,
  correlation_limit: 1,
  circuit_breaker_7d_pct: -15,
  circuit_breaker_drawdown_pct: -25,
  notification_mode: "all",
};

export async function getRiskConfig(): Promise<RiskConfig> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = $1`, [RISK_CONFIG_KEY]);
    if (res.rows.length > 0 && typeof res.rows[0].value === "object" && res.rows[0].value !== null) {
      return { ...DEFAULT_RISK_CONFIG, ...res.rows[0].value };
    }
  } catch {}
  return { ...DEFAULT_RISK_CONFIG };
}

export async function setRiskConfig(updates: Partial<RiskConfig>): Promise<RiskConfig> {
  const current = await getRiskConfig();
  const merged = { ...current, ...updates };
  if (merged.max_leverage < 1 || merged.max_leverage > 10) throw new Error("max_leverage must be 1-10");
  if (merged.risk_per_trade_pct < 1 || merged.risk_per_trade_pct > 10) throw new Error("risk_per_trade_pct must be 1-10");
  if (merged.max_positions < 1 || merged.max_positions > 10) throw new Error("max_positions must be 1-10");
  if (merged.exposure_cap_pct < 20 || merged.exposure_cap_pct > 100) throw new Error("exposure_cap_pct must be 20-100");
  if (merged.correlation_limit < 1 || merged.correlation_limit > 5) throw new Error("correlation_limit must be 1-5");
  if (merged.circuit_breaker_7d_pct > -5 || merged.circuit_breaker_7d_pct < -30) throw new Error("circuit_breaker_7d_pct must be -5 to -30");
  if (merged.circuit_breaker_drawdown_pct > -10 || merged.circuit_breaker_drawdown_pct < -50) throw new Error("circuit_breaker_drawdown_pct must be -10 to -50");
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [RISK_CONFIG_KEY, JSON.stringify(merged), Date.now()]
  );
  return merged;
}

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
  drawdownThreshold?: number;
  mode?: string;
}): ApprovalTier {
  if (params.mode === "SHADOW") return "autonomous";
  const ddThresh = params.drawdownThreshold ?? -25;
  if (
    params.capitalPct > 30 ||
    params.consecutiveLosses >= 3 ||
    params.drawdownPct < ddThresh ||
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

  const [killActive, paused, mode, rc, portfolio, positions, consecutiveLosses, peakPortfolio] = await Promise.all([
    isKillSwitchActive(),
    isPaused(),
    getMode(),
    getRiskConfig(),
    getPortfolioValue(),
    getPositions(),
    getConsecutiveLosses(),
    getPeakPortfolioValue(),
  ]);

  checks.push({ name: "kill_switch", passed: !killActive, detail: killActive ? "Kill switch is ACTIVE" : "Kill switch inactive" });
  if (killActive) allPassed = false;

  checks.push({ name: "pause_state", passed: !paused, detail: paused ? "System is PAUSED" : "System active" });
  if (paused) allPassed = false;

  checks.push({ name: "mode_check", passed: true, detail: `Mode: ${mode}${mode === "SHADOW" ? " (shadow trades only)" : ""}` });

  const levOk = params.leverage <= rc.max_leverage;
  checks.push({ name: "leverage_cap", passed: levOk, detail: `Requested: ${params.leverage}x, Max: ${rc.max_leverage}x` });
  if (!levOk) allPassed = false;

  const riskPct = rc.risk_per_trade_pct / 100;
  const maxRisk = portfolio * riskPct;
  const riskDistance = Math.abs(params.entry_price - params.stop_price);
  const riskAmount = params.risk_amount || (riskDistance > 0 ? maxRisk : 0);
  const riskOk = riskAmount <= maxRisk;
  checks.push({ name: "risk_per_trade", passed: riskOk, detail: `Risk: $${riskAmount.toFixed(2)}, Max: $${maxRisk.toFixed(2)} (${rc.risk_per_trade_pct}% of $${portfolio.toFixed(2)})` });
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

  const posCountOk = positions.length < rc.max_positions;
  checks.push({ name: "max_positions", passed: posCountOk, detail: `Open: ${positions.length}/${rc.max_positions}` });
  if (!posCountOk) allPassed = false;

  const totalExposure = positions.reduce((sum, p) => sum + (p.size * p.entry_price), 0);
  const rawPositionSize = riskDistance > 0 ? riskAmount / riskDistance : 0;
  const exposureLimit = portfolio * (rc.exposure_cap_pct / 100);
  const remainingExposure = Math.max(0, exposureLimit - totalExposure);
  const maxSizeByExposure = params.entry_price > 0 ? remainingExposure / params.entry_price : 0;
  const newPositionSize = Math.min(rawPositionSize, maxSizeByExposure);
  const newExposure = newPositionSize * params.entry_price;
  const totalAfter = totalExposure + newExposure;
  const exposureOk = newPositionSize > 0 && totalAfter <= exposureLimit;
  checks.push({ name: "total_exposure", passed: exposureOk, detail: `After: $${totalAfter.toFixed(2)} / $${exposureLimit.toFixed(2)} (${rc.exposure_cap_pct}% of portfolio)` });
  if (!exposureOk) allPassed = false;

  const bucket = getExposureBucket(params.asset, params.asset_class);
  const bucketCount = positions.filter(p => p.exposure_bucket === bucket).length;
  const correlationOk = bucketCount < rc.correlation_limit;
  checks.push({ name: "correlation_limit", passed: correlationOk, detail: `Bucket "${bucket}": ${bucketCount}/${rc.correlation_limit} positions` });
  if (!correlationOk) allPassed = false;

  checks.push({ name: "consecutive_losses", passed: consecutiveLosses < 3, detail: `Consecutive losses: ${consecutiveLosses}/3` });
  const drawdownPct = peakPortfolio > 0 ? ((portfolio - peakPortfolio) / peakPortfolio) * 100 : 0;
  const drawdownOk = drawdownPct > rc.circuit_breaker_drawdown_pct;
  checks.push({ name: "peak_drawdown", passed: drawdownOk, detail: `Drawdown from peak: ${drawdownPct.toFixed(1)}% (limit: ${rc.circuit_breaker_drawdown_pct}%)` });

  const capitalPct = portfolio > 0 ? (newExposure / portfolio) * 100 : 0;
  const firstForAsset = await isFirstTradeForAsset(params.asset, params.asset_class);
  const tier = determineApprovalTier({
    capitalPct,
    confidence: params.confidence || 3.5,
    consecutiveLosses,
    drawdownPct,
    isFirstForAsset: mode === "SHADOW" ? false : firstForAsset,
    leverageIncrease: false,
    drawdownThreshold: rc.circuit_breaker_drawdown_pct,
    mode,
  });
  checks.push({ name: "approval_tier", passed: true, detail: `Tier: ${tier} (capital: ${capitalPct.toFixed(1)}%, losses: ${consecutiveLosses}, drawdown: ${drawdownPct.toFixed(1)}%, first: ${firstForAsset})` });

  const rejectionReason = allPassed ? null : checks.filter(c => !c.passed).map(c => c.detail).join("; ");

  if (!allPassed) {
    try {
      const source: "crypto_scout" | "polymarket_scout" = params.asset_class === "polymarket" ? "polymarket_scout" : "crypto_scout";
      await autoTrackShadowTrade({
        thesis_id: `riskfail_${Date.now()}`,
        asset: params.asset,
        asset_class: params.asset_class,
        source,
        direction: params.direction,
        entry_price: params.entry_price,
        stop_price: params.stop_price,
        reason: `risk_check_failed: ${rejectionReason}`,
      });
    } catch (e) {
      console.error("[bankr] Shadow tracking on risk fail:", e instanceof Error ? e.message : e);
    }
  }

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
  venue: "bnkr";
  tx_hash?: string;
  market_id?: string;
}): Promise<{ position: Position; trade_id: string; bnkr_order_id?: string }> {
  const mode = await getMode();
  if (mode === "SHADOW") {
    const existingPositions = await getPositions();
    const alreadyOpen = existingPositions.find(p => p.thesis_id === params.thesis_id && p.asset === params.asset && p.direction === params.direction);
    if (alreadyOpen) {
      console.log(`[bankr] SHADOW skip duplicate: ${params.asset} ${params.direction} already open (${alreadyOpen.id})`);
      return { position: alreadyOpen, trade_id: `dup_${alreadyOpen.id}` };
    }

    const source: "crypto_scout" | "polymarket_scout" = params.source === "polymarket_scout" ? "polymarket_scout" : "crypto_scout";
    try {
      await autoTrackShadowTrade({
        thesis_id: params.thesis_id,
        asset: params.asset,
        asset_class: params.asset_class,
        source,
        direction: params.direction,
        entry_price: params.entry_price,
        reason: "shadow_mode_active",
        market_id: params.market_id,
      });
    } catch (e) {
      console.error("[bankr] Shadow tracking in SHADOW mode:", e instanceof Error ? e.message : e);
    }

    const portfolio = await getPortfolioValue();
    const rc = await getRiskConfig();
    const maxRisk = portfolio * (rc.risk_per_trade_pct / 100);
    const riskDistance = Math.abs(params.entry_price - params.stop_price);
    const rawSize = riskDistance > 0 ? maxRisk / riskDistance : 0;
    const totalExposure = existingPositions.reduce((sum, p) => sum + (p.size * p.entry_price), 0);
    const exposureLimit = portfolio * (rc.exposure_cap_pct / 100);
    const remainingExposure = Math.max(0, exposureLimit - totalExposure);
    const maxSizeByExposure = params.entry_price > 0 ? remainingExposure / params.entry_price : 0;
    const shadowSize = Math.min(rawSize, maxSizeByExposure);

    if (shadowSize <= 0) {
      console.log(`[bankr] SHADOW position rejected: ${params.asset} — zero size (raw=${rawSize.toFixed(4)}, maxByExposure=${maxSizeByExposure.toFixed(4)})`);
      return { position: null as any, trade_id: `rejected_${Date.now()}` };
    }

    const shadowPosId = `shadow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const shadowTradeId = `shadow_trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const shadowPosition: Position = {
      id: shadowPosId,
      thesis_id: params.thesis_id,
      asset: params.asset,
      asset_class: params.asset_class,
      source: source,
      direction: params.direction,
      leverage: String(params.leverage),
      entry_price: params.entry_price,
      current_price: params.entry_price,
      size: shadowSize,
      unrealized_pnl: 0,
      peak_price: params.entry_price,
      atr_value: params.atr_value,
      atr_stop_price: params.stop_price,
      venue: params.venue,
      opened_at: new Date().toISOString(),
      exposure_bucket: getExposureBucket(params.asset, params.asset_class),
    };

    const positions = await getPositions();
    positions.push(shadowPosition);
    await savePositions(positions);
    recordSignal(params.asset.toLowerCase(), "entry");

    console.log(`[bankr] SHADOW position opened: ${params.asset} ${params.direction} size=${shadowSize.toFixed(4)} entry=$${params.entry_price}`);
    return { position: shadowPosition, trade_id: shadowTradeId };
  }

  const portfolio = await getPortfolioValue();
  const rc = await getRiskConfig();
  const maxRisk = portfolio * (rc.risk_per_trade_pct / 100);
  const riskDistance = Math.abs(params.entry_price - params.stop_price);
  const rawSize = riskDistance > 0 ? maxRisk / riskDistance : 0;
  const livePositions = await getPositions();
  const liveExposure = livePositions.reduce((sum, p) => sum + (p.size * p.entry_price), 0);
  const liveExpLimit = portfolio * (rc.exposure_cap_pct / 100);
  const liveRemaining = Math.max(0, liveExpLimit - liveExposure);
  const liveMaxSize = params.entry_price > 0 ? liveRemaining / params.entry_price : 0;
  const size = Math.min(rawSize, liveMaxSize);

  if (size <= 0) {
    throw new Error(`Position rejected: zero size after exposure cap (raw=${rawSize.toFixed(4)}, maxByExposure=${liveMaxSize.toFixed(4)})`);
  }

  const posId = `pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tradeId = `trade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  let bnkrOrderId: string | undefined;
  let fillQuantity: number | undefined;
  const source = params.source || (params.asset_class === "polymarket" ? "polymarket_scout" : "crypto_scout");

  if (bnkr.isConfigured()) {
    if (params.asset_class === "crypto") {
      const stopLossPct = params.stop_price > 0 && params.entry_price > 0
        ? Math.abs((params.entry_price - params.stop_price) / params.entry_price) * 100
        : undefined;
      const takeProfitPct = params.entry_price > 0 && params.atr_value > 0
        ? (params.atr_value * 5.5 * 2 / params.entry_price) * 100
        : undefined;

      let usedTwap = false;
      if (bnkr.shouldUseTwap(size * params.entry_price)) {
        try {
          const twapResult = await bnkr.twapOrder({
            asset: params.asset,
            direction: params.direction === "LONG" ? "buy" : "sell",
            totalAmount: size * params.entry_price,
            durationHours: 2,
          });
          if (twapResult.status === "completed") {
            const twapOrderId = twapResult.richData?.orderDetails?.order_id
              || twapResult.richData?.orderDetails?.orderId
              || twapResult.richData?.twapId;
            if (twapOrderId) {
              bnkrOrderId = twapOrderId;
              usedTwap = true;
              console.log(`[bankr] TWAP order accepted for ${params.asset}: ${twapResult.status}, orderId=${twapOrderId}`);
            } else {
              console.warn(`[bankr] TWAP returned ${twapResult.status} but no order ID — falling back to standard execution`);
            }
          } else {
            console.warn(`[bankr] TWAP order status '${twapResult.status}' is not actionable — falling back to standard execution`);
          }
        } catch (twapErr) {
          console.warn(`[bankr] TWAP order failed, proceeding with standard execution: ${twapErr instanceof Error ? twapErr.message : twapErr}`);
        }
      }

      if (!usedTwap) {
        const order = await bnkr.openCryptoPosition({
          asset: params.asset,
          direction: params.direction as "LONG" | "SHORT",
          leverage: params.leverage,
          size,
          stop_price: params.stop_price,
          stop_loss_pct: stopLossPct ? parseFloat(stopLossPct.toFixed(1)) : undefined,
          take_profit_pct: takeProfitPct ? parseFloat(takeProfitPct.toFixed(1)) : undefined,
        });
        bnkrOrderId = order.order_id;
        if (order.entry_price > 0) params.entry_price = order.entry_price;
      }
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
        const positionValue = pos.size * exitPrice;
        const urgentReasons = new Set(["kill_switch", "circuit_breaker", "stop_loss", "take_profit", "trailing_stop", "rsi_exit"]);
        if (bnkr.shouldUseTwap(positionValue) && !urgentReasons.has(closeReason)) {
          try {
            const twapResult = await bnkr.twapOrder({
              asset: pos.asset,
              direction: pos.direction === "LONG" || pos.direction === "YES" ? "sell" : "buy",
              totalAmount: positionValue,
              durationHours: 1,
            });
            if (twapResult.status === "completed" &&
                (twapResult.richData?.orderDetails?.order_id || twapResult.richData?.orderDetails?.orderId || twapResult.richData?.twapId)) {
              const twapExitPrice = twapResult.richData?.orderDetails?.exit_price || twapResult.richData?.orderDetails?.exitPrice;
              if (twapExitPrice && twapExitPrice > 0) exitPrice = twapExitPrice;
              txHash = txHash || twapResult.richData?.orderDetails?.tx_hash || twapResult.richData?.orderDetails?.txHash;
              console.log(`[bankr] TWAP close completed for ${pos.asset}`);
            } else {
              console.warn(`[bankr] TWAP close returned '${twapResult.status}' — falling back to standard close`);
              const result = await bnkr.closeCryptoPosition(pos.bnkr_order_id);
              if (result.exit_price > 0) exitPrice = result.exit_price;
              txHash = txHash || result.tx_hash;
            }
          } catch (twapErr) {
            console.warn(`[bankr] TWAP close failed, using standard close: ${twapErr instanceof Error ? twapErr.message : twapErr}`);
            const result = await bnkr.closeCryptoPosition(pos.bnkr_order_id);
            if (result.exit_price > 0) exitPrice = result.exit_price;
            txHash = txHash || result.tx_hash;
          }
        } else {
          const result = await bnkr.closeCryptoPosition(pos.bnkr_order_id);
          if (result.exit_price > 0) exitPrice = result.exit_price;
          txHash = txHash || result.tx_hash;
        }
      } else if (pos.asset_class === "polymarket") {
        const result = await bnkr.closePolymarketPosition(pos.bnkr_order_id);
        if (result.exit_odds > 0) exitPrice = result.exit_odds;
        txHash = txHash || result.tx_hash;
      }
    } catch (err) {
      console.error(`[bankr] BNKR close failed for ${pos.bnkr_order_id}:`, err instanceof Error ? err.message : err);
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

  try {
    await updateSignalQuality({
      source: pos.source || "manual",
      asset_class: pos.asset_class,
      pnl: parseFloat(pnl.toFixed(4)),
      asset: pos.asset,
      trade_id: pos.id,
    });
  } catch (e) {
    console.error("[bankr] Signal quality update on close:", e instanceof Error ? e.message : e);
  }

  recordSignal(pos.asset.toLowerCase(), "exit");

  try {
    const openShadows = await getShadowTrades("open");
    for (const shadow of openShadows) {
      if (shadow.thesis_id === pos.thesis_id || shadow.asset === pos.asset) {
        await closeShadowTrade(shadow.id, exitPrice, closeReason);
      }
    }
  } catch (e) {
    console.error("[bankr] Shadow trade close sync:", e instanceof Error ? e.message : e);
  }

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

  const rc = await getRiskConfig();
  const triggered = pnlPct < rc.circuit_breaker_7d_pct || peakDrawdownPct < rc.circuit_breaker_drawdown_pct;

  if (triggered) {
    const pool = getPool();
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(true), Date.now()]
    );
    const reason = peakDrawdownPct < rc.circuit_breaker_drawdown_pct
      ? `Peak drawdown ${peakDrawdownPct.toFixed(1)}% < ${rc.circuit_breaker_drawdown_pct}%`
      : `7-day P&L ${pnlPct.toFixed(1)}% < ${rc.circuit_breaker_7d_pct}%`;
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

  try {
    const priceMap: Record<string, number> = {};
    for (const pos of positions) {
      if (pos.current_price > 0) {
        priceMap[pos.asset] = pos.current_price;
      }
    }
    if (Object.keys(priceMap).length > 0) {
      await updateShadowPrices(priceMap);
    }
  } catch (e) {
    console.error("[bankr] Shadow price update:", e instanceof Error ? e.message : e);
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
      const dbSignalParams = await loadCryptoSignalParams();
      const result = analyzeAsset(candles, dbSignalParams);
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
    positions,
  };
}

export async function getTaxSummary(extraTrades?: Array<{ pnl: number; closed_at: string; tax_lot?: any }>): Promise<{
  year: number;
  total_trades: number;
  realized_pnl: number;
  short_term_gains: number;
  short_term_losses: number;
  long_term_gains: number;
  long_term_losses: number;
  wash_sale_adjustments: number;
  net_taxable: number;
  estimated_federal_tax: number;
  estimated_ny_tax: number;
  total_estimated_tax: number;
  quarterly: Record<string, { trades: number; pnl: number }>;
}> {
  const history = [...(await getTradeHistory()), ...(extraTrades || [])];
  const year = new Date().getFullYear();
  const yearStart = new Date(year, 0, 1).getTime();

  const yearTrades = history.filter(t => new Date(t.closed_at).getTime() >= yearStart);

  let stGains = 0;
  let stLosses = 0;
  let ltGains = 0;
  let ltLosses = 0;
  let washSaleAdj = 0;
  const quarterly: Record<string, { trades: number; pnl: number }> = {};

  for (const t of yearTrades) {
    const q = `Q${Math.floor(new Date(t.closed_at).getMonth() / 3) + 1}`;
    if (!quarterly[q]) quarterly[q] = { trades: 0, pnl: 0 };
    quarterly[q].trades++;
    quarterly[q].pnl += t.pnl;

    const isLongTerm = t.tax_lot?.holding_period === "long";
    if (t.pnl >= 0) {
      if (isLongTerm) ltGains += t.pnl;
      else stGains += t.pnl;
    } else {
      if (isLongTerm) ltLosses += t.pnl;
      else stLosses += t.pnl;
    }

    if (t.tax_lot?.wash_sale_flagged) {
      washSaleAdj += t.tax_lot.wash_sale_disallowed;
    }
  }

  const totalGains = stGains + ltGains;
  const totalLosses = stLosses + ltLosses;
  const netTaxable = totalGains + totalLosses + washSaleAdj;
  const stFederalRate = 0.24;
  const ltFederalRate = 0.15;
  const nyRate = 0.0685;

  const estFederal = Math.max(0, stGains + stLosses) * stFederalRate + Math.max(0, ltGains + ltLosses) * ltFederalRate;
  const estNY = Math.max(0, netTaxable) * nyRate;

  return {
    year,
    total_trades: yearTrades.length,
    realized_pnl: parseFloat((totalGains + totalLosses).toFixed(2)),
    short_term_gains: parseFloat(stGains.toFixed(2)),
    short_term_losses: parseFloat(stLosses.toFixed(2)),
    long_term_gains: parseFloat(ltGains.toFixed(2)),
    long_term_losses: parseFloat(ltLosses.toFixed(2)),
    wash_sale_adjustments: parseFloat(washSaleAdj.toFixed(2)),
    net_taxable: parseFloat(netTaxable.toFixed(2)),
    estimated_federal_tax: parseFloat(estFederal.toFixed(2)),
    estimated_ny_tax: parseFloat(estNY.toFixed(2)),
    total_estimated_tax: parseFloat((estFederal + estNY).toFixed(2)),
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

export interface SignalQualityRecord {
  source: "crypto_scout" | "polymarket_scout";
  asset_class: "crypto" | "polymarket";
  wins: number;
  losses: number;
  total_pnl: number;
  avg_pnl: number;
  win_rate: number;
  profit_factor: number;
  recent_results: Array<{ pnl: number; ts: number; asset: string; trade_id?: string }>;
  asset_breakdown?: Record<string, { wins: number; losses: number; win_rate: number; avg_pnl: number }>;
}

const SIGNAL_QUALITY_KEY = "signal_quality_scores";
const SIGNAL_QUALITY_MAX_RECENT = 50;
const SIGNAL_QUALITY_DECAY_MS = 30 * 24 * 60 * 60 * 1000;

export async function getSignalQuality(): Promise<SignalQualityRecord[]> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = $1`, [SIGNAL_QUALITY_KEY]);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      const records: SignalQualityRecord[] = res.rows[0].value;
      const cutoff = Date.now() - SIGNAL_QUALITY_DECAY_MS;
      for (const record of records) {
        const before = record.recent_results.length;
        record.recent_results = record.recent_results.filter(r => r.ts > cutoff);
        if (record.recent_results.length !== before) {
          const recentWins = record.recent_results.filter(r => r.pnl > 0).length;
          const recentTotal = record.recent_results.length;
          const recentPnl = record.recent_results.reduce((s, r) => s + r.pnl, 0);
          record.win_rate = recentTotal > 0 ? parseFloat((recentWins / recentTotal * 100).toFixed(1)) : 0;
          record.avg_pnl = recentTotal > 0 ? parseFloat((recentPnl / recentTotal).toFixed(4)) : 0;
          const grossProfit = record.recent_results.filter(r => r.pnl > 0).reduce((s, r) => s + r.pnl, 0);
          const grossLoss = Math.abs(record.recent_results.filter(r => r.pnl < 0).reduce((s, r) => s + r.pnl, 0));
          record.profit_factor = grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 99 : 0;
          const breakdown: Record<string, { wins: number; losses: number; win_rate: number; avg_pnl: number }> = {};
          for (const r of record.recent_results) {
            if (!breakdown[r.asset]) breakdown[r.asset] = { wins: 0, losses: 0, win_rate: 0, avg_pnl: 0 };
            if (r.pnl > 0) breakdown[r.asset].wins++;
            else breakdown[r.asset].losses++;
          }
          for (const [asset, stats] of Object.entries(breakdown)) {
            const total = stats.wins + stats.losses;
            const pnl = record.recent_results.filter(r => r.asset === asset).reduce((s, r) => s + r.pnl, 0);
            stats.win_rate = total > 0 ? parseFloat((stats.wins / total * 100).toFixed(1)) : 0;
            stats.avg_pnl = total > 0 ? parseFloat((pnl / total).toFixed(4)) : 0;
          }
          record.asset_breakdown = breakdown;
        }
      }
      return records;
    }
  } catch (err) {
    console.error("[bankr] getSignalQuality failed:", err instanceof Error ? err.message : err);
  }
  return [];
}

export async function updateSignalQuality(params: {
  source: "crypto_scout" | "polymarket_scout" | "manual";
  asset_class: "crypto" | "polymarket";
  pnl: number;
  asset: string;
  trade_id?: string;
}): Promise<void> {
  if (params.source === "manual") return;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3) ON CONFLICT (key) DO NOTHING`,
      [SIGNAL_QUALITY_KEY, JSON.stringify([]), Date.now()]
    );
    const lockRes = await client.query(
      `SELECT value FROM app_config WHERE key = $1 FOR UPDATE`,
      [SIGNAL_QUALITY_KEY]
    );
    const records: SignalQualityRecord[] = (lockRes.rows.length > 0 && Array.isArray(lockRes.rows[0].value))
      ? lockRes.rows[0].value : [];

    const now = Date.now();
    const cutoff = now - SIGNAL_QUALITY_DECAY_MS;

    let record = records.find(r => r.source === params.source && r.asset_class === params.asset_class);
    if (!record) {
      record = {
        source: params.source,
        asset_class: params.asset_class,
        wins: 0,
        losses: 0,
        total_pnl: 0,
        avg_pnl: 0,
        win_rate: 0,
        profit_factor: 0,
        recent_results: [],
        asset_breakdown: {},
      };
      records.push(record);
    }

    if (params.trade_id && record.recent_results.some(r => r.trade_id === params.trade_id)) {
      await client.query("ROLLBACK");
      console.log(`[bankr] Signal quality skip: trade ${params.trade_id} already recorded`);
      return;
    }

    record.recent_results.push({ pnl: params.pnl, ts: now, asset: params.asset, trade_id: params.trade_id });
    record.recent_results = record.recent_results
      .filter(r => r.ts > cutoff)
      .slice(-SIGNAL_QUALITY_MAX_RECENT);

    const recentWins = record.recent_results.filter(r => r.pnl > 0).length;
    const recentTotal = record.recent_results.length;
    const recentPnl = record.recent_results.reduce((s, r) => s + r.pnl, 0);

    if (params.pnl > 0) record.wins++;
    else record.losses++;
    record.total_pnl = parseFloat((record.total_pnl + params.pnl).toFixed(4));

    record.win_rate = recentTotal > 0 ? parseFloat((recentWins / recentTotal * 100).toFixed(1)) : 0;
    record.avg_pnl = recentTotal > 0 ? parseFloat((recentPnl / recentTotal).toFixed(4)) : 0;

    const grossProfit = record.recent_results.filter(r => r.pnl > 0).reduce((s, r) => s + r.pnl, 0);
    const grossLoss = Math.abs(record.recent_results.filter(r => r.pnl < 0).reduce((s, r) => s + r.pnl, 0));
    record.profit_factor = grossLoss > 0 ? parseFloat((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 99 : 0;

    if (!record.asset_breakdown) record.asset_breakdown = {};
    const assetResults = record.recent_results.filter(r => r.asset === params.asset);
    const assetWins = assetResults.filter(r => r.pnl > 0).length;
    const assetTotal = assetResults.length;
    const assetPnl = assetResults.reduce((s, r) => s + r.pnl, 0);
    record.asset_breakdown[params.asset] = {
      wins: assetWins,
      losses: assetTotal - assetWins,
      win_rate: assetTotal > 0 ? parseFloat((assetWins / assetTotal * 100).toFixed(1)) : 0,
      avg_pnl: assetTotal > 0 ? parseFloat((assetPnl / assetTotal).toFixed(4)) : 0,
    };

    await client.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [SIGNAL_QUALITY_KEY, JSON.stringify(records), now]
    );
    await client.query("COMMIT");
    console.log(`[bankr] Signal quality updated: ${params.source}/${params.asset_class} — ${params.pnl > 0 ? "WIN" : "LOSS"} $${params.pnl.toFixed(2)}, win rate: ${record.win_rate}%, profit factor: ${record.profit_factor}`);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function getSignalQualityModifier(scores: SignalQualityRecord[], source: "crypto_scout" | "polymarket_scout", assetClass: "crypto" | "polymarket"): { modifier: string; winRate: number; sampleSize: number; profitFactor: number } {
  const MIN_SAMPLE_SIZE = 8;
  const record = scores.find(r => r.source === source && r.asset_class === assetClass);
  if (!record || record.recent_results.length < MIN_SAMPLE_SIZE) {
    return { modifier: "neutral", winRate: 0, sampleSize: record?.recent_results.length || 0, profitFactor: 0 };
  }
  const pf = record.profit_factor || 0;
  const wr = record.win_rate;
  if (wr > 55 && pf > 1.2) return { modifier: "boost", winRate: wr, sampleSize: record.recent_results.length, profitFactor: pf };
  if (wr < 40 || pf < 0.5) return { modifier: "penalty", winRate: wr, sampleSize: record.recent_results.length, profitFactor: pf };
  return { modifier: "neutral", winRate: wr, sampleSize: record.recent_results.length, profitFactor: pf };
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
