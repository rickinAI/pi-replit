import { getPool } from "./db.js";
import type { Pool } from "pg";
import type { Position, TradeRecord } from "./bankr.js";

interface TimestampedRecord {
  timestamp?: number;
  created_at?: number;
  opened_at?: number;
}

interface JobRow {
  status: string;
}

interface ApiErrorRecord {
  timestamp: number;
}

interface DurationRow {
  created_at: string | null;
  completed_at: string | null;
}

interface ThesisRecord {
  id: string;
  status?: string;
  signal_type?: string;
  source?: string;
  confidence?: number;
  score?: number;
  asset?: string;
  question?: string;
  reasoning?: string;
  age_hours?: number;
  invalidation_criteria?: string;
  whale_count?: number;
  odds?: number;
  direction?: string;
  position_size?: number;
  _source?: string;
}

let telegramNotifier: ((msg: string) => Promise<void>) | null = null;

export function setTelegramNotifier(fn: (msg: string) => Promise<void>): void {
  telegramNotifier = fn;
}

async function notifyTelegram(msg: string): Promise<void> {
  if (telegramNotifier) {
    try { await telegramNotifier(msg); } catch (e) {
      console.error("[oversight] Telegram notification failed:", e instanceof Error ? e.message : e);
    }
  }
}

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
  max_drawdown_pct: number;
  sharpe_ratio: number;
  best_trade: { asset: string; pnl: number } | null;
  worst_trade: { asset: string; pnl: number } | null;
  avg_hold_time_hours: number;
  thesis_conversion_rate: number;
  avg_slippage_pct: number;
  per_asset_pnl: Record<string, { trades: number; pnl: number; cumulative_loss: number }>;
  source_breakdown: Record<string, { trades: number; pnl: number; win_rate: number }>;
  signal_attribution: SignalAttribution[];
  exposure_alerts: string[];
}

export interface ThesisReview {
  thesis_id: string;
  asset: string;
  source: string;
  direction: string;
  bull_case: string;
  bear_case: string;
  verdict: "bull_favored" | "bear_favored" | "neutral";
  recommendation: string;
}

export interface SignalAttribution {
  signal_type: string;
  trades: number;
  wins: number;
  losses: number;
  total_pnl: number;
  avg_confidence: number;
  contribution_pct: number;
}

export interface ImprovementRequest {
  id: string;
  created_at: number;
  source: "health_check" | "performance_review" | "manual" | "circuit_breaker";
  category: "risk" | "execution" | "signal" | "infrastructure" | "strategy";
  severity: "low" | "medium" | "high" | "critical";
  domain: "crypto" | "polymarket" | "cross_domain" | "system";
  priority: number;
  title: string;
  description: string;
  pattern_description?: string;
  recommendation: string;
  route: "autoresearch" | "manual_review" | "bankr_config" | "signal_tuning" | "infra_fix";
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
const MAX_REPORTS = 200;
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

async function setConfigValue(key: string, value: unknown): Promise<void> {
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
    const rec = i as TimestampedRecord;
    const ts = rec.timestamp || rec.created_at || rec.opened_at || 0;
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

  const apiCheck = await checkApiFailureRates(pool);
  checks.push(apiCheck);

  const latencyCheck = await checkJobExecutionTrends(pool);
  checks.push(latencyCheck);

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
        recommendation: `Investigate ${issue.name} — status: ${issue.status}`,
      });
    }
  }

  return report;
}

async function checkAgentFreshness(
  pool: Pool, agentId: string, label: string, thresholdHours: number
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

async function checkMonitorHeartbeat(pool: Pool, now: number): Promise<HealthCheck> {
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

async function checkKillSwitch(pool: Pool): Promise<HealthCheck> {
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_kill_switch'`);
    if (res.rows.length > 0 && res.rows[0].value === true) {
      return { name: "Kill Switch", status: "critical", detail: "Kill switch is ACTIVE — all trading halted" };
    }
  } catch {}
  return { name: "Kill Switch", status: "ok", detail: "Kill switch inactive" };
}

async function checkPauseState(pool: Pool): Promise<HealthCheck> {
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_paused'`);
    if (res.rows.length > 0 && res.rows[0].value === true) {
      return { name: "System Paused", status: "warn", detail: "System is PAUSED — jobs will not execute" };
    }
  } catch {}
  return { name: "System Paused", status: "ok", detail: "System is running" };
}

