import { getPool } from "./db.js";
import * as autoresearch from "./autoresearch.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

const ALERTS_BOT_TOKEN = process.env.TELEGRAM_ALERTS_BOT_TOKEN || "";
const ALERTS_CHAT_ID = process.env.TELEGRAM_ALERTS_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";
const ALERTS_API_BASE = `https://api.telegram.org/bot${ALERTS_BOT_TOKEN}`;

function isAlertsBotConfigured(): boolean {
  return ALERTS_BOT_TOKEN.length > 0 && ALERTS_CHAT_ID.length > 0;
}

async function sendAlertsBotMessage(text: string, parseMode: string = "Markdown"): Promise<void> {
  if (!isAlertsBotConfigured()) return;
  try {
    await fetch(`${ALERTS_API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ALERTS_CHAT_ID, text, parse_mode: parseMode }),
    });
  } catch (err) {
    console.error("[telegram-alerts] sendMessage failed:", err instanceof Error ? err.message : err);
  }
}

import { randomBytes } from "crypto";
const WEBHOOK_SECRET = randomBytes(32).toString("hex");

let pollingActive = false;
let pollingTimeout: ReturnType<typeof setTimeout> | null = null;
let lastUpdateId = 0;
let deadManInterval: ReturnType<typeof setInterval> | null = null;
let lastDeadManAlert: Record<string, number> = {};

type CommandHandler = (args: string) => Promise<string>;
const commands: Record<string, CommandHandler> = {};

interface PendingApproval {
  thesisId: string;
  asset: string;
  direction: string;
  leverage: string;
  messageId: number;
  createdAt: number;
  resolve: (decision: "approve" | "skip" | "hold") => void;
}

const pendingApprovals = new Map<string, PendingApproval>();

async function getMode(): Promise<string> {
  try {
    const pool = getPool();
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_mode'`);
    if (res.rows.length > 0 && res.rows[0].value === "LIVE") return "[LIVE]";
  } catch {}
  return "[BETA]";
}

export function isConfigured(): boolean {
  return BOT_TOKEN.length > 0 && CHAT_ID.length > 0;
}

