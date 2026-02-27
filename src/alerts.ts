import fs from "fs";
import path from "path";
import * as calendar from "./calendar.js";
import * as tasks from "./tasks.js";
import * as weather from "./weather.js";
import * as stocks from "./stocks.js";
import * as news from "./news.js";
import * as gmail from "./gmail.js";
import * as obsidian from "./obsidian.js";

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
    morning: { enabled: true, hour: 8, minute: 0, content: ["calendar", "tasks", "weather", "news", "markets", "email"] },
    afternoon: { enabled: true, hour: 13, minute: 0, content: ["calendar", "tasks", "email", "markets"] },
    evening: { enabled: true, hour: 19, minute: 0, content: ["calendar_tomorrow", "tasks", "markets", "email"] },
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

let configPath = "";
let config: AlertConfig = { ...DEFAULT_CONFIG };
let broadcastFn: BroadcastFn | null = null;
let briefInterval: ReturnType<typeof setInterval> | null = null;
let alertInterval: ReturnType<typeof setInterval> | null = null;
let alertedCalendarEvents = new Set<string>();
let alertedEmailIds = new Set<string>();
let initialAlertCheckDone = false;
let briefRunning = false;
let alertRunning = false;
let lastDedupeReset = "";

export function init(root: string) {
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  configPath = path.join(dataDir, "alerts-config.json");
  config = loadConfig();
}

function loadConfig(): AlertConfig {
  if (!configPath) return { ...DEFAULT_CONFIG };
  try {
    if (fs.existsSync(configPath)) {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return { ...DEFAULT_CONFIG, ...raw, briefs: { ...DEFAULT_CONFIG.briefs, ...raw.briefs }, alerts: { ...DEFAULT_CONFIG.alerts, ...raw.alerts } };
    }
  } catch (err) {
    console.error("[alerts] Failed to load config:", err);
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig() {
  if (!configPath) return;
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
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

async function gatherSection(name: string): Promise<string> {
  try {
    switch (name) {
      case "calendar": {
        if (!calendar.isConfigured()) return "**Calendar:** [not connected]";
        const now = new Date();
        const endOfDay = new Date(now);
        endOfDay.setHours(23, 59, 59, 999);
        const result = await calendar.listEvents({ timeMin: now.toISOString(), timeMax: endOfDay.toISOString(), maxResults: 10 });
        return `**Today's Calendar:**\n${result}`;
      }
      case "calendar_tomorrow": {
        if (!calendar.isConfigured()) return "**Calendar:** [not connected]";
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        const endTomorrow = new Date(tomorrow);
        endTomorrow.setHours(23, 59, 59, 999);
        const result = await calendar.listEvents({ timeMin: tomorrow.toISOString(), timeMax: endTomorrow.toISOString(), maxResults: 10 });
        return `**Tomorrow's Calendar:**\n${result}`;
      }
      case "tasks": {
        const localTasks = tasks.listTasks();
        let vaultTasks = "";
        if (obsidian.isConfigured()) {
          try {
            const listing = await obsidian.listNotes("Tasks & TODOs/");
            const parsed = JSON.parse(listing);
            const files: string[] = (parsed.files || [])
              .filter((f: string) => f.endsWith(".md"))
              .slice(0, 10);
            const reads: string[] = [];
            for (const file of files) {
              try {
                const content = await obsidian.readNote(`Tasks & TODOs/${file}`);
                const label = file.replace(/\.md$/i, "");
                reads.push(`**${label}:**\n${content.slice(0, 500)}`);
              } catch {}
            }
            if (reads.length > 0) vaultTasks = reads.join("\n\n");
          } catch {}
        }
        const parts = [`**Local Tasks:**\n${localTasks}`];
        if (vaultTasks) parts.push(`**Vault Tasks:**\n${vaultTasks}`);
        return parts.join("\n\n");
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

  return sections.join("\n\n---\n\n");
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
      saveConfig();

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
            alertedCalendarEvents.add(eventKey);
            broadcastFn?.({
              type: "alert",
              alertType: "calendar",
              title: "Upcoming Event",
              content: line.trim().replace(/^\d+\.\s*/, ""),
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
    saveConfig();
  }

  if (config.alerts.taskDeadline.enabled) {
    try {
      const todayKey = getTodayKey();
      const taskList = tasks.listTasks();
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
        for (const match of idMatches) {
          const emailId = match[1];
          if (!alertedEmailIds.has(emailId)) {
            alertedEmailIds.add(emailId);
            if (initialAlertCheckDone) {
              const lineIdx = result.indexOf(`[${emailId}]`);
              const lineStart = result.lastIndexOf("\n", lineIdx) + 1;
              const lineEnd = result.indexOf("\n", lineIdx);
              const emailLine = result.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim();
              broadcastFn?.({
                type: "alert",
                alertType: "email",
                title: "Important Email",
                content: emailLine.replace(/^\d+\.\s*\*?\s*/, ""),
                timestamp: now.toISOString(),
              });
            }
          }
        }
      }
    } catch (err) {
      console.error("[alerts] Email alert check failed:", err);
    }
  }
}

export function startAlertSystem(broadcast: BroadcastFn) {
  broadcastFn = broadcast;

  briefInterval = setInterval(() => {
    checkBriefs().catch(err => console.error("[alerts] Brief check error:", err));
  }, 60_000);

  alertInterval = setInterval(() => {
    checkAlerts().catch(err => console.error("[alerts] Alert check error:", err));
  }, 15 * 60_000);

  console.log(`[alerts] System started — briefs: morning=${config.briefs.morning.enabled}/${config.briefs.morning.hour}:${String(config.briefs.morning.minute).padStart(2, "0")}, afternoon=${config.briefs.afternoon.enabled}/${config.briefs.afternoon.hour}:${String(config.briefs.afternoon.minute).padStart(2, "0")}, evening=${config.briefs.evening.enabled}/${config.briefs.evening.hour}:${String(config.briefs.evening.minute).padStart(2, "0")} (${config.timezone})`);
  console.log(`[alerts] Watchlist: ${config.watchlist.map(w => w.displaySymbol || w.symbol).join(", ")}`);

  alertedCalendarEvents.clear();
  alertedEmailIds.clear();
  initialAlertCheckDone = false;

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
