import { getPool } from "./db.js";
import {
  escapeHtml,
  truncateForTelegram,
  formatTelegramBriefHeader,
  escapeAndPreserveHtmlTags,
} from "./telegram-format.js";

const BOT_TOKEN = process.env.TG_BOT_TOKEN || "";
const CHAT_ID = process.env.TG_CHANNEL_DIRECT || process.env.TELEGRAM_CHAT_ID || "";
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const RICKIN_TELEGRAM_IDS = new Set([
  process.env.RICKIN_TELEGRAM_ID || "",
  "rickin",
].filter(Boolean));

const CHANNEL_MAP: Record<string, string> = {
  "direct": process.env.TG_CHANNEL_DIRECT || "",
  "retuned": process.env.TG_CHANNEL_RETUNED || "",
  "moodys": process.env.TG_CHANNEL_MOODYS || "",
  "family": process.env.TG_CHANNEL_FAMILY || "",
  "real-estate": process.env.TG_CHANNEL_REAL_ESTATE || "",
  "ai-tech": process.env.TG_CHANNEL_AI_TECH || "",
  "bitcoin": process.env.TG_CHANNEL_BITCOIN || "",
  "markets": process.env.TG_CHANNEL_MARKETS || "",
  "news": process.env.TG_CHANNEL_NEWS || "",
  "intel": process.env.TG_CHANNEL_INTEL || "",
  "trading": process.env.TG_CHANNEL_TRADING || "",
  "mission-control": process.env.TG_CHANNEL_MISSION_CONTROL || "",
};

export type TelegramChannel = keyof typeof CHANNEL_MAP;

export const VALID_CHANNELS = Object.keys(CHANNEL_MAP);

export async function sendToChannel(
  channel: string,
  text: string,
  parseMode: string = "HTML"
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  if (!BOT_TOKEN) return { ok: false, error: "TG_BOT_TOKEN not configured" };
  const chatId = CHANNEL_MAP[channel];
  if (!chatId) return { ok: false, error: `Unknown channel: ${channel}. Valid: ${VALID_CHANNELS.join(", ")}` };
  try {
    const resp = await fetch(`${API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: parseMode, disable_web_page_preview: true }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error(`[telegram] sendToChannel(${channel}) failed (${resp.status}): ${body}`);
      return { ok: false, error: `API error ${resp.status}: ${body.slice(0, 200)}` };
    }
    const data = await resp.json();
    return { ok: true, messageId: data.result?.message_id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[telegram] sendToChannel(${channel}) error:`, msg);
    return { ok: false, error: msg };
  }
}

