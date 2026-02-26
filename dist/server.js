// server.ts
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { fileURLToPath } from "url";
import path5 from "path";
import fs5 from "fs";
import { createProxyMiddleware } from "http-proxy-middleware";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import {
  createAgentSession,
  AuthStorage,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// src/obsidian.ts
var obsidianApiUrl = process.env.OBSIDIAN_API_URL ?? "";
var OBSIDIAN_API_KEY = process.env.OBSIDIAN_API_KEY ?? "";
function setApiUrl(url) {
  obsidianApiUrl = url.replace(/\/+$/, "");
}
function headers() {
  return {
    Authorization: `Bearer ${OBSIDIAN_API_KEY}`,
    Accept: "application/json"
  };
}
function baseUrl() {
  return obsidianApiUrl.replace(/\/+$/, "");
}
function encodePath(p) {
  return p.replace(/^\//, "").split("/").map(encodeURIComponent).join("/");
}
function isConfigured() {
  return !!(obsidianApiUrl && OBSIDIAN_API_KEY);
}
async function listNotes(dirPath = "/") {
  const url = `${baseUrl()}/vault/${encodePath(dirPath)}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify(data, null, 2);
}
async function readNote(notePath) {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const res = await fetch(url, {
    headers: { ...headers(), Accept: "text/markdown" }
  });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  return await res.text();
}
async function createNote(notePath, content) {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers(), "Content-Type": "text/markdown" },
    body: content
  });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  return `Created note: ${notePath}`;
}
async function appendToNote(notePath, content) {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      ...headers(),
      "Content-Type": "text/markdown",
      "Content-Insertion-Position": "end"
    },
    body: content
  });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  return `Appended to note: ${notePath}`;
}
async function searchNotes(query) {
  const url = `${baseUrl()}/search/simple/?query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify(data, null, 2);
}

// src/conversations.ts
import fs from "fs";
import path from "path";
var dataDir = "";
function init(dir) {
  dataDir = dir;
  fs.mkdirSync(dataDir, { recursive: true });
}
function filePath(id) {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(dataDir, `${safe}.json`);
}
function save(conv) {
  conv.updatedAt = Date.now();
  fs.writeFileSync(filePath(conv.id), JSON.stringify(conv, null, 2));
}
function load(id) {
  const fp = filePath(id);
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return null;
  }
}
function list() {
  if (!fs.existsSync(dataDir)) return [];
  const files = fs.readdirSync(dataDir).filter((f) => f.endsWith(".json"));
  const summaries = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, file), "utf-8"));
      summaries.push({
        id: raw.id,
        title: raw.title,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        messageCount: raw.messages.length
      });
    } catch {
    }
  }
  summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  return summaries;
}
function remove(id) {
  const fp = filePath(id);
  if (!fs.existsSync(fp)) return false;
  fs.unlinkSync(fp);
  return true;
}
function getRecentSummary(count = 3) {
  const recent = list().slice(0, count);
  if (recent.length === 0) return "";
  const lines = recent.map((c) => {
    const date = new Date(c.createdAt).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric"
    });
    return `- "${c.title}" (${date}, ${c.messageCount} messages)`;
  });
  return `Recent conversations:
${lines.join("\n")}`;
}
function createConversation(sessionId) {
  return {
    id: sessionId,
    title: "New conversation",
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}
function addMessage(conv, role, text) {
  conv.messages.push({ role, text, timestamp: Date.now() });
  if (conv.title === "New conversation" && role === "user" && text.trim()) {
    conv.title = text.trim().slice(0, 60);
  }
  conv.updatedAt = Date.now();
}

// src/gmail.ts
import { google } from "googleapis";
import fs2 from "fs";
import path2 from "path";
var SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar"
];
var tokenFilePath = "";
var projectRoot = "";
function init2(root) {
  projectRoot = root;
  tokenFilePath = path2.join(root, "data", "gmail-tokens.json");
  fs2.mkdirSync(path2.dirname(tokenFilePath), { recursive: true });
}
function isConfigured2() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
function isConnected() {
  if (!isConfigured2()) return false;
  try {
    const tokens = loadTokens();
    return !!(tokens && tokens.refresh_token);
  } catch {
    return false;
  }
}
function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = getRedirectUri();
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}
function getRedirectUri() {
  if (process.env.GMAIL_REDIRECT_URI) {
    return process.env.GMAIL_REDIRECT_URI;
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}/api/gmail/callback`;
  }
  if (process.env.REPLIT_DOMAINS) {
    const domain = process.env.REPLIT_DOMAINS.split(",")[0];
    return `https://${domain}/api/gmail/callback`;
  }
  const port = process.env.PORT || "3000";
  return `http://localhost:${port}/api/gmail/callback`;
}
function getAuthUrl() {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent"
  });
}
async function handleCallback(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  saveTokens(tokens);
}
function saveTokens(tokens) {
  fs2.writeFileSync(tokenFilePath, JSON.stringify(tokens, null, 2));
}
function loadTokens() {
  if (!fs2.existsSync(tokenFilePath)) return null;
  try {
    return JSON.parse(fs2.readFileSync(tokenFilePath, "utf-8"));
  } catch {
    return null;
  }
}
async function getGmailClient() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Gmail not connected");
  }
  const client = getOAuth2Client();
  client.setCredentials(tokens);
  client.on("tokens", (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    saveTokens(merged);
  });
  const isExpired = !tokens.expiry_date || Date.now() >= tokens.expiry_date - 6e4;
  if (isExpired) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      const merged = { ...tokens, ...credentials };
      saveTokens(merged);
    } catch (err) {
      if (err.message?.includes("invalid_grant")) {
        throw new Error("Gmail authorization expired \u2014 need to reconnect");
      }
      throw err;
    }
  }
  return google.gmail({ version: "v1", auth: client });
}
function decodeHeader(headers2, name) {
  const h = headers2.find((h2) => h2.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}
function decodeBody(payload) {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf-8");
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf-8");
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        const html = Buffer.from(part.body.data, "base64url").toString("utf-8");
        return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
    for (const part of payload.parts) {
      const nested = decodeBody(part);
      if (nested) return nested;
    }
  }
  return "";
}
async function listEmails(query, maxResults = 10) {
  try {
    const gmail = await getGmailClient();
    const params = {
      userId: "me",
      maxResults: Math.min(maxResults, 20)
    };
    if (query) params.q = query;
    const listRes = await gmail.users.messages.list(params);
    const messageRefs = listRes.data.messages || [];
    if (messageRefs.length === 0) {
      return query ? `No emails found matching "${query}".` : "Inbox is empty.";
    }
    const details = await Promise.all(
      messageRefs.map(async (ref) => {
        const msg = await gmail.users.messages.get({
          userId: "me",
          id: ref.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"]
        });
        const headers2 = msg.data.payload?.headers || [];
        return {
          id: ref.id,
          from: decodeHeader(headers2, "From"),
          subject: decodeHeader(headers2, "Subject") || "(no subject)",
          date: decodeHeader(headers2, "Date"),
          snippet: msg.data.snippet || "",
          unread: (msg.data.labelIds || []).includes("UNREAD")
        };
      })
    );
    const lines = details.map((e, i) => {
      const marker = e.unread ? "*" : " ";
      return `${marker} ${i + 1}. [${e.id}]
   From: ${e.from}
   Subject: ${e.subject}
   Date: ${e.date}
   Preview: ${e.snippet}`;
    });
    const header = query ? `Emails matching "${query}" (${details.length}):` : `Recent emails (${details.length}):`;
    return `${header}
(* = unread)

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail listEmails error:", msg);
    if (msg.includes("not connected")) {
      return "Gmail is not connected. Please connect your Gmail account first.";
    }
    if (msg.includes("invalid_grant") || msg.includes("Token has been expired") || msg.includes("authorization expired")) {
      return "Gmail authorization has expired. Rickin needs to visit /api/gmail/auth in the browser to reconnect.";
    }
    return `Unable to check emails right now: ${msg}`;
  }
}
async function readEmail(messageId) {
  try {
    const gmail = await getGmailClient();
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full"
    });
    const headers2 = msg.data.payload?.headers || [];
    const from = decodeHeader(headers2, "From");
    const to = decodeHeader(headers2, "To");
    const subject = decodeHeader(headers2, "Subject") || "(no subject)";
    const date = decodeHeader(headers2, "Date");
    const body = decodeBody(msg.data.payload) || "(no readable content)";
    const truncatedBody = body.length > 3e3 ? body.slice(0, 3e3) + "\n\n[...truncated]" : body;
    return `From: ${from}
To: ${to}
Subject: ${subject}
Date: ${date}

${truncatedBody}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail readEmail error:", msg);
    if (msg.includes("not connected")) {
      return "Gmail is not connected. Please connect your Gmail account first.";
    }
    if (msg.includes("404") || msg.includes("Not Found")) {
      return "That email could not be found. It may have been deleted.";
    }
    if (msg.includes("invalid_grant") || msg.includes("authorization expired")) {
      return "Gmail authorization has expired. Rickin needs to visit /api/gmail/auth in the browser to reconnect.";
    }
    return `Unable to read this email right now: ${msg}`;
  }
}
async function searchEmails(query) {
  return listEmails(query, 10);
}

