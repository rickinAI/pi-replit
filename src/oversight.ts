import { getPool } from "./db.js";
import type { Position, TradeRecord } from "./bankr.js";

export interface HealthReport {
  id: string;
  timestamp: number;
  checks: HealthCheck[];
  overall_status: "healthy" | "degraded" | "critical";
  summary: string;
}

export interface HealthCheck {
  name: string;
  status: "ok" | "warn" | "critical";
  detail: string;
  value?: number;
  threshold?: number;
}

export interface PerformanceReview {
  id: string;
  timestamp: number;
  period_start: number;
  period_end: number;
  total_trades: number;
  win_rate: number;
  avg_pnl: number;
  total_pnl: number;
  sharpe_ratio: number;
  best_trade: { asset: string; pnl: number } | null;
  worst_trade: { asset: string; pnl: number } | null;
  avg_hold_time_hours: number;
  thesis_conversion_rate: number;
  avg_slippage_pct: number;
  source_breakdown: Record<string, { trades: number; pnl: number; win_rate: number }>;
  exposure_alerts: string[];
}

export interface ImprovementRequest {
  id: string;
  created_at: number;
  source: "health_check" | "performance_review" | "manual" | "circuit_breaker";
  category: "risk" | "execution" | "signal" | "infrastructure" | "strategy";
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  suggested_action: string;
  status: "open" | "accepted" | "resolved" | "dismissed";
  resolved_at?: number;
  resolution_note?: string;
}

export interface ShadowTrade {
  id: string;
  thesis_id: string;
  asset: string;
  asset_class: "crypto" | "polymarket";
  source: "crypto_scout" | "polymarket_scout";
  direction: string;
  entry_price: number;
  current_price: number;
  hypothetical_pnl: number;
  opened_at: number;
  closed_at?: number;
  exit_price?: number;
  close_reason?: string;
  status: "open" | "closed";
}

export interface CrossDomainExposure {
  crypto_asset: string;
  polymarket_question: string;
  correlation_type: "direct" | "inverse" | "thematic";
  combined_exposure_pct: number;
  risk_level: "low" | "medium" | "high";
  detail: string;
}