export async function sendToChannelWithKeyboard(
  channel: string,
  text: string,
  keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>,
  parseMode: string = "HTML"
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  if (!BOT_TOKEN) return { ok: false, error: "TG_BOT_TOKEN not configured" };
  const chatId = CHANNEL_MAP[channel];
  if (!chatId) return { ok: false, error: `Unknown channel: ${channel}` };
  try {
    const resp = await fetch(`${API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard },
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      console.error(`[telegram] sendToChannelWithKeyboard(${channel}) failed (${resp.status}): ${body}`);
      return { ok: false, error: `API error ${resp.status}` };
    }
    const data = await resp.json();
    return { ok: true, messageId: data.result?.message_id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export async function sendAlertsBotMessage(text: string, parseMode: string = "Markdown"): Promise<boolean> {
  const result = await sendToChannel("mission-control", text, parseMode);
  return result.ok;
}

import { createHash } from "crypto";
const WEBHOOK_SECRET = createHash("sha256").update(`webhook-secret-${BOT_TOKEN}`).digest("hex");

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

export async function sendPhoto(photoUrl: string, caption?: string, parseMode: string = "Markdown"): Promise<number | null> {
  if (!isConfigured()) return null;
  try {
    const body: Record<string, any> = {
      chat_id: CHAT_ID,
      photo: photoUrl,
    };
    if (caption) {
      body.caption = caption.length > 1024 ? caption.slice(0, 1020) + "..." : caption;
      body.parse_mode = parseMode;
    }
    const result = await tgFetch("sendPhoto", body);
    return result.result?.message_id || null;
  } catch (err) {
    console.error("[telegram] sendPhoto failed:", err instanceof Error ? err.message : err);
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
  let pauseActive = false;
  let healthLine = "";
  let shadowLine = "";

  try {
    const configRes = await pool.query(
      `SELECT key, value FROM app_config WHERE key IN ('wealth_engines_kill_switch', 'wealth_engines_paused', 'oversight_health_reports', 'oversight_shadow_trades')`
    );
    const configMap: Record<string, any> = {};
    for (const row of configRes.rows) configMap[row.key] = row.value;

    killSwitchActive = configMap['wealth_engines_kill_switch'] === true;
    pauseActive = configMap['wealth_engines_paused'] === true;

    const healthReports = configMap['oversight_health_reports'];
    if (Array.isArray(healthReports) && healthReports.length > 0) {
      const latest = healthReports[healthReports.length - 1];
      const icons: Record<string, string> = { healthy: "🟢", degraded: "🟡", critical: "🔴" };
      healthLine = `${icons[latest.overall_status] || "⚪"} Oversight: ${latest.overall_status}`;
    }

    const shadowTrades = configMap['oversight_shadow_trades'];
    if (Array.isArray(shadowTrades)) {
      const open = shadowTrades.filter((t: any) => t.status === "open");
      const closed = shadowTrades.filter((t: any) => t.status === "closed");
      const totalPnl = closed.reduce((s: number, t: any) => s + (t.hypothetical_pnl || 0), 0)
        + open.reduce((s: number, t: any) => s + (t.hypothetical_pnl || 0), 0);
      const pnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
      shadowLine = `👻 Shadow: ${open.length} open, ${closed.length} closed | P&L: ${pnlStr}`;
    }
  } catch {}

  let bankrLastRun = "never";
  let pmLastRun = "never";
  try {
    const jobRes = await pool.query(`
      SELECT DISTINCT ON (grp) grp, created_at FROM (
        SELECT 'bankr' AS grp, created_at FROM job_history WHERE agent_id = 'bankr'
        UNION ALL
        SELECT 'pm' AS grp, created_at FROM job_history WHERE job_id IN ('polymarket-activity-scan','polymarket-full-cycle')
      ) sub ORDER BY grp, created_at DESC
    `);
    for (const row of jobRes.rows) {
      const ts = timeAgo(new Date(row.created_at).getTime());
      if (row.grp === "bankr") bankrLastRun = ts;
      else if (row.grp === "pm") pmLastRun = ts;
    }
  } catch {}

  const notifyMode = await getNotificationMode();

  const lines = [
    `${mode} *DarkNode Status*`,
    "",
    `🔴 Kill Switch: ${killSwitchActive ? "ACTIVE" : "OFF"}`,
    `⏸ Paused: ${pauseActive ? "YES" : "NO"}`,
  ];
  lines.push(`🎰 PM SCOUT: ${pmLastRun}`);
  lines.push(`💰 BANKR: ${bankrLastRun}`);
  if (healthLine) lines.push(healthLine);
  if (shadowLine) lines.push(shadowLine);
  lines.push(`🔔 Notifications: ${notifyMode}`);
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
    const { formatPnl } = await import("./telegram-format.js");
    const arrow = pnl >= 0 ? "🟢" : "🔴";
    lines.push(`${arrow} *${pos.asset}* ${pos.direction} ${pos.leverage || "1x"}`);
    lines.push(`   Entry: $${pos.entry_price} | P&L: ${formatPnl(pnl)}`);
  }
  lines.push("");
  const { formatPnl: fmtPnl } = await import("./telegram-format.js");
  lines.push(`*Total P&L:* ${fmtPnl(totalPnl)}`);

  return lines.join("\n");
}

async function handleIntelCommand(): Promise<string> {
  const mode = await getMode();
  const pool = getPool();

  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
    if (res.rows.length > 0 && res.rows[0].value) {
      const theses = res.rows[0].value;
      const summary = Array.isArray(theses) ? theses.filter((t: any) => t.status === "active").map((t: any) => `• ${t.question || t.market_question || "?"} (${t.direction}, ${t.confidence})`).join("\n") : JSON.stringify(theses);
      const truncated = summary.length > 3000 ? summary.slice(0, 3000) + "\n\n_(truncated)_" : summary;
      return `${mode} *PM SCOUT Active Theses*\n\n${truncated || "No active theses"}`;
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
  return `Scout command has been replaced. Use /intel for active Polymarket theses.`;
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
        const { formatPnl } = await import("./telegram-format.js");
        const icon = pnl >= 0 ? "🟢" : "🔴";
        const date = t.closed_at ? new Date(t.closed_at).toLocaleDateString("en-US", { timeZone: "America/New_York" }) : "open";
        lines.push(`${icon} *${t.asset}* ${t.direction} ${t.leverage || "1x"} — ${formatPnl(pnl)} (${date})`);
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

async function handleResetCommand(args: string): Promise<string> {
  const mode = await getMode();
  const pool = getPool();
  const rawCapital = args.trim() ? parseFloat(args.trim()) : 10000;
  const capital = isFinite(rawCapital) && rawCapital > 0 ? rawCapital : 10000;
  try {
    const now = Date.now();
    const resets: [string, unknown][] = [
      ["wealth_engines_portfolio_value", capital],
      ["wealth_engines_peak_portfolio", capital],
      ["wealth_engines_consecutive_losses", 0],
      ["wealth_engines_trade_history", []],
      ["wealth_engines_positions", []],
      ["oversight_shadow_trades", []],
      ["signal_quality_scores", []],
      ["wealth_engines_paused", false],
      ["wealth_engines_kill_switch", false],
    ];
    for (const [key, value] of resets) {
      await pool.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [key, JSON.stringify(value), now]
      );
    }
    console.log(`[telegram] FULL RESET via Telegram — capital: $${capital}`);
    return [
      `${mode} 🔄 *Full Portfolio Reset*`,
      "",
      `💰 Capital: $${capital.toLocaleString()}`,
      "✅ Positions cleared",
      "✅ Trade history cleared",
      "✅ Shadow trades cleared",
      "✅ Signal quality scores cleared",
      "✅ Kill switch & pause reset",
      "",
      "_System is ready for fresh learning cycle._",
    ].join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${mode} ❌ Reset failed: ${msg}`;
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

  let portfolio = 1000;
  try {
    const pv = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_portfolio_value'`);
    if (pv.rows.length > 0 && typeof pv.rows[0].value === "number") portfolio = pv.rows[0].value;
  } catch {}

  const rcDefaults = { max_leverage: 5, risk_per_trade_pct: 5, max_positions: 3, exposure_cap_pct: 60, correlation_limit: 1, circuit_breaker_7d_pct: -15, circuit_breaker_drawdown_pct: -25 };
  let rc = rcDefaults;
  try {
    const rcRes = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engine_config'`);
    if (rcRes.rows.length > 0 && typeof rcRes.rows[0].value === "object" && rcRes.rows[0].value !== null) {
      rc = { ...rcDefaults, ...rcRes.rows[0].value };
    }
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

  let peakPortfolio = portfolio;
  try {
    const peakRes = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_peak_portfolio'`);
    if (peakRes.rows.length > 0 && typeof peakRes.rows[0].value === "number") peakPortfolio = peakRes.rows[0].value;
  } catch {}
  const drawdownPct = peakPortfolio > 0 ? ((portfolio - peakPortfolio) / peakPortfolio * 100) : 0;

  const lines = [
    `${mode} *Risk Dashboard*`,
    "",
    `💰 Portfolio: $${portfolio.toFixed(2)} (peak: $${peakPortfolio.toFixed(2)})`,
    `📊 Exposure: $${totalExposure.toFixed(2)} (${exposurePct.toFixed(0)}% of portfolio)`,
    `📈 Unrealized P&L: ${unrealizedPnl >= 0 ? "+" : ""}$${unrealizedPnl.toFixed(2)}`,
    `📉 7-Day Rolling P&L: ${rolling7d >= 0 ? "+" : ""}$${rolling7d.toFixed(2)} (${rolling7dPct.toFixed(1)}%)`,
    `🔻 7d Breaker: ${rolling7dPct < rc.circuit_breaker_7d_pct ? "⚠️ TRIGGERED" : "OK"} (${rolling7dPct.toFixed(1)}% / ${rc.circuit_breaker_7d_pct}%)`,
    `🔻 Drawdown Breaker: ${drawdownPct < rc.circuit_breaker_drawdown_pct ? "⚠️ TRIGGERED" : "OK"} (${drawdownPct.toFixed(1)}% / ${rc.circuit_breaker_drawdown_pct}%)`,
    "",
    `*Leverage:* max ${rc.max_leverage}x | *Risk/Trade:* ${rc.risk_per_trade_pct}%`,
    `*Positions:* ${positions.length}/${rc.max_positions}`,
    `*Exposure Limit:* ${exposurePct.toFixed(0)}%/${rc.exposure_cap_pct}%`,
    `*Buckets:* ${Object.entries(buckets).map(([b, c]) => `${b}: ${c}/${rc.correlation_limit}`).join(", ") || "none"}`,
  ];

  try {
    const { getSignalQuality } = await import("./bankr.js");
    const scores = await getSignalQuality();
    if (scores.length > 0) {
      lines.push("", "*Signal Quality:*");
      for (const s of scores) {
        const emoji = s.win_rate > 60 ? "🟢" : s.win_rate < 40 ? "🔴" : "🟡";
        const pf = s.profit_factor != null ? ` PF:${s.profit_factor}` : "";
        lines.push(`${emoji} ${s.source}/${s.asset_class}: ${s.win_rate}% win (${s.recent_results.length} trades, avg $${s.avg_pnl.toFixed(2)}${pf})`);
        const bd = s.asset_breakdown;
        if (bd && typeof bd === "object") {
          for (const [asset, stats] of Object.entries(bd)) {
            const ae = stats.win_rate > 60 ? "🟢" : stats.win_rate < 40 ? "🔴" : "🟡";
            lines.push(`  ${ae} ${asset}: ${stats.win_rate}% (${stats.wins}W/${stats.losses}L, avg $${stats.avg_pnl.toFixed(2)})`);
          }
        }
      }
    }
  } catch {}

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

    const portfolio = portfolioRes.rows.length > 0 ? Number(portfolioRes.rows[0].value) : 1000;
    const peak = peakRes.rows.length > 0 ? Number(peakRes.rows[0].value) : 1000;
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
        const { formatPnl } = await import("./telegram-format.js");
        lines.push(`  • ${t.asset} ${t.direction} — ${formatPnl(t.hypothetical_pnl)}`);
      }
    }

    return lines.join("\n");
  } catch (err) {
    return `${mode} *Shadow Trading*\n\n❌ Failed to fetch: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleAlertsCommand(): Promise<string> {
  const mode = await getMode();
  const botStatus = isConfigured() ? "✅ Connected" : "❌ Disconnected";
  const configuredChannels = VALID_CHANNELS.filter(ch => CHANNEL_MAP[ch]);
  return [
    `${mode} *Telegram Status*`,
    "",
    `🤖 Bot: ${botStatus}`,
    `📡 Channels: ${configuredChannels.length}/12`,
    `  ${configuredChannels.join(", ")}`,
  ].join("\n");
}

async function handleWalletsCommand(): Promise<string> {
  try {
    const { getWhaleWatchlist } = await import("./polymarket.js");
    const { getWalletPerformance } = await import("./copy-trading.js");
    const fmt = await import("./telegram-format.js");
    const wallets = await getWhaleWatchlist();
    const performance = await getWalletPerformance();

    const enabled = wallets.filter(w => w.enabled);
    const sorted = [...enabled].sort((a, b) => b.composite_score - a.composite_score);
    const top3 = sorted.slice(0, 3);

    const nicheGroups: Record<string, number> = {};
    for (const w of enabled) {
      const n = w.niche || "unknown";
      nicheGroups[n] = (nicheGroups[n] || 0) + 1;
    }
    const nicheStr = Object.entries(nicheGroups)
      .map(([n, c]) => `${fmt.getNicheEmoji(n)} ${n.charAt(0).toUpperCase() + n.slice(1)} (${c})`)
      .join(" · ");

    const lines = [
      fmt.buildCategoryHeader(fmt.CATEGORY_BADGES.WHALE_INTEL, "Registry"),
      "",
      `${wallets.length} tracked wallets`,
      fmt.SEPARATOR,
      "Top performers:",
    ];

    for (let i = 0; i < top3.length; i++) {
      const w = top3[i];
      const wp = performance.find(p => p.wallet_address === w.address);
      const roi = wp && wp.total_pnl !== undefined ? ` · ROI: ${fmt.formatPnl(wp.total_pnl)}` : "";
      lines.push(`  ${i + 1}. ${fmt.truncateAddress(w.address)} · Score: ${w.composite_score.toFixed(1)}${roi}`);
    }

    lines.push("");
    lines.push(`Niches: ${nicheStr}`);

    return fmt.truncateToTelegramLimit(lines.join("\n"));
  } catch (err) {
    return `❌ Failed to fetch wallets: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleSeedWalletsCommand(): Promise<string> {
  try {
    const { seedWalletsFromTradeStream } = await import("./polymarket-scout.js");
    const fmt = await import("./telegram-format.js");
    const result = await seedWalletsFromTradeStream();
    const lines = [
      fmt.buildCategoryHeader(fmt.CATEGORY_BADGES.DISCOVERY, "Seed Running..."),
      "",
      `Candidates found: ${result.candidates_found}`,
      `Added: ${result.added}`,
      `Rejected: ${result.rejected}`,
      "",
      ...result.details.slice(0, 10),
    ];
    return fmt.truncateToTelegramLimit(lines.join("\n"));
  } catch (err) {
    return `❌ Seed failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleWalletStatusCommand(): Promise<string> {
  try {
    const { getWhaleWatchlist } = await import("./polymarket.js");
    const { getWalletPerformance } = await import("./copy-trading.js");
    const fmt = await import("./telegram-format.js");
    const wallets = await getWhaleWatchlist();
    const performance = await getWalletPerformance();

    const active = wallets.filter(w => w.enabled && w.status === 'active' && !w.observation_only);
    const observing = wallets.filter(w => w.observation_only);
    const disabled = wallets.filter(w => !w.enabled);
    const blacklisted = wallets.filter(w => w.status === 'removed');

    const lastCheckedWallet = wallets
      .filter(w => w.last_checked > 0)
      .sort((a, b) => b.last_checked - a.last_checked)[0];
    const lastScanAgo = lastCheckedWallet
      ? `${Math.floor((Date.now() - lastCheckedWallet.last_checked) / 60000)} min ago`
      : "never";

    const lines = [
      fmt.buildCategoryHeader(fmt.CATEGORY_BADGES.WHALE_INTEL, "Status"),
      "",
      `Active watchers: ${active.length}`,
      `Observing: ${observing.length}`,
      `Blacklisted: ${blacklisted.length}`,
      `Disabled: ${disabled.length}`,
      "",
      `Last scan: ${lastScanAgo}`,
    ];

    return fmt.truncateToTelegramLimit(lines.join("\n"));
  } catch (err) {
    return `❌ Failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleCopytradesCommand(): Promise<string> {
  try {
    const { getWalletPerformance } = await import("./copy-trading.js");
    const { getPositions } = await import("./bankr.js");
    const fmt = await import("./telegram-format.js");
    const positions = await getPositions();
    const copyPositions = positions.filter(p => p.is_copy_trade);
    const performance = await getWalletPerformance();

    const lines = [
      fmt.buildCategoryHeader(fmt.CATEGORY_BADGES.COPY_TRADE, "Active Positions"),
      "",
      `${copyPositions.length} open position${copyPositions.length !== 1 ? "s" : ""}`,
    ];

    if (copyPositions.length > 0) {
      lines.push(fmt.SEPARATOR);
      let totalUnrealized = 0;
      for (let i = 0; i < copyPositions.length; i++) {
        const pos = copyPositions[i];
        const pnl = pos.unrealized_pnl || 0;
        totalUnrealized += pnl;
        const pnlStr = fmt.formatPnl(pnl);
        const pctStr = pos.entry_price > 0 ? ` (${fmt.formatPct((pnl / pos.entry_price) * 100)})` : "";
        lines.push(`${i + 1}. ${pos.asset.slice(0, 50)} ${pos.direction}`);
        lines.push(`   Entry: $${pos.entry_price?.toFixed(2) || "?"} · ${pnlStr}${pctStr}`);
      }
      lines.push("");
      lines.push(fmt.SEPARATOR);
      lines.push(`Total unrealized: ${fmt.formatPnl(totalUnrealized)}`);
    }

    return fmt.truncateToTelegramLimit(lines.join("\n"));
  } catch (err) {
    return `❌ Failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleGoalCommand(args: string): Promise<string> {
  const pool = getPool();
  const fmt = await import("./telegram-format.js");
  const val = args.trim();

  if (!val) {
    let goalTarget = 50000;
    let portfolioValue = 1000;
    try {
      const res = await pool.query(`SELECT key, value FROM app_config WHERE key IN ('wealth_goal', 'wealth_engines_portfolio_value')`);
      for (const row of res.rows) {
        if (row.key === 'wealth_goal' && typeof row.value?.target === "number") goalTarget = row.value.target;
        if (row.key === 'wealth_engines_portfolio_value' && typeof row.value === "number") portfolioValue = row.value;
      }
    } catch {}
    const bar = fmt.buildProgressBar(portfolioValue, goalTarget, 10);
    const pct = goalTarget > 0 ? ((portfolioValue / goalTarget) * 100).toFixed(1) : "0";
    return [
      `🎯 Current Goal: $${goalTarget.toLocaleString()}`,
      `${bar}  $${Math.floor(portfolioValue).toLocaleString()} / $${goalTarget.toLocaleString()} (${pct}%)`,
      "",
      `Use /goal <amount> to change (e.g. /goal 100000)`,
    ].join("\n");
  }

  const amount = parseInt(val.replace(/[$,]/g, ""), 10);
  if (isNaN(amount) || amount <= 0) {
    return `❌ Invalid amount. Use: /goal 50000`;
  }

  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_goal', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify({ target: amount, label: `$${(amount / 1000).toFixed(0)}K Goal` }), Date.now()]
    );
    return `🎯 Goal updated to $${amount.toLocaleString()}`;
  } catch (err) {
    return `❌ Failed to update goal: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleAddWalletCommand(args: string): Promise<string> {
  const mode = await getMode();
  const parts = args.trim().split(/\s+/);
  const address = parts[0];
  const alias = parts.slice(1).join(" ") || undefined;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return `${mode} ❌ Usage: /add-wallet <0x address> [alias]\nAddress must be a valid 42-char hex address.`;
  }

  try {
    const { getWhaleWatchlist, isBlacklisted, buildWalletFromActivity, saveWhaleWatchlist } = await import("./polymarket.js");
    const wallets = await getWhaleWatchlist();

    if (await isBlacklisted(address)) {
      return `${mode} 🚫 Wallet \`${address.slice(0, 10)}…\` is blacklisted. Remove from blacklist first.`;
    }

    const existingIdx = wallets.findIndex(w => w.address.toLowerCase() === address.toLowerCase());
    if (existingIdx !== -1) {
      const existing = wallets[existingIdx];
      if (!existing.enabled || existing.status === "probation") {
        existing.enabled = true;
        existing.status = "active";
        existing.degraded_count = 0;
        existing.observation_only = true;
        if (alias) existing.alias = alias;
        await saveWhaleWatchlist(wallets);
        return [
          `${mode} ♻️ *Wallet Re-Enabled*`,
          "",
          `*Alias:* ${existing.alias}`,
          `*Address:* \`${existing.address.slice(0, 10)}…\``,
          `*Score:* ${existing.composite_score.toFixed(2)}`,
          `_Was disabled/probation — now active (observation\\_only). Degraded count reset._`,
        ].join("\n");
      }
      return `${mode} ⚠️ Wallet \`${address.slice(0, 10)}…\` is already tracked and active.`;
    }

    const wallet = await buildWalletFromActivity(address, "manual");
    if (alias) wallet.alias = alias;
    wallet.observation_only = true;

    wallets.push(wallet);
    await saveWhaleWatchlist(wallets);

    return [
      `${mode} ✅ *Wallet Added*`,
      "",
      `*Alias:* ${wallet.alias}`,
      `*Address:* \`${wallet.address.slice(0, 10)}…\``,
      `*Niche:* ${wallet.niche}`,
      `*Score:* ${wallet.composite_score.toFixed(2)}`,
      `*Win Rate:* ${(wallet.win_rate * 100).toFixed(0)}%`,
      `*Trades:* ${wallet.total_trades} | Markets: ${wallet.total_markets}`,
      "",
      `_Status: observation\\_only — will be promoted after first copy-trade scan cycle._`,
    ].join("\n");
  } catch (err) {
    return `${mode} ❌ Failed to add wallet: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleRemoveWalletCommand(args: string): Promise<string> {
  const mode = await getMode();
  const query = args.trim();

  if (!query) {
    return `${mode} ❌ Usage: /remove-wallet <address or alias>`;
  }

  try {
    const { getWhaleWatchlist, saveWhaleWatchlist } = await import("./polymarket.js");
    const wallets = await getWhaleWatchlist();
    const idx = wallets.findIndex(w =>
      w.address.toLowerCase() === query.toLowerCase() ||
      (w.alias || "").toLowerCase() === query.toLowerCase()
    );

    if (idx === -1) {
      return `${mode} ⚠️ No wallet found matching \`${query}\`.`;
    }

    const removed = wallets.splice(idx, 1)[0];
    await saveWhaleWatchlist(wallets);

    return [
      `${mode} 🗑️ *Wallet Removed*`,
      "",
      `*Alias:* ${removed.alias}`,
      `*Address:* \`${removed.address.slice(0, 10)}…\``,
      `*Was:* ${removed.enabled ? "enabled" : "disabled"} | Score: ${removed.composite_score.toFixed(2)}`,
      `_${wallets.length} wallets remaining in registry._`,
    ].join("\n");
  } catch (err) {
    return `${mode} ❌ Failed to remove wallet: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleBlacklistWalletCommand(args: string): Promise<string> {
  const mode = await getMode();
  const query = args.trim();

  if (!query) {
    return `${mode} ❌ Usage: /blacklist-wallet <address or alias>`;
  }

  try {
    const { getWhaleWatchlist, saveWhaleWatchlist, getBlacklist, saveBlacklist } = await import("./polymarket.js");
    const wallets = await getWhaleWatchlist();
    const idx = wallets.findIndex(w =>
      w.address.toLowerCase() === query.toLowerCase() ||
      (w.alias || "").toLowerCase() === query.toLowerCase()
    );

    let address: string;
    let aliasLabel: string;

    if (idx !== -1) {
      address = wallets[idx].address.toLowerCase();
      aliasLabel = wallets[idx].alias || address.slice(0, 10);
    } else if (/^0x[a-fA-F0-9]{40}$/i.test(query)) {
      address = query.toLowerCase();
      aliasLabel = `${address.slice(0, 10)}…`;
    } else {
      return `${mode} ⚠️ No wallet found matching \`${query}\`. Provide a valid address or alias.`;
    }

    const blacklist = await getBlacklist();
    if (blacklist.includes(address)) {
      return `${mode} ⚠️ \`${address.slice(0, 10)}…\` is already blacklisted.`;
    }

    if (idx !== -1) {
      wallets[idx].enabled = false;
      wallets[idx].status = "removed";
      await saveWhaleWatchlist(wallets);
    }

    blacklist.push(address);
    await saveBlacklist(blacklist);

    return [
      `${mode} 🚫 *Wallet Blacklisted*`,
      "",
      `*Alias:* ${aliasLabel}`,
      `*Address:* \`${address.slice(0, 10)}…\``,
      idx !== -1 ? `_Disabled in registry and added to blacklist._` : `_Added to blacklist (was not in registry)._`,
      `_Blacklist size: ${blacklist.length}_`,
    ].join("\n");
  } catch (err) {
    return `${mode} ❌ Failed to blacklist wallet: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function handleHelpCommand(): Promise<string> {
  const mode = await getMode();
  return [
    `${mode} *DarkNode Commands*`,
    "",
    "/status — System health & mode",
    "/portfolio — Open positions & P&L",
    "/intel — Latest SCOUT brief",
    "/scout — (redirects to /intel)",
    "/polymarket — Active PM theses",
    "/wallets — Tracked whale wallets",
    "/walletstatus — Wallet health & scores",
    "/copytrades — Copy trading dashboard",
    "/add-wallet — Add whale wallet to track",
    "/remove-wallet — Remove tracked wallet",
    "/blacklist-wallet — Blacklist a wallet",
    "/goal — View or set wealth goal target",
    "/seedwallets — Auto-discover whales",
    "/trades [n] — Last N trades (default 5)",
    "/risk — Risk dashboard",
    "/oversight — Oversight agent status",
    "/shadow — Shadow trading stats",
    "/tax — YTD tax summary",
    "/reset [capital] — Full portfolio reset (default $10K)",
    "/kill — Emergency kill switch",
    "/pause — Halt all Wealth Engine jobs",
    "/resume — Resume Wealth Engine jobs",
    "/public on|off — Toggle dashboard access",
    "/alerts — Bot connection status",
    "/notify [smart|immediate|digest] — Notification mode",
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
  chartUrl?: string;
}): Promise<"approve" | "skip" | "hold"> {
  const mode = await getMode();
  if (!isConfigured()) {
    console.warn("[telegram] Trade approval requested but Telegram not configured — auto-skipping");
    return "skip";
  }

  if (params.chartUrl) {
    try {
      await sendPhoto(params.chartUrl, `📊 ${params.asset} — Chart for trade approval`);
    } catch (err) {
      console.warn("[telegram] Failed to send chart with trade approval:", err instanceof Error ? err.message : err);
    }
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
  if (data === "pause_we") {
    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        ["wealth_engines_paused", true, Date.now()]
      );
      await answerCallbackQuery(callbackQueryId, "⏸ Wealth Engines PAUSED");
      await sendToChannel("trading", "⏸ <b>Wealth Engines PAUSED</b> via inline button", "HTML");
    } catch (err) {
      console.error("[telegram] pause_we callback error:", err);
      await answerCallbackQuery(callbackQueryId, "Failed to pause");
    }
    return;
  }

  if (data.startsWith("retire_thesis:")) {
    const thesisId = data.replace("retire_thesis:", "");
    try {
      const pool = getPool();
      const res = await pool.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
      if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
        const theses = res.rows[0].value.filter((t: any) => t.id !== thesisId);
        await pool.query(
          `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
          ["polymarket_scout_active_theses", JSON.stringify(theses), Date.now()]
        );
        await answerCallbackQuery(callbackQueryId, `🗑 Thesis retired`);
        await sendToChannel("trading", `🗑 Thesis <b>${escapeHtml(thesisId.slice(0, 30))}</b> retired via inline button`, "HTML");
      } else {
        await answerCallbackQuery(callbackQueryId, "No theses found");
      }
    } catch (err) {
      console.error("[telegram] retire_thesis callback error:", err);
      await answerCallbackQuery(callbackQueryId, "Failed to retire thesis");
    }
    return;
  }

  if (data === "view_pnl" || data === "view_dashboard") {
    await answerCallbackQuery(callbackQueryId, "Opening dashboard...");
    return;
  }

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
      const pmScoutRes = await pool.query(
        `SELECT created_at FROM job_history WHERE job_id IN ('polymarket-activity-scan','polymarket-full-cycle') ORDER BY created_at DESC LIMIT 1`
      );
      if (pmScoutRes.rows.length > 0) {
        const lastRun = new Date(pmScoutRes.rows[0].created_at).getTime();
        const hoursSince = (Date.now() - lastRun) / (3600 * 1000);
        if (hoursSince > 6) {
          const lastAlert = lastDeadManAlert["pm-scout"] || 0;
          if (Date.now() - lastAlert > 4 * 3600 * 1000) {
            lastDeadManAlert["pm-scout"] = Date.now();
            const fmt = await import("./telegram-format.js");
            const dmLines = [
              fmt.buildCategoryHeader(fmt.CATEGORY_BADGES.DEAD_MAN, "SCOUT Silent"),
              "",
              `Last run: ${Math.floor(hoursSince)}h ago (threshold: 6h)`,
              `Expected: Every 60min`,
              `Action: Check scheduled-jobs or restart`,
              "",
              `[/scout to trigger manually]`,
            ];
            await sendToChannel("mission-control", fmt.truncateToTelegramLimit(dmLines.join("\n")), "HTML");
          }
        } else {
          delete lastDeadManAlert["pm-scout"];
        }
      }
    } catch (err) {
      console.error("[telegram] Dead man switch PM SCOUT check failed:", err);
    }
  } else {
    delete lastDeadManAlert["pm-scout"];
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
          const fmtBm = await import("./telegram-format.js");
          const bmLines = [
            fmtBm.buildCategoryHeader(fmtBm.CATEGORY_BADGES.DEAD_MAN, "BANKR Monitor Silent"),
            "",
            `Last tick: ${Math.floor(minsSince)}min ago (threshold: 30min)`,
            `Action: Server may have restarted or crashed`,
          ];
          await sendToChannel("mission-control", fmtBm.truncateToTelegramLimit(bmLines.join("\n")), "HTML");
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
            const fmtBa = await import("./telegram-format.js");
            const baLines = [
              fmtBa.buildCategoryHeader(fmtBa.CATEGORY_BADGES.DEAD_MAN, "BANKR Silent"),
              "",
              `Last run: ${Math.floor(hoursSince)}h ago (threshold: 8h)`,
              `Action: Check scheduled-jobs or restart`,
            ];
            await sendToChannel("mission-control", fmtBa.truncateToTelegramLimit(baLines.join("\n")), "HTML");
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
  type: "executed" | "stopped" | "emergency" | "closed" | "flagged";
  asset: string;
  direction?: string;
  leverage?: string;
  entryPrice?: string;
  exitPrice?: string;
  pnl?: number;
  pnlPct?: number;
  reason?: string;
  openedAt?: string;
  closedAt?: string;
}): Promise<void> {
  const fmt = await import("./telegram-format.js");
  const mode = await getMode();
  const icons: Record<string, string> = {
    executed: "📈",
    stopped: "🛑",
    emergency: "🚨",
    closed: "✅",
    flagged: "⚠️",
  };
  const icon = icons[params.type] || "📊";

  const lines = [`${mode} ${icon} Trade ${params.type.toUpperCase()}`, ""];
  lines.push(`Asset: ${fmt.escapeHtml(params.asset)}`);
  if (params.direction) lines.push(`Direction: ${fmt.escapeHtml(params.direction)}`);
  if (params.leverage) lines.push(`Leverage: ${fmt.escapeHtml(params.leverage)}`);
  if (params.entryPrice) lines.push(`Entry: $${fmt.escapeHtml(params.entryPrice)}`);
  if (params.exitPrice) lines.push(`Exit: $${fmt.escapeHtml(params.exitPrice)}`);
  if (params.pnl != null) {
    lines.push(`PnL: ${fmt.formatPnl(params.pnl)}`);
  }
  if (params.pnlPct != null) {
    const sign = params.pnlPct >= 0 ? "+" : "";
    lines.push(`Return: ${sign}${params.pnlPct.toFixed(2)}%`);
  } else if (params.pnl != null && params.entryPrice) {
    const entry = parseFloat(params.entryPrice);
    if (entry > 0) {
      const pct = (params.pnl / entry) * 100;
      const sign = pct >= 0 ? "+" : "";
      lines.push(`Return: ${sign}${pct.toFixed(2)}%`);
    }
  }
  if (params.openedAt && params.closedAt) {
    const openMs = new Date(params.openedAt).getTime();
    const closeMs = new Date(params.closedAt).getTime();
    if (openMs > 0 && closeMs > openMs) {
      const holdMs = closeMs - openMs;
      const holdH = Math.floor(holdMs / 3600000);
      const holdM = Math.floor((holdMs % 3600000) / 60000);
      lines.push(`Hold: ${holdH}h ${holdM}m`);
    }
  }
  if (params.reason) lines.push(`Reason: ${fmt.escapeHtml(params.reason)}`);

  const tradeButtons = [
    [
      { text: "📊 Dashboard", url: "https://rickin.live/pages/wealth-engines" },
      { text: "⏸ Pause WE", callback_data: "pause_we" },
    ],
  ];
  await sendToChannelWithKeyboard("trading", lines.join("\n"), tradeButtons);
}