// src/calendar.ts
import { google as google2 } from "googleapis";
import fs3 from "fs";
import path3 from "path";
var tokenFilePath2 = "";
function init3(root) {
  tokenFilePath2 = path3.join(root, "data", "gmail-tokens.json");
}
function getOAuth2Client2() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || "";
  return new google2.auth.OAuth2(clientId, clientSecret, redirectUri);
}
function loadTokens2() {
  if (!fs3.existsSync(tokenFilePath2)) return null;
  try {
    return JSON.parse(fs3.readFileSync(tokenFilePath2, "utf-8"));
  } catch {
    return null;
  }
}
function saveTokens2(tokens) {
  fs3.writeFileSync(tokenFilePath2, JSON.stringify(tokens, null, 2));
}
async function getCalendarClient() {
  const tokens = loadTokens2();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Google not connected \u2014 need to authorize first");
  }
  const client = getOAuth2Client2();
  client.setCredentials(tokens);
  client.on("tokens", (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    saveTokens2(merged);
  });
  const isExpired = !tokens.expiry_date || Date.now() >= tokens.expiry_date - 6e4;
  if (isExpired) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      saveTokens2({ ...tokens, ...credentials });
    } catch (err) {
      if (err.message?.includes("invalid_grant")) {
        throw new Error("Google authorization expired \u2014 need to reconnect");
      }
      throw err;
    }
  }
  return google2.calendar({ version: "v3", auth: client });
}
function isConfigured3() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
async function listEvents(options) {
  try {
    const calendar = await getCalendarClient();
    const now = /* @__PURE__ */ new Date();
    const params = {
      calendarId: "primary",
      timeMin: options?.timeMin || now.toISOString(),
      maxResults: options?.maxResults || 10,
      singleEvents: true,
      orderBy: "startTime"
    };
    if (options?.timeMax) params.timeMax = options.timeMax;
    const res = await calendar.events.list(params);
    const events = res.data.items || [];
    if (events.length === 0) return "No upcoming events found.";
    const lines = events.map((event, i) => {
      const start = event.start?.dateTime ? new Date(event.start.dateTime).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : event.start?.date || "TBD";
      const end = event.end?.dateTime ? new Date(event.end.dateTime).toLocaleString("en-US", { hour: "numeric", minute: "2-digit" }) : "";
      const location = event.location ? `
   Location: ${event.location}` : "";
      const desc = event.description ? `
   ${event.description.slice(0, 100).replace(/\n/g, " ")}` : "";
      return `${i + 1}. ${event.summary || "(No title)"}
   ${start}${end ? ` - ${end}` : ""}${location}${desc}`;
    });
    return `Upcoming events (${events.length}):

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Calendar listEvents error:", msg);
    if (msg.includes("authorization expired") || msg.includes("invalid_grant")) {
      return "Google authorization has expired. Rickin needs to reconnect at /api/gmail/auth.";
    }
    if (msg.includes("insufficient")) {
      return "Calendar access not authorized. Rickin needs to reconnect at /api/gmail/auth to grant calendar permissions.";
    }
    return `Unable to fetch calendar events: ${msg}`;
  }
}
async function createEvent(summary, options) {
  try {
    const calendar = await getCalendarClient();
    let start;
    let end;
    if (options.allDay) {
      start = { date: options.startTime.split("T")[0] };
      const endDate = options.endTime ? options.endTime.split("T")[0] : options.startTime.split("T")[0];
      const d = new Date(endDate);
      d.setDate(d.getDate() + 1);
      end = { date: d.toISOString().split("T")[0] };
    } else {
      start = { dateTime: options.startTime, timeZone: "America/New_York" };
      if (options.endTime) {
        end = { dateTime: options.endTime, timeZone: "America/New_York" };
      } else {
        const endTime = new Date(new Date(options.startTime).getTime() + 60 * 60 * 1e3);
        end = { dateTime: endTime.toISOString(), timeZone: "America/New_York" };
      }
    }
    const event = {
      summary,
      start,
      end
    };
    if (options.description) event.description = options.description;
    if (options.location) event.location = options.location;
    const res = await calendar.events.insert({
      calendarId: "primary",
      requestBody: event
    });
    const created = res.data;
    const startStr = created.start?.dateTime ? new Date(created.start.dateTime).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : created.start?.date || "";
    return `Created event: "${summary}" on ${startStr}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Calendar createEvent error:", msg);
    if (msg.includes("authorization expired") || msg.includes("invalid_grant")) {
      return "Google authorization has expired. Rickin needs to reconnect at /api/gmail/auth.";
    }
    if (msg.includes("insufficient") || msg.includes("Forbidden")) {
      return "Calendar write access not authorized. Rickin needs to reconnect at /api/gmail/auth to grant calendar permissions.";
    }
    return `Unable to create event: ${msg}`;
  }
}