const HEALTH_REPORTS_KEY = "oversight_health_reports";
const IMPROVEMENT_QUEUE_KEY = "oversight_improvement_queue";
const SHADOW_TRADES_KEY = "oversight_shadow_trades";
const LAST_HEALTH_CHECK_KEY = "oversight_last_health_check";
const MAX_REPORTS = 50;
const MAX_IMPROVEMENTS = 100;
const MAX_SHADOW_TRADES = 200;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function getConfigValue<T>(key: string, fallback: T): Promise<T> {
  const pool = getPool();
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = $1`, [key]);
    if (res.rows.length > 0) return res.rows[0].value as T;
  } catch (err) {
    console.warn(`[oversight] Failed to read ${key}:`, err instanceof Error ? err.message : err);
  }
  return fallback;
}

async function setConfigValue(key: string, value: any): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), Date.now()]
  );
}

function pruneByAge<T extends { timestamp?: number; created_at?: number; opened_at?: number }>(
  items: T[], maxItems: number
): T[] {
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  const filtered = items.filter(i => {
    const ts = (i as any).timestamp || (i as any).created_at || (i as any).opened_at || 0;
    return ts > cutoff;
  });
  return filtered.slice(-maxItems);
}

export async function runHealthCheck(): Promise<HealthReport> {
  const pool = getPool();
  const checks: HealthCheck[] = [];
  const now = Date.now();

  const scoutCheck = await checkAgentFreshness(pool, "scout", "SCOUT", 6);
  checks.push(scoutCheck);

  const bankrCheck = await checkAgentFreshness(pool, "bankr", "BANKR", 8);
  checks.push(bankrCheck);

  const polyScoutCheck = await checkAgentFreshness(pool, "polymarket-scout", "Polymarket SCOUT", 6);
  checks.push(polyScoutCheck);

  const monitorCheck = await checkMonitorHeartbeat(pool, now);
  checks.push(monitorCheck);

  const killCheck = await checkKillSwitch(pool);
  checks.push(killCheck);

  const pauseCheck = await checkPauseState(pool);
  checks.push(pauseCheck);

  const circuitCheck = await checkCircuitBreakerState(pool);
  checks.push(circuitCheck);

  const dataCheck = await checkDataFreshness(pool, now);
  checks.push(dataCheck);

  const jobFailCheck = await checkRecentJobFailures(pool);
  checks.push(jobFailCheck);

  const criticalCount = checks.filter(c => c.status === "critical").length;
  const warnCount = checks.filter(c => c.status === "warn").length;
  const overall: HealthReport["overall_status"] =
    criticalCount > 0 ? "critical" : warnCount >= 2 ? "degraded" : "healthy";

  const summaryParts: string[] = [];
  if (criticalCount > 0) summaryParts.push(`${criticalCount} critical`);
  if (warnCount > 0) summaryParts.push(`${warnCount} warnings`);
  const okCount = checks.length - criticalCount - warnCount;
  if (okCount > 0) summaryParts.push(`${okCount} ok`);

  const report: HealthReport = {
    id: `health_${now}`,
    timestamp: now,
    checks,
    overall_status: overall,
    summary: `${overall.toUpperCase()}: ${summaryParts.join(", ")} (${checks.length} checks)`,
  };

  const existing = await getConfigValue<HealthReport[]>(HEALTH_REPORTS_KEY, []);
  existing.push(report);
  await setConfigValue(HEALTH_REPORTS_KEY, pruneByAge(existing, MAX_REPORTS));
  await setConfigValue(LAST_HEALTH_CHECK_KEY, now);

  if (criticalCount > 0 || warnCount >= 2) {
    const issues = checks.filter(c => c.status !== "ok");
    for (const issue of issues) {
      await captureImprovement({
        source: "health_check",
        category: "infrastructure",
        severity: issue.status === "critical" ? "critical" : "medium",
        title: `Health: ${issue.name}`,
        description: issue.detail,
        suggested_action: `Investigate ${issue.name} — status: ${issue.status}`,
      });
    }
  }

  return report;
}

async function checkAgentFreshness(
  pool: any, agentId: string, label: string, thresholdHours: number
): Promise<HealthCheck> {
  try {
    const res = await pool.query(
      `SELECT created_at, status FROM job_history WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [agentId]
    );
    if (res.rows.length === 0) {
      return { name: `${label} Freshness`, status: "warn", detail: `${label} has never run` };
    }
    const lastRun = new Date(res.rows[0].created_at).getTime();
    const hoursSince = (Date.now() - lastRun) / (3600 * 1000);
    if (hoursSince > thresholdHours * 2) {
      return {
        name: `${label} Freshness`, status: "critical",
        detail: `${label} last ran ${Math.floor(hoursSince)}h ago (threshold: ${thresholdHours}h)`,
        value: hoursSince, threshold: thresholdHours,
      };
    }
    if (hoursSince > thresholdHours) {
      return {
        name: `${label} Freshness`, status: "warn",
        detail: `${label} last ran ${Math.floor(hoursSince)}h ago (threshold: ${thresholdHours}h)`,
        value: hoursSince, threshold: thresholdHours,
      };
    }
    const lastStatus = res.rows[0].status;
    if (lastStatus === "error") {
      return {
        name: `${label} Freshness`, status: "warn",
        detail: `${label} ran ${Math.floor(hoursSince)}h ago but last status was error`,
      };
    }
    return {
      name: `${label} Freshness`, status: "ok",
      detail: `${label} ran ${Math.floor(hoursSince)}h ago — OK`,
    };
  } catch {
    return { name: `${label} Freshness`, status: "warn", detail: `Could not check ${label} status` };
  }
}