export async function sendScoutBrief(brief: string, chartUrls?: string[]): Promise<void> {
  const fmt = await import("./telegram-format.js");

  if (chartUrls && chartUrls.length > 0) {
    for (const url of chartUrls.slice(0, 3)) {
      try {
        await sendPhoto(url, `📊 SCOUT chart`);
      } catch (err) {
        console.warn("[telegram] Failed to send scout chart:", err instanceof Error ? err.message : err);
      }
    }
  }

  const header = fmt.buildCategoryHeader(fmt.CATEGORY_BADGES.SCOUT, "Full Cycle Complete");
  const escaped = fmt.escapeHtml(brief);
  const msg = `${header}\n\n${escaped}`;
  await sendToChannel("trading", fmt.truncateToTelegramLimit(msg), "HTML");
}

let lastPmNotifyHash = "";

interface DigestEvent {
  timestamp: number;
  jobId: string;
  jobName: string;
  status: string;
  detail: string;
}
const digestQueue: DigestEvent[] = [];
let digestFlushInterval: ReturnType<typeof setInterval> | null = null;

async function flushDigestQueue(): Promise<void> {
  if (digestQueue.length === 0) return;
  if (!isConfigured()) { digestQueue.length = 0; return; }

  const fmt = await import("./telegram-format.js");
  const events = digestQueue.splice(0, digestQueue.length);

  const grouped: Record<string, DigestEvent[]> = {};
  for (const e of events) {
    const key = e.jobId.split("-")[0];
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(e);
  }

  const groupIcons: Record<string, string> = {
    scout: "🔍", polymarket: "🎰", bankr: "💰",
    oversight: "🛡️",
  };

  const lines = [
    fmt.buildCategoryHeader(fmt.CATEGORY_BADGES.DAILY_BRIEF, "Digest"),
    "",
  ];

  for (const [group, evts] of Object.entries(grouped)) {
    const icon = groupIcons[group] || "⚙️";
    const successes = evts.filter(e => e.status !== "error").length;
    const errors = evts.filter(e => e.status === "error").length;
    lines.push(`${icon} ${fmt.escapeHtml(evts[0].jobName)} — ${successes} run(s)${errors > 0 ? `, ${errors} error(s)` : ""}`);
    const lastEvent = evts[evts.length - 1];
    if (lastEvent.detail) lines.push(`  ${fmt.escapeHtml(lastEvent.detail)}`);
  }

  lines.push("");
  lines.push(`${events.length} events over last 4h`);
  lines.push(fmt.formatETTime());

  await sendToChannel("mission-control", fmt.truncateToTelegramLimit(lines.join("\n")), "HTML");
  console.log(`[telegram] Digest flushed: ${events.length} events`);
}