// src/weather.ts
var WMO_CODES = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail"
};
async function geocode(location) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const r = data.results?.[0];
  if (!r) return null;
  return { name: r.name, lat: r.latitude, lon: r.longitude, country: r.country || "", timezone: r.timezone || "auto" };
}
async function getWeather(location) {
  try {
    const geo = await geocode(location);
    if (!geo) return `Could not find location "${location}". Try a city name like "New York" or "London".`;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,winddirection_10m,relative_humidity_2m,uv_index&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=${encodeURIComponent(geo.timezone)}&forecast_days=3`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather API error ${res.status}`);
    const data = await res.json();
    const c = data.current;
    if (!c) return `Could not get weather data for "${location}".`;
    const condition = WMO_CODES[c.weathercode] || "Unknown";
    const locationLabel = `${geo.name}${geo.country ? `, ${geo.country}` : ""}`;
    let result = `Current weather for ${locationLabel}:
`;
    result += `  Condition: ${condition}
`;
    result += `  Temperature: ${Math.round(c.temperature_2m)}\xB0F
`;
    result += `  Feels like: ${Math.round(c.apparent_temperature)}\xB0F
`;
    result += `  Humidity: ${c.relative_humidity_2m}%
`;
    result += `  Wind: ${Math.round(c.windspeed_10m)} mph
`;
    if (c.uv_index !== void 0) result += `  UV Index: ${c.uv_index}
`;
    const daily = data.daily;
    if (daily?.time?.length > 0) {
      result += `
3-Day Forecast:
`;
      for (let i = 0; i < daily.time.length; i++) {
        const date = daily.time[i];
        const hi = Math.round(daily.temperature_2m_max[i]);
        const lo = Math.round(daily.temperature_2m_min[i]);
        const desc = WMO_CODES[daily.weathercode[i]] || "Unknown";
        const rain = daily.precipitation_probability_max[i];
        result += `  ${date}: ${desc}, ${lo}-${hi}\xB0F, Rain: ${rain}%
`;
      }
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Weather error:", msg);
    return `Unable to get weather for "${location}": ${msg}`;
  }
}