async function checkMonitorHeartbeat(pool: any, now: number): Promise<HealthCheck> {
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'bankr_monitor_last_tick'`);
    if (res.rows.length === 0) {
      return { name: "Position Monitor", status: "warn", detail: "Monitor has never ticked" };
    }
    const lastTick = typeof res.rows[0].value === "number" ? res.rows[0].value : parseInt(String(res.rows[0].value));
    const minsSince = (now - lastTick) / (60 * 1000);
    if (minsSince > 30) {
      return {
        name: "Position Monitor", status: "critical",
        detail: `Monitor last ticked ${Math.floor(minsSince)} min ago (threshold: 30 min)`,
        value: minsSince, threshold: 30,
      };
    }
    if (minsSince > 15) {
      return {
        name: "Position Monitor", status: "warn",
        detail: `Monitor last ticked ${Math.floor(minsSince)} min ago`,
        value: minsSince, threshold: 30,
      };
    }
    return {
      name: "Position Monitor", status: "ok",
      detail: `Monitor ticked ${Math.floor(minsSince)} min ago — OK`,
    };
  } catch {
    return { name: "Position Monitor", status: "warn", detail: "Could not check monitor heartbeat" };
  }
}

async function checkKillSwitch(pool: any): Promise<HealthCheck> {
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_kill_switch'`);
    if (res.rows.length > 0 && res.rows[0].value === true) {
      return { name: "Kill Switch", status: "critical", detail: "Kill switch is ACTIVE — all trading halted" };
    }
  } catch {}
  return { name: "Kill Switch", status: "ok", detail: "Kill switch inactive" };
}

async function checkPauseState(pool: any): Promise<HealthCheck> {
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_paused'`);
    if (res.rows.length > 0 && res.rows[0].value === true) {
      return { name: "System Paused", status: "warn", detail: "System is PAUSED — jobs will not execute" };
    }
  } catch {}
  return { name: "System Paused", status: "ok", detail: "System is running" };
}

async function checkCircuitBreakerState(pool: any): Promise<HealthCheck> {
  try {
    const history = await getConfigValue<TradeRecord[]>("wealth_engines_trade_history", []);
    const portfolio = await getConfigValue<number>("wealth_engines_portfolio_value", 50);
    const peak = await getConfigValue<number>("wealth_engines_peak_portfolio", 50);

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentTrades = history.filter(t => new Date(t.closed_at).getTime() > sevenDaysAgo);
    const rolling7d = recentTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    const rolling7dPct = portfolio > 0 ? (rolling7d / portfolio * 100) : 0;
    const drawdownPct = peak > 0 ? ((peak - portfolio) / peak * 100) : 0;

    if (rolling7dPct < -15 || drawdownPct > 25) {
      return {
        name: "Circuit Breaker", status: "critical",
        detail: `Circuit breaker triggered — 7d P&L: ${rolling7dPct.toFixed(1)}%, drawdown: ${drawdownPct.toFixed(1)}%`,
      };
    }
    if (rolling7dPct < -10 || drawdownPct > 20) {
      return {
        name: "Circuit Breaker", status: "warn",
        detail: `Approaching circuit breaker — 7d P&L: ${rolling7dPct.toFixed(1)}%, drawdown: ${drawdownPct.toFixed(1)}%`,
      };
    }
    return {
      name: "Circuit Breaker", status: "ok",
      detail: `7d P&L: ${rolling7dPct.toFixed(1)}%, drawdown: ${drawdownPct.toFixed(1)}% — OK`,
    };
  } catch {
    return { name: "Circuit Breaker", status: "warn", detail: "Could not evaluate circuit breaker" };
  }
}