async function tgFetch(method: string, body?: Record<string, any>): Promise<any> {
  const url = `${API_BASE}/${method}`;
  const opts: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Telegram API ${method} failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

export async function sendMessage(text: string, parseMode: string = "Markdown"): Promise<number | null> {
  if (!isConfigured()) return null;
  try {
    const result = await tgFetch("sendMessage", {
      chat_id: CHAT_ID,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });
    return result.result?.message_id || null;
  } catch (err) {
    console.error("[telegram] sendMessage failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function sendMessageWithKeyboard(
  text: string,
  keyboard: Array<Array<{ text: string; callback_data: string }>>,
  parseMode: string = "Markdown"
): Promise<number | null> {
  if (!isConfigured()) return null;
  try {
    const result = await tgFetch("sendMessage", {
      chat_id: CHAT_ID,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    });
    return result.result?.message_id || null;
  } catch (err) {
    console.error("[telegram] sendMessageWithKeyboard failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  try {
    await tgFetch("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text || "Received",
    });
  } catch (err) {
    console.error("[telegram] answerCallbackQuery failed:", err instanceof Error ? err.message : err);
  }
}

async function editMessage(messageId: number, text: string, parseMode: string = "Markdown"): Promise<void> {
  try {
    await tgFetch("editMessageText", {
      chat_id: CHAT_ID,
      message_id: messageId,
      text,
      parse_mode: parseMode,
    });
  } catch (err) {
    console.error("[telegram] editMessage failed:", err instanceof Error ? err.message : err);
  }
}

function registerCommand(name: string, handler: CommandHandler): void {
  commands[name.toLowerCase()] = handler;
}

async function handleStatusCommand(): Promise<string> {
  const mode = await getMode();
  const pool = getPool();

  let killSwitchActive = false;
  try {
    const ks = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_kill_switch'`);
    killSwitchActive = ks.rows.length > 0 && ks.rows[0].value === true;
  } catch {}

  let pauseActive = false;
  try {
    const pa = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_paused'`);
    pauseActive = pa.rows.length > 0 && pa.rows[0].value === true;
  } catch {}

  let scoutLastRun = "never";
  let bankrLastRun = "never";
  try {
    const sr = await pool.query(`SELECT created_at FROM job_history WHERE agent_id = 'scout' ORDER BY created_at DESC LIMIT 1`);
    if (sr.rows.length > 0) scoutLastRun = timeAgo(new Date(sr.rows[0].created_at).getTime());
  } catch {}
  try {
    const br = await pool.query(`SELECT created_at FROM job_history WHERE agent_id = 'bankr' ORDER BY created_at DESC LIMIT 1`);
    if (br.rows.length > 0) bankrLastRun = timeAgo(new Date(br.rows[0].created_at).getTime());
  } catch {}

  let healthLine = "";
  try {
    const healthRes = await pool.query(`SELECT value FROM app_config WHERE key = 'oversight_health_reports'`);
    if (healthRes.rows.length > 0 && Array.isArray(healthRes.rows[0].value) && healthRes.rows[0].value.length > 0) {
      const latest = healthRes.rows[0].value[healthRes.rows[0].value.length - 1];
      const icons: Record<string, string> = { healthy: "🟢", degraded: "🟡", critical: "🔴" };
      healthLine = `${icons[latest.overall_status] || "⚪"} Oversight: ${latest.overall_status}`;
    }
  } catch {}

  const lines = [
    `${mode} *DarkNode Status*`,
    "",
    `🔴 Kill Switch: ${killSwitchActive ? "ACTIVE" : "OFF"}`,
    `⏸ Paused: ${pauseActive ? "YES" : "NO"}`,
    `🔍 SCOUT last run: ${scoutLastRun}`,
    `💰 BANKR last run: ${bankrLastRun}`,
  ];
  if (healthLine) lines.push(healthLine);
  lines.push("");
  lines.push(`_${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET_`);
  return lines.join("\n");
}

async function handlePortfolioCommand(): Promise<string> {
  const mode = await getMode();
  const pool = getPool();

  let positions: any[] = [];
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_positions'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
      positions = res.rows[0].value;
    }
  } catch {}

  if (positions.length === 0) {
    return `${mode} *Portfolio*\n\nNo open positions.\n\n_Use /trades to see recent trade history._`;
  }

  const lines = [`${mode} *Portfolio*`, ""];
  let totalPnl = 0;
  for (const pos of positions) {
    const pnl = pos.unrealized_pnl || 0;
    totalPnl += pnl;
    const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
    const arrow = pnl >= 0 ? "🟢" : "🔴";
    lines.push(`${arrow} *${pos.asset}* ${pos.direction} ${pos.leverage || "1x"}`);
    lines.push(`   Entry: $${pos.entry_price} | P&L: ${pnlStr}`);
  }
  lines.push("");
  const totalStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
  lines.push(`*Total P&L:* ${totalStr}`);

  return lines.join("\n");
}

async function handleIntelCommand(): Promise<string> {
  const mode = await getMode();
  const pool = getPool();

  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'scout_latest_brief'`);
    if (res.rows.length > 0 && res.rows[0].value) {
      const brief = res.rows[0].value;
      const summary = typeof brief === "string" ? brief : (brief.summary || JSON.stringify(brief));
      const truncated = summary.length > 3000 ? summary.slice(0, 3000) + "\n\n_(truncated)_" : summary;
      return `${mode} *Latest SCOUT Intel*\n\n${truncated}`;
    }
  } catch {}

  return `${mode} *Latest SCOUT Intel*\n\nNo SCOUT brief available yet. SCOUT agent has not run.`;
}

async function handlePauseCommand(): Promise<string> {
  const mode = await getMode();
  const pool = getPool();

  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(true), Date.now()]
    );
    console.log("[telegram] Wealth Engines PAUSED via Telegram");
    return `${mode} ⏸ *System PAUSED*\n\nAll Wealth Engine jobs will halt within 60 seconds.\nUse /resume to restart.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${mode} ❌ Failed to pause: ${msg}`;
  }
}

async function handleResumeCommand(): Promise<string> {
  const mode = await getMode();
  const pool = getPool();

  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(false), Date.now()]
    );
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_kill_switch', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(false), Date.now()]
    );
    console.log("[telegram] Wealth Engines RESUMED + kill switch deactivated via Telegram");
    return `${mode} ▶️ *System RESUMED*\n\nAll Wealth Engine jobs are active. Kill switch deactivated.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${mode} ❌ Failed to resume: ${msg}`;
  }
}

async function handleScoutCommand(): Promise<string> {
  const mode = await getMode();
  const pool = getPool();

  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'scout_active_theses'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value) && res.rows[0].value.length > 0) {
      const theses = res.rows[0].value;
      const now = Date.now();
      const active = theses.filter((t: any) => !t.expires_at || t.expires_at > now);
      if (active.length === 0) {
        return `${mode} *Active SCOUT Theses*\n\nAll theses have expired. Waiting for next SCOUT cycle.`;
      }
      const lines = [`${mode} *Active SCOUT Theses* (${active.length})`, ""];
      for (const t of active.slice(0, 10)) {
        const conf = t.confidence || "?";
        const dir = t.direction || "?";
        const vc = t.vote_count ?? t.votes;
        const votes = vc != null ? (typeof vc === "string" && vc.includes("/") ? vc : `${vc}/6`) : "?";
        const score = t.technical_score != null ? t.technical_score.toFixed(2) : "?";
        const regime = t.market_regime || t.regime || "?";
        const nansenFlow = t.nansen_flow_direction || t.nansen_flow || "";
        const target = t.exit_price || t.target_price || "?";
        const age = t.created_at ? `${Math.floor((now - t.created_at) / 3600000)}h ago` : "";
        lines.push(`• *${t.asset}* — ${dir} ${conf}`);
        lines.push(`  Votes: ${votes} | Score: ${score} | ${regime}`);
        if (t.entry_price) lines.push(`  Entry: $${t.entry_price} | Stop: $${t.stop_price || "?"} | Target: $${target}`);
        if (nansenFlow) lines.push(`  Nansen: ${nansenFlow}`);
        if (age) lines.push(`  _${age}_`);
        lines.push("");
      }
      return lines.join("\n");
    }
  } catch {}

  return `${mode} *Active SCOUT Theses*\n\nNo active theses. SCOUT has not generated any yet.`;
}

async function handleTradesCommand(args: string): Promise<string> {
  const mode = await getMode();
  const pool = getPool();
  const limit = Math.min(Math.max(parseInt(args) || 5, 1), 20);

  try {
    const res = await pool.query(
      `SELECT value FROM app_config WHERE key = 'wealth_engines_trade_history'`
    );
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value) && res.rows[0].value.length > 0) {
      const trades = res.rows[0].value.slice(-limit).reverse();
      const lines = [`${mode} *Recent Trades* (last ${trades.length})`, ""];
      for (const t of trades) {
        const pnl = t.pnl || 0;
        const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
        const icon = pnl >= 0 ? "🟢" : "🔴";
        const date = t.closed_at ? new Date(t.closed_at).toLocaleDateString("en-US", { timeZone: "America/New_York" }) : "open";
        lines.push(`${icon} *${t.asset}* ${t.direction} ${t.leverage || "1x"} — ${pnlStr} (${date})`);
      }
      return lines.join("\n");
    }
  } catch {}

  return `${mode} *Recent Trades*\n\nNo trade history yet.`;
}

async function handlePublicCommand(args: string): Promise<string> {
  const mode = await getMode();
  const pool = getPool();
  const val = args.trim().toLowerCase();

  if (val !== "on" && val !== "off") {
    try {
      const res = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_public'`);
      const isPublic = res.rows.length > 0 && res.rows[0].value === true;
      return `${mode} Dashboard is currently *${isPublic ? "PUBLIC" : "PRIVATE"}*.\n\nUsage: /public on | /public off`;
    } catch {
      return `${mode} Dashboard is currently *PRIVATE*.\n\nUsage: /public on | /public off`;
    }
  }

  const newVal = val === "on";
  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_public', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(newVal), Date.now()]
    );
    return `${mode} Dashboard is now *${newVal ? "PUBLIC" : "PRIVATE"}*.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${mode} ❌ Failed to update: ${msg}`;
  }
}