async function checkCircuitBreakerState(pool: Pool): Promise<HealthCheck> {
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
      await enforceCircuitBreaker(rolling7dPct, drawdownPct);
      return {
        name: "Circuit Breaker", status: "critical",
        detail: `Circuit breaker TRIGGERED & ENFORCED — 7d P&L: ${rolling7dPct.toFixed(1)}%, drawdown: ${drawdownPct.toFixed(1)}% — auto-paused`,
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

async function checkDataFreshness(pool: Pool, now: number): Promise<HealthCheck> {
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

async function checkRecentJobFailures(pool: Pool): Promise<HealthCheck> {
  try {
    const res = await pool.query(
      `SELECT job_id, status FROM job_history
       WHERE agent_id IN ('scout', 'bankr', 'polymarket-scout')
       AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC LIMIT 20`
    );
    const failures = res.rows.filter((r: JobRow) => r.status === "error");
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

async function enforceCircuitBreaker(rolling7dPct: number, drawdownPct: number): Promise<void> {
  const pool = getPool();
  const alreadyPaused = await getConfigValue<boolean>("wealth_engines_paused", false);
  if (!alreadyPaused) {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(true), Date.now()]
    );
    console.log(`[oversight] CIRCUIT BREAKER ENFORCED — auto-paused all Wealth Engines`);
  }

  const alertMsg = [
    `🚨 *CIRCUIT BREAKER TRIGGERED*`,
    "",
    `⛔ All Wealth Engine agents have been *AUTO-PAUSED*`,
    `📉 7-day P&L: ${rolling7dPct.toFixed(1)}%${rolling7dPct < -15 ? " (limit: -15%)" : ""}`,
    `📉 Peak drawdown: ${drawdownPct.toFixed(1)}%${drawdownPct > 25 ? " (limit: 25%)" : ""}`,
    "",
    `Use /resume to manually restart after reviewing positions.`,
  ].join("\n");
  await notifyTelegram(alertMsg);

  await captureImprovement({
    source: "circuit_breaker",
    category: "risk",
    severity: "critical",
    domain: "system",
    priority: 1,
    title: `Circuit breaker: 7d ${rolling7dPct.toFixed(1)}%, DD ${drawdownPct.toFixed(1)}%`,
    description: `Auto-paused due to circuit breaker. Rolling 7d P&L: ${rolling7dPct.toFixed(1)}%, peak drawdown: ${drawdownPct.toFixed(1)}%.`,
    pattern_description: "Sustained losses exceeding risk thresholds",
    recommendation: "Review all open positions, evaluate thesis quality, reduce leverage/position sizing before resuming",
    route: "manual_review",
  });
}

async function checkApiFailureRates(pool: Pool): Promise<HealthCheck> {
  try {
    const res = await pool.query(
      `SELECT value FROM app_config WHERE key = 'wealth_engines_api_errors'`
    );
    if (res.rows.length === 0) {
      return { name: "API Health", status: "ok", detail: "No API error tracking data" };
    }
    const errors = res.rows[0].value;
    const recentErrors = Array.isArray(errors)
      ? errors.filter((e: ApiErrorRecord) => e.timestamp > Date.now() - 6 * 60 * 60 * 1000)
      : [];
    const byService: Record<string, number> = {};
    for (const e of recentErrors) {
      const svc = e.service || "unknown";
      byService[svc] = (byService[svc] || 0) + 1;
    }
    const highFailServices = Object.entries(byService).filter(([, count]) => count >= 5);
    if (highFailServices.length > 0) {
      const details = highFailServices.map(([svc, count]) => `${svc}: ${count}`).join(", ");
      return {
        name: "API Health", status: highFailServices.some(([, c]) => c >= 10) ? "critical" : "warn",
        detail: `API failures in last 6h: ${details}`,
        value: recentErrors.length,
      };
    }
    return { name: "API Health", status: "ok", detail: `${recentErrors.length} API errors in last 6h — OK` };
  } catch {
    return { name: "API Health", status: "ok", detail: "API error tracking not available" };
  }
}

async function checkJobExecutionTrends(pool: Pool): Promise<HealthCheck> {
  try {
    const res = await pool.query(
      `SELECT job_id, created_at, completed_at FROM job_history
       WHERE agent_id IN ('scout', 'bankr', 'polymarket-scout')
       AND created_at > NOW() - INTERVAL '48 hours'
       AND completed_at IS NOT NULL
       ORDER BY created_at DESC LIMIT 30`
    );
    if (res.rows.length < 3) {
      return { name: "Job Latency", status: "ok", detail: "Insufficient data for trend analysis" };
    }
    const durations = res.rows.map((r: DurationRow) => {
      const start = new Date(r.created_at || 0).getTime();
      const end = new Date(r.completed_at || 0).getTime();
      return (end - start) / 1000;
    }).filter((d: number) => d > 0);
    if (durations.length === 0) {
      return { name: "Job Latency", status: "ok", detail: "No valid durations" };
    }
    const avgDuration = durations.reduce((a: number, b: number) => a + b, 0) / durations.length;
    const maxDuration = Math.max(...durations);
    if (maxDuration > 300) {
      return {
        name: "Job Latency", status: "warn",
        detail: `Slow jobs detected — avg: ${avgDuration.toFixed(0)}s, max: ${maxDuration.toFixed(0)}s`,
        value: avgDuration, threshold: 120,
      };
    }
    return {
      name: "Job Latency", status: "ok",
      detail: `Avg job duration: ${avgDuration.toFixed(0)}s, max: ${maxDuration.toFixed(0)}s — OK`,
      value: avgDuration,
    };
  } catch {
    return { name: "Job Latency", status: "ok", detail: "Could not analyze job trends" };
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

  const cryptoTheses = await getConfigValue<ThesisRecord[]>("scout_active_theses", []);
  const pmTheses = await getConfigValue<ThesisRecord[]>("polymarket_scout_active_theses", []);
  const totalTheses = cryptoTheses.length + pmTheses.length;
  const tradedThesisIds = new Set(periodTrades.map(t => t.thesis_id));
  const allThesisIds = new Set([
    ...cryptoTheses.map((t: ThesisRecord) => t.id),
    ...pmTheses.map((t: ThesisRecord) => t.id),
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

  const perAssetPnl: Record<string, { trades: number; pnl: number; cumulative_loss: number }> = {};
  for (const t of periodTrades) {
    const asset = t.asset || "unknown";
    if (!perAssetPnl[asset]) perAssetPnl[asset] = { trades: 0, pnl: 0, cumulative_loss: 0 };
    perAssetPnl[asset].trades++;
    perAssetPnl[asset].pnl += t.pnl || 0;
    if ((t.pnl || 0) < 0) perAssetPnl[asset].cumulative_loss += Math.abs(t.pnl || 0);
  }

  let maxDrawdownPct = 0;
  if (periodTrades.length > 0) {
    let peak = 0;
    let running = 0;
    const sorted = [...periodTrades].sort((a, b) =>
      new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime()
    );
    for (const t of sorted) {
      running += t.pnl || 0;
      if (running > peak) peak = running;
      const dd = peak > 0 ? ((peak - running) / peak * 100) : 0;
      if (dd > maxDrawdownPct) maxDrawdownPct = dd;
    }
  }

  const signalAttribution = buildSignalAttribution(periodTrades, totalPnl);

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
    max_drawdown_pct: maxDrawdownPct,
    sharpe_ratio: sharpe,
    best_trade: bestTrade,
    worst_trade: worstTrade,
    avg_hold_time_hours: avgHoldTime,
    thesis_conversion_rate: conversionRate,
    avg_slippage_pct: avgSlippage,
    per_asset_pnl: perAssetPnl,
    source_breakdown: sourceBreakdown,
    signal_attribution: signalAttribution,
    exposure_alerts: exposureAlerts.map(e => e.detail),
  };

  if (winRate < 40 && periodTrades.length >= 3) {
    await captureImprovement({
      source: "performance_review",
      category: "signal",
      severity: "high",
      title: `Low win rate: ${winRate.toFixed(0)}%`,
      description: `Win rate over ${periodDays}d is ${winRate.toFixed(1)}% (${wins.length}/${periodTrades.length}). Signal quality may be degraded.`,
      recommendation: "Review SCOUT thesis generation criteria; consider tightening confidence thresholds",
    });
  }

  if (avgSlippage > 1.5 && slippages.length >= 2) {
    await captureImprovement({
      source: "performance_review",
      category: "execution",
      severity: "medium",
      title: `High slippage: ${avgSlippage.toFixed(2)}%`,
      description: `Average execution slippage is ${avgSlippage.toFixed(2)}% over ${slippages.length} trades.`,
      recommendation: "Review BNKR execution timing; consider limit orders or smaller position sizes",
    });
  }

  return review;
}

function buildSignalAttribution(trades: TradeRecord[], totalPnl: number): SignalAttribution[] {
  const bySignal: Record<string, TradeRecord[]> = {};
  for (const t of trades) {
    const signalType = t.source || "unknown";
    if (!bySignal[signalType]) bySignal[signalType] = [];
    bySignal[signalType].push(t);
  }

  const attrs: SignalAttribution[] = [];
  for (const [signal, signalTrades] of Object.entries(bySignal)) {
    const wins = signalTrades.filter(t => (t.pnl || 0) > 0);
    const losses = signalTrades.filter(t => (t.pnl || 0) <= 0);
    const signalPnl = signalTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    const avgConf = 0;
    attrs.push({
      signal_type: signal,
      trades: signalTrades.length,
      wins: wins.length,
      losses: losses.length,
      total_pnl: signalPnl,
      avg_confidence: avgConf,
      contribution_pct: totalPnl !== 0 ? (signalPnl / Math.abs(totalPnl)) * 100 : 0,
    });
  }
  return attrs.sort((a, b) => b.total_pnl - a.total_pnl);
}

export async function detectCrossDomainExposure(): Promise<CrossDomainExposure[]> {
  const positions = await getConfigValue<Position[]>("wealth_engines_positions", []);
  const pmTheses = await getConfigValue<ThesisRecord[]>("polymarket_scout_active_theses", []);
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

  const EXPOSURE_ALERT_THRESHOLD = 40;
  const highExposure = alerts.filter(a => a.combined_exposure_pct > EXPOSURE_ALERT_THRESHOLD);
  for (const alert of highExposure) {
    await notifyTelegram(
      `⚠️ CROSS-DOMAIN RISK: ${alert.crypto_asset} + ${alert.polymarket_question.slice(0, 40)} — ${alert.combined_exposure_pct.toFixed(0)}% combined exposure (${alert.correlation_type})`
    );
    await captureImprovement({
      source: "health_check",
      category: "risk",
      severity: alert.combined_exposure_pct > 60 ? "critical" : "high",
      domain: "cross_domain",
      title: `Cross-domain concentration: ${alert.combined_exposure_pct.toFixed(0)}% exposure`,
      description: alert.detail,
      recommendation: "Reduce correlated positions across crypto perps and Polymarket to stay under 40% combined exposure",
      route: "bankr_config",
    });
  }

  return alerts;
}

export async function captureImprovement(params: {
  source: ImprovementRequest["source"];
  category: ImprovementRequest["category"];
  severity: ImprovementRequest["severity"];
  title: string;
  description: string;
  recommendation: string;
  domain?: ImprovementRequest["domain"];
  priority?: number;
  pattern_description?: string;
  route?: ImprovementRequest["route"];
}): Promise<ImprovementRequest> {
  const queue = await getConfigValue<ImprovementRequest[]>(IMPROVEMENT_QUEUE_KEY, []);

  const isDuplicate = queue.some(
    i => i.title === params.title && i.status === "open" &&
         (Date.now() - i.created_at) < 24 * 60 * 60 * 1000
  );
  if (isDuplicate) {
    return queue.find(i => i.title === params.title && i.status === "open")!;
  }

  const severityPriority: Record<string, number> = { critical: 1, high: 2, medium: 3, low: 4 };
  const routeMap: Record<string, ImprovementRequest["route"]> = {
    signal: "signal_tuning",
    execution: "bankr_config",
    infrastructure: "infra_fix",
    risk: "manual_review",
    strategy: "autoresearch",
  };

  const improvement: ImprovementRequest = {
    id: `imp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    created_at: Date.now(),
    source: params.source,
    category: params.category,
    severity: params.severity,
    domain: params.domain || inferDomain(params),
    priority: params.priority ?? severityPriority[params.severity] ?? 3,
    title: params.title,
    description: params.description,
    pattern_description: params.pattern_description,
    recommendation: params.recommendation,
    route: params.route || routeMap[params.category] || "manual_review",
    status: "open",
  };

  queue.push(improvement);
  await setConfigValue(IMPROVEMENT_QUEUE_KEY, pruneByAge(queue, MAX_IMPROVEMENTS));

  console.log(`[oversight] Improvement captured: [${params.severity}] ${params.title} → route:${improvement.route}`);
  return improvement;
}

function inferDomain(params: { title: string; description: string; category: string }): ImprovementRequest["domain"] {
  const text = `${params.title} ${params.description}`.toLowerCase();
  if (text.includes("polymarket") || text.includes("pm ")) return "polymarket";
  if (text.includes("crypto") || text.includes("scout") || text.includes("bnkr") || text.includes("bankr")) return "crypto";
  if (text.includes("cross") || text.includes("exposure") || text.includes("correlated")) return "cross_domain";
  return "system";
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
  drawdown: { portfolio_value: number; peak_value: number; drawdown_pct: number; rolling_7d_pnl_pct: number };
  improvements: {
    open: number; total: number; critical: number;
    active_items: Array<{ id: string; severity: string; title: string; domain: string; route: string; created_at: number }>;
  };
  shadow: { open: number; total_pnl: number };
  last_check: number | null;
}> {
  const health = await getLatestHealthReport();
  const queue = await getConfigValue<ImprovementRequest[]>(IMPROVEMENT_QUEUE_KEY, []);
  const openItems = queue.filter(i => i.status === "open");
  const criticalItems = openItems.filter(i => i.severity === "critical");
  const shadowPerf = await getShadowPerformance();
  const lastCheck = await getConfigValue<number | null>(LAST_HEALTH_CHECK_KEY, null);

  const portfolio = await getConfigValue<number>("wealth_engines_portfolio_value", 50);
  const peak = await getConfigValue<number>("wealth_engines_peak_portfolio", 50);
  const history = await getConfigValue<TradeRecord[]>("wealth_engines_trade_history", []);
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentTrades = history.filter(t => new Date(t.closed_at).getTime() > sevenDaysAgo);
  const rolling7d = recentTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const rolling7dPct = portfolio > 0 ? (rolling7d / portfolio * 100) : 0;
  const drawdownPct = peak > 0 ? ((peak - portfolio) / peak * 100) : 0;

  return {
    health,
    drawdown: { portfolio_value: portfolio, peak_value: peak, drawdown_pct: drawdownPct, rolling_7d_pnl_pct: rolling7dPct },
    improvements: {
      open: openItems.length,
      total: queue.length,
      critical: criticalItems.length,
      active_items: openItems.slice(0, 10).map(i => ({
        id: i.id, severity: i.severity, title: i.title,
        domain: i.domain || "system", route: i.route || "manual_review", created_at: i.created_at,
      })),
    },
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
    `*Max Drawdown:* ${review.max_drawdown_pct.toFixed(1)}%`,
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

  if (review.signal_attribution.length > 0) {
    lines.push("");
    lines.push("*📡 Signal Attribution:*");
    for (const sa of review.signal_attribution) {
      lines.push(`  ${sa.signal_type}: ${sa.wins}W/${sa.losses}L, $${sa.total_pnl.toFixed(2)} (${sa.contribution_pct.toFixed(0)}% contrib)`);
    }
  }

  return lines.join("\n");
}

export async function reviewTheses(): Promise<ThesisReview[]> {
  const cryptoTheses = await getConfigValue<ThesisRecord[]>("scout_active_theses", []);
  const pmTheses = await getConfigValue<ThesisRecord[]>("polymarket_scout_active_theses", []);
  const history = await getConfigValue<TradeRecord[]>("wealth_engines_trade_history", []);
  const reviews: ThesisReview[] = [];

  const allTheses: ThesisRecord[] = [
    ...cryptoTheses.filter((t) => t.status === "active").map((t) => ({ ...t, _source: "crypto_scout" as const })),
    ...pmTheses.filter((t) => t.status === "active").map((t) => ({ ...t, _source: "polymarket_scout" as const })),
  ];

  for (const thesis of allTheses) {
    const asset = thesis.asset || thesis.question || "unknown";
    const assetHistory = history.filter(t => t.thesis_id === thesis.id);
    const assetPnl = assetHistory.reduce((s, t) => s + (t.pnl || 0), 0);
    const assetWins = assetHistory.filter(t => (t.pnl || 0) > 0).length;
    const assetLosses = assetHistory.filter(t => (t.pnl || 0) <= 0).length;

    const confidence = thesis.confidence || thesis.score || 0;
    const direction = thesis.direction || "LONG";

    const bullFactors: string[] = [];
    const bearFactors: string[] = [];

    if (confidence >= 0.7 || confidence >= 3.5) bullFactors.push(`High confidence: ${confidence}`);
    else bearFactors.push(`Low confidence: ${confidence}`);

    if (assetWins > assetLosses) bullFactors.push(`Positive track record: ${assetWins}W/${assetLosses}L`);
    else if (assetLosses > 0) bearFactors.push(`Negative track record: ${assetWins}W/${assetLosses}L`);

    if (assetPnl > 0) bullFactors.push(`Cumulative profit: $${assetPnl.toFixed(2)}`);
    else if (assetPnl < 0) bearFactors.push(`Cumulative loss: $${assetPnl.toFixed(2)}`);

    if (thesis.reasoning) bullFactors.push(`Thesis reasoning documented`);
    if (thesis.age_hours && thesis.age_hours > 72) bearFactors.push(`Thesis aging: ${thesis.age_hours.toFixed(0)}h old`);
    if (thesis.invalidation_criteria) bullFactors.push(`Clear invalidation criteria defined`);

    if (thesis._source === "polymarket_scout") {
      if ((thesis.whale_count ?? 0) >= 3) bullFactors.push(`Strong whale consensus: ${thesis.whale_count} whales`);
      else bearFactors.push(`Weak whale consensus: ${thesis.whale_count || 0} whales`);
      if (thesis.odds && (thesis.odds > 85 || thesis.odds < 15)) bearFactors.push(`Extreme odds: ${thesis.odds}% — limited edge`);
    }

    const verdict: ThesisReview["verdict"] =
      bullFactors.length > bearFactors.length + 1 ? "bull_favored" :
      bearFactors.length > bullFactors.length + 1 ? "bear_favored" : "neutral";

    let recommendation = "Continue monitoring";
    if (verdict === "bear_favored") {
      recommendation = "Consider reducing position size or tightening stops";
    }

    reviews.push({
      thesis_id: thesis.id,
      asset: typeof asset === "string" ? asset.slice(0, 50) : "unknown",
      source: thesis._source || "unknown",
      direction: direction || "unknown",
      bull_case: bullFactors.join("; ") || "No strong bull factors",
      bear_case: bearFactors.join("; ") || "No significant bear factors",
      verdict,
      recommendation,
    });

    if (verdict === "bear_favored") {
      await captureImprovement({
        source: "performance_review",
        category: "signal",
        severity: "medium",
        domain: thesis._source === "polymarket_scout" ? "polymarket" : "crypto",
        title: `Bear-favored thesis: ${typeof asset === "string" ? asset.slice(0, 30) : "unknown"}`,
        description: `Adversarial review found bear case stronger: ${bearFactors.join("; ")}`,
        pattern_description: `Thesis ${thesis.id} has more bear factors (${bearFactors.length}) than bull (${bullFactors.length})`,
        recommendation,
        route: "signal_tuning",
      });
    }
  }

  return reviews;
}

export async function checkPerAssetLosses(): Promise<void> {
  const history = await getConfigValue<TradeRecord[]>("wealth_engines_trade_history", []);
  const portfolio = await getConfigValue<number>("wealth_engines_portfolio_value", 50);
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = history.filter(t => new Date(t.closed_at).getTime() > sevenDaysAgo);

  const byAsset: Record<string, number> = {};
  for (const t of recent) {
    const asset = t.asset || "unknown";
    byAsset[asset] = (byAsset[asset] || 0) + (t.pnl || 0);
  }

  for (const [asset, pnl] of Object.entries(byAsset)) {
    const lossPct = portfolio > 0 ? (Math.abs(pnl) / portfolio * 100) : 0;
    if (pnl < 0 && lossPct > 10) {
      await captureImprovement({
        source: "performance_review",
        category: "risk",
        severity: lossPct > 20 ? "critical" : "high",
        domain: "crypto",
        title: `Per-asset loss: ${asset} -${lossPct.toFixed(1)}%`,
        description: `${asset} has accumulated $${Math.abs(pnl).toFixed(2)} loss (${lossPct.toFixed(1)}% of portfolio) in 7 days.`,
        pattern_description: `Concentrated losses in single asset ${asset}`,
        recommendation: `Review ${asset} thesis quality; consider blacklisting or reducing position limits`,
        route: "bankr_config",
      });
    }
  }
}

export async function generateDailyPerformanceSummary(): Promise<string> {
  const review = await runPerformanceReview(1);
  const health = await getLatestHealthReport();
  const portfolio = await getConfigValue<number>("wealth_engines_portfolio_value", 50);
  const peak = await getConfigValue<number>("wealth_engines_peak_portfolio", 50);
  const drawdownPct = peak > 0 ? ((peak - portfolio) / peak * 100) : 0;
  const queue = await getConfigValue<ImprovementRequest[]>(IMPROVEMENT_QUEUE_KEY, []);
  const openItems = queue.filter(i => i.status === "open");

  const lines = [
    `📋 *Daily Performance Summary*`,
    `_${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" })}_`,
    "",
    `💰 *Portfolio:* $${portfolio.toFixed(2)} (peak: $${peak.toFixed(2)}, DD: ${drawdownPct.toFixed(1)}%)`,
    `📊 *Today:* ${review.total_trades} trades, ${review.total_pnl >= 0 ? "+" : ""}$${review.total_pnl.toFixed(2)}`,
    `🎯 *Win Rate:* ${review.win_rate.toFixed(0)}%`,
  ];

  if (health) {
    const icons: Record<string, string> = { healthy: "🟢", degraded: "🟡", critical: "🔴" };
    lines.push(`${icons[health.overall_status] || "⚪"} *System:* ${health.overall_status}`);
  }

  if (openItems.length > 0) {
    const critical = openItems.filter(i => i.severity === "critical");
    lines.push(`📋 *Open Issues:* ${openItems.length}${critical.length > 0 ? ` (${critical.length} critical)` : ""}`);
  }

  return lines.join("\n");
}

export async function sendDailyPerformanceSummary(): Promise<void> {
  const summary = await generateDailyPerformanceSummary();
  await notifyTelegram(summary);
  console.log("[oversight] Daily performance summary sent");
}

export async function autoTrackShadowTrade(params: {
  thesis_id: string;
  asset: string;
  asset_class: "crypto" | "polymarket";
  source: "crypto_scout" | "polymarket_scout";
  direction: string;
  entry_price: number;
  reason: string;
}): Promise<ShadowTrade | null> {
  const existing = await getShadowTrades("open");
  const alreadyTracked = existing.some(t => t.thesis_id === params.thesis_id && t.asset === params.asset);
  if (alreadyTracked) return null;

  const shadow = await openShadowTrade({
    thesis_id: params.thesis_id,
    asset: params.asset,
    asset_class: params.asset_class,
    source: params.source,
    direction: params.direction,
    entry_price: params.entry_price,
  });
  console.log(`[oversight] Auto-shadow: ${params.asset} ${params.direction} @ $${params.entry_price} — ${params.reason}`);
  return shadow;
}