async function checkDataFreshness(pool: any, now: number): Promise<HealthCheck> {
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'scout_latest_brief'`);
    if (res.rows.length === 0) {
      return { name: "Scout Data", status: "warn", detail: "No scout brief data available" };
    }
    const brief = res.rows[0].value;
    const briefTs = brief?.timestamp || brief?.created_at;
    if (briefTs) {
      const hoursSince = (now - briefTs) / (3600 * 1000);
      if (hoursSince > 12) {
        return {
          name: "Scout Data", status: "warn",
          detail: `Scout brief is ${Math.floor(hoursSince)}h old (stale >12h)`,
        };
      }
    }
    return { name: "Scout Data", status: "ok", detail: "Scout brief data available" };
  } catch {
    return { name: "Scout Data", status: "warn", detail: "Could not check scout data" };
  }
}

async function checkRecentJobFailures(pool: any): Promise<HealthCheck> {
  try {
    const res = await pool.query(
      `SELECT job_id, status FROM job_history
       WHERE agent_id IN ('scout', 'bankr', 'polymarket-scout')
       AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC LIMIT 20`
    );
    const failures = res.rows.filter((r: any) => r.status === "error");
    if (failures.length >= 5) {
      return {
        name: "Job Failures", status: "critical",
        detail: `${failures.length} WE job failures in last 24h`,
        value: failures.length, threshold: 5,
      };
    }
    if (failures.length >= 2) {
      return {
        name: "Job Failures", status: "warn",
        detail: `${failures.length} WE job failures in last 24h`,
        value: failures.length, threshold: 5,
      };
    }
    return {
      name: "Job Failures", status: "ok",
      detail: `${failures.length} failures in last 24h — OK`,
    };
  } catch {
    return { name: "Job Failures", status: "warn", detail: "Could not check job failures" };
  }
}

export async function runPerformanceReview(periodDays: number = 7): Promise<PerformanceReview> {
  const now = Date.now();
  const periodStart = now - periodDays * 24 * 60 * 60 * 1000;

  const history = await getConfigValue<TradeRecord[]>("wealth_engines_trade_history", []);
  const periodTrades = history.filter(t => new Date(t.closed_at).getTime() > periodStart);

  const wins = periodTrades.filter(t => (t.pnl || 0) > 0);
  const winRate = periodTrades.length > 0 ? (wins.length / periodTrades.length) * 100 : 0;
  const totalPnl = periodTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const avgPnl = periodTrades.length > 0 ? totalPnl / periodTrades.length : 0;

  let sharpe = 0;
  if (periodTrades.length >= 2) {
    const pnls = periodTrades.map(t => t.pnl || 0);
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (pnls.length - 1);
    const stdDev = Math.sqrt(variance);
    sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252 / periodDays) : 0;
  }

  let bestTrade: { asset: string; pnl: number } | null = null;
  let worstTrade: { asset: string; pnl: number } | null = null;
  for (const t of periodTrades) {
    if (!bestTrade || t.pnl > bestTrade.pnl) bestTrade = { asset: t.asset, pnl: t.pnl };
    if (!worstTrade || t.pnl < worstTrade.pnl) worstTrade = { asset: t.asset, pnl: t.pnl };
  }

  const holdTimes = periodTrades.map(t => {
    const open = new Date(t.opened_at).getTime();
    const close = new Date(t.closed_at).getTime();
    return (close - open) / (3600 * 1000);
  });
  const avgHoldTime = holdTimes.length > 0 ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length : 0;

  const cryptoTheses = await getConfigValue<any[]>("scout_active_theses", []);
  const pmTheses = await getConfigValue<any[]>("polymarket_scout_active_theses", []);
  const totalTheses = cryptoTheses.length + pmTheses.length;
  const tradedThesisIds = new Set(periodTrades.map(t => t.thesis_id));
  const allThesisIds = new Set([
    ...cryptoTheses.map((t: any) => t.id),
    ...pmTheses.map((t: any) => t.id),
  ]);
  const convertedCount = [...tradedThesisIds].filter(id => allThesisIds.has(id)).length;
  const conversionRate = totalTheses > 0 ? (convertedCount / totalTheses) * 100 : 0;

  const slippages = periodTrades
    .filter(t => t.expected_entry_price && t.entry_price)
    .map(t => Math.abs(t.entry_price - t.expected_entry_price) / t.expected_entry_price * 100);
  const avgSlippage = slippages.length > 0 ? slippages.reduce((a, b) => a + b, 0) / slippages.length : 0;

  const sourceBreakdown: Record<string, { trades: number; pnl: number; win_rate: number }> = {};
  for (const t of periodTrades) {
    const src = t.source || "unknown";
    if (!sourceBreakdown[src]) sourceBreakdown[src] = { trades: 0, pnl: 0, win_rate: 0 };
    sourceBreakdown[src].trades++;
    sourceBreakdown[src].pnl += t.pnl || 0;
  }
  for (const src of Object.keys(sourceBreakdown)) {
    const srcTrades = periodTrades.filter(t => (t.source || "unknown") === src);
    const srcWins = srcTrades.filter(t => (t.pnl || 0) > 0);
    sourceBreakdown[src].win_rate = srcTrades.length > 0 ? (srcWins.length / srcTrades.length) * 100 : 0;
  }

  const exposureAlerts = await detectCrossDomainExposure();

  const review: PerformanceReview = {
    id: `perf_${now}`,
    timestamp: now,
    period_start: periodStart,
    period_end: now,
    total_trades: periodTrades.length,
    win_rate: winRate,
    avg_pnl: avgPnl,
    total_pnl: totalPnl,
    sharpe_ratio: sharpe,
    best_trade: bestTrade,
    worst_trade: worstTrade,
    avg_hold_time_hours: avgHoldTime,
    thesis_conversion_rate: conversionRate,
    avg_slippage_pct: avgSlippage,
    source_breakdown: sourceBreakdown,
    exposure_alerts: exposureAlerts.map(e => e.detail),
  };

  if (winRate < 40 && periodTrades.length >= 3) {
    await captureImprovement({
      source: "performance_review",
      category: "signal",
      severity: "high",
      title: `Low win rate: ${winRate.toFixed(0)}%`,
      description: `Win rate over ${periodDays}d is ${winRate.toFixed(1)}% (${wins.length}/${periodTrades.length}). Signal quality may be degraded.`,
      suggested_action: "Review SCOUT thesis generation criteria; consider tightening confidence thresholds",
    });
  }

  if (avgSlippage > 1.5 && slippages.length >= 2) {
    await captureImprovement({
      source: "performance_review",
      category: "execution",
      severity: "medium",
      title: `High slippage: ${avgSlippage.toFixed(2)}%`,
      description: `Average execution slippage is ${avgSlippage.toFixed(2)}% over ${slippages.length} trades.`,
      suggested_action: "Review BNKR execution timing; consider limit orders or smaller position sizes",
    });
  }

  return review;
}

export async function detectCrossDomainExposure(): Promise<CrossDomainExposure[]> {
  const positions = await getConfigValue<Position[]>("wealth_engines_positions", []);
  const pmTheses = await getConfigValue<any[]>("polymarket_scout_active_theses", []);
  const portfolio = await getConfigValue<number>("wealth_engines_portfolio_value", 50);
  const alerts: CrossDomainExposure[] = [];

  const cryptoPositions = positions.filter(p => p.asset_class === "crypto");
  const pmPositions = positions.filter(p => p.asset_class === "polymarket");

  const CRYPTO_PM_CORRELATIONS: Record<string, string[]> = {
    BTC: ["bitcoin", "btc", "crypto"],
    ETH: ["ethereum", "eth", "crypto"],
    SOL: ["solana", "sol"],
    DOGE: ["doge", "meme"],
    XRP: ["xrp", "ripple"],
  };

  for (const cryptoPos of cryptoPositions) {
    const asset = cryptoPos.asset.toUpperCase().replace(/USDT?$/, "");
    const keywords = CRYPTO_PM_CORRELATIONS[asset] || [asset.toLowerCase()];

    for (const pmThesis of pmTheses) {
      if (pmThesis.status !== "active") continue;
      const question = (pmThesis.asset || pmThesis.question || "").toLowerCase();
      const matched = keywords.some(kw => question.includes(kw));
      if (!matched) continue;

      const cryptoExposure = (cryptoPos.size || 0) * (cryptoPos.entry_price || 0);
      const pmExposure = pmThesis.position_size || 0;
      const combinedPct = portfolio > 0 ? ((cryptoExposure + pmExposure) / portfolio * 100) : 0;

      const isSameDirection =
        (cryptoPos.direction === "LONG" && pmThesis.direction === "YES") ||
        (cryptoPos.direction === "SHORT" && pmThesis.direction === "NO");

      alerts.push({
        crypto_asset: cryptoPos.asset,
        polymarket_question: (pmThesis.asset || pmThesis.question || "").slice(0, 80),
        correlation_type: isSameDirection ? "direct" : "inverse",
        combined_exposure_pct: combinedPct,
        risk_level: combinedPct > 40 ? "high" : combinedPct > 25 ? "medium" : "low",
        detail: `${cryptoPos.asset} ${cryptoPos.direction} + PM "${(pmThesis.asset || "").slice(0, 40)}" ${pmThesis.direction} — ${combinedPct.toFixed(0)}% combined exposure (${isSameDirection ? "correlated" : "hedged"})`,
      });
    }
  }

  for (let i = 0; i < pmPositions.length; i++) {
    for (let j = i + 1; j < pmPositions.length; j++) {
      const a = pmPositions[i];
      const b = pmPositions[j];
      if (a.exposure_bucket === b.exposure_bucket) {
        const combinedExposure = ((a.size * a.entry_price) + (b.size * b.entry_price));
        const combinedPct = portfolio > 0 ? (combinedExposure / portfolio * 100) : 0;
        alerts.push({
          crypto_asset: `PM: ${a.asset}`,
          polymarket_question: b.asset,
          correlation_type: "thematic",
          combined_exposure_pct: combinedPct,
          risk_level: combinedPct > 30 ? "high" : "medium",
          detail: `PM bucket overlap: "${a.asset.slice(0, 30)}" + "${b.asset.slice(0, 30)}" in bucket "${a.exposure_bucket}" — ${combinedPct.toFixed(0)}% combined`,
        });
      }
    }
  }

  return alerts;
}

export async function captureImprovement(params: {
  source: ImprovementRequest["source"];
  category: ImprovementRequest["category"];
  severity: ImprovementRequest["severity"];
  title: string;
  description: string;
  suggested_action: string;
}): Promise<ImprovementRequest> {
  const queue = await getConfigValue<ImprovementRequest[]>(IMPROVEMENT_QUEUE_KEY, []);

  const isDuplicate = queue.some(
    i => i.title === params.title && i.status === "open" &&
         (Date.now() - i.created_at) < 24 * 60 * 60 * 1000
  );
  if (isDuplicate) {
    return queue.find(i => i.title === params.title && i.status === "open")!;
  }

  const improvement: ImprovementRequest = {
    id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    created_at: Date.now(),
    ...params,
    status: "open",
  };

  queue.push(improvement);
  await setConfigValue(IMPROVEMENT_QUEUE_KEY, pruneByAge(queue, MAX_IMPROVEMENTS));

  console.log(`[oversight] Improvement captured: [${params.severity}] ${params.title}`);
  return improvement;
}

export async function updateImprovement(
  id: string, status: ImprovementRequest["status"], note?: string
): Promise<ImprovementRequest | null> {
  const queue = await getConfigValue<ImprovementRequest[]>(IMPROVEMENT_QUEUE_KEY, []);
  const idx = queue.findIndex(i => i.id === id);
  if (idx === -1) return null;

  queue[idx].status = status;
  if (status === "resolved" || status === "dismissed") {
    queue[idx].resolved_at = Date.now();
    if (note) queue[idx].resolution_note = note;
  }

  await setConfigValue(IMPROVEMENT_QUEUE_KEY, queue);
  return queue[idx];
}

export async function getImprovementQueue(): Promise<ImprovementRequest[]> {
  return getConfigValue<ImprovementRequest[]>(IMPROVEMENT_QUEUE_KEY, []);
}

export async function openShadowTrade(params: {
  thesis_id: string;
  asset: string;
  asset_class: "crypto" | "polymarket";
  source: "crypto_scout" | "polymarket_scout";
  direction: string;
  entry_price: number;
}): Promise<ShadowTrade> {
  const shadow: ShadowTrade = {
    id: `shadow_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    thesis_id: params.thesis_id,
    asset: params.asset,
    asset_class: params.asset_class,
    source: params.source,
    direction: params.direction,
    entry_price: params.entry_price,
    current_price: params.entry_price,
    hypothetical_pnl: 0,
    opened_at: Date.now(),
    status: "open",
  };

  const trades = await getConfigValue<ShadowTrade[]>(SHADOW_TRADES_KEY, []);
  trades.push(shadow);
  await setConfigValue(SHADOW_TRADES_KEY, pruneByAge(trades, MAX_SHADOW_TRADES));

  console.log(`[oversight] Shadow trade opened: ${params.asset} ${params.direction} @ $${params.entry_price}`);
  return shadow;
}