async function handleKillCommand(): Promise<string> {
  const mode = await getMode();
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_kill_switch', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(true), Date.now()]
    );
    console.log("[telegram] KILL SWITCH ACTIVATED via Telegram");
    return `${mode} 🚨 *KILL SWITCH ACTIVATED*\n\nAll positions will be closed on the next monitor tick (within 5 minutes).\nUse /resume to deactivate kill switch and resume.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${mode} ❌ Kill switch failed: ${msg}`;
  }
}

async function handleRiskCommand(): Promise<string> {
  const mode = await getMode();
  const pool = getPool();

  let portfolio = 50;
  try {
    const pv = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_portfolio_value'`);
    if (pv.rows.length > 0 && typeof pv.rows[0].value === "number") portfolio = pv.rows[0].value;
  } catch {}

  let positions: any[] = [];
  try {
    const pos = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_positions'`);
    if (pos.rows.length > 0 && Array.isArray(pos.rows[0].value)) positions = pos.rows[0].value;
  } catch {}

  let history: any[] = [];
  try {
    const hist = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_trade_history'`);
    if (hist.rows.length > 0 && Array.isArray(hist.rows[0].value)) history = hist.rows[0].value;
  } catch {}

  const totalExposure = positions.reduce((s: number, p: any) => s + (p.size || 0) * (p.entry_price || 0), 0);
  const unrealizedPnl = positions.reduce((s: number, p: any) => s + (p.unrealized_pnl || 0), 0);
  const exposurePct = portfolio > 0 ? (totalExposure / portfolio * 100) : 0;

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentTrades = history.filter((t: any) => new Date(t.closed_at).getTime() > sevenDaysAgo);
  const rolling7d = recentTrades.reduce((s: number, t: any) => s + (t.pnl || 0), 0);
  const rolling7dPct = portfolio > 0 ? (rolling7d / portfolio * 100) : 0;

  const buckets: Record<string, number> = {};
  for (const p of positions) {
    const b = p.exposure_bucket || "general";
    buckets[b] = (buckets[b] || 0) + 1;
  }

  const lines = [
    `${mode} *Risk Dashboard*`,
    "",
    `💰 Portfolio: $${portfolio.toFixed(2)}`,
    `📊 Exposure: $${totalExposure.toFixed(2)} (${exposurePct.toFixed(0)}% of portfolio)`,
    `📈 Unrealized P&L: ${unrealizedPnl >= 0 ? "+" : ""}$${unrealizedPnl.toFixed(2)}`,
    `📉 7-Day Rolling P&L: ${rolling7d >= 0 ? "+" : ""}$${rolling7d.toFixed(2)} (${rolling7dPct.toFixed(1)}%)`,
    `🔻 Circuit Breaker: ${rolling7dPct < -15 ? "⚠️ TRIGGERED" : "OK"} (threshold: -15%)`,
    "",
    `*Positions:* ${positions.length}/5`,
    `*Exposure Limit:* ${exposurePct.toFixed(0)}%/80%`,
    `*Buckets:* ${Object.entries(buckets).map(([b, c]) => `${b}: ${c}/2`).join(", ") || "none"}`,
  ];
  return lines.join("\n");
}

async function handlePolymarketCommand(): Promise<string> {
  const mode = await getMode();
  const pool = getPool();

  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value) && res.rows[0].value.length > 0) {
      const theses = res.rows[0].value;
      const now = Date.now();
      const active = theses.filter((t: any) => t.status === "active" && (!t.expires_at || t.expires_at > now));
      if (active.length === 0) {
        return `${mode} *Polymarket Theses*\n\nNo active theses. Waiting for next scan.`;
      }
      const lines = [`${mode} *Polymarket Theses* (${active.length})`, ""];
      for (const t of active.slice(0, 8)) {
        const dir = t.direction === "YES" ? "✅ YES" : "❌ NO";
        const age = Math.floor((now - t.created_at) / 3600000);
        const conf = { HIGH: "🟢", MEDIUM: "🟡", LOW: "🔴" }[t.confidence as string] || "⚪";
        lines.push(`${conf} *${(t.asset || "").slice(0, 60)}*`);
        lines.push(`  ${dir} | Odds: ${((t.current_odds || 0) * 100).toFixed(0)}% | Whales: ${t.whale_consensus || 0}`);
        lines.push(`  Score: ${(t.whale_avg_score || 0).toFixed(2)} | _${age}h ago_`);
        lines.push("");
      }
      return lines.join("\n");
    }
  } catch {}

  return `${mode} *Polymarket Theses*\n\nNo active theses. Polymarket SCOUT has not generated any yet.`;
}

