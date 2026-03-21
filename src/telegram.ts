import { getPool } from "./db.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

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

function getMode(): string {
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
  const mode = getMode();
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

  const lines = [
    `${mode} *DarkNode Status*`,
    "",
    `🔴 Kill Switch: ${killSwitchActive ? "ACTIVE" : "OFF"}`,
    `⏸ Paused: ${pauseActive ? "YES" : "NO"}`,
    `🔍 SCOUT last run: ${scoutLastRun}`,
    `💰 BANKR last run: ${bankrLastRun}`,
    "",
    `_${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET_`,
  ];
  return lines.join("\n");
}

async function handlePortfolioCommand(): Promise<string> {
  const mode = getMode();
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
  const mode = getMode();
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
  const mode = getMode();
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
  const mode = getMode();
  const pool = getPool();

  try {
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('wealth_engines_paused', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(false), Date.now()]
    );
    console.log("[telegram] Wealth Engines RESUMED via Telegram");
    return `${mode} ▶️ *System RESUMED*\n\nAll Wealth Engine jobs are active again.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${mode} ❌ Failed to resume: ${msg}`;
  }
}

async function handleScoutCommand(): Promise<string> {
  const mode = getMode();
  const pool = getPool();

  try {
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'scout_active_theses'`);
    if (res.rows.length > 0 && Array.isArray(res.rows[0].value) && res.rows[0].value.length > 0) {
      const theses = res.rows[0].value;
      const lines = [`${mode} *Active SCOUT Theses*`, ""];
      for (const t of theses.slice(0, 10)) {
        const conf = t.confidence || "?";
        const dir = t.direction || "?";
        const score = t.technical_score != null ? ` (${t.technical_score.toFixed(2)})` : "";
        lines.push(`• *${t.asset}* — ${dir} ${conf}${score}`);
        if (t.entry_price) lines.push(`  Entry: $${t.entry_price} | Stop: $${t.stop_price || "?"}`);
      }
      return lines.join("\n");
    }
  } catch {}

  return `${mode} *Active SCOUT Theses*\n\nNo active theses. SCOUT has not generated any yet.`;
}

async function handleTradesCommand(args: string): Promise<string> {
  const mode = getMode();
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
  const mode = getMode();
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

function handleHelpCommand(): string {
  const mode = getMode();
  return [
    `${mode} *DarkNode Commands*`,
    "",
    "/status — System health & mode",
    "/portfolio — Open positions & P&L",
    "/intel — Latest SCOUT brief",
    "/scout — Active theses",
    "/trades [n] — Last N trades (default 5)",
    "/pause — Halt all Wealth Engine jobs",
    "/resume — Resume Wealth Engine jobs",
    "/public on|off — Toggle dashboard access",
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
  const mode = getMode();
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

  const mode = getMode();
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
          const cmd = parts[0].toLowerCase().replace("@", "").replace(/\//, "");
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

async function checkDeadManSwitches(): Promise<void> {
  if (!isConfigured()) return;
  const pool = getPool();
  const mode = getMode();

  let paused = false;
  try {
    const pa = await pool.query(`SELECT value FROM app_config WHERE key = 'wealth_engines_paused'`);
    paused = pa.rows.length > 0 && pa.rows[0].value === true;
  } catch {}
  if (paused) return;

  try {
    const scoutRes = await pool.query(
      `SELECT created_at FROM job_history WHERE agent_id = 'scout' ORDER BY created_at DESC LIMIT 1`
    );
    if (scoutRes.rows.length > 0) {
      const lastRun = new Date(scoutRes.rows[0].created_at).getTime();
      const hoursSince = (Date.now() - lastRun) / (3600 * 1000);
      if (hoursSince > 36) {
        const lastAlert = lastDeadManAlert["scout"] || 0;
        if (Date.now() - lastAlert > 12 * 3600 * 1000) {
          lastDeadManAlert["scout"] = Date.now();
          await sendMessage(
            `${mode} ⚠️ *Dead Man's Switch: SCOUT*\n\nSCOUT has not run in ${Math.floor(hoursSince)}h (threshold: 36h).\nLast run: ${timeAgo(lastRun)}\n\nCheck scheduled jobs or run manually.`
          );
        }
      } else {
        delete lastDeadManAlert["scout"];
      }
    }
  } catch (err) {
    console.error("[telegram] Dead man switch SCOUT check failed:", err);
  }

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
            `${mode} ⚠️ *Dead Man's Switch: BANKR*\n\nBANKR monitor has not run in ${Math.floor(hoursSince)}h (threshold: 8h).\nLast run: ${timeAgo(lastRun)}\n\nCheck scheduled jobs or run manually.`
          );
        }
      } else {
        delete lastDeadManAlert["bankr"];
      }
    }
  } catch (err) {
    console.error("[telegram] Dead man switch BANKR check failed:", err);
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
  const mode = getMode();
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
  const mode = getMode();
  const truncated = brief.length > 3500 ? brief.slice(0, 3500) + "\n\n_(truncated)_" : brief;
  await sendMessage(`${mode} 🔍 *SCOUT Morning Brief*\n\n${truncated}`);
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
  registerCommand("help", async () => handleHelpCommand());

  try {
    const me = await tgFetch("getMe");
    console.log(`[telegram] Bot connected: @${me.result?.username || "unknown"}`);
  } catch (err) {
    console.error("[telegram] Failed to connect:", err instanceof Error ? err.message : err);
    return;
  }

  pollingActive = true;
  pollUpdates();

  deadManInterval = setInterval(() => {
    checkDeadManSwitches().catch(err => console.error("[telegram] Dead man check error:", err));
  }, 60 * 60 * 1000);

  console.log("[telegram] initialized (long-polling mode, dead man switches hourly)");
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
  if (!isConfigured()) return;

  const mode = getMode();

  if (event.type === "brief") {
    const briefLabel = event.briefType ? event.briefType.charAt(0).toUpperCase() + event.briefType.slice(1) : "Daily";
    const truncated = event.content.length > 3500 ? event.content.slice(0, 3500) + "\n\n_(truncated)_" : event.content;
    await sendMessage(`${mode} 📋 *${briefLabel} Brief*\n\n${truncated}`);
    return;
  }

  if (event.type === "alert") {
    const icons: Record<string, string> = {
      calendar: "📅",
      stock: "📊",
      task: "✅",
      email: "📧",
    };
    const icon = icons[event.alertType || ""] || "🔔";
    await sendMessage(`${mode} ${icon} *${event.title || "Alert"}*\n\n${event.content}`);
  }
}