export async function closeShadowTrade(
  id: string, exitPrice: number, reason: string
): Promise<ShadowTrade | null> {
  const trades = await getConfigValue<ShadowTrade[]>(SHADOW_TRADES_KEY, []);
  const idx = trades.findIndex(t => t.id === id);
  if (idx === -1) return null;

  const trade = trades[idx];
  trade.status = "closed";
  trade.exit_price = exitPrice;
  trade.closed_at = Date.now();
  trade.close_reason = reason;

  const multiplier = trade.direction === "LONG" || trade.direction === "YES" ? 1 : -1;
  trade.hypothetical_pnl = (exitPrice - trade.entry_price) * multiplier;

  await setConfigValue(SHADOW_TRADES_KEY, trades);
  console.log(`[oversight] Shadow trade closed: ${trade.asset} P&L: $${trade.hypothetical_pnl.toFixed(2)}`);
  return trade;
}

export async function updateShadowPrices(
  priceUpdates: Record<string, number>
): Promise<ShadowTrade[]> {
  const trades = await getConfigValue<ShadowTrade[]>(SHADOW_TRADES_KEY, []);
  const openTrades = trades.filter(t => t.status === "open");

  for (const trade of openTrades) {
    const newPrice = priceUpdates[trade.asset];
    if (newPrice != null) {
      trade.current_price = newPrice;
      const multiplier = trade.direction === "LONG" || trade.direction === "YES" ? 1 : -1;
      trade.hypothetical_pnl = (newPrice - trade.entry_price) * multiplier;
    }
  }

  await setConfigValue(SHADOW_TRADES_KEY, trades);
  return openTrades;
}