async function handleTaxCommand(): Promise<string> {
  const mode = await getMode();
  const pool = getPool();

  let history: any[] = [];
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_trade_history'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) history = res.rows[0].value;
  } catch {}

  const year = new Date().getFullYear();
  const yearStart = new Date(year, 0, 1).getTime();
  const yearTrades = history.filter((t: any) => new Date(t.closed_at).getTime() >= yearStart);

  let gains = 0, losses = 0, washAdj = 0;
  for (const t of yearTrades) {
    if ((t.pnl || 0) >= 0) gains += t.pnl;
    else losses += t.pnl;
    if (t.tax_lot?.wash_sale_flagged) washAdj += t.tax_lot.wash_sale_disallowed || 0;
  }

  const net = gains + losses + washAdj;
  const fedTax = Math.max(0, net) * 0.24;
  const nyTax = Math.max(0, net) * 0.0685;

  const lines = [
    `${mode} *${year} Tax Summary*`,
    "",
    `📊 Total Trades: ${yearTrades.length}`,
    `🟢 Gains: +$${gains.toFixed(2)}`,
    `🔴 Losses: -$${Math.abs(losses).toFixed(2)}`,
    `⚠️ Wash Sale Adj: $${washAdj.toFixed(2)}`,
    `💵 Net Taxable: $${net.toFixed(2)}`,
    "",
    `*Estimated Tax:*`,
    `  Federal (24%): $${fedTax.toFixed(2)}`,
    `  NY State (6.85%): $${nyTax.toFixed(2)}`,
    `  Total: $${(fedTax + nyTax).toFixed(2)}`,
  ];
  return lines.join("\n");
}