// src/websearch.ts
async function search(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; pi-assistant/1.0)"
      }
    });
    if (!res.ok) throw new Error(`Search error ${res.status}`);
    const html = await res.text();
    const results = [];
    const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>.*?<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;
    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < 8) {
      const rawUrl = match[1];
      const title = match[2].replace(/<[^>]+>/g, "").trim();
      const snippet = match[3].replace(/<[^>]+>/g, "").trim();
      let decodedUrl = rawUrl;
      const uddg = rawUrl.match(/uddg=([^&]+)/);
      if (uddg) {
        decodedUrl = decodeURIComponent(uddg[1]);
      }
      if (title && snippet) {
        results.push({ title, url: decodedUrl, snippet });
      }
    }
    if (results.length === 0) {
      const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gs;
      const titleRegex = /<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/gs;
      const titles = [];
      const snippets = [];
      let m;
      while ((m = titleRegex.exec(html)) !== null && titles.length < 8) {
        titles.push(m[1].replace(/<[^>]+>/g, "").trim());
      }
      while ((m = snippetRegex.exec(html)) !== null && snippets.length < 8) {
        snippets.push(m[1].replace(/<[^>]+>/g, "").trim());
      }
      for (let i = 0; i < Math.min(titles.length, snippets.length); i++) {
        results.push({ title: titles[i], url: "", snippet: snippets[i] });
      }
    }
    if (results.length === 0) {
      return `No search results found for "${query}".`;
    }
    const lines = results.map(
      (r, i) => `${i + 1}. ${r.title}
   ${r.snippet}${r.url ? `
   URL: ${r.url}` : ""}`
    );
    return `Search results for "${query}":

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Web search error:", msg);
    return `Unable to search for "${query}": ${msg}`;
  }
}

// src/tasks.ts
import fs4 from "fs";
import path4 from "path";
var tasksFilePath = "";
function init4(root) {
  const dataDir2 = path4.join(root, "data");
  fs4.mkdirSync(dataDir2, { recursive: true });
  tasksFilePath = path4.join(dataDir2, "tasks.json");
}
function loadTasks() {
  if (!fs4.existsSync(tasksFilePath)) return [];
  try {
    return JSON.parse(fs4.readFileSync(tasksFilePath, "utf-8"));
  } catch {
    return [];
  }
}
function saveTasks(tasks) {
  fs4.writeFileSync(tasksFilePath, JSON.stringify(tasks, null, 2));
}
function generateId() {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}
function addTask(title, options) {
  const tasks = loadTasks();
  const task = {
    id: generateId(),
    title,
    description: options?.description,
    dueDate: options?.dueDate,
    priority: options?.priority || "medium",
    completed: false,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    tags: options?.tags
  };
  tasks.push(task);
  saveTasks(tasks);
  return `Added task: "${title}"${task.dueDate ? ` (due: ${task.dueDate})` : ""}${task.priority !== "medium" ? ` [${task.priority} priority]` : ""}`;
}
function listTasks(filter) {
  const tasks = loadTasks();
  let filtered = tasks;
  if (!filter?.showCompleted) {
    filtered = filtered.filter((t) => !t.completed);
  }
  if (filter?.tag) {
    filtered = filtered.filter((t) => t.tags?.includes(filter.tag));
  }
  if (filter?.priority) {
    filtered = filtered.filter((t) => t.priority === filter.priority);
  }
  if (filtered.length === 0) {
    return filter?.showCompleted ? "No tasks found." : "No open tasks. You're all caught up!";
  }
  filtered.sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    if (priorityOrder[a.priority] !== priorityOrder[b.priority]) return priorityOrder[a.priority] - priorityOrder[b.priority];
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });
  const lines = filtered.map((t, i) => {
    const status = t.completed ? "[x]" : "[ ]";
    const priority = t.priority === "high" ? " !!" : t.priority === "low" ? " ~" : "";
    const due = t.dueDate ? ` (due: ${t.dueDate})` : "";
    const tags = t.tags?.length ? ` [${t.tags.join(", ")}]` : "";
    return `${i + 1}. ${status} ${t.title}${priority}${due}${tags}
   ID: ${t.id}${t.description ? `
   ${t.description}` : ""}`;
  });
  const openCount = filtered.filter((t) => !t.completed).length;
  const doneCount = filtered.filter((t) => t.completed).length;
  let header = `Tasks (${openCount} open`;
  if (doneCount > 0) header += `, ${doneCount} completed`;
  header += "):";
  return `${header}

${lines.join("\n\n")}`;
}
function completeTask(taskId) {
  const tasks = loadTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return `Task not found: ${taskId}`;
  if (task.completed) return `Task already completed: "${task.title}"`;
  task.completed = true;
  task.completedAt = (/* @__PURE__ */ new Date()).toISOString();
  saveTasks(tasks);
  return `Completed task: "${task.title}"`;
}
function deleteTask(taskId) {
  const tasks = loadTasks();
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return `Task not found: ${taskId}`;
  const removed = tasks.splice(idx, 1)[0];
  saveTasks(tasks);
  return `Deleted task: "${removed.title}"`;
}
function updateTask(taskId, updates) {
  const tasks = loadTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return `Task not found: ${taskId}`;
  if (updates.title) task.title = updates.title;
  if (updates.description !== void 0) task.description = updates.description;
  if (updates.dueDate !== void 0) task.dueDate = updates.dueDate;
  if (updates.priority) task.priority = updates.priority;
  if (updates.tags) task.tags = updates.tags;
  saveTasks(tasks);
  return `Updated task: "${task.title}"`;
}

// src/news.ts
var RSS_FEEDS = {
  "top": "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en",
  "world": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "business": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "technology": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "science": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp0Y1RjU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "health": "https://news.google.com/rss/topics/CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FtVnVLQUFQAQ?hl=en-US&gl=US&ceid=US:en",
  "sports": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en",
  "entertainment": "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en"
};
function parseRssItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < 10) {
    const block = match[1];
    const title = block.match(/<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/)?.[1] || block.match(/<title>(.*?)<\/title>/)?.[1] || "";
    const link = block.match(/<link>(.*?)<\/link>/)?.[1] || "";
    const desc = block.match(/<description><!\[CDATA\[(.*?)\]\]>|<description>(.*?)<\/description>/)?.[1] || "";
    const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || "";
    const source = block.match(/<source[^>]*>(.*?)<\/source>/)?.[1] || "";
    const cleanDesc = desc.replace(/<[^>]+>/g, "").trim();
    const cleanTitle = title.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    if (cleanTitle) {
      items.push({
        title: cleanTitle,
        link,
        description: cleanDesc.slice(0, 200),
        pubDate,
        source
      });
    }
  }
  return items;
}
async function getNews(category) {
  try {
    const cat = (category || "top").toLowerCase();
    const feedUrl = RSS_FEEDS[cat];
    if (!feedUrl) {
      const available = Object.keys(RSS_FEEDS).join(", ");
      return `Unknown category "${category}". Available categories: ${available}`;
    }
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "pi-assistant/1.0" }
    });
    if (!res.ok) throw new Error(`News feed error ${res.status}`);
    const xml = await res.text();
    const items = parseRssItems(xml);
    if (items.length === 0) return `No news articles found for "${cat}".`;
    const lines = items.map((item, i) => {
      const source = item.source ? ` (${item.source})` : "";
      const date = item.pubDate ? new Date(item.pubDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
      return `${i + 1}. ${item.title}${source}
   ${date}${item.description ? ` \u2014 ${item.description}` : ""}`;
    });
    const catLabel = cat.charAt(0).toUpperCase() + cat.slice(1);
    return `${catLabel} News Headlines:

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("News error:", msg);
    return `Unable to fetch news: ${msg}`;
  }
}
async function searchNews(query) {
  try {
    const feedUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "pi-assistant/1.0" }
    });
    if (!res.ok) throw new Error(`News search error ${res.status}`);
    const xml = await res.text();
    const items = parseRssItems(xml);
    if (items.length === 0) return `No news articles found for "${query}".`;
    const lines = items.map((item, i) => {
      const source = item.source ? ` (${item.source})` : "";
      const date = item.pubDate ? new Date(item.pubDate).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
      return `${i + 1}. ${item.title}${source}
   ${date}${item.description ? ` \u2014 ${item.description}` : ""}`;
    });
    return `News about "${query}":

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("News search error:", msg);
    return `Unable to search news for "${query}": ${msg}`;
  }
}

// server.ts
var PORT = parseInt(process.env.PORT || "3000", 10);
var INTERVIEW_PORT = parseInt(process.env.INTERVIEW_PORT || "19847", 10);
var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
var APP_PASSWORD = process.env.APP_PASSWORD || "";
var SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
var __filename = fileURLToPath(import.meta.url);
var __dirname = path5.dirname(__filename);
var PROJECT_ROOT = __filename.includes("/dist/") ? path5.resolve(__dirname, "..") : __dirname;
var PUBLIC_DIR = path5.join(PROJECT_ROOT, "public");
var AGENT_DIR = path5.join(PROJECT_ROOT, ".pi/agent");
var DATA_DIR = path5.join(PROJECT_ROOT, "data", "conversations");
fs5.mkdirSync(AGENT_DIR, { recursive: true });
init(DATA_DIR);
init2(PROJECT_ROOT);
init3(PROJECT_ROOT);
init4(PROJECT_ROOT);
if (!ANTHROPIC_KEY) console.warn("ANTHROPIC_API_KEY is not set.");
if (!isConfigured()) console.warn("Knowledge base integration not configured.");
if (!isConfigured2()) console.warn("Gmail integration not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing).");
else if (!isConnected()) console.warn("Gmail configured but not yet authorized. Visit /api/gmail/auth to connect.");
if (!APP_PASSWORD) console.warn("APP_PASSWORD is not set \u2014 auth disabled.");
console.log(`[boot] PORT=${PORT} PUBLIC_DIR=${PUBLIC_DIR} AGENT_DIR=${AGENT_DIR}`);
console.log(`[boot] public/ exists: ${fs5.existsSync(PUBLIC_DIR)}`);
function buildKnowledgeBaseTools() {
  if (!isConfigured()) return [];
  return [
    {
      name: "notes_list",
      label: "Notes List",
      description: "List files and folders in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Directory path inside the knowledge base. Defaults to root." }))
      }),
      async execute(_toolCallId, params) {
        const result = await listNotes(params.path ?? "/");
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "notes_read",
      label: "Notes Read",
      description: "Read the markdown content of a note in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the note, e.g. 'Daily Notes/2025-01-15.md'" })
      }),
      async execute(_toolCallId, params) {
        const result = await readNote(params.path);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "notes_create",
      label: "Notes Create",
      description: "Create or overwrite a note in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.String({ description: "Path for the new note, e.g. 'Ideas/new-idea.md'" }),
        content: Type.String({ description: "Markdown content for the note" })
      }),
      async execute(_toolCallId, params) {
        const result = await createNote(params.path, params.content);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "notes_append",
      label: "Notes Append",
      description: "Append content to the end of an existing note in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the note to append to" }),
        content: Type.String({ description: "Markdown content to append" })
      }),
      async execute(_toolCallId, params) {
        const result = await appendToNote(params.path, params.content);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "notes_search",
      label: "Notes Search",
      description: "Search for text across all notes in the user's knowledge base. Returns matching notes and snippets.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query string" })
      }),
      async execute(_toolCallId, params) {
        const result = await searchNotes(params.query);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildGmailTools() {
  if (!isConfigured2()) return [];
  return [
    {
      name: "email_list",
      label: "Email List",
      description: "List recent emails from the user's inbox. Optionally filter with a Gmail search query (e.g. 'is:unread', 'from:someone@example.com', 'subject:meeting').",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Gmail search query to filter emails. Uses Gmail search syntax." })),
        maxResults: Type.Optional(Type.Number({ description: "Maximum number of emails to return (default 10, max 20)." }))
      }),
      async execute(_toolCallId, params) {
        const result = await listEmails(params.query, params.maxResults ?? 10);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_read",
      label: "Email Read",
      description: "Read the full content of a specific email by its message ID. Use email_list first to find the ID.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID to read (from email_list results)." })
      }),
      async execute(_toolCallId, params) {
        const result = await readEmail(params.messageId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_search",
      label: "Email Search",
      description: "Search emails using Gmail search syntax. Supports queries like 'from:name subject:topic after:2025/01/01 has:attachment'.",
      parameters: Type.Object({
        query: Type.String({ description: "Gmail search query string." })
      }),
      async execute(_toolCallId, params) {
        const result = await searchEmails(params.query);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildWeatherTools() {
  return [
    {
      name: "weather_get",
      label: "Weather",
      description: "Get current weather conditions and 3-day forecast for a location. Use city names, zip codes, or landmarks.",
      parameters: Type.Object({
        location: Type.String({ description: "Location to get weather for (e.g. 'New York', '90210', 'Tokyo')" })
      }),
      async execute(_toolCallId, params) {
        const result = await getWeather(params.location);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildSearchTools() {
  return [
    {
      name: "web_search",
      label: "Web Search",
      description: "Search the web for real-time information. Returns top results with titles, snippets, and URLs.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" })
      }),
      async execute(_toolCallId, params) {
        const result = await search(params.query);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildCalendarTools() {
  if (!isConfigured3()) return [];
  return [
    {
      name: "calendar_list",
      label: "Calendar Events",
      description: "List upcoming calendar events. Can filter by date range.",
      parameters: Type.Object({
        maxResults: Type.Optional(Type.Number({ description: "Maximum number of events to return (default 10)" })),
        timeMin: Type.Optional(Type.String({ description: "Start of date range in ISO 8601 format (defaults to now)" })),
        timeMax: Type.Optional(Type.String({ description: "End of date range in ISO 8601 format" }))
      }),
      async execute(_toolCallId, params) {
        const result = await listEvents(params);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "calendar_create",
      label: "Create Event",
      description: "Create a new calendar event.",
      parameters: Type.Object({
        summary: Type.String({ description: "Event title" }),
        startTime: Type.String({ description: "Start time in ISO 8601 format (e.g. '2025-03-15T14:00:00')" }),
        endTime: Type.Optional(Type.String({ description: "End time in ISO 8601 format (defaults to 1 hour after start)" })),
        description: Type.Optional(Type.String({ description: "Event description" })),
        location: Type.Optional(Type.String({ description: "Event location" })),
        allDay: Type.Optional(Type.Boolean({ description: "Whether this is an all-day event" }))
      }),
      async execute(_toolCallId, params) {
        const { summary, ...options } = params;
        const result = await createEvent(summary, options);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildTaskTools() {
  return [
    {
      name: "task_add",
      label: "Add Task",
      description: "Add a new task or to-do item with optional due date, priority, and tags.",
      parameters: Type.Object({
        title: Type.String({ description: "Task title" }),
        description: Type.Optional(Type.String({ description: "Task description or details" })),
        dueDate: Type.Optional(Type.String({ description: "Due date in YYYY-MM-DD format" })),
        priority: Type.Optional(Type.String({ description: "Priority: 'low', 'medium', or 'high' (default: medium)" })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" }))
      }),
      async execute(_toolCallId, params) {
        const { title, ...options } = params;
        const result = addTask(title, options);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "task_list",
      label: "List Tasks",
      description: "List tasks and to-do items. Shows open tasks by default.",
      parameters: Type.Object({
        showCompleted: Type.Optional(Type.Boolean({ description: "Include completed tasks (default: false)" })),
        tag: Type.Optional(Type.String({ description: "Filter by tag" })),
        priority: Type.Optional(Type.String({ description: "Filter by priority: 'low', 'medium', 'high'" }))
      }),
      async execute(_toolCallId, params) {
        const result = listTasks(params);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "task_complete",
      label: "Complete Task",
      description: "Mark a task as completed.",
      parameters: Type.Object({
        taskId: Type.String({ description: "The task ID to complete" })
      }),
      async execute(_toolCallId, params) {
        const result = completeTask(params.taskId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "task_delete",
      label: "Delete Task",
      description: "Delete a task permanently.",
      parameters: Type.Object({
        taskId: Type.String({ description: "The task ID to delete" })
      }),
      async execute(_toolCallId, params) {
        const result = deleteTask(params.taskId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "task_update",
      label: "Update Task",
      description: "Update an existing task's details.",
      parameters: Type.Object({
        taskId: Type.String({ description: "The task ID to update" }),
        title: Type.Optional(Type.String({ description: "New title" })),
        description: Type.Optional(Type.String({ description: "New description" })),
        dueDate: Type.Optional(Type.String({ description: "New due date in YYYY-MM-DD format" })),
        priority: Type.Optional(Type.String({ description: "New priority: 'low', 'medium', 'high'" })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "New tags" }))
      }),
      async execute(_toolCallId, params) {
        const { taskId, ...updates } = params;
        const result = updateTask(taskId, updates);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildNewsTools() {
  return [
    {
      name: "news_headlines",
      label: "News Headlines",
      description: "Get latest news headlines by category. Categories: top, world, business, technology, science, health, sports, entertainment.",
      parameters: Type.Object({
        category: Type.Optional(Type.String({ description: "News category (default: 'top'). Options: top, world, business, technology, science, health, sports, entertainment" }))
      }),
      async execute(_toolCallId, params) {
        const result = await getNews(params.category);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "news_search",
      label: "Search News",
      description: "Search for news articles about a specific topic.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query for news articles" })
      }),
      async execute(_toolCallId, params) {
        const result = await searchNews(params.query);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
var sessions = /* @__PURE__ */ new Map();
function saveAndCleanSession(id) {
  const entry = sessions.get(id);
  if (!entry) return;
  if (entry.currentAgentText) {
    addMessage(entry.conversation, "agent", entry.currentAgentText);
    entry.currentAgentText = "";
  }
  if (entry.conversation.messages.length > 0) {
    save(entry.conversation);
  }
  for (const sub of entry.subscribers) {
    try {
      sub.end();
    } catch {
    }
  }
  entry.subscribers.clear();
  sessions.delete(id);
}
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1e3;
  for (const [id, entry] of sessions.entries()) {
    if (entry.createdAt < cutoff) {
      saveAndCleanSession(id);
    }
  }
}, 10 * 60 * 1e3);
setInterval(() => {
  for (const entry of sessions.values()) {
    if (entry.currentAgentText) {
      addMessage(entry.conversation, "agent", entry.currentAgentText);
      entry.currentAgentText = "";
    }
    if (entry.conversation.messages.length > 0) {
      save(entry.conversation);
    }
  }
}, 5 * 60 * 1e3);
var app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser(SESSION_SECRET));
var AUTH_PUBLIC_PATHS = /* @__PURE__ */ new Set(["/login.html", "/login.css", "/api/login", "/health"]);
function authMiddleware(req, res, next) {
  if (!APP_PASSWORD) {
    next();
    return;
  }
  if (AUTH_PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }
  if (req.path === "/api/config/tunnel-url") {
    next();
    return;
  }
  if (req.path === "/api/gmail/callback") {
    next();
    return;
  }
  if (req.path === "/api/gmail/auth") {
    next();
    return;
  }
  const token = req.signedCookies?.auth;
  if (token === "authenticated") {
    next();
    return;
  }
  if (req.headers.accept?.includes("text/html") || req.path === "/") {
    res.redirect("/login.html");
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
}
app.use(authMiddleware);
app.post("/api/login", (req, res) => {
  const { password } = req.body;
  if (!password || password !== APP_PASSWORD) {
    res.status(401).json({ error: "ACCESS DENIED" });
    return;
  }
  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie("auth", "authenticated", {
    signed: true,
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1e3
  });
  res.json({ ok: true });
});
app.get("/api/logout", (_req, res) => {
  res.clearCookie("auth");
  res.redirect("/login.html");
});
app.use(express.static(PUBLIC_DIR));
app.use(
  "/interview",
  createProxyMiddleware({
    target: `http://localhost:${INTERVIEW_PORT}`,
    changeOrigin: true,
    on: {
      error: (_err, _req, res) => {
        try {
          if ("writeHead" in res && typeof res.status === "function") {
            res.status(502).json({ error: "Interview tool is not running." });
          }
        } catch {
        }
      }
    }
  })
);
app.get("/api/gmail/auth", (_req, res) => {
  if (!isConfigured2()) {
    res.status(500).json({ error: "Gmail not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET." });
    return;
  }
  const url = getAuthUrl();
  res.redirect(url);
});
app.get("/api/gmail/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) {
    res.status(400).send("Missing authorization code.");
    return;
  }
  try {
    await handleCallback(code);
    res.send(`<html><body style="background:#000;color:#0f0;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>[GMAIL CONNECTED]</h2><p>Authorization successful. You can close this tab.</p><script>setTimeout(()=>window.close(),2000)</script></div></body></html>`);
  } catch (err) {
    console.error("Gmail callback error:", err);
    res.status(500).send("Gmail authorization failed. Please try again.");
  }
});
app.get("/api/gmail/status", (_req, res) => {
  res.json({
    configured: isConfigured2(),
    connected: isConnected()
  });
});
app.post("/api/session", async (_req, res) => {
  try {
    const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const authStorage = AuthStorage.create(path5.join(AGENT_DIR, "auth.json"));
    authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_KEY);
    const allTools = [
      ...buildKnowledgeBaseTools(),
      ...buildGmailTools(),
      ...buildCalendarTools(),
      ...buildWeatherTools(),
      ...buildSearchTools(),
      ...buildTaskTools(),
      ...buildNewsTools()
    ];
    console.log(`[session] ${allTools.length} tools registered`);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: PROJECT_ROOT,
      agentDir: AGENT_DIR,
      settingsManager,
      noSkills: true,
      noExtensions: true
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      agentDir: AGENT_DIR,
      authStorage,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      resourceLoader,
      tools: [],
      customTools: allTools
    });
    const conv = createConversation(sessionId);
    const entry = {
      session,
      subscribers: /* @__PURE__ */ new Set(),
      createdAt: Date.now(),
      conversation: conv,
      currentAgentText: ""
    };
    sessions.set(sessionId, entry);
    session.subscribe((event) => {
      const data = JSON.stringify(event);
      for (const sub of entry.subscribers) {
        try {
          sub.write(`data: ${data}

`);
        } catch {
        }
      }
      if (event.type === "message_update") {
        const ae = event.assistantMessageEvent;
        if (ae?.type === "text_delta" && ae.delta) {
          entry.currentAgentText += ae.delta;
        }
      }
      if (event.type === "agent_end") {
        if (entry.currentAgentText) {
          addMessage(entry.conversation, "agent", entry.currentAgentText);
          entry.currentAgentText = "";
        }
      }
    });
    const recentSummary = getRecentSummary(5);
    res.json({ sessionId, recentContext: recentSummary || null });
  } catch (err) {
    console.error("Failed to create session:", err);
    res.status(500).json({ error: String(err) });
  }
});
app.get("/api/session/:id/stream", (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15e3);
  entry.subscribers.add(res);
  req.on("close", () => {
    clearInterval(heartbeat);
    entry.subscribers.delete(res);
  });
});
app.post("/api/session/:id/prompt", async (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const { message } = req.body;
  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  addMessage(entry.conversation, "user", message.trim());
  res.json({ ok: true });
  try {
    await entry.session.prompt(message);
  } catch (err) {
    console.error("Prompt error:", err);
    const errEvent = JSON.stringify({ type: "error", error: String(err) });
    for (const sub of entry.subscribers) {
      try {
        sub.write(`data: ${errEvent}

`);
      } catch {
      }
    }
  }
});
app.delete("/api/session/:id", (req, res) => {
  saveAndCleanSession(req.params["id"]);
  res.json({ ok: true });
});
app.get("/api/conversations", (_req, res) => {
  res.json(list());
});
app.get("/api/conversations/:id", (req, res) => {
  const conv = load(req.params["id"]);
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.json(conv);
});
app.delete("/api/conversations/:id", (req, res) => {
  remove(req.params["id"]);
  res.json({ ok: true });
});
app.post("/api/config/tunnel-url", (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.OBSIDIAN_API_KEY}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { url } = req.body;
  if (!url?.startsWith("https://")) {
    res.status(400).json({ error: "url must be an https:// URL" });
    return;
  }
  setApiUrl(url);
  console.log(`Tunnel URL updated to: ${url}`);
  res.json({ ok: true, url });
});
app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: sessions.size, ts: Date.now() });
});
app.use((err, _req, res, _next) => {
  console.error("Express error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});
process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));
var server = createServer(app);
function gracefulShutdown(signal) {
  console.error(`Got ${signal} \u2014 closing server...`);
  for (const [id] of sessions.entries()) {
    saveAndCleanSession(id);
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(1);
  }, 3e3);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[ready] pi-replit listening on http://localhost:${PORT}`);
});