export async function sendJobCompletionNotification(params: {
  jobId: string;
  jobName: string;
  status: "success" | "partial" | "error";
  summary: string;
  durationMs?: number;
}): Promise<void> {
  if (!isConfigured()) return;
  const pool = getPool();
  const fmt = await import("./telegram-format.js");

  const notifyMode = await getNotificationMode();

  const weJobIds = new Set([
    "polymarket-activity-scan", "polymarket-full-cycle",
    "bankr-execute", "oversight-health", "oversight-weekly",
    "oversight-daily-summary", "oversight-shadow-refresh",
    "prediction-markets-daily",
  ]);
  if (!weJobIds.has(params.jobId)) return;

  if (params.status === "error") {
    const errSnippet = fmt.escapeHtml(params.summary.slice(0, 300));
    const lines = [
      `❌ JOB FAILED · ${fmt.escapeHtml(params.jobName)}`,
      "",
      errSnippet,
      "",
      fmt.formatETTime(),
    ];
    await sendToChannel("mission-control", fmt.truncateToTelegramLimit(lines.join("\n")), "HTML");
    return;
  }

  if (notifyMode === "smart") {
    if (params.jobId === "polymarket-activity-scan") {
      try {
        const res = await pool.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
        if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
          const active = res.rows[0].value.filter((t: any) => t.status === "active");
          const fingerprint = active.map((t: any) => `${(t.asset || "").slice(0, 30)}:${t.direction}:${t.confidence || "?"}`).sort().join("|");
          const hash = `pm_${fingerprint}`;
          if (hash === lastPmNotifyHash) return;
          lastPmNotifyHash = hash;
        }
      } catch {}
    }
  }

  const durationStr = params.durationMs ? `${Math.round(params.durationMs / 1000)}s` : "";
  const statusIcon = params.status === "partial" ? "⚠️" : "✅";

  let detailLines: string[] = [];
  try {
    if (params.jobId.startsWith("polymarket-")) {
      const res = await pool.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
      if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
        const now = Date.now();
        const active = res.rows[0].value.filter((t: any) => t.status === "active");
        const newTheses = active.filter((t: any) => t.created_at && (now - t.created_at) < 3600000);
        detailLines.push(`PM Theses: ${active.length} active${newTheses.length > 0 ? ` (${newTheses.length} new)` : ""}`);
        for (const t of active.slice(0, 3)) {
          const odds = t.current_odds != null ? `${(t.current_odds * 100).toFixed(0)}%` : "";
          const whales = t.whale_consensus ? `whales=${t.whale_consensus}` : "";
          const parts = [fmt.escapeHtml((t.asset || "").slice(0, 40)), t.direction, odds, whales].filter(Boolean);
          detailLines.push(`  • ${parts.join(" | ")}`);
        }
      }
    } else if (params.jobId === "bankr-execute") {
      detailLines.push(fmt.escapeHtml(params.summary.slice(0, 200)));
    } else if (params.jobId === "oversight-health") {
      const res = await pool.query(`SELECT value FROM app_config WHERE key = 'oversight_health_reports'`);
      if (res.rows.length > 0 && Array.isArray(res.rows[0].value) && res.rows[0].value.length > 0) {
        const latest = res.rows[0].value[res.rows[0].value.length - 1];
        const icons2: Record<string, string> = { healthy: "🟢", degraded: "🟡", critical: "🔴" };
        detailLines.push(`${icons2[latest.overall_status] || "⚪"} ${latest.overall_status}: ${fmt.escapeHtml(latest.summary || "")}`);
      }
    }
  } catch {}

  if (notifyMode === "digest") {
    digestQueue.push({
      timestamp: Date.now(),
      jobId: params.jobId,
      jobName: params.jobName,
      status: params.status,
      detail: detailLines.join(" | ").slice(0, 200),
    });
    return;
  }

  const jobBadge = params.jobId.startsWith("polymarket-") ? fmt.CATEGORY_BADGES.SCOUT
    : params.jobId === "bankr-execute" ? fmt.CATEGORY_BADGES.COPY_TRADE
    : params.jobId.startsWith("oversight-") ? fmt.CATEGORY_BADGES.OVERSIGHT
    : "✅ JOB COMPLETE";

  const lines = [
    fmt.buildCategoryHeader(jobBadge, `${statusIcon} ${fmt.escapeHtml(params.jobName)}`),
    "",
    `Duration: ${durationStr}`,
  ];
  if (detailLines.length > 0) {
    lines.push(...detailLines);
  }

  await sendToChannel("trading", fmt.truncateToTelegramLimit(lines.join("\n")), "HTML");
}