async function handleOversightCommand(): Promise<string> {
  const mode = await getMode();
  const pool = getPool();

  try {
    const healthRes = await pool.query(`SELECT value FROM app_config WHERE key = 'oversight_health_reports'`);
    const queueRes = await pool.query(`SELECT value FROM app_config WHERE key = 'oversight_improvement_queue'`);
    const lastCheckRes = await pool.query(`SELECT value FROM app_config WHERE key = 'oversight_last_health_check'`);
    const portfolioRes = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_portfolio_value'`);
    const peakRes = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_peak_portfolio'`);
    const historyRes = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_trade_history'`);

    let healthStatus = "No health checks run yet";
    let healthIcon = "⚪";
    if (healthRes.rows.length > 0 && Array.isArray(healthRes.rows[0].value) && healthRes.rows[0].value.length > 0) {
      const latest = healthRes.rows[0].value[healthRes.rows[0].value.length - 1];
      const icons: Record<string, string> = { healthy: "🟢", degraded: "🟡", critical: "🔴" };
      healthIcon = icons[latest.overall_status] || "⚪";
      healthStatus = latest.summary || latest.overall_status;
    }

    let openImprovements = 0;
    let criticalImprovements = 0;
    const activeItems: Array<{ severity: string; title: string; route: string }> = [];
    if (queueRes.rows.length > 0 && Array.isArray(queueRes.rows[0].value)) {
      const open = queueRes.rows[0].value.filter((i: any) => i.status === "open");
      openImprovements = open.length;
      criticalImprovements = open.filter((i: any) => i.severity === "critical").length;
      for (const item of open.slice(0, 5)) {
        activeItems.push({ severity: item.severity, title: item.title, route: item.route || "manual" });
      }
    }

    const portfolio = portfolioRes.rows.length > 0 ? Number(portfolioRes.rows[0].value) : 50;
    const peak = peakRes.rows.length > 0 ? Number(peakRes.rows[0].value) : 50;
    const drawdownPct = peak > 0 ? ((peak - portfolio) / peak * 100) : 0;

    let rolling7dPct = 0;
    if (historyRes.rows.length > 0 && Array.isArray(historyRes.rows[0].value)) {
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recent = historyRes.rows[0].value.filter((t: any) => new Date(t.closed_at).getTime() > sevenDaysAgo);
      const rolling7d = recent.reduce((s: number, t: any) => s + (t.pnl || 0), 0);
      rolling7dPct = portfolio > 0 ? (rolling7d / portfolio * 100) : 0;
    }

    let lastCheck = "never";
    if (lastCheckRes.rows.length > 0 && typeof lastCheckRes.rows[0].value === "number") {
      lastCheck = timeAgo(lastCheckRes.rows[0].value);
    }

    const ddIcon = drawdownPct > 25 ? "🔴" : drawdownPct > 15 ? "🟡" : "🟢";
    const pnlIcon = rolling7dPct < -15 ? "🔴" : rolling7dPct < -5 ? "🟡" : "🟢";

    const lines = [
      `${mode} *Oversight Status*`,
      "",
      `${healthIcon} *Health:* ${healthStatus}`,
      `🕐 *Last Check:* ${lastCheck}`,
      "",
      `*Drawdown:*`,
      `${ddIcon} Peak DD: ${drawdownPct.toFixed(1)}% ($${portfolio.toFixed(2)} / $${peak.toFixed(2)} peak)`,
      `${pnlIcon} 7d P&L: ${rolling7dPct >= 0 ? "+" : ""}${rolling7dPct.toFixed(1)}%`,
      "",
      `📋 *Open Improvements:* ${openImprovements}${criticalImprovements > 0 ? ` (${criticalImprovements} critical)` : ""}`,
    ];

    if (activeItems.length > 0) {
      const sevIcons: Record<string, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪" };
      for (const item of activeItems) {
        lines.push(`  ${sevIcons[item.severity] || "⚪"} ${item.title} → ${item.route}`);
      }
    }

    return lines.join("\n");
  } catch (err) {
    return `${mode} *Oversight Status*\n\n❌ Failed to fetch: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleShadowCommand(): Promise<string> {
  const mode = await getMode();
  const pool = getPool();

  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'oversight_shadow_trades'`);
    if (res.rows.length === 0 || !Array.isArray(res.rows[0].value) || res.rows[0].value.length === 0) {
      return `${mode} *Shadow Trading*\n\nNo shadow trades recorded yet.`;
    }

    const trades = res.rows[0].value;
    const openTrades = trades.filter((t: any) => t.status === "open");
    const closedTrades = trades.filter((t: any) => t.status === "closed");
    const totalPnl = closedTrades.reduce((s: number, t: any) => s + (t.hypothetical_pnl || 0), 0);
    const openPnl = openTrades.reduce((s: number, t: any) => s + (t.hypothetical_pnl || 0), 0);
    const wins = closedTrades.filter((t: any) => (t.hypothetical_pnl || 0) > 0);
    const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length * 100) : 0;

    const lines = [
      `${mode} *Shadow Trading*`,
      "",
      `📊 *Total:* ${trades.length} trades (${openTrades.length} open, ${closedTrades.length} closed)`,
      `💰 *Closed P&L:* ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`,
      `📈 *Open P&L:* ${openPnl >= 0 ? "+" : ""}$${openPnl.toFixed(2)}`,
      `🎯 *Win Rate:* ${winRate.toFixed(0)}%`,
    ];

    if (openTrades.length > 0) {
      lines.push("");
      lines.push("*Open Positions:*");
      for (const t of openTrades.slice(0, 5)) {
        const pnlStr = t.hypothetical_pnl >= 0 ? `+$${t.hypothetical_pnl.toFixed(2)}` : `-$${Math.abs(t.hypothetical_pnl).toFixed(2)}`;
        lines.push(`  • ${t.asset} ${t.direction} — ${pnlStr}`);
      }
    }

    return lines.join("\n");
  } catch (err) {
    return `${mode} *Shadow Trading*\n\n❌ Failed to fetch: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleAlertsCommand(): Promise<string> {
  const mode = await getMode();
  const darkNodeStatus = isConfigured() ? "✅ Connected" : "❌ Disconnected";
  const alertsStatus = isAlertsBotConfigured() ? "✅ Connected" : "❌ Disconnected";
  return [
    `${mode} *Telegram Bots Status*`,
    "",
    `🤖 *DarkNode* (trading): ${darkNodeStatus}`,
    "  → Scout signals, BANKR execution, oversight, circuit breakers, autoresearch, trade approvals",
    "",
    `📋 *Mission Control* (personal): ${alertsStatus}`,
    "  → Daily briefs, calendar, email, stock watchlist, task alerts",
  ].join("\n");
}

async function handleHelpCommand(): Promise<string> {
  const mode = await getMode();
  return [
    `${mode} *DarkNode Commands*`,
    "",
    "/status — System health & mode",
    "/portfolio — Open positions & P&L",
    "/intel — Latest SCOUT brief",
    "/scout — Active crypto theses",
    "/polymarket — Active PM theses",
    "/trades [n] — Last N trades (default 5)",
    "/risk — Risk dashboard",
    "/oversight — Oversight agent status",
    "/shadow — Shadow trading stats",
    "/tax — YTD tax summary",
    "/kill — Emergency kill switch",
    "/pause — Halt all Wealth Engine jobs",
    "/resume — Resume Wealth Engine jobs",
    "/public on|off — Toggle dashboard access",
    "/alerts — Bot connection status",
    "/research [crypto|pm] — Run autoresearch",
    "/help — This message",
  ].join("\n");
}

export async function requestTradeApproval(params: {
  thesisId: string;
  asset: string;
  direction: string;
  leverage: string;
  entryPrice: string;
  stopLoss: string;
  takeProfit: string;
  riskAmount: string;
  reason: string;
}): Promise<"approve" | "skip" | "hold"> {
  const mode = await getMode();
  if (!isConfigured()) {
    console.warn("[telegram] Trade approval requested but Telegram not configured — auto-skipping");
    return "skip";
  }

  const text = [
    `${mode} 🔔 *Trade Approval Required*`,
    "",
    `*Asset:* ${params.asset}`,
    `*Direction:* ${params.direction}`,
    `*Leverage:* ${params.leverage}`,
    `*Entry:* $${params.entryPrice}`,
    `*Stop Loss:* $${params.stopLoss}`,
    `*Take Profit:* $${params.takeProfit}`,
    `*Risk:* $${params.riskAmount}`,
    "",
    `*Reason:* ${params.reason}`,
    "",
    `_Thesis: ${params.thesisId}_`,
  ].join("\n");

  const approvalId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const keyboard = [
    [
      { text: "✅ Approve", callback_data: `trade_approve:${approvalId}` },
      { text: "⏭ Skip", callback_data: `trade_skip:${approvalId}` },
      { text: "⏸ Hold", callback_data: `trade_hold:${approvalId}` },
    ],
  ];

  return new Promise(async (resolve) => {
    const msgId = await sendMessageWithKeyboard(text, keyboard);

    pendingApprovals.set(approvalId, {
      thesisId: params.thesisId,
      asset: params.asset,
      direction: params.direction,
      leverage: params.leverage,
      messageId: msgId || 0,
      createdAt: Date.now(),
      resolve,
    });

    setTimeout(() => {
      if (pendingApprovals.has(approvalId)) {
        pendingApprovals.delete(approvalId);
        resolve("skip");
        if (msgId) {
          editMessage(msgId, `${text}\n\n⏰ _Expired — auto-skipped after 30 minutes_`);
        }
      }
    }, 30 * 60 * 1000);
  });
}

async function handleCallbackQuery(callbackQueryId: string, data: string): Promise<void> {
  const [action, approvalId] = data.split(":");

  if (!action?.startsWith("trade_")) {
    await answerCallbackQuery(callbackQueryId, "Unknown action");
    return;
  }

  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    await answerCallbackQuery(callbackQueryId, "This approval has expired");
    return;
  }

  const decision = action.replace("trade_", "") as "approve" | "skip" | "hold";
  pendingApprovals.delete(approvalId);

  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [
        `trade_decision_${approvalId}`,
        JSON.stringify({ decision, thesisId: pending.thesisId, asset: pending.asset, decidedAt: new Date().toISOString() }),
        Date.now(),
      ]
    );
  } catch (err) {
    console.error("[telegram] Failed to record trade decision:", err);
  }

  const decisionLabels: Record<string, string> = {
    approve: "✅ APPROVED",
    skip: "⏭ SKIPPED",
    hold: "⏸ ON HOLD",
  };

  const mode = await getMode();
  if (pending.messageId) {
    await editMessage(
      pending.messageId,
      `${mode} *Trade ${decisionLabels[decision]}*\n\n*${pending.asset}* ${pending.direction} ${pending.leverage}\n\n_Decision recorded at ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET_`
    );
  }

  await answerCallbackQuery(callbackQueryId, decisionLabels[decision]);
  pending.resolve(decision);
  console.log(`[telegram] Trade ${decision}: ${pending.asset} ${pending.direction} (thesis: ${pending.thesisId})`);
}

async function pollUpdates(): Promise<void> {
  if (!pollingActive || !isConfigured()) return;

  try {
    const result = await tgFetch("getUpdates", {
      offset: lastUpdateId + 1,
      timeout: 30,
      allowed_updates: ["message", "callback_query"],
    });

    const updates = result.result || [];
    for (const update of updates) {
      lastUpdateId = Math.max(lastUpdateId, update.update_id);

      if (update.callback_query) {
        const cbq = update.callback_query;
        if (String(cbq.message?.chat?.id) === CHAT_ID) {
          await handleCallbackQuery(cbq.id, cbq.data || "");
        }
        continue;
      }

      if (update.message?.text && String(update.message.chat.id) === CHAT_ID) {
        const text = update.message.text.trim();
        if (text.startsWith("/")) {
          const parts = text.split(/\s+/);
          const cmd = parts[0].toLowerCase().replace(/@\w+/, "").replace("/", "");
          const args = parts.slice(1).join(" ");
          const handler = commands[cmd];
          if (handler) {
            try {
              const response = await handler(args);
              await sendMessage(response);
            } catch (err) {
              console.error(`[telegram] Command /${cmd} failed:`, err);
              await sendMessage(`❌ Command failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && !err.message.includes("ETIMEDOUT")) {
      console.error("[telegram] Poll error:", err.message);
    }
  }

  if (pollingActive) {
    pollingTimeout = setTimeout(() => pollUpdates(), 1000);
  }
}

function timeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function isJobEnabled(pool: any, agentId: string): Promise<boolean> {
  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'scheduled_jobs'`);
    if (res.rows.length > 0 && res.rows[0].value?.jobs) {
      const jobs = res.rows[0].value.jobs;
      return jobs.some((j: any) => j.agentId === agentId && j.enabled);
    }
  } catch {}
  return false;
}

async function checkDeadManSwitches(): Promise<void> {
  if (!isConfigured()) return;
  const pool = getPool();
  const mode = await getMode();

  let paused = false;
  try {
    const pa = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_paused'`);
    paused = pa.rows.length > 0 && pa.rows[0].value === true;
  } catch {}
  if (paused) return;

  const scoutEnabled = await isJobEnabled(pool, "scout");
  if (scoutEnabled) {
    try {
      const scoutRes = await pool.query(
        `SELECT created_at FROM job_history WHERE agent_id = 'scout' ORDER BY created_at DESC LIMIT 1`
      );
      if (scoutRes.rows.length > 0) {
        const lastRun = new Date(scoutRes.rows[0].created_at).getTime();
        const hoursSince = (Date.now() - lastRun) / (3600 * 1000);
        if (hoursSince > 6) {
          const lastAlert = lastDeadManAlert["scout"] || 0;
          if (Date.now() - lastAlert > 4 * 3600 * 1000) {
            lastDeadManAlert["scout"] = Date.now();
            await sendMessage(
              `${mode} ⚠️ *Dead Man's Switch: SCOUT*\n\nSCOUT has not run in ${Math.floor(hoursSince)}h (threshold: 6h).\nLast run: ${timeAgo(lastRun)}\n\nCheck scheduled jobs or run manually.`
            );
          }
        } else {
          delete lastDeadManAlert["scout"];
        }
      }
    } catch (err) {
      console.error("[telegram] Dead man switch SCOUT check failed:", err);
    }
  } else {
    delete lastDeadManAlert["scout"];
  }

  try {
    const monitorRes = await pool.query(
      `SELECT value FROM app_config WHERE key = 'bankr_monitor_last_tick'`
    );
    if (monitorRes.rows.length > 0) {
      const lastTick = typeof monitorRes.rows[0].value === "number" ? monitorRes.rows[0].value : parseInt(String(monitorRes.rows[0].value));
      const minsSince = (Date.now() - lastTick) / (60 * 1000);
      if (minsSince > 30) {
        const lastAlert = lastDeadManAlert["bankr-monitor"] || 0;
        if (Date.now() - lastAlert > 60 * 60 * 1000) {
          lastDeadManAlert["bankr-monitor"] = Date.now();
          await sendMessage(
            `${mode} ⚠️ *Dead Man's Switch: BANKR Monitor*\n\nPosition monitor has not ticked in ${Math.floor(minsSince)} min (threshold: 30 min).\nLast tick: ${timeAgo(lastTick)}\n\nThe server may have restarted or crashed.`
          );
        }
      } else {
        delete lastDeadManAlert["bankr-monitor"];
      }
    }
  } catch (err) {
    console.error("[telegram] Dead man switch BANKR monitor check failed:", err);
  }

  const bankrEnabled = await isJobEnabled(pool, "bankr");
  if (bankrEnabled) {
    try {
      const bankrRes = await pool.query(
        `SELECT created_at FROM job_history WHERE agent_id = 'bankr' ORDER BY created_at DESC LIMIT 1`
      );
      if (bankrRes.rows.length > 0) {
        const lastRun = new Date(bankrRes.rows[0].created_at).getTime();
        const hoursSince = (Date.now() - lastRun) / (3600 * 1000);
        if (hoursSince > 8) {
          const lastAlert = lastDeadManAlert["bankr"] || 0;
          if (Date.now() - lastAlert > 4 * 3600 * 1000) {
            lastDeadManAlert["bankr"] = Date.now();
            await sendMessage(
              `${mode} ⚠️ *Dead Man's Switch: BANKR*\n\nBANKR agent has not run in ${Math.floor(hoursSince)}h (threshold: 8h).\nLast run: ${timeAgo(lastRun)}\n\nCheck scheduled jobs or run manually.`
            );
          }
        } else {
          delete lastDeadManAlert["bankr"];
        }
      }
    } catch (err) {
      console.error("[telegram] Dead man switch BANKR check failed:", err);
    }
  } else {
    delete lastDeadManAlert["bankr"];
  }
}