export async function getShadowTrades(statusFilter?: "open" | "closed"): Promise<ShadowTrade[]> {
  const trades = await getConfigValue<ShadowTrade[]>(SHADOW_TRADES_KEY, []);
  if (statusFilter) return trades.filter(t => t.status === statusFilter);
  return trades;
}

export async function getShadowPerformance(): Promise<{
  total_trades: number;
  open_trades: number;
  closed_trades: number;
  total_pnl: number;
  win_rate: number;
  avg_pnl: number;
  trades: ShadowTrade[];
}> {
  const trades = await getConfigValue<ShadowTrade[]>(SHADOW_TRADES_KEY, []);
  const closed = trades.filter(t => t.status === "closed");
  const open = trades.filter(t => t.status === "open");
  const wins = closed.filter(t => t.hypothetical_pnl > 0);
  const totalPnl = closed.reduce((s, t) => s + t.hypothetical_pnl, 0);
  const openPnl = open.reduce((s, t) => s + t.hypothetical_pnl, 0);

  return {
    total_trades: trades.length,
    open_trades: open.length,
    closed_trades: closed.length,
    total_pnl: totalPnl + openPnl,
    win_rate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
    avg_pnl: closed.length > 0 ? totalPnl / closed.length : 0,
    trades,
  };
}