export async function sendShadowTradeNotification(params: {
  type: "open" | "close";
  asset: string;
  direction: string;
  entryPrice: number;
  exitPrice?: number;
  pnl?: number;
  reason?: string;
  source?: string;
  openedAt?: number;
  closedAt?: number;
  niche?: string;
}): Promise<void> {
  if (!isConfigured()) return;
  const fmt = await import("./telegram-format.js");
  const niche = params.niche || "general";

  if (params.type === "open") {
    const marketBadge = fmt.getMarketBadge(niche);
    const assetText = fmt.escapeHtml(params.asset.slice(0, 80));
    const lines = [
      fmt.buildCategoryHeader(fmt.CATEGORY_BADGES.SHADOW_BOOK, "Opening"),
      "",
      `${marketBadge} · "${assetText}"`,
      `Direction: ${params.direction} · Entry: $${params.entryPrice.toFixed(4)}`,
      `Thesis: Shadow tracking — below execution threshold`,
      "",
      `🎲 "Watching from the sidelines... for now."`,
    ];
    const openButtons = [
      [
        { text: "📊 Dashboard", url: "https://rickin.live/pages/wealth-engines" },
        { text: "🗑 Retire Thesis", callback_data: `retire_thesis:${params.asset.slice(0, 40)}` },
      ],
    ];
    await sendToChannelWithKeyboard("trading", fmt.truncateToTelegramLimit(lines.join("\n")), openButtons);
  } else {
    const isWin = (params.pnl ?? 0) > 0;
    const statusIcon = isWin ? "✅" : "❌";
    const pnlStr = params.pnl != null ? fmt.formatPnl(params.pnl) : "N/A";

    let pctReturn = "";
    if (params.pnl != null && params.entryPrice > 0) {
      const pct = (params.pnl / params.entryPrice) * 100;
      pctReturn = fmt.formatPct(pct);
    }

    let holdDuration = "";
    if (params.openedAt && params.closedAt) {
      const diffMs = params.closedAt - params.openedAt;
      const totalMins = Math.floor(diffMs / 60000);
      const hours = Math.floor(totalMins / 60);
      const days = Math.floor(hours / 24);
      const remainHours = hours % 24;
      const mins = totalMins % 60;
      if (days > 0) holdDuration = `${days}d ${remainHours}h`;
      else if (hours > 0) holdDuration = `${hours}h ${mins}m`;
      else holdDuration = `${mins}m`;
    }

    const streak = await updateShadowStreak(isWin, params.pnl ?? 0);
    const streakText = fmt.buildStreakText(streak.currentStreak, streak.streakType);

    const marketBadge = fmt.getMarketBadge(niche);
    const assetText = fmt.escapeHtml(params.asset.slice(0, 80));

    const lines = [
      fmt.buildCategoryHeader(fmt.CATEGORY_BADGES.SHADOW_BOOK, `Closed ${statusIcon}`),
      "",
      `${marketBadge} · "${assetText}"`,
      `${params.direction} · Entry: $${params.entryPrice.toFixed(4)}${params.exitPrice != null ? ` → Exit: $${params.exitPrice.toFixed(4)}` : ""}`,
      `P&L: ${pnlStr}${pctReturn ? ` (${pctReturn})` : ""}${holdDuration ? ` | Held: ${holdDuration}` : ""}`,
    ];
    if (params.reason) lines.push(`Reason: ${fmt.escapeHtml(params.reason)}`);

    if (streakText) {
      lines.push("");
      lines.push(streakText);
    }

    let runningLine = "";
    try {
      const pool = getPool();
      const res = await pool.query(`SELECT value FROM app_config WHERE key = 'oversight_shadow_trades'`);
      if (res.rows.length > 0 && Array.isArray(res.rows[0].value)) {
        const allTrades = res.rows[0].value;
        const closed = allTrades.filter((t: any) => t.status === "closed");
        const wins = closed.filter((t: any) => (t.hypothetical_pnl || 0) > 0).length;
        const losses = closed.length - wins;
        const cumPnl = closed.reduce((s: number, t: any) => s + (t.hypothetical_pnl || 0), 0);
        runningLine = `Shadow Running Total: ${fmt.formatPnl(cumPnl)} | W:${wins} L:${losses}`;
      }
    } catch {}
    if (runningLine) {
      lines.push(fmt.SEPARATOR);
      lines.push(runningLine);
    }

    const closeButtons = [
      [
        { text: "📊 Dashboard", url: "https://rickin.live/pages/wealth-engines" },
        { text: "📈 View P&L", callback_data: "view_pnl" },
      ],
    ];
    await sendToChannelWithKeyboard("trading", fmt.truncateToTelegramLimit(lines.join("\n")), closeButtons);
  }
}

interface ShadowStreak {
  currentStreak: number;
  streakType: "W" | "L";
  longestStreak: number;
  weeklyWins: number;
  weeklyLosses: number;
  weeklyPnl: number;
  weekResetDate: string;
}

async function updateShadowStreak(isWin: boolean, pnl: number): Promise<ShadowStreak> {
  const pool = getPool();
  let streak: ShadowStreak = {
    currentStreak: 0,
    streakType: "W",
    longestStreak: 0,
    weeklyWins: 0,
    weeklyLosses: 0,
    weeklyPnl: 0,
    weekResetDate: getNextMonday(),
  };

  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'shadow_streak'`);
    if (res.rows.length > 0 && res.rows[0].value) {
      streak = { ...streak, ...res.rows[0].value };
    }
  } catch {}

  const nowET = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
  const resetDate = new Date(streak.weekResetDate);
  const now = new Date(nowET);
  if (now >= resetDate) {
    streak.weeklyWins = 0;
    streak.weeklyLosses = 0;
    streak.weeklyPnl = 0;
    streak.weekResetDate = getNextMonday();
  }

  const newType: "W" | "L" = isWin ? "W" : "L";
  if (newType === streak.streakType) {
    streak.currentStreak++;
  } else {
    streak.streakType = newType;
    streak.currentStreak = 1;
  }
  if (streak.currentStreak > streak.longestStreak) {
    streak.longestStreak = streak.currentStreak;
  }

  if (isWin) streak.weeklyWins++;
  else streak.weeklyLosses++;
  streak.weeklyPnl += pnl;

  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('shadow_streak', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(streak), Date.now()]
    );
  } catch {}

  return streak;
}

function getNextMonday(): string {
  const now = new Date();
  const day = now.getDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilMonday);
  return next.toISOString().slice(0, 10);
}

async function getNotificationMode(): Promise<"smart" | "immediate" | "digest"> {
  try {
    const pool = getPool();
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'we_notification_mode'`);
    if (res.rows.length > 0) {
      const v = res.rows[0].value;
      if (v === "immediate" || v === "digest") return v;
    }
  } catch {}
  return "smart";
}