export async function sendTradeAlert(params: {
  type: "executed" | "stopped" | "emergency" | "closed";
  asset: string;
  direction?: string;
  leverage?: string;
  entryPrice?: string;
  exitPrice?: string;
  pnl?: number;
  reason?: string;
}): Promise<void> {
  const mode = await getMode();
  const icons: Record<string, string> = {
    executed: "📈",
    stopped: "🛑",
    emergency: "🚨",
    closed: "✅",
  };
  const icon = icons[params.type] || "📊";

  const lines = [`${mode} ${icon} *Trade ${params.type.toUpperCase()}*`, ""];
  lines.push(`*Asset:* ${params.asset}`);
  if (params.direction) lines.push(`*Direction:* ${params.direction}`);
  if (params.leverage) lines.push(`*Leverage:* ${params.leverage}`);
  if (params.entryPrice) lines.push(`*Entry:* $${params.entryPrice}`);
  if (params.exitPrice) lines.push(`*Exit:* $${params.exitPrice}`);
  if (params.pnl != null) {
    const pnlStr = params.pnl >= 0 ? `+$${params.pnl.toFixed(2)}` : `-$${Math.abs(params.pnl).toFixed(2)}`;
    lines.push(`*P&L:* ${pnlStr}`);
  }
  if (params.reason) lines.push(`\n_${params.reason}_`);

  await sendMessage(lines.join("\n"));
}

export async function sendScoutBrief(brief: string): Promise<void> {
  const mode = await getMode();
  const truncated = brief.length > 3500 ? brief.slice(0, 3500) + "\n\n_(truncated)_" : brief;
  await sendMessage(`${mode} 🔍 *SCOUT Morning Brief*\n\n${truncated}`);
}

let webhookMode = false;

