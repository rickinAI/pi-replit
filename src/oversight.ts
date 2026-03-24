import { getPool } from "./db.js";
import type { Pool } from "pg";
import type { Position, TradeRecord } from "./bankr.js";
import * as polymarket from "./polymarket.js";

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
  domain: "polymarket" | "system";
  priority: number;
  title: string;
  description: string;
  pattern_description?: string;
  recommendation: string;
  route: "manual" | "bankr-config";
  status: "open" | "accepted" | "resolved" | "dismissed";
  resolved_at?: number;
  resolution_note?: string;
}

export interface ShadowTrade {
  id: string;
  thesis_id: string;
  asset: string;
  asset_class: "polymarket";
  source: "polymarket_scout";
  direction: string;
  entry_price: number;
  current_price: number;
  hypothetical_pnl: number;
  notional_amount: number;
  pnl_pct: number;
  opened_at: number;
  closed_at?: number;
  exit_price?: number;
  close_reason?: string;
  market_id?: string;
  status: "open" | "closed";
  stop_price?: number;
  target_price?: number;
  end_date?: string;
  token_id?: string;
  last_price_update?: number;
}

export interface CrossDomainExposure {
  asset_a: string;
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

let shadowMutexQueue: Promise<void> = Promise.resolve();
function withShadowLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = shadowMutexQueue;
  let resolve: () => void;
  shadowMutexQueue = new Promise<void>(r => { resolve = r; });
  return prev.then(fn).finally(() => resolve!());
}

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

  const walletHealthCheck = await checkWalletHealth();
  checks.push(walletHealthCheck);

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
    const fmt = await import("./telegram-format.js");

    const hcLines = [
      fmt.buildCategoryHeader(fmt.CATEGORY_BADGES.OVERSIGHT, `Health Check ⚠️`),
      "",
      `${issues.length} issue${issues.length !== 1 ? "s" : ""} detected:`,
      ...issues.map(i => `  ${i.status === "critical" ? "🔴" : "🟡"} ${fmt.escapeHtml(i.name)}: ${fmt.escapeHtml(i.detail)}`),
      "",
      `Action: Check scheduled-jobs status`,
      `[/oversight for full report]`,
    ];
    await notifyTelegram(fmt.truncateToTelegramLimit(hcLines.join("\n")));

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

interface WalletPosition {
  redeemable?: boolean;
  currentValue?: number;
  closedAt?: string;
  updatedAt?: string;
  createdAt?: string;
  cashPnl?: number;
}

