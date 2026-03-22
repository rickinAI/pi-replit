import Anthropic from "@anthropic-ai/sdk";
import { getPool } from "./db.js";
import * as calendar from "./calendar.js";
import * as tasks from "./tasks.js";
import * as weather from "./weather.js";
import * as stocks from "./stocks.js";
import * as news from "./news.js";
import * as gmail from "./gmail.js";

interface WatchlistItem {
  symbol: string;
  type: "stock" | "crypto";
  displaySymbol?: string;
}

interface BriefConfig {
  enabled: boolean;
  hour: number;
  minute: number;
  content: string[];
}

interface AlertToggle {
  enabled: boolean;
  minutesBefore?: number;
  thresholdPercent?: number;
}

interface AlertConfig {
  timezone: string;
  location: string;
  briefs: {
    morning: BriefConfig;
    afternoon: BriefConfig;
    evening: BriefConfig;
  };
  alerts: {
    calendarReminder: AlertToggle;
    stockMove: AlertToggle;
    taskDeadline: AlertToggle;
    importantEmail: AlertToggle;
  };
  watchlist: WatchlistItem[];
  theme: "dark" | "light";
  lastPrices: Record<string, number>;
  lastBriefRun: Record<string, string>;
}

type BroadcastFn = (event: BriefEvent | AlertEvent) => void;
type SaveBriefFn = (path: string, content: string) => Promise<void>;

export interface BriefEvent {
  type: "brief";
  briefType: "morning" | "afternoon" | "evening";
  content: string;
  timestamp: string;
}

export interface AlertEvent {
  type: "alert";
  alertType: "calendar" | "stock" | "task" | "email";
  title: string;
  content: string;
  timestamp: string;
}

const DEFAULT_CONFIG: AlertConfig = {
  timezone: "America/New_York",
  location: "New York",
  briefs: {
    morning: { enabled: true, hour: 8, minute: 0, content: ["calendar", "tasks", "weather", "news", "markets", "headlines", "email"] },
    afternoon: { enabled: true, hour: 13, minute: 0, content: ["calendar", "tasks", "email", "markets", "headlines"] },
    evening: { enabled: true, hour: 19, minute: 0, content: ["calendar_tomorrow", "tasks", "markets", "headlines", "email"] },
  },
  alerts: {
    calendarReminder: { enabled: true, minutesBefore: 30 },
    stockMove: { enabled: true, thresholdPercent: 3 },
    taskDeadline: { enabled: true },
    importantEmail: { enabled: true },
  },
  watchlist: [
    { symbol: "GC=F", type: "stock", displaySymbol: "GOLD" },
    { symbol: "SI=F", type: "stock", displaySymbol: "SILVER" },
    { symbol: "bitcoin", type: "crypto", displaySymbol: "BTCUSD" },
    { symbol: "MSTR", type: "stock" },
  ],
  theme: "dark",
  lastPrices: {},
  lastBriefRun: {},
};

let config: AlertConfig = { ...DEFAULT_CONFIG };
let broadcastFn: BroadcastFn | null = null;
let saveBriefFn: SaveBriefFn | null = null;
let briefInterval: ReturnType<typeof setInterval> | null = null;
let alertInterval: ReturnType<typeof setInterval> | null = null;
let alertedCalendarEvents = new Set<string>();
let alertedEmailIds = new Set<string>();
let initialAlertCheckDone = false;
let briefRunning = false;
let alertRunning = false;
let lastDedupeReset = "";

async function loadPersistedAlertDedup(): Promise<void> {
  try {
    const { getPool } = await import("./db.js");
    const pool = getPool();
    const res = await pool.query(`SELECT value FROM app_config WHERE key = 'alerted_calendar_events'`);
    if (res.rows.length > 0 && res.rows[0].value) {
      const data = res.rows[0].value;
      if (data.date === getTodayKey() && Array.isArray(data.events)) {
        for (const e of data.events) alertedCalendarEvents.add(e);
      }
    }
  } catch {}
}