async function handleNotifyCommand(args: string): Promise<string> {
  const mode = await getMode();
  const pool = getPool();
  const val = args.trim().toLowerCase();
  const validModes = ["smart", "immediate", "digest"];

  if (!validModes.includes(val)) {
    const current = await getNotificationMode();
    return [
      `${mode} *Notification Mode:* ${current}`,
      "",
      `*smart* — Only notify on material changes (new thesis, regime shift)`,
      `*immediate* — Notify on every job completion`,
      `*digest* — Queue events, send batched summary periodically`,
      "",
      `Usage: /notify smart | /notify immediate | /notify digest`,
    ].join("\n");
  }

  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('we_notification_mode', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(val), Date.now()]
    );

    if (val === "digest" && !digestFlushInterval) {
      digestFlushInterval = setInterval(() => {
        flushDigestQueue().catch(err => console.error("[telegram] Digest flush error:", err));
      }, 4 * 60 * 60 * 1000);
    } else if (val !== "digest" && digestFlushInterval) {
      clearInterval(digestFlushInterval);
      digestFlushInterval = null;
      if (digestQueue.length > 0) {
        flushDigestQueue().catch(() => {});
      }
    }

    return `${mode} ✅ Notification mode set to *${val}*`;
  } catch (err) {
    return `${mode} ❌ Failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}


export async function sendDarkNodeSummary(): Promise<void> {
  if (!isConfigured()) return;
  const pool = getPool();
  const fmt = await import("./telegram-format.js");

  let portfolioValue = 1000;
  let pmThesisCount = 0;
  let copyTradeCount = 0;
  let shadowOpen = 0;
  let shadowWins = 0;
  let shadowLosses = 0;
  let shadowPnl = 0;
  let todayPnl = 0;
  let todayWins = 0;
  let todayLosses = 0;
  let healthStatus = "unknown";
  let healthIcon = "⚪";
  let paused = false;
  let killSwitch = false;
  let weeklyPnlPct = 0;
  let goalTarget = 50000;
  let fgValue = "N/A";
  let fgClass = "";

  try {
    const configRes = await pool.query(
      `SELECT key, value FROM app_config WHERE key IN ('wealth_engines_portfolio_value', 'polymarket_scout_active_theses', 'oversight_shadow_trades', 'oversight_health_reports', 'wealth_engines_paused', 'wealth_engines_kill_switch', 'shadow_streak', 'wealth_goal', 'fear_greed_index')`
    );
    const cm: Record<string, any> = {};
    for (const row of configRes.rows) cm[row.key] = row.value;

    if (typeof cm['wealth_engines_portfolio_value'] === "number") portfolioValue = cm['wealth_engines_portfolio_value'];
    paused = cm['wealth_engines_paused'] === true;
    killSwitch = cm['wealth_engines_kill_switch'] === true;

    if (cm['wealth_goal'] && typeof cm['wealth_goal'].target === "number") {
      goalTarget = cm['wealth_goal'].target;
    }

    if (cm['fear_greed_index'] && typeof cm['fear_greed_index'].value === "number") {
      fgValue = String(cm['fear_greed_index'].value);
      const v = cm['fear_greed_index'].value;
      if (v <= 25) fgClass = "🔴 Extreme Fear";
      else if (v <= 40) fgClass = "🟠 Fear";
      else if (v <= 60) fgClass = "🟡 Neutral";
      else if (v <= 75) fgClass = "🟢 Greed";
      else fgClass = "🟢 Extreme Greed";
    }

    if (Array.isArray(cm['polymarket_scout_active_theses'])) {
      const active = cm['polymarket_scout_active_theses'].filter((t: any) => t.status === "active");
      pmThesisCount = active.length;
      copyTradeCount = active.filter((t: any) => t.source === "copy_trade" || t.is_copy_trade).length;
    }

    const shadowTrades = cm['oversight_shadow_trades'];
    if (Array.isArray(shadowTrades)) {
      const open = shadowTrades.filter((t: any) => t.status === "open");
      const closed = shadowTrades.filter((t: any) => t.status === "closed");
      shadowOpen = open.length;
      shadowWins = closed.filter((t: any) => (t.hypothetical_pnl || 0) > 0).length;
      shadowLosses = closed.length - shadowWins;
      shadowPnl = closed.reduce((s: number, t: any) => s + (t.hypothetical_pnl || 0), 0)
        + open.reduce((s: number, t: any) => s + (t.hypothetical_pnl || 0), 0);

      const nowETStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
      const todayET = new Date(nowETStr);
      todayET.setHours(0, 0, 0, 0);
      const todayMs = todayET.getTime();
      const todayClosed = closed.filter((t: any) => (t.closed_at || 0) >= todayMs);
      todayWins = todayClosed.filter((t: any) => (t.hypothetical_pnl || 0) > 0).length;
      todayLosses = todayClosed.length - todayWins;
      todayPnl = todayClosed.reduce((s: number, t: any) => s + (t.hypothetical_pnl || 0), 0);
    }

    if (cm['shadow_streak'] && typeof cm['shadow_streak'].weeklyPnl === "number") {
      weeklyPnlPct = portfolioValue > 0 ? (cm['shadow_streak'].weeklyPnl / portfolioValue) * 100 : 0;
    }

    const healthReports = cm['oversight_health_reports'];
    if (Array.isArray(healthReports) && healthReports.length > 0) {
      const latest = healthReports[healthReports.length - 1];
      healthStatus = latest.overall_status || "unknown";
      healthIcon = ({ healthy: "🟢", degraded: "🟡", critical: "🔴" } as Record<string, string>)[healthStatus] || "⚪";
    }
  } catch {}

  let pmScoutLastRun = "never";
  let activeJobCount = 0;
  try {
    const jobRes = await pool.query(
      `SELECT created_at FROM job_history WHERE job_id IN ('polymarket-activity-scan','polymarket-full-cycle') ORDER BY created_at DESC LIMIT 1`
    );
    if (jobRes.rows.length > 0) {
      pmScoutLastRun = timeAgo(new Date(jobRes.rows[0].created_at).getTime());
    }
    const countRes = await pool.query(`SELECT COUNT(*) as c FROM job_history WHERE created_at > NOW() - INTERVAL '24 hours'`);
    activeJobCount = parseInt(countRes.rows[0]?.c || "0");
  } catch {}

  const alerts: string[] = [];
  if (killSwitch) alerts.push("🚨 Kill switch ACTIVE");
  if (paused) alerts.push("⏸️ System PAUSED");

  const mood = fmt.buildMoodIndicator(weeklyPnlPct);
  const goalBar = fmt.buildProgressBar(portfolioValue, goalTarget, 10);
  const goalPct = goalTarget > 0 ? ((portfolioValue / goalTarget) * 100).toFixed(1) : "0";
  const etTime = fmt.formatETTime();

  const thesisLine = copyTradeCount > 0
    ? `  ⚡ ${copyTradeCount} copy trade${copyTradeCount > 1 ? "s" : ""} | 👻 ${shadowOpen} shadow`
    : `  👻 ${shadowOpen} shadow`;

  const lines = [
    fmt.buildCategoryHeader(fmt.CATEGORY_BADGES.DAILY_BRIEF, etTime),
    `${mood} · ${fmt.formatPct(weeklyPnlPct)} this week`,
    "",
    fmt.SEPARATOR,
    `💰 Portfolio`,
    `  $${portfolioValue.toFixed(2)} · Shadow Mode`,
    `  P&L today: ${fmt.formatPnl(todayPnl)} | W:${todayWins} L:${todayLosses}`,
    "",
    `🎯 $${(goalTarget / 1000).toFixed(0)}K Goal`,
    `  ${goalBar}  $${Math.floor(portfolioValue).toLocaleString()} / $${goalTarget.toLocaleString()} (${goalPct}%)`,
    "",
    fmt.SEPARATOR,
    `🧠 Active Theses: ${pmThesisCount}`,
    thesisLine,
    "",
    `😱 Fear & Greed: ${fgValue}${fgClass ? ` ${fgClass}` : ""}`,
    `🤖 System: ${healthIcon} ${healthStatus}${paused ? " (PAUSED)" : ""} | ${activeJobCount} jobs (24h)`,
    `🔍 Last Scan: ${pmScoutLastRun}`,
    "",
    fmt.SEPARATOR,
    `⚠️ Alerts: ${alerts.length > 0 ? alerts.join(" · ") : "None"}`,
  ];

  await sendToChannel("trading", fmt.truncateToTelegramLimit(lines.join("\n")), "HTML");
  console.log("[telegram] DarkNode summary sent");
}

let webhookMode = false;

async function registerWebhook(): Promise<boolean> {
  const domain = process.env.TELEGRAM_WEBHOOK_DOMAIN || "rickin.live";
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

let personalContextCache: string | null = null;
let personalContextLastSync = 0;
const PERSONAL_CONTEXT_SYNC_INTERVAL = 6 * 60 * 60 * 1000;

function isAuthorizedUser(userId: number | string, username?: string): boolean {
  if (RICKIN_TELEGRAM_IDS.has(String(userId))) return true;
  if (username && RICKIN_TELEGRAM_IDS.has(username.toLowerCase())) return true;
  return false;
}

async function getPersonalContext(): Promise<string> {
  const now = Date.now();
  if (personalContextCache && (now - personalContextLastSync) < PERSONAL_CONTEXT_SYNC_INTERVAL) {
    return personalContextCache;
  }
  try {
    const pool = getPool();
    const result = await pool.query("SELECT content FROM personal_context WHERE id = 1");
    if (result.rows.length > 0) {
      personalContextCache = result.rows[0].content;
      personalContextLastSync = now;
      return personalContextCache;
    }
  } catch {}
  try {
    const fs = await import("fs");
    const path = "data/vault/About Me/Telegram Context.md";
    if (fs.existsSync(path)) {
      personalContextCache = fs.readFileSync(path, "utf-8");
      personalContextLastSync = now;
      return personalContextCache;
    }
  } catch {}
  return "";
}

export async function syncPersonalContext(): Promise<boolean> {
  try {
    const fs = await import("fs");
    const path = "data/vault/About Me/Telegram Context.md";
    if (!fs.existsSync(path)) return false;
    const content = fs.readFileSync(path, "utf-8");
    const pool = getPool();
    await pool.query(
      `INSERT INTO personal_context (id, content, updated_at) VALUES (1, $1, NOW())
       ON CONFLICT (id) DO UPDATE SET content = $1, updated_at = NOW()`,
      [content]
    );
    personalContextCache = content;
    personalContextLastSync = Date.now();
    console.log(`[telegram] Personal context synced (${content.length} chars)`);
    return true;
  } catch (err) {
    console.error("[telegram] Personal context sync failed:", err);
    return false;
  }
}

async function getConversationHistory(chatId: string): Promise<Array<{ role: string; content: string }>> {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT role, content FROM telegram_conversation_history
       WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [chatId]
    );
    return result.rows.reverse();
  } catch {
    return [];
  }
}

async function addConversationMessage(chatId: string, role: string, content: string): Promise<void> {
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO telegram_conversation_history (chat_id, role, content) VALUES ($1, $2, $3)`,
      [chatId, role, content]
    );
    await pool.query(
      `DELETE FROM telegram_conversation_history
       WHERE chat_id = $1 AND id NOT IN (
         SELECT id FROM telegram_conversation_history WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 100
       )`,
      [chatId]
    );
  } catch (err) {
    console.error("[telegram] Failed to save conversation message:", err);
  }
}

function cleanAgentResponse(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(/^\*\*DARKNODE RESPONSE\*\*\s*/i, "");
  cleaned = cleaned.replace(/\n*System status unchanged\.?\s*$/i, "");
  cleaned = cleaned.replace(/^\*\*DarkNode:\*\*\s*/i, "");
  return cleaned.trim();
}