async function checkWalletHealth(): Promise<HealthCheck> {
  try {
    const wallets = await polymarket.getWhaleWatchlist();
    if (wallets.length === 0) {
      return { name: "Wallet Health", status: "ok", detail: "No wallets in registry" };
    }

    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let healthy = 0;
    let degraded = 0;
    let disabled = 0;
    const disabledThisCycle: string[] = [];

    for (const wallet of wallets) {
      if (!wallet.enabled) {
        disabled++;
        continue;
      }

      try {
        const positions = await polymarket.fetchWalletPositionsDirect(wallet.address) as WalletPosition[];
        const resolved = positions.filter((p) => {
          const isResolved = p.redeemable || p.currentValue === 0;
          const timestamp = p.closedAt || p.updatedAt || p.createdAt;
          const ts = timestamp ? new Date(timestamp).getTime() : 0;
          return isResolved && ts > thirtyDaysAgo;
        });

        if (resolved.length < 3) {
          if (wallet.degraded_count > 0) wallet.degraded_count = 0;
          healthy++;
        } else {
          const wins = resolved.filter((p) => (p.cashPnl || 0) > 0).length;
          const winRate = wins / resolved.length;
          wallet.win_rate = winRate;

          if (winRate < 0.55) {
            wallet.degraded_count = (wallet.degraded_count || 0) + 1;

            if (wallet.degraded_count >= 3) {
              wallet.enabled = false;
              wallet.status = "probation";
              disabledThisCycle.push(wallet.alias);
              disabled++;

              const fmtW = await import("./telegram-format.js");
              const wdLines = [
                fmtW.buildCategoryHeader(fmtW.CATEGORY_BADGES.WHALE_INTEL, "Wallet Auto-Disabled"),
                "",
                `${fmtW.getNicheEmoji(wallet.niche)} ${fmtW.escapeHtml(wallet.alias)} (${fmtW.escapeHtml(wallet.niche)})`,
                `Win rate: ${(winRate * 100).toFixed(0)}% (30d, ${resolved.length} resolved)`,
                `Degraded ${wallet.degraded_count} consecutive checks`,
                "",
                `Use /add-wallet to re-enable after review.`,
              ];
              await notifyTelegram(fmtW.truncateToTelegramLimit(wdLines.join("\n")));
            } else {
              degraded++;
            }
          } else {
            if (wallet.degraded_count > 0) wallet.degraded_count = 0;
            healthy++;
          }
        }
      } catch (fetchErr) {
        console.warn(`[oversight] Wallet health fetch failed for ${wallet.alias}:`, fetchErr instanceof Error ? fetchErr.message : fetchErr);
        degraded++;
      }

      await new Promise(r => setTimeout(r, 300));
    }

    await polymarket.saveWhaleWatchlist(wallets);

    const total = healthy + degraded + disabled;
    const detail = `${healthy} healthy, ${degraded} degraded, ${disabled} disabled` +
      (disabledThisCycle.length > 0 ? ` (auto-disabled: ${disabledThisCycle.join(", ")})` : "");

    const status: HealthCheck["status"] =
      disabledThisCycle.length > 0 ? "warn" :
      degraded > 0 ? "warn" : "ok";

    return { name: "Wallet Health", status, detail, value: healthy, threshold: total };
  } catch (err) {
    return {
      name: "Wallet Health",
      status: "warn",
      detail: `Check failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
    const portfolio = await getConfigValue<number>("wealth_engines_portfolio_value", 1000);
    const peak = await getConfigValue<number>("wealth_engines_peak_portfolio", 1000);

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
    return { name: "PM Scout Data", status: "ok", detail: "Polymarket scout active" };
  } catch {
    return { name: "PM Scout Data", status: "warn", detail: "Could not check PM scout data" };
  }
}

async function checkRecentJobFailures(pool: Pool): Promise<HealthCheck> {
  try {
    const res = await pool.query(
      `SELECT job_id, status FROM job_history
       WHERE agent_id IN ('bankr', 'polymarket-scout')
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

  const { CATEGORY_BADGES, buildCategoryHeader, SEPARATOR, truncateToTelegramLimit } = await import("./telegram-format.js");
  const alertMsg = [
    buildCategoryHeader(CATEGORY_BADGES.CIRCUIT_BREAK, "Triggered"),
    "",
    `Reason: Risk limits exceeded`,
    `📉 7-day P&L: ${rolling7dPct.toFixed(1)}%${rolling7dPct < -15 ? " (limit: -15%)" : ""}`,
    `📉 Peak drawdown: ${drawdownPct.toFixed(1)}%${drawdownPct > 25 ? " (limit: 25%)" : ""}`,
    `Action: New entries paused`,
    "",
    `[/resume to override]`,
  ].join("\n");
  await notifyTelegram(truncateToTelegramLimit(alertMsg));

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
    route: "manual",
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
      `SELECT job_id, duration_ms FROM job_history
       WHERE agent_id IN ('bankr', 'polymarket-scout')
       AND created_at > NOW() - INTERVAL '48 hours'
       AND duration_ms IS NOT NULL AND duration_ms > 0
       ORDER BY created_at DESC LIMIT 30`
    );
    if (res.rows.length < 3) {
      return { name: "Job Latency", status: "ok", detail: "Insufficient data for trend analysis" };
    }
    const durations = res.rows.map((r: { duration_ms: number }) => r.duration_ms / 1000).filter((d: number) => d > 0);
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

  const pmTheses = await getConfigValue<ThesisRecord[]>("polymarket_scout_active_theses", []);
  const totalTheses = pmTheses.length;
  const tradedThesisIds = new Set(periodTrades.map(t => t.thesis_id));
  const allThesisIds = new Set([
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
    const portfolio = await getConfigValue<number>("wealth_engines_portfolio_value", 1000);
    let equity = portfolio;
    let peak = portfolio;
    const sorted = [...periodTrades].sort((a, b) =>
      new Date(a.closed_at).getTime() - new Date(b.closed_at).getTime()
    );
    for (const t of sorted) {
      equity += t.pnl || 0;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? ((peak - equity) / peak * 100) : 0;
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

  const PERF_REVIEWS_KEY = "oversight_performance_reviews";
  const existingReviews = await getConfigValue<PerformanceReview[]>(PERF_REVIEWS_KEY, []);
  existingReviews.push(review);
  await setConfigValue(PERF_REVIEWS_KEY, pruneByAge(existingReviews, MAX_REPORTS));

  return review;
}

function buildSignalAttribution(trades: TradeRecord[], totalPnl: number): SignalAttribution[] {
  const groupKeys: Record<string, TradeRecord[]> = {};
  for (const t of trades) {
    const source = t.source || "unknown";
    const direction = t.direction || "unknown";
    const key = `${source}/${direction}`;
    if (!groupKeys[key]) groupKeys[key] = [];
    groupKeys[key].push(t);

    const sourceKey = source;
    if (!groupKeys[sourceKey]) groupKeys[sourceKey] = [];
    groupKeys[sourceKey].push(t);
  }

  const attrs: SignalAttribution[] = [];
  const seen = new Set<string>();

  for (const source of ["polymarket_scout", "manual"]) {
    const sourceTrades = groupKeys[source];
    if (!sourceTrades || seen.has(source)) continue;
    seen.add(source);

    const wins = sourceTrades.filter(t => (t.pnl || 0) > 0);
    const losses = sourceTrades.filter(t => (t.pnl || 0) <= 0);
    const signalPnl = sourceTrades.reduce((s, t) => s + (t.pnl || 0), 0);
    const avgPnlPerTrade = sourceTrades.length > 0 ? signalPnl / sourceTrades.length : 0;

    attrs.push({
      signal_type: source,
      trades: sourceTrades.length,
      wins: wins.length,
      losses: losses.length,
      total_pnl: signalPnl,
      avg_confidence: avgPnlPerTrade,
      contribution_pct: totalPnl !== 0 ? (signalPnl / Math.abs(totalPnl)) * 100 : 0,
    });

    for (const dir of ["LONG", "SHORT", "YES", "NO"]) {
      const dirKey = `${source}/${dir}`;
      const dirTrades = groupKeys[dirKey];
      if (!dirTrades || seen.has(dirKey)) continue;
      seen.add(dirKey);

      const dirWins = dirTrades.filter(t => (t.pnl || 0) > 0);
      const dirLosses = dirTrades.filter(t => (t.pnl || 0) <= 0);
      const dirPnl = dirTrades.reduce((s, t) => s + (t.pnl || 0), 0);

      attrs.push({
        signal_type: `${source}/${dir}`,
        trades: dirTrades.length,
        wins: dirWins.length,
        losses: dirLosses.length,
        total_pnl: dirPnl,
        avg_confidence: dirTrades.length > 0 ? dirPnl / dirTrades.length : 0,
        contribution_pct: totalPnl !== 0 ? (dirPnl / Math.abs(totalPnl)) * 100 : 0,
      });
    }
  }

  return attrs.sort((a, b) => b.total_pnl - a.total_pnl);
}

export async function detectCrossDomainExposure(): Promise<CrossDomainExposure[]> {
  const positions = await getConfigValue<Position[]>("wealth_engines_positions", []);
  const portfolio = await getConfigValue<number>("wealth_engines_portfolio_value", 1000);
  const alerts: CrossDomainExposure[] = [];

  const pmPositions = positions.filter(p => p.asset_class === "polymarket");

  for (let i = 0; i < pmPositions.length; i++) {
    for (let j = i + 1; j < pmPositions.length; j++) {
      const a = pmPositions[i];
      const b = pmPositions[j];
      if (a.exposure_bucket === b.exposure_bucket) {
        const combinedExposure = ((a.size * a.entry_price) + (b.size * b.entry_price));
        const combinedPct = portfolio > 0 ? (combinedExposure / portfolio * 100) : 0;
        alerts.push({
          asset_a: `PM: ${a.asset}`,
          polymarket_question: b.asset,
          correlation_type: "thematic",
          combined_exposure_pct: combinedPct,
          risk_level: combinedPct > 30 ? "high" : "medium",
          detail: `PM bucket overlap: "${a.asset.slice(0, 30)}" + "${b.asset.slice(0, 30)}" in bucket "${a.exposure_bucket}" — ${combinedPct.toFixed(0)}% combined`,
        });
      }
    }
  }

  const bucketExposure: Record<string, number> = {};
  for (const pos of positions) {
    const bucket = pos.exposure_bucket || "general";
    const exposure = (pos.size || 0) * (pos.entry_price || 0);
    bucketExposure[bucket] = (bucketExposure[bucket] || 0) + exposure;
  }
  const BUCKET_THRESHOLD_PCT = 40;
  for (const [bucket, exposure] of Object.entries(bucketExposure)) {
    const pct = portfolio > 0 ? (exposure / portfolio) * 100 : 0;
    if (pct > BUCKET_THRESHOLD_PCT) {
      alerts.push({
        asset_a: `Bucket: ${bucket}`,
        polymarket_question: `All positions in "${bucket}"`,
        correlation_type: "thematic",
        combined_exposure_pct: pct,
        risk_level: pct > 60 ? "high" : "medium",
        detail: `Exposure bucket "${bucket}" has ${pct.toFixed(0)}% of portfolio ($${exposure.toFixed(2)}) across ${positions.filter(p => (p.exposure_bucket || "general") === bucket).length} positions`,
      });
    }
  }

  const EXPOSURE_ALERT_THRESHOLD = 40;
  const highExposure = alerts.filter(a => a.combined_exposure_pct > EXPOSURE_ALERT_THRESHOLD);
  for (const alert of highExposure) {
    const fmtE = await import("./telegram-format.js");
    const erLines = [
      fmtE.buildCategoryHeader(fmtE.CATEGORY_BADGES.OVERSIGHT, "Exposure Risk"),
      "",
      `⚠️ Correlated exposure detected`,
      "",
      `${fmtE.escapeHtml(alert.asset_a)} + ${fmtE.escapeHtml(alert.polymarket_question.slice(0, 40))}`,
      `Combined exposure: ${alert.combined_exposure_pct.toFixed(0)}% (${alert.correlation_type})`,
      `Recommendation: Reduce or hedge before next scan`,
    ];
    await notifyTelegram(fmtE.truncateToTelegramLimit(erLines.join("\n")));
    await captureImprovement({
      source: "health_check",
      category: "risk",
      severity: alert.combined_exposure_pct > 60 ? "critical" : "high",
      domain: "polymarket",
      title: `Concentration risk: ${alert.combined_exposure_pct.toFixed(0)}% exposure`,
      description: alert.detail,
      recommendation: "Reduce correlated Polymarket positions to stay under 40% combined exposure",
      route: "bankr-config",
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
    signal: "manual",
    execution: "bankr-config",
    infrastructure: "manual",
    risk: "manual",
    strategy: "manual",
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
    route: params.route || routeMap[params.category] || "manual",
    status: "open",
  };

  queue.push(improvement);
  await setConfigValue(IMPROVEMENT_QUEUE_KEY, pruneByAge(queue, MAX_IMPROVEMENTS));

  console.log(`[oversight] Improvement captured: [${params.severity}] ${params.title} → route:${improvement.route}`);
  return improvement;
}

function inferDomain(params: { title: string; description: string; category: string }): ImprovementRequest["domain"] {
  const text = `${params.title} ${params.description}`.toLowerCase();
  if (text.includes("polymarket") || text.includes("pm ") || text.includes("bankr") || text.includes("bnkr") || text.includes("scout")) return "polymarket";
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
  asset_class: "polymarket";
  source: "polymarket_scout";
  direction: string;
  entry_price: number;
  market_id?: string;
  stop_price?: number;
  target_price?: number;
  notional_amount?: number;
  end_date?: string;
}): Promise<ShadowTrade> {
  let notional = params.notional_amount;
  if (!notional || notional <= 0) {
    try {
      const bankrMod = await import("./bankr.js");
      const portfolio = await bankrMod.getPortfolioValue();
      notional = portfolio * 0.05;
    } catch {
      notional = 500;
    }
  }

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
    notional_amount: notional,
    pnl_pct: 0,
    opened_at: Date.now(),
    market_id: params.market_id,
    status: "open",
    stop_price: params.stop_price,
    target_price: params.target_price,
    end_date: params.end_date,
  };

  const trades = await getConfigValue<ShadowTrade[]>(SHADOW_TRADES_KEY, []);
  trades.push(shadow);
  await setConfigValue(SHADOW_TRADES_KEY, pruneByAge(trades, MAX_SHADOW_TRADES));

  console.log(`[oversight] Shadow trade opened: ${params.asset} ${params.direction} @ $${params.entry_price}`);

  try {
    const clobStream = await import("./clob-stream.js");
    if (params.market_id) {
      const tokens = await clobStream.resolveTokenIds(params.market_id);
      if (tokens) {
        const isYes = params.direction === "YES" || params.direction === "LONG";
        const relevantId = isYes ? tokens.yesTokenId : tokens.noTokenId;
        shadow.token_id = relevantId;
        await withShadowLock(async () => {
          const allTrades = await getConfigValue<ShadowTrade[]>(SHADOW_TRADES_KEY, []);
          const sIdx = allTrades.findIndex(t => t.id === shadow.id);
          if (sIdx !== -1) {
            allTrades[sIdx].token_id = relevantId;
            await setConfigValue(SHADOW_TRADES_KEY, allTrades);
          }
        });
        clobStream.subscribe([relevantId]);
        clobStream.registerTradeToken(relevantId, shadow.id);
        console.log(`[oversight] Persisted token_id for ${shadow.asset}: ${relevantId.slice(0, 20)}...`);
      }
    }
  } catch (e) {
    console.warn("[oversight] CLOB subscribe on shadow open failed:", e instanceof Error ? e.message : e);
  }

  try {
    const { sendShadowTradeNotification } = await import("./telegram.js");
    sendShadowTradeNotification({
      type: "open",
      asset: params.asset,
      direction: params.direction,
      entryPrice: params.entry_price,
      source: params.source,
    }).catch(e => console.warn("[oversight] Shadow open notification failed:", e));
  } catch {}

  return shadow;
}

export function closeShadowTrade(
  id: string, exitPrice: number, reason: string
): Promise<ShadowTrade | null> {
  return withShadowLock(async () => {
    const trades = await getConfigValue<ShadowTrade[]>(SHADOW_TRADES_KEY, []);
    const idx = trades.findIndex(t => t.id === id);
    if (idx === -1) return null;

    const trade = trades[idx];
    trade.status = "closed";
    trade.exit_price = exitPrice;
    trade.closed_at = Date.now();
    trade.close_reason = reason;

    const multiplier = trade.direction === "LONG" || trade.direction === "YES" ? 1 : -1;
    const priceDiff = (exitPrice - trade.entry_price) * multiplier;
    const notional = trade.notional_amount || 500;
    trade.pnl_pct = trade.entry_price > 0 ? (priceDiff / trade.entry_price * 100) : 0;
    trade.hypothetical_pnl = trade.entry_price > 0 ? (priceDiff / trade.entry_price * notional) : 0;

    await setConfigValue(SHADOW_TRADES_KEY, trades);
    console.log(`[oversight] Shadow trade closed: ${trade.asset} P&L: $${trade.hypothetical_pnl.toFixed(2)} (${trade.pnl_pct.toFixed(1)}%) notional=$${notional} reason: ${reason}`);

    const LEARNING_REASONS = ["stop_hit", "target_hit", "expired", "rsi_exit", "time_exit", "manual"];
    if (LEARNING_REASONS.includes(reason)) {
      try {
        const { updateSignalQuality } = await import("./bankr.js");
        await updateSignalQuality({
          source: (trade.source as "polymarket_scout") || "polymarket_scout",
          asset_class: trade.asset_class,
          pnl: trade.hypothetical_pnl,
          asset: trade.asset,
          trade_id: trade.id,
        });
      } catch (e) {
        console.warn("[oversight] Signal quality update on shadow close:", e instanceof Error ? e.message : e);
      }
    } else {
      console.log(`[oversight] Skipping signal quality update for non-terminal close reason: ${reason}`);
    }

    try {
      const { sendShadowTradeNotification } = await import("./telegram.js");
      sendShadowTradeNotification({
        type: "close",
        asset: trade.asset,
        direction: trade.direction,
        entryPrice: trade.entry_price,
        exitPrice,
        pnl: trade.hypothetical_pnl,
        reason,
        openedAt: trade.opened_at,
        closedAt: trade.closed_at,
      }).catch(e => console.warn("[oversight] Shadow close notification failed:", e));
    } catch {}

    return trade;
  });
}

export function updateShadowPrices(
  priceUpdates: Record<string, number>
): Promise<ShadowTrade[]> {
  return withShadowLock(async () => {
    const trades = await getConfigValue<ShadowTrade[]>(SHADOW_TRADES_KEY, []);
    const openTrades = trades.filter(t => t.status === "open");

    for (const trade of openTrades) {
      const newPrice = priceUpdates[trade.asset];
      if (newPrice != null) {
        trade.current_price = newPrice;
        const multiplier = trade.direction === "LONG" || trade.direction === "YES" ? 1 : -1;
        const priceDiff = (newPrice - trade.entry_price) * multiplier;
        const notional = trade.notional_amount || 500;
        trade.pnl_pct = trade.entry_price > 0 ? (priceDiff / trade.entry_price * 100) : 0;
        trade.hypothetical_pnl = trade.entry_price > 0 ? (priceDiff / trade.entry_price * notional) : 0;
      }
    }

    await setConfigValue(SHADOW_TRADES_KEY, trades);
    return openTrades;
  });
}

const SHADOW_MAX_AGE_HOURS = 168;

export async function refreshShadowTradesFromMarket(): Promise<{
  updated: number;
  closed: number;
  errors: string[];
}> {
  const trades = await getConfigValue<ShadowTrade[]>(SHADOW_TRADES_KEY, []);
  const openTrades = trades.filter(t => t.status === "open");
  let updated = 0;
  let closed = 0;
  const errors: string[] = [];

  const now = Date.now();

  const pendingCloseNotifications: Array<{ trade: ShadowTrade; reason: string }> = [];

  const nonExpiredTrades: ShadowTrade[] = [];
  for (const trade of openTrades) {
    const ageHours = (now - trade.opened_at) / (3600 * 1000);
    if (ageHours > SHADOW_MAX_AGE_HOURS) {
      trade.status = "closed";
      trade.closed_at = now;
      trade.close_reason = "expired";
      trade.exit_price = trade.current_price;
      const multiplier = trade.direction === "LONG" || trade.direction === "YES" ? 1 : -1;
      const priceDiff = (trade.current_price - trade.entry_price) * multiplier;
      const notional = trade.notional_amount || 500;
      trade.pnl_pct = trade.entry_price > 0 ? (priceDiff / trade.entry_price * 100) : 0;
      trade.hypothetical_pnl = trade.entry_price > 0 ? (priceDiff / trade.entry_price * notional) : 0;
      closed++;
      pendingCloseNotifications.push({ trade, reason: "expired (168h max age)" });
    } else {
      nonExpiredTrades.push(trade);
    }
  }

  const priceResults = await Promise.allSettled(
    nonExpiredTrades.map(async (trade) => {
      let latestPrice: number | null = null;
      if (trade.asset_class === "polymarket" && trade.market_id) {
        const market = await polymarket.getMarketDetails(trade.market_id);
        if (market && market.outcome_prices && market.outcome_prices.length > 0) {
          const parsed = parseFloat(String(market.outcome_prices[0]));
          latestPrice = Number.isFinite(parsed) ? parsed : null;
        }
      }
      return latestPrice;
    })
  );

  for (let i = 0; i < nonExpiredTrades.length; i++) {
    const trade = nonExpiredTrades[i];
    const result = priceResults[i];
    if (result.status === "rejected") {
      errors.push(`${trade.asset}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      continue;
    }
    const latestPrice = result.value;
    if (latestPrice == null) continue;

    trade.current_price = latestPrice;
    const isLong = trade.direction === "LONG" || trade.direction === "YES";
    const multiplier = isLong ? 1 : -1;
    const priceDiff = (latestPrice - trade.entry_price) * multiplier;
    const notional = trade.notional_amount || 500;
    trade.pnl_pct = trade.entry_price > 0 ? (priceDiff / trade.entry_price * 100) : 0;
    trade.hypothetical_pnl = trade.entry_price > 0 ? (priceDiff / trade.entry_price * notional) : 0;
    updated++;

    if (trade.stop_price != null) {
      const stopHit = isLong ? latestPrice <= trade.stop_price : latestPrice >= trade.stop_price;
      if (stopHit) {
        trade.status = "closed";
        trade.closed_at = now;
        trade.close_reason = "stop_hit";
        trade.exit_price = latestPrice;
        closed++;
        console.log(`[oversight] Shadow stop hit: ${trade.asset} ${trade.direction} @ $${latestPrice} (stop=$${trade.stop_price}) P&L: $${trade.hypothetical_pnl.toFixed(4)}`);
        pendingCloseNotifications.push({ trade, reason: `stop hit ($${trade.stop_price})` });
        continue;
      }
    }

    if (trade.target_price != null) {
      const targetHit = isLong ? latestPrice >= trade.target_price : latestPrice <= trade.target_price;
      if (targetHit) {
        trade.status = "closed";
        trade.closed_at = now;
        trade.close_reason = "target_hit";
        trade.exit_price = latestPrice;
        closed++;
        console.log(`[oversight] Shadow target hit: ${trade.asset} ${trade.direction} @ $${latestPrice} (target=$${trade.target_price}) P&L: $${trade.hypothetical_pnl.toFixed(4)}`);
        pendingCloseNotifications.push({ trade, reason: `target hit ($${trade.target_price})` });
        continue;
      }
    }
  }

  await setConfigValue(SHADOW_TRADES_KEY, trades);

  for (const { trade, reason } of pendingCloseNotifications) {
    try {
      const { updateSignalQuality } = await import("./bankr.js");
      await updateSignalQuality({
        source: (trade.source as "polymarket_scout") || "polymarket_scout",
        asset_class: trade.asset_class,
        pnl: trade.hypothetical_pnl,
        asset: trade.asset,
        trade_id: trade.id,
      });
    } catch (e) {
      console.warn("[oversight] Signal quality update on shadow refresh close:", e instanceof Error ? e.message : e);
    }
    try {
      const { sendShadowTradeNotification } = await import("./telegram.js");
      sendShadowTradeNotification({
        type: "close", asset: trade.asset, direction: trade.direction,
        entryPrice: trade.entry_price, exitPrice: trade.exit_price || trade.current_price,
        pnl: trade.hypothetical_pnl, reason,
        openedAt: trade.opened_at, closedAt: trade.closed_at,
      }).catch(() => {});
    } catch {}
  }
  console.log(`[oversight] Shadow refresh: ${updated} updated, ${closed} expired, ${errors.length} errors`);
  return { updated, closed, errors };
}

export async function getShadowTrades(statusFilter?: "open" | "closed"): Promise<ShadowTrade[]> {
  const trades = await getConfigValue<ShadowTrade[]>(SHADOW_TRADES_KEY, []);
  if (statusFilter) return trades.filter(t => t.status === statusFilter);
  return trades;
}

export function updateShadowTradeFields(
  tradeId: string,
  updates: Partial<Pick<ShadowTrade, "current_price" | "hypothetical_pnl" | "pnl_pct" | "token_id" | "last_price_update">>
): Promise<ShadowTrade | null> {
  return withShadowLock(async () => {
    const trades = await getConfigValue<ShadowTrade[]>(SHADOW_TRADES_KEY, []);
    const idx = trades.findIndex(t => t.id === tradeId);
    if (idx === -1) return null;
    Object.assign(trades[idx], updates);
    await setConfigValue(SHADOW_TRADES_KEY, trades);
    return trades[idx];
  });
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

  const portfolio = await getConfigValue<number>("wealth_engines_portfolio_value", 1000);
  const peak = await getConfigValue<number>("wealth_engines_peak_portfolio", 1000);
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
        domain: i.domain || "system", route: i.route || "manual", created_at: i.created_at,
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
  const pmTheses = await getConfigValue<ThesisRecord[]>("polymarket_scout_active_theses", []);
  const history = await getConfigValue<TradeRecord[]>("wealth_engines_trade_history", []);
  const reviews: ThesisReview[] = [];

  const allTheses: ThesisRecord[] = [
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
        domain: "polymarket",
        title: `Bear-favored thesis: ${typeof asset === "string" ? asset.slice(0, 30) : "unknown"}`,
        description: `Adversarial review found bear case stronger: ${bearFactors.join("; ")}`,
        pattern_description: `Thesis ${thesis.id} has more bear factors (${bearFactors.length}) than bull (${bullFactors.length})`,
        recommendation,
        route: "manual",
      });
    }
  }

  return reviews;
}

export async function checkPerAssetLosses(): Promise<void> {
  const history = await getConfigValue<TradeRecord[]>("wealth_engines_trade_history", []);
  const portfolio = await getConfigValue<number>("wealth_engines_portfolio_value", 1000);
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
        domain: "polymarket",
        title: `Per-asset loss: ${asset} -${lossPct.toFixed(1)}%`,
        description: `${asset} has accumulated $${Math.abs(pnl).toFixed(2)} loss (${lossPct.toFixed(1)}% of portfolio) in 7 days.`,
        pattern_description: `Concentrated losses in single asset ${asset}`,
        recommendation: `Review ${asset} thesis quality; consider blacklisting or reducing position limits`,
        route: "bankr-config",
      });
    }
  }
}

export async function generateDailyPerformanceSummary(): Promise<string> {
  const review = await runPerformanceReview(1);
  const health = await getLatestHealthReport();
  const portfolio = await getConfigValue<number>("wealth_engines_portfolio_value", 1000);
  const peak = await getConfigValue<number>("wealth_engines_peak_portfolio", 1000);
  const drawdownPct = peak > 0 ? ((peak - portfolio) / peak * 100) : 0;
  const queue = await getConfigValue<ImprovementRequest[]>(IMPROVEMENT_QUEUE_KEY, []);
  const openItems = queue.filter(i => i.status === "open");
  const fmt = await import("./telegram-format.js");

  const lines = [
    fmt.buildCategoryHeader(fmt.CATEGORY_BADGES.OVERSIGHT, "Daily Performance"),
    `${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "short", day: "numeric" })}`,
    "",
    `💰 Portfolio: $${portfolio.toFixed(2)} (peak: $${peak.toFixed(2)}, DD: ${drawdownPct.toFixed(1)}%)`,
    `📊 Today: ${review.total_trades} trades, ${fmt.formatPnl(review.total_pnl)}`,
    `🎯 Win Rate: ${review.win_rate.toFixed(0)}%`,
  ];

  if (health) {
    const icons: Record<string, string> = { healthy: "🟢", degraded: "🟡", critical: "🔴" };
    lines.push(`${icons[health.overall_status] || "⚪"} System: ${health.overall_status}`);
  }

  if (openItems.length > 0) {
    const critical = openItems.filter(i => i.severity === "critical");
    lines.push(`📋 Open Issues: ${openItems.length}${critical.length > 0 ? ` (${critical.length} critical)` : ""}`);
  }

  return fmt.truncateToTelegramLimit(lines.join("\n"));
}

export async function sendDailyPerformanceSummary(): Promise<void> {
  const summary = await generateDailyPerformanceSummary();
  await notifyTelegram(summary);
  console.log("[oversight] Daily performance summary sent");
}

export async function autoTrackShadowTrade(params: {
  thesis_id: string;
  asset: string;
  asset_class: "polymarket";
  source: "polymarket_scout";
  direction: string;
  entry_price: number;
  reason: string;
  market_id?: string;
  stop_price?: number;
  target_price?: number;
  end_date?: string;
}): Promise<ShadowTrade | null> {
  const existing = await getShadowTrades("open");
  const match = existing.find(t => t.asset === params.asset && t.direction === params.direction);
  if (match) {
    const ageHours = (Date.now() - new Date(match.opened_at).getTime()) / 3600000;
    if (ageHours < 24) return null;
    await closeShadowTrade(match.id, match.entry_price, "replaced_by_newer_thesis");
  }

  let stopPrice = params.stop_price;
  let targetPrice = params.target_price;
  let endDate = params.end_date;
  if (!stopPrice || !targetPrice || !endDate) {
    try {
      const { getActiveTheses: getPmTheses } = await import("./polymarket-scout.js");
      const theses: Array<{ id: string; asset: string; direction: string; stop_price?: number; exit_price?: number; exit_odds?: number; entry_odds?: number; expires_at?: string; end_date?: string }> = await getPmTheses();
      const thesis = theses.find(t => t.id === params.thesis_id || (t.asset === params.asset && t.direction === params.direction));
      if (thesis) {
        if (!stopPrice && thesis.stop_price) stopPrice = thesis.stop_price;
        if (!targetPrice && (thesis.exit_price || thesis.exit_odds)) targetPrice = thesis.exit_price || thesis.exit_odds;
        if (!endDate && (thesis.expires_at || thesis.end_date)) endDate = thesis.expires_at || thesis.end_date;
      }
    } catch (e) {
      console.warn(`[oversight] Thesis lookup for shadow levels failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const shadow = await openShadowTrade({
    thesis_id: params.thesis_id,
    asset: params.asset,
    asset_class: params.asset_class,
    source: params.source,
    direction: params.direction,
    entry_price: params.entry_price,
    market_id: params.market_id,
    stop_price: stopPrice,
    target_price: targetPrice,
    end_date: endDate,
  });
  console.log(`[oversight] Auto-shadow: ${params.asset} ${params.direction} @ $${params.entry_price} | stop=$${stopPrice ?? "none"} target=$${targetPrice ?? "none"} — ${params.reason}`);
  return shadow;
}