async function persistAlertDedup(): Promise<void> {
  try {
    const { getPool } = await import("./db.js");
    const pool = getPool();
    const data = { date: getTodayKey(), events: [...alertedCalendarEvents] };
    await pool.query(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('alerted_calendar_events', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(data), Date.now()]
    );
  } catch {}
}

const ACTIONABLE_EMAIL_CATEGORIES = new Set(["Travel", "Financial", "Documents", "Calendar"]);

export async function init(): Promise<void> {
  const existing = await getPool().query(`SELECT value FROM app_config WHERE key = 'alerts'`);
  if (existing.rows.length === 0) {
    try {
      const fs = await import("fs");
      const path = await import("path");
      const legacyPath = path.default.join(process.cwd(), "data", "alerts-config.json");
      if (fs.default.existsSync(legacyPath)) {
        const raw = JSON.parse(fs.default.readFileSync(legacyPath, "utf-8"));
        const migrated = { ...DEFAULT_CONFIG, ...raw, briefs: { ...DEFAULT_CONFIG.briefs, ...raw.briefs }, alerts: { ...DEFAULT_CONFIG.alerts, ...raw.alerts } };
        await getPool().query(
          `INSERT INTO app_config (key, value, updated_at) VALUES ('alerts', $1, $2)`,
          [JSON.stringify(migrated), Date.now()]
        );
        config = migrated;
        console.log("[alerts] Migrated config from data/alerts-config.json to PostgreSQL");
      }
    } catch (err) {
      console.error("[alerts] Config migration failed:", err);
    }
  }

  if (existing.rows.length > 0) {
    config = await loadConfig();
  }
  console.log("[alerts] initialized");
}

async function loadConfig(): Promise<AlertConfig> {
  try {
    const result = await getPool().query(`SELECT value FROM app_config WHERE key = 'alerts'`);
    if (result.rows.length > 0) {
      const raw = result.rows[0].value;
      return { ...DEFAULT_CONFIG, ...raw, briefs: { ...DEFAULT_CONFIG.briefs, ...raw.briefs }, alerts: { ...DEFAULT_CONFIG.alerts, ...raw.alerts } };
    }
  } catch (err) {
    console.error("[alerts] Failed to load config:", err);
  }
  return { ...DEFAULT_CONFIG };
}

async function saveConfig(): Promise<void> {
  try {
    await getPool().query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ('alerts', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(config), Date.now()]
    );
  } catch (err) {
    console.error("[alerts] Failed to save config:", err);
  }
}

export function getConfig(): Omit<AlertConfig, "lastPrices" | "lastBriefRun"> {
  const { lastPrices, lastBriefRun, ...rest } = config;
  return rest;
}

export function updateConfig(partial: any): Omit<AlertConfig, "lastPrices" | "lastBriefRun"> {
  if (partial.timezone) config.timezone = partial.timezone;
  if (partial.location) config.location = partial.location;
  if (partial.briefs) {
    for (const key of ["morning", "afternoon", "evening"] as const) {
      if (partial.briefs[key]) {
        config.briefs[key] = { ...config.briefs[key], ...partial.briefs[key] };
      }
    }
  }
  if (partial.alerts) {
    for (const key of ["calendarReminder", "stockMove", "taskDeadline", "importantEmail"] as const) {
      if (partial.alerts[key]) {
        config.alerts[key] = { ...config.alerts[key], ...partial.alerts[key] };
      }
    }
  }
  if (partial.watchlist) config.watchlist = partial.watchlist;
  if (partial.theme === "dark" || partial.theme === "light") config.theme = partial.theme;
  saveConfig();
  return getConfig();
}

function getNow(): Date {
  const nowStr = new Date().toLocaleString("en-US", { timeZone: config.timezone });
  return new Date(nowStr);
}

function getTodayKey(): string {
  const now = getNow();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function formatTimeET(date?: Date): string {
  const d = date || new Date();
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: config.timezone });
}