export async function getLatestHealthReport(): Promise<HealthReport | null> {
  const reports = await getConfigValue<HealthReport[]>(HEALTH_REPORTS_KEY, []);
  return reports.length > 0 ? reports[reports.length - 1] : null;
}

export async function getOversightSummary(): Promise<{
  health: HealthReport | null;
  improvements: { open: number; total: number; critical: number };
  shadow: { open: number; total_pnl: number };
  last_check: number | null;
}> {
  const health = await getLatestHealthReport();
  const queue = await getConfigValue<ImprovementRequest[]>(IMPROVEMENT_QUEUE_KEY, []);
  const openItems = queue.filter(i => i.status === "open");
  const criticalItems = openItems.filter(i => i.severity === "critical");
  const shadowPerf = await getShadowPerformance();
  const lastCheck = await getConfigValue<number | null>(LAST_HEALTH_CHECK_KEY, null);

  return {
    health,
    improvements: { open: openItems.length, total: queue.length, critical: criticalItems.length },
    shadow: { open: shadowPerf.open_trades, total_pnl: shadowPerf.total_pnl },
    last_check: lastCheck,
  };
}

export function formatHealthReport(report: HealthReport): string {
  const statusIcons: Record<string, string> = { ok: "🟢", warn: "🟡", critical: "🔴" };
  const overallIcon = statusIcons[report.overall_status] || "⚪";

  const lines = [
    `${overallIcon} *Oversight Health Report*`,
    `Status: ${report.overall_status.toUpperCase()}`,
    `_${new Date(report.timestamp).toLocaleString("en-US", { timeZone: "America/New_York" })} ET_`,
    "",
  ];

  for (const check of report.checks) {
    const icon = statusIcons[check.status] || "⚪";
    lines.push(`${icon} *${check.name}*: ${check.detail}`);
  }

  lines.push("");
  lines.push(`_${report.summary}_`);
  return lines.join("\n");
}