async function replyToChat(chatId: string, text: string): Promise<void> {
  try {
    await tgFetch("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.warn("[telegram] replyToChat HTML failed, retrying plain text:", err instanceof Error ? err.message : err);
    try {
      await tgFetch("sendMessage", {
        chat_id: chatId,
        text: text.replace(/<[^>]*>/g, ""),
        disable_web_page_preview: true,
      });
    } catch (err2) {
      console.error("[telegram] replyToChat plain text also failed:", err2 instanceof Error ? err2.message : err2);
    }
  }
}

async function handleTwoWayChat(userId: string, chatId: string, text: string): Promise<void> {
  try {
    const { getRunAgent } = await import("./scheduled-jobs.js");
    const runAgent = getRunAgent();
    if (!runAgent) {
      await replyToChat(chatId, "⚠️ Agent system not ready — try again in a moment.");
      return;
    }

    await addConversationMessage(chatId, "user", text);
    const history = await getConversationHistory(chatId);
    const personalContext = await getPersonalContext();

    let historyPrompt = "";
    if (history.length > 1) {
      const pastMessages = history.slice(0, -1).map(m =>
        `${m.role === "user" ? "Rickin" : "DarkNode"}: ${m.content}`
      ).join("\n");
      historyPrompt = `Recent conversation:\n${pastMessages}\n\n`;
    }

    let contextBlock = "";
    if (personalContext) {
      contextBlock = `---\nPERSONAL CONTEXT:\n${personalContext}\n---\n\n`;
    }

    const prompt = `${contextBlock}${historyPrompt}Rickin says via Telegram: "${text}"\n\nRespond concisely (max 500 chars). You are DarkNode, Rickin's autonomous AI system. Answer questions, run commands, provide status. Keep it conversational and direct. Do NOT prefix with "DARKNODE RESPONSE" or add "System status unchanged" footers. IMPORTANT: Do NOT use the telegram_send tool — just return your response as text. The reply will be routed back to Rickin's chat automatically.`;

    console.log(`[WEBHOOK] Step 4 — Calling oversight agent for userId=${userId} chatId=${chatId} text="${text.slice(0, 50)}" history=${history.length} contextLen=${personalContext.length}`);
    const result = await runAgent("oversight", prompt);
    const response = result.response || "I couldn't process that — try again.";
    console.log(`[WEBHOOK] Step 4 — Agent returned ${response.length} chars`);

    const cleanResponse = cleanAgentResponse(response).slice(0, 4000);
    await addConversationMessage(chatId, "assistant", cleanResponse);

    console.log(`[WEBHOOK] Step 5 — Sending reply to chatId=${chatId} (${cleanResponse.length} chars)`);
    await replyToChat(chatId, cleanResponse);
    console.log(`[WEBHOOK] Step 5 — replyToChat completed`);
  } catch (err) {
    console.error("[telegram] Two-way chat error:", err);
    await replyToChat(chatId, "⚠️ Error processing your message. Try again.");
  }
}

export async function handleWebhookUpdate(update: any): Promise<void> {
  if (!isConfigured()) {
    console.log("[WEBHOOK] Step 3 — BLOCKED: bot not configured (no token/chat_id)");
    return;
  }

  if (update.callback_query) {
    const cbq = update.callback_query;
    const cbqUserId = cbq.from?.id;
    const cbqUsername = cbq.from?.username;
    if (!isAuthorizedUser(cbqUserId, cbqUsername)) {
      console.log(`[telegram] Ignoring callback from unauthorized user: ${cbqUserId} (@${cbqUsername || "unknown"})`);
      await answerCallbackQuery(cbq.id, "Unauthorized");
      return;
    }
    await handleCallbackQuery(cbq.id, cbq.data || "");
    return;
  }

  if (!update.message?.text) {
    console.log("[WEBHOOK] Step 3 — No message.text in update, ignoring. Keys:", Object.keys(update));
    return;
  }

  const msg = update.message;
  const userId = msg.from?.id;
  const username = msg.from?.username;
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();

  console.log(`[WEBHOOK] Step 3 — Parsed: userId=${userId} username=${username} chatId=${chatId} text="${text.slice(0, 80)}"`);
  console.log(`[WEBHOOK] Step 3 — Auth check: RICKIN_TELEGRAM_ID env="${process.env.RICKIN_TELEGRAM_ID}" allowlist=[${[...RICKIN_TELEGRAM_IDS].join(",")}]`);

  if (!isAuthorizedUser(userId, username)) {
    console.log(`[WEBHOOK] Step 3 — BLOCKED: unauthorized user ${userId} (@${username || "unknown"}) not in [${[...RICKIN_TELEGRAM_IDS].join(",")}]`);
    return;
  }
  console.log(`[WEBHOOK] Step 3 — Auth PASSED for userId=${userId}`);

  if (text.startsWith("/")) {
    if (chatId !== CHAT_ID) return;
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
    return;
  }

  await handleTwoWayChat(String(userId), chatId, text);
}

async function handleResearchCommand(_args: string): Promise<string> {
  const mode = await getMode();
  return `${mode} ❌ Autoresearch has been removed — DarkNode is now prediction-markets only.`;
}

export async function init(): Promise<void> {
  if (!BOT_TOKEN) {
    console.warn("[telegram] TG_BOT_TOKEN not set — Telegram bot disabled");
    return;
  }
  if (!CHAT_ID) {
    console.warn("[telegram] TG_CHANNEL_DIRECT not set — Telegram bot disabled");
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
  registerCommand("reset", async (args) => handleResetCommand(args));
  registerCommand("kill", async () => handleKillCommand());
  registerCommand("risk", async () => handleRiskCommand());
  registerCommand("polymarket", async () => handlePolymarketCommand());
  registerCommand("tax", async () => handleTaxCommand());
  registerCommand("oversight", async () => handleOversightCommand());
  registerCommand("shadow", async () => handleShadowCommand());
  registerCommand("research", async (args) => handleResearchCommand(args));
  registerCommand("alerts", async () => handleAlertsCommand());
  registerCommand("notify", async (args) => handleNotifyCommand(args));
  registerCommand("wallets", async () => handleWalletsCommand());
  registerCommand("copytrades", async () => handleCopytradesCommand());
  registerCommand("walletstatus", async () => handleWalletStatusCommand());
  registerCommand("seedwallets", async () => handleSeedWalletsCommand());
  registerCommand("addwallet", async (args) => handleAddWalletCommand(args));
  registerCommand("add-wallet", async (args) => handleAddWalletCommand(args));
  registerCommand("removewallet", async (args) => handleRemoveWalletCommand(args));
  registerCommand("remove-wallet", async (args) => handleRemoveWalletCommand(args));
  registerCommand("blacklistwallet", async (args) => handleBlacklistWalletCommand(args));
  registerCommand("blacklist-wallet", async (args) => handleBlacklistWalletCommand(args));
  registerCommand("goal", async (args) => handleGoalCommand(args));
  registerCommand("help", async () => handleHelpCommand());

  try {
    const me = await tgFetch("getMe");
    console.log(`[telegram] Bot connected: @${me.result?.username || "unknown"}`);
  } catch (err) {
    console.error("[telegram] Failed to connect:", err instanceof Error ? err.message : err);
    return;
  }

  const configuredChannels = VALID_CHANNELS.filter(ch => CHANNEL_MAP[ch]);
  console.log(`[telegram] ${configuredChannels.length}/12 channels configured: ${configuredChannels.join(", ")}`);

  webhookMode = await registerWebhook();
  if (!webhookMode) {
    await deleteWebhook();
    pollingActive = true;
    pollUpdates();
    console.log("[telegram] initialized (long-polling fallback, dead man switches every 4h)");
  } else {
    console.log("[telegram] initialized (webhook mode, dead man switches every 4h)");
  }

  deadManInterval = setInterval(() => {
    checkDeadManSwitches().catch(err => console.error("[telegram] Dead man check error:", err));
  }, 4 * 60 * 60 * 1000);


  const notifyMode = await getNotificationMode();
  if (notifyMode === "digest") {
    digestFlushInterval = setInterval(() => {
      flushDigestQueue().catch(err => console.error("[telegram] Digest flush error:", err));
    }, 4 * 60 * 60 * 1000);
    console.log("[telegram] Digest mode active — events queued, flushed every 4h");
  }
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
  if (digestFlushInterval) {
    clearInterval(digestFlushInterval);
    digestFlushInterval = null;
  }
  console.log("[telegram] stopped");
}

const DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;
const notificationFingerprints = new Map<string, number>();

function getNotificationFingerprint(event: { type: string; alertType?: string; title?: string; content: string }): string {
  const key = `${event.type}:${event.alertType || ""}:${event.title || ""}:${event.content.slice(0, 100)}`;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  }
  return String(hash);
}

function isDuplicateNotification(fingerprint: string): boolean {
  const now = Date.now();
  const lastSent = notificationFingerprints.get(fingerprint);
  if (lastSent && (now - lastSent) < DEDUP_WINDOW_MS) return true;
  notificationFingerprints.set(fingerprint, now);
  for (const [fp, ts] of notificationFingerprints) {
    if (now - ts > DEDUP_WINDOW_MS) notificationFingerprints.delete(fp);
  }
  return false;
}

function getPriorityTag(alertType: string, content: string): { tag: string; priority: string } {
  const c = content.toLowerCase();
  if (alertType === "calendar") return { tag: "📅", priority: "FYI" };
  if (alertType === "stock") return { tag: "📊", priority: c.includes("down") || c.includes("▼") ? "Action needed" : "FYI" };
  if (alertType === "task") return { tag: "🔴", priority: "Action needed" };
  if (alertType === "email") {
    if (/flight|booking|confirmation|itinerary/i.test(c)) return { tag: "✈️", priority: "Travel" };
    if (/card|amex|visa|billing|payment|statement|bank|invoice/i.test(c)) return { tag: "💰", priority: "Financial" };
    if (/shipped|delivered|tracking|order/i.test(c)) return { tag: "📦", priority: "FYI" };
    if (/urgent|asap|action required|action needed/i.test(c)) return { tag: "🔴", priority: "Action needed" };
    return { tag: "📧", priority: "FYI" };
  }
  return { tag: "🔔", priority: "FYI" };
}

export async function sendMorningPack(): Promise<void> {
  if (!isConfigured()) return;
  const fmt = await import("./telegram-format.js");
  const pool = getPool();

  const dateStr = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  });

  let btcLine = "₿ BTC  Data unavailable";
  let marketsLine = "📈 Markets  Data unavailable";
  let aiLine = "🤖 AI  Check #ai-tech";
  let newsLine = "📰 News  Check #news";
  let intelLine = "🐦 X  Check #intel";

  try {
    const fgRes = await pool.query(`SELECT value FROM app_config WHERE key = 'fear_greed_index'`);
    if (fgRes.rows.length > 0) {
      const fg = fgRes.rows[0].value;
      const fgValue = typeof fg === "object" ? fg.value : fg;
      const fgClass = typeof fg === "object" ? fg.classification : "";
      btcLine = `₿ BTC  Fear & Greed: ${fgValue}${fgClass ? ` ${fgClass}` : ""}`;
    }
  } catch {}

  try {
    const thesesRes = await pool.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
    if (thesesRes.rows.length > 0 && Array.isArray(thesesRes.rows[0].value)) {
      const count = thesesRes.rows[0].value.length;
      const topThesis = thesesRes.rows[0].value[0];
      marketsLine = `📈 Markets  ${count} active theses${topThesis ? ` · Latest: ${String(topThesis.question || topThesis.asset || "").slice(0, 40)}` : ""}`;
    }
  } catch {}

  try {
    const jhRes = await pool.query(`SELECT summary FROM job_history WHERE job_id LIKE '%ai-tech%' ORDER BY created_at DESC LIMIT 1`);
    if (jhRes.rows.length > 0 && jhRes.rows[0].summary) {
      aiLine = `🤖 AI  ${jhRes.rows[0].summary.slice(0, 60)}`;
    }
  } catch {}

  try {
    const jhRes = await pool.query(`SELECT summary FROM job_history WHERE job_id LIKE '%news%' OR job_id LIKE '%intel%' ORDER BY created_at DESC LIMIT 1`);
    if (jhRes.rows.length > 0 && jhRes.rows[0].summary) {
      newsLine = `📰 News  ${jhRes.rows[0].summary.slice(0, 60)}`;
    }
  } catch {}

  try {
    const jhRes = await pool.query(`SELECT summary FROM job_history WHERE job_id LIKE '%intel%' ORDER BY created_at DESC LIMIT 1`);
    if (jhRes.rows.length > 0 && jhRes.rows[0].summary) {
      intelLine = `🐦 X  ${jhRes.rows[0].summary.slice(0, 60)}`;
    }
  } catch {}

  const lines = [
    `☀️ <b>MORNING PACK</b> · ${dateStr}`,
    "",
    aiLine,
    btcLine,
    marketsLine,
    newsLine,
    intelLine,
    "",
    fmt.SEPARATOR,
    "Full briefs in each channel ↑",
  ];

  await sendToChannel("direct", fmt.truncateToTelegramLimit(lines.join("\n")), "HTML");
  console.log("[telegram] Morning Pack sent");
}