function getTzOffset(tz: string, refDate: Date): number {
  const utcStr = refDate.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = refDate.toLocaleString("en-US", { timeZone: tz });
  return new Date(tzStr).getTime() - new Date(utcStr).getTime();
}

function getDateInTimezone(tz: string, daysOffset: number = 0): { start: Date; end: Date } {
  const now = new Date();
  const nowOffsetMs = getTzOffset(tz, now);
  const nowInTz = new Date(now.getTime() + nowOffsetMs);
  nowInTz.setUTCDate(nowInTz.getUTCDate() + daysOffset);
  const noonOnTarget = new Date(Date.UTC(nowInTz.getUTCFullYear(), nowInTz.getUTCMonth(), nowInTz.getUTCDate(), 12, 0, 0, 0));
  const targetOffsetMs = getTzOffset(tz, new Date(noonOnTarget.getTime() - nowOffsetMs));
  const startInTz = new Date(Date.UTC(nowInTz.getUTCFullYear(), nowInTz.getUTCMonth(), nowInTz.getUTCDate(), 0, 0, 0, 0));
  const endInTz = new Date(Date.UTC(nowInTz.getUTCFullYear(), nowInTz.getUTCMonth(), nowInTz.getUTCDate(), 23, 59, 59, 999));
  const startUTC = new Date(startInTz.getTime() - targetOffsetMs);
  const endUTC = new Date(endInTz.getTime() - targetOffsetMs);
  return { start: startUTC, end: endUTC };
}