export function formatPerformanceReview(review: PerformanceReview): string {
  const periodDays = Math.round((review.period_end - review.period_start) / (24 * 60 * 60 * 1000));

  const lines = [
    `📊 *Performance Review (${periodDays}d)*`,
    "",
    `*Trades:* ${review.total_trades}`,
    `*Win Rate:* ${review.win_rate.toFixed(1)}%`,
    `*Total P&L:* ${review.total_pnl >= 0 ? "+" : ""}$${review.total_pnl.toFixed(2)}`,
    `*Avg P&L:* ${review.avg_pnl >= 0 ? "+" : ""}$${review.avg_pnl.toFixed(2)}`,
    `*Sharpe:* ${review.sharpe_ratio.toFixed(2)}`,
    `*Avg Hold:* ${review.avg_hold_time_hours.toFixed(1)}h`,
    `*Slippage:* ${review.avg_slippage_pct.toFixed(2)}%`,
    `*Thesis Conv:* ${review.thesis_conversion_rate.toFixed(0)}%`,
  ];

  if (review.best_trade) {
    lines.push(`*Best:* ${review.best_trade.asset} +$${review.best_trade.pnl.toFixed(2)}`);
  }
  if (review.worst_trade) {
    lines.push(`*Worst:* ${review.worst_trade.asset} $${review.worst_trade.pnl.toFixed(2)}`);
  }

  if (Object.keys(review.source_breakdown).length > 0) {
    lines.push("");
    lines.push("*By Source:*");
    for (const [src, data] of Object.entries(review.source_breakdown)) {
      lines.push(`  ${src}: ${data.trades} trades, $${data.pnl.toFixed(2)}, ${data.win_rate.toFixed(0)}% win`);
    }
  }

  if (review.exposure_alerts.length > 0) {
    lines.push("");
    lines.push("*⚠️ Exposure Alerts:*");
    for (const alert of review.exposure_alerts) {
      lines.push(`  • ${alert}`);
    }
  }

  return lines.join("\n");
}