export async function sendEODRollup(): Promise<void> {
  if (!isConfigured()) return;
  const fmt = await import("./telegram-format.js");
  const pool = getPool();

  const dateStr = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
  });

  let portfolioValue = 10000;
  let todayPnl = 0;
  let todayWins = 0;
  let todayLosses = 0;
  let scoutCycles = 0;
  let thesesGenerated = 0;
  let shadowOpened = 0;
  let healthStatus = "All clear";
  let healthAlerts: string[] = [];
  let topStory = "None";
  let aiHeadline = "";
  let btcHeadline = "";
  let outstandingItems: string[] = [];

  try {
    const pvRes = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_portfolio_value'`);
    if (pvRes.rows.length > 0) portfolioValue = Number(pvRes.rows[0].value) || 10000;
  } catch {}

  try {
    const stRes = await pool.query(`SELECT value FROM app_config WHERE key = 'oversight_shadow_trades'`);
    if (stRes.rows.length > 0 && Array.isArray(stRes.rows[0].value)) {
      const trades = stRes.rows[0].value;
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayMs = todayStart.getTime();

      const todayClosed = trades.filter((t: any) =>
        t.status === "closed" && t.closed_at && new Date(t.closed_at).getTime() > todayMs
      );
      const todayOpened = trades.filter((t: any) =>
        t.opened_at && new Date(t.opened_at).getTime() > todayMs
      );

      shadowOpened = todayOpened.length;
      todayWins = todayClosed.filter((t: any) => (t.hypothetical_pnl || 0) > 0).length;
      todayLosses = todayClosed.filter((t: any) => (t.hypothetical_pnl || 0) <= 0).length;
      todayPnl = todayClosed.reduce((s: number, t: any) => s + (t.hypothetical_pnl || 0), 0);
    }
  } catch {}

  try {
    const jhRes = await pool.query(
      `SELECT COUNT(*) as cnt FROM job_history WHERE job_id LIKE '%scout%' AND created_at > NOW() - INTERVAL '24 hours'`
    );
    scoutCycles = parseInt(jhRes.rows[0]?.cnt || "0", 10);
  } catch {}

  try {
    const tRes = await pool.query(`SELECT value FROM app_config WHERE key = 'polymarket_scout_active_theses'`);
    if (tRes.rows.length > 0 && Array.isArray(tRes.rows[0].value)) {
      thesesGenerated = tRes.rows[0].value.length;
    }
  } catch {}

  try {
    const hrRes = await pool.query(`SELECT value FROM app_config WHERE key = 'oversight_health_reports'`);
    if (hrRes.rows.length > 0 && Array.isArray(hrRes.rows[0].value)) {
      const reports = hrRes.rows[0].value;
      const todayAlerts = reports.filter((r: any) => {
        const ts = r.timestamp || r.created_at;
        if (!ts) return false;
        const rDate = new Date(ts);
        return (Date.now() - rDate.getTime()) < 24 * 60 * 60 * 1000;
      });
      if (todayAlerts.length > 0) {
        healthStatus = `${todayAlerts.length} alert(s) triggered`;
        healthAlerts = todayAlerts.map((a: any) => a.summary || a.type || "alert").slice(0, 3);
      }
    }
  } catch {}

  try {
    const pausedRes = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_paused'`);
    if (pausedRes.rows.length > 0 && pausedRes.rows[0].value === true) {
      outstandingItems.push("Wealth Engines PAUSED");
    }
  } catch {}

  try {
    const fgRes = await pool.query(`SELECT value FROM app_config WHERE key = 'fear_greed_index'`);
    if (fgRes.rows.length > 0) {
      const fg = fgRes.rows[0].value;
      btcHeadline = `₿ BTC  Fear & Greed: ${typeof fg === "object" ? `${fg.value} ${fg.classification || ""}` : fg}`;
    }
  } catch {}

  try {
    const jhRes = await pool.query(`SELECT summary FROM job_history WHERE job_id LIKE '%ai-tech%' ORDER BY created_at DESC LIMIT 1`);
    if (jhRes.rows.length > 0 && jhRes.rows[0].summary) {
      aiHeadline = `🤖 AI  ${jhRes.rows[0].summary.slice(0, 60)}`;
    }
  } catch {}

  try {
    const nhRes = await pool.query(`SELECT summary FROM job_history WHERE job_id LIKE '%news%' ORDER BY created_at DESC LIMIT 1`);
    if (nhRes.rows.length > 0 && nhRes.rows[0].summary) {
      topStory = nhRes.rows[0].summary.slice(0, 60);
    }
  } catch {}

  const pnlSign = todayPnl >= 0 ? "+" : "";
  const tradeStr = (todayWins + todayLosses) > 0
    ? `W:${todayWins} L:${todayLosses}`
    : "No trades today";

  const lines = [
    `🌙 <b>EOD ROLLUP</b> · ${dateStr}`,
    "",
    `💰 Portfolio  $${portfolioValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · ${pnlSign}$${Math.abs(todayPnl).toFixed(2)} today · ${tradeStr}`,
    `🔍 Scout  ${scoutCycles} cycles · ${thesesGenerated} active theses · ${shadowOpened} shadow opened`,
    `🛡️ Health  ${healthStatus}${healthAlerts.length > 0 ? ` · ${healthAlerts.join(", ")}` : ""}`,
    "",
    fmt.SEPARATOR,
    `📰 Top Story  ${topStory}`,
  ];
  if (aiHeadline) lines.push(aiHeadline);
  if (btcHeadline) lines.push(btcHeadline);

  lines.push("");
  lines.push(fmt.SEPARATOR);
  lines.push(`⚠️ Outstanding  ${outstandingItems.length > 0 ? outstandingItems.join(" · ") : "None"}`);
  lines.push("✅ Good night");

  await sendToChannel("direct", fmt.truncateToTelegramLimit(lines.join("\n")), "HTML");
  console.log("[telegram] EOD Rollup sent");
}

export async function forwardAlertToTelegram(event: { type: string; briefType?: string; alertType?: string; title?: string; content: string; telegramContent?: string }): Promise<void> {
  const mode = await getMode();

  const personalAlertTypes = new Set(["calendar", "stock", "task", "email"]);
  const tradingEventTypes = new Set(["scout", "bankr", "oversight", "circuit_breaker"]);

  if (event.type === "brief") {
    const fingerprint = getNotificationFingerprint(event);
    if (isDuplicateNotification(fingerprint)) {
      console.log("[telegram] Suppressed duplicate brief notification");
      return;
    }
    const header = formatTelegramBriefHeader(event.briefType || "Daily", mode);
    const rawBody = event.telegramContent || event.content;
    const safeBody = escapeAndPreserveHtmlTags(rawBody);
    const truncated = truncateForTelegram(`${header}\n\n${safeBody}`, 4000);
    await sendToChannel("mission-control", truncated, "HTML");
    return;
  }

  if (event.type === "alert" && personalAlertTypes.has(event.alertType || "")) {
    const fingerprint = getNotificationFingerprint(event);
    if (isDuplicateNotification(fingerprint)) {
      console.log(`[telegram] Suppressed duplicate ${event.alertType} notification: ${(event.title || "").slice(0, 50)}`);
      return;
    }
    const { tag, priority } = getPriorityTag(event.alertType || "", event.content);
    const priorityCircle = priority === "Action needed" ? "🔴" : priority === "Travel" ? "✈️" : priority === "Financial" ? "💰" : "🟡";
    const escapedTitle = escapeHtml(event.title || "Alert");
    const escapedContent = escapeHtml(event.content);
    const msg = `${mode} ${tag} <b>${escapedTitle}</b>\n${priorityCircle} ${escapeHtml(priority)}\n━━━━━━━━━━━━\n${escapedContent}`;
    await sendToChannel("direct", msg, "HTML");
    return;
  }

  if (tradingEventTypes.has(event.type) || (event.type === "alert" && !personalAlertTypes.has(event.alertType || ""))) {
    if (!isConfigured()) return;
    const fingerprint = getNotificationFingerprint(event);
    if (isDuplicateNotification(fingerprint)) {
      console.log(`[telegram] Suppressed duplicate trading notification: ${(event.title || "").slice(0, 50)}`);
      return;
    }
    const tradingIcons: Record<string, string> = {
      scout: "🔍",
      bankr: "💰",
      oversight: "🛡️",
      circuit_breaker: "🚨",
    };
    const icon = tradingIcons[event.type] || "🔔";
    const escapedTitle = escapeHtml(event.title || "Alert");
    const escapedContent = escapeHtml(event.content);
    const channel = event.type === "circuit_breaker" ? "mission-control" : "trading";
    await sendToChannel(channel, `${mode} ${icon} <b>${escapedTitle}</b>\n━━━━━━━━━━━━\n${escapedContent}`, "HTML");
  }
}