async function gatherSection(name: string): Promise<string> {
  try {
    switch (name) {
      case "calendar": {
        if (!calendar.isConfigured()) return "**Calendar:** [not connected]";
        const now = new Date();
        const { end: endOfDay } = getDateInTimezone(config.timezone, 0);
        console.log(`[alerts] Calendar today query: ${now.toISOString()} to ${endOfDay.toISOString()}`);
        const result = await calendar.listEvents({ timeMin: now.toISOString(), timeMax: endOfDay.toISOString(), maxResults: 10 });
        return `**Today's Calendar:**\n${result}`;
      }
      case "calendar_tomorrow": {
        if (!calendar.isConfigured()) return "**Calendar:** [not connected]";
        const { start: tomorrow, end: endTomorrow } = getDateInTimezone(config.timezone, 1);
        console.log(`[alerts] Calendar tomorrow query: ${tomorrow.toISOString()} to ${endTomorrow.toISOString()}`);
        const result = await calendar.listEvents({ timeMin: tomorrow.toISOString(), timeMax: endTomorrow.toISOString(), maxResults: 10 });
        return `**Tomorrow's Calendar:**\n${result}`;
      }
      case "tasks": {
        const localTasks = await tasks.listTasks();
        return `**Tasks:**\n${localTasks}`;
      }
      case "weather": {
        const result = await weather.getWeather(config.location);
        return `**Weather:**\n${result}`;
      }
      case "news": {
        const [top, finance, tech] = await Promise.allSettled([
          news.getNews("top"),
          news.getNews("business"),
          news.getNews("technology"),
        ]);
        const sections: string[] = [];
        if (top.status === "fulfilled") {
          const lines = top.value.split("\n").slice(0, 12).join("\n");
          sections.push(`**Top Headlines:**\n${lines}`);
        }
        if (finance.status === "fulfilled") {
          const lines = finance.value.split("\n").slice(0, 12).join("\n");
          sections.push(`**Finance Headlines:**\n${lines}`);
        }
        if (tech.status === "fulfilled") {
          const lines = tech.value.split("\n").slice(0, 12).join("\n");
          sections.push(`**Technology Headlines:**\n${lines}`);
        }
        return sections.join("\n\n") || "**News:** [unavailable]";
      }
      case "markets": {
        const items: string[] = [];
        for (const w of config.watchlist) {
          try {
            const label = w.displaySymbol || w.symbol.toUpperCase();
            if (w.type === "crypto") {
              const data = await stocks.getCryptoPrice(w.symbol);
              const priceLine = data.split("\n").slice(0, 3).join(" | ");
              items.push(`${label}: ${priceLine}`);
            } else {
              const data = await stocks.getStockQuote(w.symbol);
              const priceLine = data.split("\n").slice(0, 3).join(" | ");
              items.push(`${label}: ${priceLine}`);
            }
          } catch {
            items.push(`${w.displaySymbol || w.symbol}: [unavailable]`);
          }
        }
        return `**Markets:**\n${items.join("\n")}`;
      }
      case "headlines": {
        try {
          const topNews = await news.getNews("top");
          const items = topNews.split("\n").filter(l => /^\d+\./.test(l)).slice(0, 5);
          const bullets = items.map(line => {
            const cleaned = line.replace(/^\d+\.\s*/, "");
            return `• ${cleaned}`;
          });
          return `**Top Headlines:**\n${bullets.join("\n")}`;
        } catch {
          return "**Top Headlines:** [unavailable]";
        }
      }
      case "email": {
        if (!gmail.isConfigured() || !gmail.isConnected()) return "**Email:** [not connected]";
        try {
          const result = await gmail.listEmails("is:unread", 5);
          const cleaned = result
            .replace(/\s*\[[a-f0-9]+\]/gi, "")
            .replace(/\(\* = unread\)\n?/g, "")
            .replace(/^\* /gm, "")
            .replace(/\n{3,}/g, "\n\n");
          return `**Email:**\n${cleaned}`;
        } catch {
          return "**Email:** [unavailable]";
        }
      }
      default:
        return "";
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[alerts] Section "${name}" failed:`, msg);
    return `**${name}:** [unavailable]`;
  }
}

async function synthesizeBrief(type: string, rawSections: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return rawSections;

  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `You are Rickin's personal assistant delivering his ${type} briefing. Synthesize the following raw data into a concise, natural-language briefing. Lead with the most important and actionable items. Be direct — no filler.

Format rules:
- Use markdown headers (##) for major sections
- Use bullet points for individual items
- Keep each item to 1-2 lines max
- If a section has no data or says "not connected", skip it entirely
- For markets, highlight notable moves; don't just list prices
- For calendar, emphasize timing and what's next
- For email, mention sender and subject briefly

RAW DATA:
${rawSections}`
      }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    return text || rawSections;
  } catch (err) {
    console.error(`[alerts] AI synthesis failed for ${type} brief:`, err);
    return rawSections;
  }
}

async function generateBrief(type: "morning" | "afternoon" | "evening"): Promise<string> {
  const briefConfig = config.briefs[type];
  const sections: string[] = [];

  const results = await Promise.allSettled(
    briefConfig.content.map(name => gatherSection(name))
  );

  for (const result of results) {
    if (result.status === "fulfilled" && result.value) {
      sections.push(result.value);
    }
  }

  const rawContent = sections.join("\n\n---\n\n");
  const synthesized = await synthesizeBrief(type, rawContent);

  if (saveBriefFn) {
    try {
      const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: config.timezone });
      const briefPath = `Daily Digests/${dateStr}-${type}.md`;
      const header = `# ${type.charAt(0).toUpperCase() + type.slice(1)} Brief — ${dateStr}\n\n`;
      await saveBriefFn(briefPath, header + synthesized);
      console.log(`[alerts] Brief saved to vault: ${briefPath}`);
    } catch (err) {
      console.error(`[alerts] Failed to save brief to vault:`, err);
    }
  }

  return synthesized;
}

async function checkBriefs() {
  if (briefRunning) return;
  briefRunning = true;
  try {
    await doCheckBriefs();
  } finally {
    briefRunning = false;
  }
}

async function doCheckBriefs() {
  const now = getNow();
  const todayKey = getTodayKey();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();

  if (lastDedupeReset !== todayKey) {
    alertedCalendarEvents.clear();
    alertedEmailIds.clear();
    lastDedupeReset = todayKey;
  }

  for (const type of ["morning", "afternoon", "evening"] as const) {
    const briefConfig = config.briefs[type];
    if (!briefConfig.enabled) continue;

    const runKey = `${type}_${todayKey}`;
    if (config.lastBriefRun[runKey]) continue;

    const targetMinutes = briefConfig.hour * 60 + briefConfig.minute;
    const nowMinutes = currentHour * 60 + currentMinute;

    if (nowMinutes >= targetMinutes && nowMinutes <= targetMinutes + 2) {
      console.log(`[alerts] Triggering ${type} brief`);
      config.lastBriefRun[runKey] = new Date().toISOString();
      await saveConfig();

      try {
        const content = await generateBrief(type);
        const event: BriefEvent = {
          type: "brief",
          briefType: type,
          content,
          timestamp: new Date().toISOString(),
        };
        broadcastFn?.(event);
        console.log(`[alerts] ${type} brief sent`);
      } catch (err) {
        console.error(`[alerts] ${type} brief failed:`, err);
      }
    }
  }
}

async function checkAlerts() {
  if (alertRunning) return;
  alertRunning = true;
  try {
    await doCheckAlerts();
  } finally {
    alertRunning = false;
  }
}

const CALENDAR_SYSTEM_PATTERNS = [
  /updated your access/i,
  /shared .* calendar/i,
  /sharing settings/i,
  /permission/i,
  /calendar modified/i,
  /accepted your invitation/i,
  /declined your invitation/i,
  /changed the .* calendar/i,
  /added you to/i,
  /removed you from/i,
];

function isCalendarSystemEvent(content: string): boolean {
  return CALENDAR_SYSTEM_PATTERNS.some(p => p.test(content));
}

function categorizeEmail(subject: string, sender: string): { icon: string; category: string } {
  const s = subject.toLowerCase();
  const f = sender.toLowerCase();
  if (/flight|booking|jetblue|delta|united|american air|southwest|airline|itinerary/i.test(s)) return { icon: "✈️", category: "Travel" };
  if (/hotel|airbnb|vrbo|reservation/i.test(s)) return { icon: "🏨", category: "Travel" };
  if (/card|amex|visa|mastercard|chase|citi|capital one|billing|statement|payment|invoice/i.test(s)) return { icon: "💰", category: "Financial" };
  if (/bank|transfer|deposit|withdraw|wire|ach/i.test(s)) return { icon: "🏦", category: "Financial" };
  if (/receipt|order|shipped|delivered|tracking/i.test(s)) return { icon: "📦", category: "Shopping" };
  if (/resume|cv|job|interview|application|offer letter/i.test(s)) return { icon: "📄", category: "Documents" };
  if (/meeting|call|zoom|teams|webex/i.test(s)) return { icon: "📅", category: "Calendar" };
  if (/update|weekly|digest|newsletter|report/i.test(s)) return { icon: "💼", category: "Updates" };
  if (/calendar|event|invitation|rsvp/i.test(s)) return { icon: "📅", category: "Calendar" };
  return { icon: "📧", category: "Email" };
}

let pendingEmailAlerts: Array<{ sender: string; subject: string; icon: string; category: string; timestamp: string }> = [];
let emailBatchTimeout: ReturnType<typeof setTimeout> | null = null;

function flushEmailBatch() {
  if (pendingEmailAlerts.length === 0) return;
  const emails = [...pendingEmailAlerts];
  pendingEmailAlerts = [];
  emailBatchTimeout = null;

  const actionable = emails.filter(e => ACTIONABLE_EMAIL_CATEGORIES.has(e.category));
  if (actionable.length === 0) return;

  if (actionable.length === 1) {
    const e = actionable[0];
    broadcastFn?.({
      type: "alert",
      alertType: "email",
      title: `${e.icon} ${e.sender}`,
      content: e.subject,
      timestamp: e.timestamp,
    });
    return;
  }

  const lines: string[] = [];
  for (const item of actionable) {
    lines.push(`${item.icon} ${item.subject} — ${item.sender}`);
  }

  broadcastFn?.({
    type: "alert",
    alertType: "email",
    title: `New Emails (${actionable.length})`,
    content: lines.join("\n"),
    timestamp: new Date().toISOString(),
  });
}

async function doCheckAlerts() {
  const now = new Date();

  if (config.alerts.calendarReminder.enabled && calendar.isConfigured()) {
    try {
      const minutesBefore = config.alerts.calendarReminder.minutesBefore || 30;
      const windowEnd = new Date(now.getTime() + minutesBefore * 60 * 1000);
      const result = await calendar.listEvents({ timeMin: now.toISOString(), timeMax: windowEnd.toISOString(), maxResults: 5 });
      if (!result.includes("No upcoming events")) {
        const lines = result.split("\n").filter(l => l.trim());
        for (const line of lines) {
          const eventKey = line.trim().slice(0, 80);
          if (alertedCalendarEvents.has(eventKey)) continue;
          if (/^\d+\./.test(line.trim())) {
            const eventContent = line.trim().replace(/^\d+\.\s*/, "");
            if (isCalendarSystemEvent(eventContent)) continue;
            alertedCalendarEvents.add(eventKey);
            persistAlertDedup();
            broadcastFn?.({
              type: "alert",
              alertType: "calendar",
              title: "Upcoming Event",
              content: eventContent,
              timestamp: now.toISOString(),
            });
          }
        }
      }
    } catch (err) {
      console.error("[alerts] Calendar alert check failed:", err);
    }
  }

  if (config.alerts.stockMove.enabled && config.watchlist.length > 0) {
    const threshold = config.alerts.stockMove.thresholdPercent || 3;
    for (const w of config.watchlist) {
      try {
        const label = w.displaySymbol || w.symbol.toUpperCase();
        let currentPrice: number | null = null;

        if (w.type === "crypto") {
          const data = await stocks.getCryptoPrice(w.symbol);
          const priceMatch = data.match(/Price:\s*\$([0-9,]+\.?\d*)/);
          if (priceMatch) currentPrice = parseFloat(priceMatch[1].replace(/,/g, ""));
        } else {
          const data = await stocks.getStockQuote(w.symbol);
          const priceMatch = data.match(/Price:\s*\$([0-9,]+\.?\d*)/);
          if (priceMatch) currentPrice = parseFloat(priceMatch[1].replace(/,/g, ""));
        }

        if (currentPrice !== null) {
          const lastPrice = config.lastPrices[label];
          if (lastPrice) {
            const pctChange = ((currentPrice - lastPrice) / lastPrice) * 100;
            if (Math.abs(pctChange) >= threshold) {
              const direction = pctChange > 0 ? "UP" : "DOWN";
              const arrow = pctChange > 0 ? "▲" : "▼";
              broadcastFn?.({
                type: "alert",
                alertType: "stock",
                title: `${label} ${direction} ${Math.abs(pctChange).toFixed(1)}%`,
                content: `${label} moved ${arrow} ${Math.abs(pctChange).toFixed(1)}% — now $${currentPrice.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
                timestamp: now.toISOString(),
              });
            }
          }
          config.lastPrices[label] = currentPrice;
        }
      } catch (err) {
        console.error(`[alerts] Stock alert check for ${w.symbol} failed:`, err);
      }
    }
    await saveConfig();
  }

  if (config.alerts.taskDeadline.enabled) {
    try {
      const todayKey = getTodayKey();
      const taskList = await tasks.listTasks();
      if (!taskList.includes("No open tasks") && !taskList.includes("No tasks found")) {
        const lines = taskList.split("\n");
        for (const line of lines) {
          if (line.includes(`due: ${todayKey}`) && !line.includes("[x]")) {
            const taskTitle = line.replace(/^\d+\.\s*\[.\]\s*/, "").replace(/\s*!!.*/, "").replace(/\s*\(due:.*/, "").trim();
            if (taskTitle && !alertedCalendarEvents.has(`task_${taskTitle}`)) {
              alertedCalendarEvents.add(`task_${taskTitle}`);
              broadcastFn?.({
                type: "alert",
                alertType: "task",
                title: "Task Due Today",
                content: taskTitle,
                timestamp: now.toISOString(),
              });
            }
          }
        }
      }
    } catch (err) {
      console.error("[alerts] Task alert check failed:", err);
    }
  }

  if (config.alerts.importantEmail.enabled && gmail.isConfigured() && gmail.isConnected()) {
    try {
      const result = await gmail.listEmails("is:unread is:important", 5);
      if (!result.includes("No emails found") && !result.includes("not authorized")) {
        const idMatches = result.matchAll(/\[([a-f0-9]+)\]/gi);
        let newEmailCount = 0;
        for (const match of idMatches) {
          const emailId = match[1];
          if (!alertedEmailIds.has(emailId)) {
            alertedEmailIds.add(emailId);
            if (initialAlertCheckDone) {
              const lineIdx = result.indexOf(`[${emailId}]`);
              const blockEnd = result.indexOf("\n\n", lineIdx);
              const block = result.slice(lineIdx, blockEnd === -1 ? undefined : blockEnd);
              const fromMatch = block.match(/From:\s*(.+)/);
              const subjectMatch = block.match(/Subject:\s*(.+)/);
              const sender = fromMatch ? fromMatch[1].replace(/<[^>]+>/, "").trim() : "Unknown";
              const subject = subjectMatch ? subjectMatch[1].trim() : "No subject";
              const { icon, category } = categorizeEmail(subject, sender);
              pendingEmailAlerts.push({ sender, subject, icon, category, timestamp: now.toISOString() });
              newEmailCount++;
            }
          }
        }
        if (newEmailCount > 0 && !emailBatchTimeout) {
          emailBatchTimeout = setTimeout(() => flushEmailBatch(), 5000);
        }
      }
    } catch (err) {
      console.error("[alerts] Email alert check failed:", err);
    }
  }
}

export async function startAlertSystem(broadcast: BroadcastFn, saveBrief?: SaveBriefFn) {
  broadcastFn = broadcast;
  saveBriefFn = saveBrief || null;

  briefInterval = setInterval(() => {
    checkBriefs().catch(err => console.error("[alerts] Brief check error:", err));
  }, 60_000);

  alertInterval = setInterval(() => {
    checkAlerts().catch(err => console.error("[alerts] Alert check error:", err));
  }, 60 * 60_000);

  console.log(`[alerts] System started — briefs: morning=${config.briefs.morning.enabled}/${config.briefs.morning.hour}:${String(config.briefs.morning.minute).padStart(2, "0")}, afternoon=${config.briefs.afternoon.enabled}/${config.briefs.afternoon.hour}:${String(config.briefs.afternoon.minute).padStart(2, "0")}, evening=${config.briefs.evening.enabled}/${config.briefs.evening.hour}:${String(config.briefs.evening.minute).padStart(2, "0")} (${config.timezone})`);
  console.log(`[alerts] Watchlist: ${config.watchlist.map(w => w.displaySymbol || w.symbol).join(", ")}`);

  alertedEmailIds.clear();
  initialAlertCheckDone = false;

  await loadPersistedAlertDedup();

  setTimeout(async () => {
    try {
      await checkAlerts();
    } catch (err) {
      console.error("[alerts] Initial alert check error:", err);
    }
    initialAlertCheckDone = true;
  }, 30_000);
}

export function stopAlertSystem() {
  if (briefInterval) clearInterval(briefInterval);
  if (alertInterval) clearInterval(alertInterval);
  if (emailBatchTimeout) {
    clearTimeout(emailBatchTimeout);
    emailBatchTimeout = null;
    flushEmailBatch();
  }
  broadcastFn = null;
}

export async function triggerBrief(type: "morning" | "afternoon" | "evening"): Promise<BriefEvent> {
  console.log(`[alerts] Manual trigger: ${type} brief`);
  const content = await generateBrief(type);
  const event: BriefEvent = {
    type: "brief",
    briefType: type,
    content,
    timestamp: new Date().toISOString(),
  };
  broadcastFn?.(event);
  return event;
}