async function registerWebhook(): Promise<boolean> {
  const domain = process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS?.split(",")[0];
  if (!domain) {
    console.warn("[telegram] No domain available for webhook — falling back to long-polling");
    return false;
  }

  const webhookUrl = `https://${domain}/api/telegram/webhook`;
  try {
    const result = await tgFetch("setWebhook", {
      url: webhookUrl,
      allowed_updates: ["message", "callback_query"],
      secret_token: WEBHOOK_SECRET,
    });
    if (result.ok) {
      console.log(`[telegram] Webhook registered: ${webhookUrl}`);
      return true;
    }
    console.warn("[telegram] Webhook registration failed:", result.description);
    return false;
  } catch (err) {
    console.warn("[telegram] Webhook registration failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

async function deleteWebhook(): Promise<void> {
  try {
    await tgFetch("deleteWebhook");
  } catch {}
}

export function getWebhookSecret(): string {
  return WEBHOOK_SECRET;
}

export async function handleWebhookUpdate(update: any): Promise<void> {
  if (!isConfigured()) return;

  if (update.callback_query) {
    const cbq = update.callback_query;
    if (String(cbq.message?.chat?.id) === CHAT_ID) {
      await handleCallbackQuery(cbq.id, cbq.data || "");
    }
    return;
  }

  if (update.message?.text && String(update.message.chat.id) === CHAT_ID) {
    const text = update.message.text.trim();
    if (text.startsWith("/")) {
      const parts = text.split(/\s+/);
      const cmd = parts[0].toLowerCase().replace(/@\w+/, "").replace("/", "");
      const args = parts.slice(1).join(" ");
      const handler = commands[cmd];
      if (handler) {
        try {
          const response = await handler(args);
          await sendMessage(response);
        } catch (err) {
          console.error(`[telegram] Command /${cmd} failed:`, err);
          await sendMessage(`❌ Command failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
}

async function handleResearchCommand(args: string): Promise<string> {
  const mode = await getMode();
  const parts = args.trim().toLowerCase().split(/\s+/);

  if (parts[0] === "rollback") {
    const domain = parts[1] === "polymarket" ? "polymarket" as const : "crypto" as const;
    const result = await autoresearch.rollbackParams(domain);
    return `${mode} ${result.success ? "✅" : "❌"} ${result.message}`;
  }

  if (parts[0] === "status") {
    const status = await autoresearch.getResearchStatus();
    const lines = [
      `${mode} 🔬 *Autoresearch Status*`,
      "",
      `*Crypto Parameters:*`,
      ...Object.entries(status.crypto_params).slice(0, 8).map(([k, v]) => `  ${k}: ${v}`),
      `  ... (${Object.keys(status.crypto_params).length} total)`,
      "",
      `*Polymarket Parameters:*`,
      ...Object.entries(status.polymarket_params).slice(0, 8).map(([k, v]) => `  ${k}: ${v}`),
      `  ... (${Object.keys(status.polymarket_params).length} total)`,
      "",
      `*History:* ${status.crypto_history_count} crypto, ${status.polymarket_history_count} polymarket rollback sets`,
      `*Recent Experiments:* ${status.recent_experiments.length} logged`,
    ];

    if (status.recent_experiments.length > 0) {
      const last3 = status.recent_experiments.slice(-3);
      lines.push("");
      for (const e of last3) {
        lines.push(`  ${e.domain}: ${e.outcome} (${e.delta_pct.toFixed(1)}%) — ${Object.keys(e.parameters_changed).join(", ")}`);
      }
    }

    return lines.join("\n");
  }

  await sendMessage(`${mode} 🔬 Starting autoresearch...`);

  let summaries: autoresearch.ResearchRunSummary[];
  if (parts[0] === "crypto") {
    summaries = [await autoresearch.runCryptoResearch()];
  } else if (parts[0] === "polymarket") {
    summaries = [await autoresearch.runPolymarketResearch()];
  } else {
    summaries = await autoresearch.runFullResearch();
  }

  return autoresearch.formatResearchSummary(summaries);
}

export async function init(): Promise<void> {
  if (!BOT_TOKEN) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
    return;
  }
  if (!CHAT_ID) {
    console.warn("[telegram] TELEGRAM_CHAT_ID not set — Telegram bot disabled");
    return;
  }

  registerCommand("status", async () => handleStatusCommand());
  registerCommand("portfolio", async () => handlePortfolioCommand());
  registerCommand("intel", async () => handleIntelCommand());
  registerCommand("pause", async () => handlePauseCommand());
  registerCommand("resume", async () => handleResumeCommand());
  registerCommand("scout", async () => handleScoutCommand());
  registerCommand("trades", async (args) => handleTradesCommand(args));
  registerCommand("public", async (args) => handlePublicCommand(args));
  registerCommand("kill", async () => handleKillCommand());
  registerCommand("risk", async () => handleRiskCommand());
  registerCommand("polymarket", async () => handlePolymarketCommand());
  registerCommand("tax", async () => handleTaxCommand());
  registerCommand("oversight", async () => handleOversightCommand());
  registerCommand("shadow", async () => handleShadowCommand());
  registerCommand("research", async (args) => handleResearchCommand(args));
  registerCommand("alerts", async () => handleAlertsCommand());
  registerCommand("help", async () => handleHelpCommand());

  try {
    const me = await tgFetch("getMe");
    console.log(`[telegram] Bot connected: @${me.result?.username || "unknown"}`);
  } catch (err) {
    console.error("[telegram] Failed to connect:", err instanceof Error ? err.message : err);
    return;
  }

  if (isAlertsBotConfigured()) {
    try {
      const alertsMe = await fetch(`${ALERTS_API_BASE}/getMe`, { method: "POST", headers: { "Content-Type": "application/json" } });
      const alertsData = await alertsMe.json();
      console.log(`[telegram-alerts] Alerts bot connected: @${alertsData.result?.username || "unknown"}`);
    } catch (err) {
      console.warn("[telegram-alerts] Failed to connect alerts bot:", err instanceof Error ? err.message : err);
    }
  } else {
    console.warn("[telegram-alerts] TELEGRAM_ALERTS_BOT_TOKEN not set — personal alerts bot disabled");
  }

  webhookMode = await registerWebhook();
  if (!webhookMode) {
    await deleteWebhook();
    pollingActive = true;
    pollUpdates();
    console.log("[telegram] initialized (long-polling fallback, dead man switches hourly)");
  } else {
    console.log("[telegram] initialized (webhook mode, dead man switches hourly)");
  }

  deadManInterval = setInterval(() => {
    checkDeadManSwitches().catch(err => console.error("[telegram] Dead man check error:", err));
  }, 60 * 60 * 1000);
}

export function stop(): void {
  pollingActive = false;
  if (pollingTimeout) {
    clearTimeout(pollingTimeout);
    pollingTimeout = null;
  }
  if (deadManInterval) {
    clearInterval(deadManInterval);
    deadManInterval = null;
  }
  console.log("[telegram] stopped");
}

export async function forwardAlertToTelegram(event: { type: string; briefType?: string; alertType?: string; title?: string; content: string }): Promise<void> {
  const mode = await getMode();

  const personalAlertTypes = new Set(["calendar", "stock", "task", "email"]);
  const tradingEventTypes = new Set(["scout", "bankr", "oversight", "autoresearch", "circuit_breaker"]);

  if (event.type === "brief") {
    if (!isAlertsBotConfigured()) return;
    const briefLabel = event.briefType ? event.briefType.charAt(0).toUpperCase() + event.briefType.slice(1) : "Daily";
    const truncated = event.content.length > 3500 ? event.content.slice(0, 3500) + "\n\n_(truncated)_" : event.content;
    await sendAlertsBotMessage(`${mode} 📋 *${briefLabel} Brief*\n\n${truncated}`);
    return;
  }

  if (event.type === "alert" && personalAlertTypes.has(event.alertType || "")) {
    if (!isAlertsBotConfigured()) return;
    const icons: Record<string, string> = {
      calendar: "📅",
      stock: "📊",
      task: "✅",
      email: "📧",
    };
    const icon = icons[event.alertType || ""] || "🔔";
    await sendAlertsBotMessage(`${mode} ${icon} *${event.title || "Alert"}*\n\n${event.content}`);
    return;
  }

  if (tradingEventTypes.has(event.type) || (event.type === "alert" && !personalAlertTypes.has(event.alertType || ""))) {
    if (!isConfigured()) return;
    const tradingIcons: Record<string, string> = {
      scout: "🔍",
      bankr: "💰",
      oversight: "🛡️",
      autoresearch: "🔬",
      circuit_breaker: "🚨",
    };
    const icon = tradingIcons[event.type] || "🔔";
    await sendMessage(`${mode} ${icon} *${event.title || "Alert"}*\n\n${event.content}`);
  }
}
