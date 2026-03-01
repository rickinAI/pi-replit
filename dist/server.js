// server.ts
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { fileURLToPath } from "url";
import path8 from "path";
import fs8 from "fs";
import { execSync } from "child_process";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import {
  createAgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// src/obsidian.ts
var obsidianApiUrl = process.env.OBSIDIAN_API_URL ?? "";
var OBSIDIAN_API_KEY = process.env.OBSIDIAN_API_KEY ?? "";
var FETCH_TIMEOUT_MS = 1e4;
var MAX_RETRIES = 2;
var RETRY_DELAY_MS = 1e3;
var RETRYABLE_STATUSES = /* @__PURE__ */ new Set([502, 503, 504]);
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
async function fetchWithRetry(url, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok || !RETRYABLE_STATUSES.has(res.status)) {
        return res;
      }
      lastError = new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === "AbortError") {
        lastError = new Error("Knowledge base request timed out (10s)");
      } else {
        lastError = new Error(`Knowledge base connection failed: ${err.message}`);
      }
    }
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
    }
  }
  throw lastError;
}
async function ping() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5e3);
    const res = await fetch(`${baseUrl()}/`, { headers: headers(), signal: controller.signal });
    clearTimeout(timeout);
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}
async function listNotes(dirPath = "/") {
  const url = `${baseUrl()}/vault/${encodePath(dirPath)}`;
  const res = await fetchWithRetry(url, { headers: headers() });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify(data, null, 2);
}
async function readNote(notePath) {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const res = await fetchWithRetry(url, {
    headers: { ...headers(), Accept: "text/markdown" }
  });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  return await res.text();
}
async function createNote(notePath, content) {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const res = await fetchWithRetry(url, {
    method: "PUT",
    headers: { ...headers(), "Content-Type": "text/markdown" },
    body: content
  });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  return `Created note: ${notePath}`;
}
async function appendToNote(notePath, content) {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        ...headers(),
        "Content-Type": "text/markdown",
        "Content-Insertion-Position": "end"
      },
      body: content,
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
    return `Appended to note: ${notePath}`;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Knowledge base request timed out (10s)");
    throw err;
  }
}
async function searchNotes(query) {
  const url = `${baseUrl()}/search/simple/?query=${encodeURIComponent(query)}`;
  const res = await fetchWithRetry(url, { headers: headers() });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return JSON.stringify(data, null, 2);
}

// src/vault-local.ts
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
var vaultPath = "";
function init(basePath) {
  vaultPath = basePath;
}
function isConfigured2() {
  if (!vaultPath) return false;
  try {
    return fsSync.existsSync(vaultPath) && fsSync.readdirSync(vaultPath).length > 0;
  } catch {
    return false;
  }
}
async function listNotes2(dirPath = "/") {
  const resolved = resolvePath(dirPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new Error(`Path not found: ${dirPath}`);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${dirPath}`);
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = path.join(dirPath === "/" ? "" : dirPath, entry.name);
    files.push(entry.isDirectory() ? rel + "/" : rel);
  }
  return JSON.stringify({ files }, null, 2);
}
async function readNote2(notePath) {
  const resolved = resolvePath(notePath);
  try {
    return await fs.readFile(resolved, "utf-8");
  } catch {
    throw new Error(`Note not found: ${notePath}`);
  }
}
async function createNote2(notePath, content) {
  const resolved = resolvePath(notePath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(resolved, content, "utf-8");
  return `Created note: ${notePath}`;
}
async function appendToNote2(notePath, content) {
  const resolved = resolvePath(notePath);
  try {
    await fs.access(resolved);
  } catch {
    throw new Error(`Note not found: ${notePath}`);
  }
  await fs.appendFile(resolved, content, "utf-8");
  return `Appended to note: ${notePath}`;
}
async function searchNotes2(query) {
  if (!query || query.trim().length === 0) {
    return JSON.stringify([], null, 2);
  }
  const results = [];
  const queryLower = query.toLowerCase();
  async function walkDir(dir, relBase) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const promises = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        promises.push(walkDir(fullPath, relPath));
      } else if (entry.name.endsWith(".md")) {
        promises.push((async () => {
          try {
            const content = await fs.readFile(fullPath, "utf-8");
            const contentLower = content.toLowerCase();
            const matches = [];
            let idx = 0;
            while ((idx = contentLower.indexOf(queryLower, idx)) !== -1) {
              const start = Math.max(0, idx - 50);
              const end = Math.min(content.length, idx + query.length + 50);
              matches.push({
                match: { start: idx, end: idx + query.length },
                context: content.substring(start, end)
              });
              idx += query.length;
              if (matches.length >= 5) break;
            }
            if (matches.length > 0) {
              results.push({ filename: relPath, matches });
            }
          } catch {
          }
        })());
      }
    }
    await Promise.all(promises);
  }
  await walkDir(vaultPath, "");
  return JSON.stringify(results, null, 2);
}
function resolvePath(p) {
  const cleaned = p.replace(/^\/+/, "");
  const resolved = path.resolve(vaultPath, cleaned);
  const relative = path.relative(vaultPath, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path traversal not allowed");
  }
  return resolved;
}

// src/conversations.ts
import fs2 from "fs";
import path2 from "path";
var dataDir = "";
function init2(dir) {
  dataDir = dir;
  fs2.mkdirSync(dataDir, { recursive: true });
}
function filePath(id) {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return path2.join(dataDir, `${safe}.json`);
}
function save(conv) {
  conv.updatedAt = Date.now();
  fs2.writeFileSync(filePath(conv.id), JSON.stringify(conv, null, 2));
}
function load(id) {
  const fp = filePath(id);
  if (!fs2.existsSync(fp)) return null;
  try {
    return JSON.parse(fs2.readFileSync(fp, "utf-8"));
  } catch {
    return null;
  }
}
function list() {
  if (!fs2.existsSync(dataDir)) return [];
  const files = fs2.readdirSync(dataDir).filter((f) => f.endsWith(".json"));
  const summaries = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(fs2.readFileSync(path2.join(dataDir, file), "utf-8"));
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
  if (!fs2.existsSync(fp)) return false;
  fs2.unlinkSync(fp);
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
function addMessage(conv, role, text, images) {
  const msg = { role, text, timestamp: Date.now() };
  if (images && images.length > 0) {
    msg.images = images;
  }
  conv.messages.push(msg);
  if (conv.title === "New conversation" && role === "user" && text.trim()) {
    conv.title = text.trim().slice(0, 60);
  }
  conv.updatedAt = Date.now();
}
function search(query, options) {
  if (!fs2.existsSync(dataDir)) return [];
  const files = fs2.readdirSync(dataDir).filter((f) => f.endsWith(".json"));
  const results = [];
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  const limit = options?.limit ?? 10;
  for (const file of files) {
    try {
      const conv = JSON.parse(fs2.readFileSync(path2.join(dataDir, file), "utf-8"));
      if (options?.before && conv.createdAt > options.before) continue;
      if (options?.after && conv.createdAt < options.after) continue;
      const snippets = [];
      for (const msg of conv.messages) {
        if (msg.role === "system") continue;
        const lower = msg.text.toLowerCase();
        if (terms.some((t) => lower.includes(t))) {
          const snippet = msg.text.slice(0, 200);
          const role = msg.role === "user" ? "You" : "Agent";
          const time = new Date(msg.timestamp).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
          snippets.push(`[${role}, ${time}] ${snippet}`);
          if (snippets.length >= 3) break;
        }
      }
      if (snippets.length > 0) {
        results.push({
          id: conv.id,
          title: conv.title,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          messageCount: conv.messages.length,
          snippets
        });
      }
    } catch {
    }
  }
  results.sort((a, b) => b.updatedAt - a.updatedAt);
  return results.slice(0, limit);
}
function shouldSync(conv) {
  const userMessages = conv.messages.filter((m) => m.role === "user");
  return userMessages.length >= 4;
}
function generateSummaryMarkdown(conv) {
  const date = new Date(conv.createdAt).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric"
  });
  const time = new Date(conv.createdAt).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit"
  });
  const userMsgs = conv.messages.filter((m) => m.role === "user").map((m) => m.text.trim());
  const agentMsgs = conv.messages.filter((m) => m.role === "agent").map((m) => m.text.trim());
  const topicLines = userMsgs.slice(0, 8).map((t) => `- ${t.slice(0, 120)}`).join("\n");
  let keyPoints = "";
  for (const a of agentMsgs) {
    const lines = a.split("\n").filter((l) => l.trim().length > 10);
    for (const line of lines.slice(0, 2)) {
      keyPoints += `- ${line.trim().slice(0, 150)}
`;
    }
    if (keyPoints.split("\n").length > 6) break;
  }
  return `# ${conv.title}

**Date:** ${date} at ${time}
**Messages:** ${conv.messages.length}

## Topics Discussed
${topicLines}

## Key Points
${keyPoints.trim() || "- General discussion"}

---
*Session ID: ${conv.id}*
`;
}

// src/gmail.ts
import { google } from "googleapis";
import fs3 from "fs";
import path3 from "path";
var SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar"
];
var tokenFilePath = "";
var projectRoot = "";
function init3(root) {
  projectRoot = root;
  tokenFilePath = path3.join(root, "data", "gmail-tokens.json");
  fs3.mkdirSync(path3.dirname(tokenFilePath), { recursive: true });
}
function isConfigured3() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
function isConnected() {
  if (!isConfigured3()) return false;
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
  fs3.writeFileSync(tokenFilePath, JSON.stringify(tokens, null, 2));
}
function loadTokens() {
  if (!fs3.existsSync(tokenFilePath)) return null;
  try {
    return JSON.parse(fs3.readFileSync(tokenFilePath, "utf-8"));
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
async function getUnreadCount() {
  try {
    const client = await getGmailClient();
    const res = await client.users.messages.list({
      userId: "me",
      q: "is:unread newer_than:1d category:primary",
      maxResults: 1
    });
    return res.data.resultSizeEstimate || 0;
  } catch {
    try {
      const client = await getGmailClient();
      const res = await client.users.messages.list({
        userId: "me",
        q: "is:unread newer_than:1d",
        maxResults: 1
      });
      return res.data.resultSizeEstimate || 0;
    } catch (err) {
      console.error("Gmail getUnreadCount error:", err instanceof Error ? err.message : err);
      return 0;
    }
  }
}
async function getConnectedEmail() {
  try {
    const client = await getGmailClient();
    const profile = await client.users.getProfile({ userId: "me" });
    return profile.data.emailAddress || null;
  } catch {
    return null;
  }
}

// src/calendar.ts
import { google as google2 } from "googleapis";
import fs4 from "fs";
import path4 from "path";
var tokenFilePath2 = "";
function init4(root) {
  tokenFilePath2 = path4.join(root, "data", "gmail-tokens.json");
}
function getOAuth2Client2() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || "";
  return new google2.auth.OAuth2(clientId, clientSecret, redirectUri);
}
function loadTokens2() {
  if (!fs4.existsSync(tokenFilePath2)) return null;
  try {
    return JSON.parse(fs4.readFileSync(tokenFilePath2, "utf-8"));
  } catch {
    return null;
  }
}
function saveTokens2(tokens) {
  fs4.writeFileSync(tokenFilePath2, JSON.stringify(tokens, null, 2));
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
function isConfigured4() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
async function listEvents(options) {
  try {
    const cal = await getCalendarClient();
    const now = /* @__PURE__ */ new Date();
    const timeMin = options?.timeMin || now.toISOString();
    const maxResults = options?.maxResults || 10;
    let calendarIds = ["primary"];
    try {
      const calList = await cal.calendarList.list({ minAccessRole: "reader" });
      const items = calList.data.items || [];
      if (items.length > 0) {
        calendarIds = items.filter((c) => c.selected !== false).map((c) => c.id).filter(Boolean);
        if (calendarIds.length === 0) calendarIds = ["primary"];
      }
      console.log(`[calendar] Querying ${calendarIds.length} calendar(s): ${calendarIds.join(", ")}`);
    } catch (err) {
      console.log("[calendar] Could not list calendars, falling back to primary");
    }
    console.log(`[calendar] Query range: ${timeMin} to ${options?.timeMax || "open-ended"}`);
    const allEvents = [];
    for (const calId of calendarIds) {
      try {
        const params = {
          calendarId: calId,
          timeMin,
          maxResults,
          singleEvents: true,
          orderBy: "startTime"
        };
        if (options?.timeMax) params.timeMax = options.timeMax;
        const res = await cal.events.list(params);
        const items = res.data.items || [];
        allEvents.push(...items);
      } catch (err) {
        console.log(`[calendar] Failed to query calendar ${calId}:`, err instanceof Error ? err.message : String(err));
      }
    }
    allEvents.sort((a, b) => {
      const aTime = a.start?.dateTime || a.start?.date || "";
      const bTime = b.start?.dateTime || b.start?.date || "";
      return aTime.localeCompare(bTime);
    });
    const events = allEvents.slice(0, maxResults);
    console.log(`[calendar] Found ${allEvents.length} event(s), returning ${events.length}`);
    if (events.length === 0) return "No upcoming events found.";
    const lines = events.map((event, i) => {
      const start = event.start?.dateTime ? new Date(event.start.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : event.start?.date || "TBD";
      const end = event.end?.dateTime ? new Date(event.end.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "";
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
    const startStr = created.start?.dateTime ? new Date(created.start.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : created.start?.date || "";
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
function cToF(c) {
  return Math.round(c * 9 / 5 + 32);
}
function tempStr(c) {
  return `${Math.round(c)}\xB0C (${cToF(c)}\xB0F)`;
}
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
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,winddirection_10m,relative_humidity_2m,uv_index&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max&temperature_unit=celsius&windspeed_unit=mph&timezone=${encodeURIComponent(geo.timezone)}&forecast_days=3`;
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
    result += `  Temperature: ${tempStr(c.temperature_2m)}
`;
    result += `  Feels like: ${tempStr(c.apparent_temperature)}
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
        const hiF = cToF(daily.temperature_2m_max[i]);
        const loF = cToF(daily.temperature_2m_min[i]);
        const desc = WMO_CODES[daily.weathercode[i]] || "Unknown";
        const rain = daily.precipitation_probability_max[i];
        result += `  ${date}: ${desc}, ${lo}-${hi}\xB0C (${loF}-${hiF}\xB0F), Rain: ${rain}%
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
async function search2(query) {
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
import fs5 from "fs";
import path5 from "path";
var tasksFilePath = "";
function init5(root) {
  const dataDir2 = path5.join(root, "data");
  fs5.mkdirSync(dataDir2, { recursive: true });
  tasksFilePath = path5.join(dataDir2, "tasks.json");
}
function loadTasks() {
  if (!fs5.existsSync(tasksFilePath)) return [];
  try {
    return JSON.parse(fs5.readFileSync(tasksFilePath, "utf-8"));
  } catch {
    return [];
  }
}
function saveTasks(tasks) {
  fs5.writeFileSync(tasksFilePath, JSON.stringify(tasks, null, 2));
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

// src/twitter.ts
var FXTWITTER_BASE = "https://api.fxtwitter.com";
var SYNDICATION_BASE = "https://syndication.twitter.com/srv/timeline-profile/screen-name";
var TIMEOUT_MS = 1e4;
function cleanUsername(input) {
  return input.replace(/^@/, "").replace(/^https?:\/\/(x\.com|twitter\.com)\//, "").replace(/\/.*$/, "").trim();
}
function extractTweetId(input) {
  const match = input.match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/);
  if (match) return match[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}
async function fetchWithTimeout(url, headers2 = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "pi-assistant/1.0", ...headers2 },
      signal: controller.signal
    });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("X request timed out");
    throw err;
  }
}
async function getUserProfile(username) {
  try {
    const handle = cleanUsername(username);
    const res = await fetchWithTimeout(`${FXTWITTER_BASE}/${handle}`);
    if (!res.ok) return `Could not find X user @${handle} (${res.status})`;
    const data = await res.json();
    const u = data.user;
    if (!u) return `Could not find X user @${handle}`;
    const parts = [
      `@${u.screen_name} (${u.name})`,
      u.description ? `Bio: ${u.description}` : null,
      u.location ? `Location: ${u.location}` : null,
      `Followers: ${(u.followers || 0).toLocaleString()} | Following: ${(u.following || 0).toLocaleString()}`,
      `Tweets: ${(u.tweets || 0).toLocaleString()}`,
      u.website ? `Website: ${u.website.url || u.website}` : null,
      u.joined ? `Joined: ${u.joined}` : null,
      `Profile: ${u.url}`
    ];
    return parts.filter(Boolean).join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching X profile: ${msg}`;
  }
}
async function getTweet(tweetInput) {
  try {
    const tweetId = extractTweetId(tweetInput);
    if (!tweetId) return "Please provide a valid tweet URL or tweet ID.";
    const urlMatch = tweetInput.match(/(?:x\.com|twitter\.com)\/(\w+)\/status\//);
    const handle = urlMatch ? urlMatch[1] : "i";
    const res = await fetchWithTimeout(`${FXTWITTER_BASE}/${handle}/status/${tweetId}`);
    if (!res.ok) return `Could not find that tweet (${res.status})`;
    const data = await res.json();
    const t = data.tweet;
    if (!t) return "Tweet not found or may have been deleted.";
    const parts = [
      `@${t.author?.screen_name || "unknown"} (${t.author?.name || ""})`,
      t.text,
      "",
      `${(t.likes || 0).toLocaleString()} likes | ${(t.retweets || 0).toLocaleString()} retweets | ${(t.replies || 0).toLocaleString()} replies`,
      t.created_at ? `Posted: ${t.created_at}` : null,
      `Link: ${t.url || tweetInput}`
    ];
    if (t.media?.all?.length) {
      parts.push(`Media: ${t.media.all.length} attachment(s)`);
    }
    if (t.quote) {
      parts.push("", `Quoting @${t.quote.author?.screen_name || "unknown"}:`, t.quote.text);
    }
    return parts.filter((p) => p !== null).join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching tweet: ${msg}`;
  }
}
async function getUserTimeline(username, count = 10) {
  try {
    const handle = cleanUsername(username);
    const maxTweets = Math.min(count, 20);
    const res = await fetchWithTimeout(`${SYNDICATION_BASE}/${handle}`);
    if (!res.ok) return `Could not fetch timeline for @${handle} (${res.status})`;
    const html = await res.text();
    const tweets = [];
    const tweetRegex = /"full_text":"((?:[^"\\]|\\.)*)"/g;
    const nameRegex = /"name":"((?:[^"\\]|\\.)*)"/g;
    const screenNameRegex = /"screen_name":"((?:[^"\\]|\\.)*)"/g;
    const dateRegex = /"created_at":"((?:[^"\\]|\\.)*)"/g;
    const likeRegex = /"favorite_count":(\d+)/g;
    const rtRegex = /"retweet_count":(\d+)/g;
    const replyRegex = /"reply_count":(\d+)/g;
    const idRegex = /"id_str":"(\d+)"/g;
    const texts = [];
    const names = [];
    const screenNames = [];
    const dates = [];
    const likes = [];
    const rts = [];
    const replies = [];
    const ids = [];
    let m;
    while ((m = tweetRegex.exec(html)) !== null) texts.push(m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'));
    while ((m = nameRegex.exec(html)) !== null) names.push(m[1]);
    while ((m = screenNameRegex.exec(html)) !== null) screenNames.push(m[1]);
    while ((m = dateRegex.exec(html)) !== null) dates.push(m[1]);
    while ((m = likeRegex.exec(html)) !== null) likes.push(parseInt(m[1]));
    while ((m = rtRegex.exec(html)) !== null) rts.push(parseInt(m[1]));
    while ((m = replyRegex.exec(html)) !== null) replies.push(parseInt(m[1]));
    while ((m = idRegex.exec(html)) !== null) ids.push(m[1]);
    const seen = /* @__PURE__ */ new Set();
    for (let i = 0; i < texts.length && tweets.length < maxTweets; i++) {
      const text = texts[i];
      if (seen.has(text) || text.startsWith("RT @")) continue;
      seen.add(text);
      tweets.push({
        text,
        author: names[i] || handle,
        handle: screenNames[i] || handle,
        date: dates[i] ? new Date(dates[i]).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "",
        likes: likes[i] || 0,
        retweets: rts[i] || 0,
        replies: replies[i] || 0,
        url: ids[i] ? `https://x.com/${screenNames[i] || handle}/status/${ids[i]}` : ""
      });
    }
    if (tweets.length === 0) return `No recent tweets found for @${handle}. The account may be private or have no recent activity.`;
    const lines = tweets.map((t, i) => {
      const stats = `${t.likes.toLocaleString()} likes | ${t.retweets.toLocaleString()} RTs`;
      return `${i + 1}. @${t.handle} \u2014 ${t.date}
   ${t.text.slice(0, 280)}${t.text.length > 280 ? "..." : ""}
   ${stats}${t.url ? ` | ${t.url}` : ""}`;
    });
    return `Recent tweets from @${handle}:

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching timeline: ${msg}`;
  }
}

// src/stocks.ts
var TIMEOUT_MS2 = 1e4;
var CRYPTO_ALIASES = {
  btc: "bitcoin",
  bitcoin: "bitcoin",
  eth: "ethereum",
  ethereum: "ethereum",
  sol: "solana",
  solana: "solana",
  doge: "dogecoin",
  dogecoin: "dogecoin",
  ada: "cardano",
  cardano: "cardano",
  xrp: "ripple",
  ripple: "ripple",
  dot: "polkadot",
  polkadot: "polkadot",
  matic: "matic-network",
  polygon: "matic-network",
  avax: "avalanche-2",
  avalanche: "avalanche-2",
  link: "chainlink",
  chainlink: "chainlink",
  bnb: "binancecoin",
  binancecoin: "binancecoin",
  ltc: "litecoin",
  litecoin: "litecoin",
  shib: "shiba-inu",
  uni: "uniswap",
  uniswap: "uniswap",
  atom: "cosmos",
  cosmos: "cosmos",
  near: "near",
  apt: "aptos",
  aptos: "aptos",
  arb: "arbitrum",
  arbitrum: "arbitrum",
  op: "optimism",
  optimism: "optimism",
  sui: "sui",
  pepe: "pepe"
};
async function fetchWithTimeout2(url, headers2 = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS2);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "pi-assistant/1.0", ...headers2 },
      signal: controller.signal
    });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Request timed out");
    throw err;
  }
}
function formatNum(n) {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
function formatPrice(n) {
  if (n >= 1) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${n.toFixed(6)}`;
}
async function getStockQuote(symbol) {
  try {
    const ticker = symbol.toUpperCase().trim();
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d&includePrePost=false`;
    const res = await fetchWithTimeout2(url);
    if (!res.ok) {
      if (res.status === 404) return `Could not find stock symbol "${ticker}". Try using the ticker symbol (e.g. AAPL, TSLA, MSFT).`;
      throw new Error(`Yahoo Finance error ${res.status}`);
    }
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return `No data found for "${ticker}".`;
    const meta = result.meta;
    const price = meta.regularMarketPrice;
    if (price == null) return `No price data available for "${ticker}". The market may be closed or the symbol may be invalid.`;
    const prevClose = meta.chartPreviousClose || meta.previousClose;
    const currency = meta.currency || "USD";
    const exchange = meta.exchangeName || "";
    const name = meta.shortName || meta.longName || ticker;
    const change = prevClose ? price - prevClose : 0;
    const changePct = prevClose ? change / prevClose * 100 : 0;
    const arrow = change >= 0 ? "\u25B2" : "\u25BC";
    const sign = change >= 0 ? "+" : "";
    const indicators = result.indicators?.quote?.[0];
    const volumes = indicators?.volume || [];
    const lastVolume = volumes.filter((v) => v != null).pop();
    const lines = [
      `${name} (${ticker}) \u2014 ${exchange}`,
      `Price: ${formatPrice(price)} ${currency}`,
      `Change: ${sign}${change.toFixed(2)} (${sign}${changePct.toFixed(2)}%) ${arrow}`
    ];
    if (prevClose) lines.push(`Prev Close: ${formatPrice(prevClose)}`);
    const timestamps = result.timestamp || [];
    const closes = indicators?.close || [];
    if (timestamps.length > 0 && closes.length > 0) {
      const highs = indicators?.high || [];
      const lows = indicators?.low || [];
      const lastIdx = closes.length - 1;
      if (highs[lastIdx] != null && lows[lastIdx] != null) lines.push(`Day Range: ${formatPrice(lows[lastIdx])} \u2013 ${formatPrice(highs[lastIdx])}`);
    }
    if (lastVolume) lines.push(`Volume: ${lastVolume.toLocaleString("en-US")}`);
    const marketState = meta.marketState || "";
    if (marketState && marketState !== "REGULAR") {
      lines.push(`Market: ${marketState.replace(/_/g, " ").toLowerCase()}`);
    }
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Stock quote error:", msg);
    return `Unable to get stock quote for "${symbol}": ${msg}`;
  }
}
async function getCryptoPrice(coin) {
  try {
    const input = coin.toLowerCase().trim();
    const coinId = CRYPTO_ALIASES[input] || input;
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;
    const res = await fetchWithTimeout2(url);
    if (!res.ok) {
      if (res.status === 404) {
        const searchUrl = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(input)}`;
        const searchRes = await fetchWithTimeout2(searchUrl);
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          const coins = searchData.coins?.slice(0, 5);
          if (coins?.length > 0) {
            const suggestions = coins.map((c) => `${c.name} (${c.symbol.toUpperCase()})`).join(", ");
            return `Could not find "${coin}". Did you mean: ${suggestions}?`;
          }
        }
        return `Could not find cryptocurrency "${coin}". Try using the full name (e.g. "bitcoin") or ticker (e.g. "BTC").`;
      }
      throw new Error(`CoinGecko error ${res.status}`);
    }
    const data = await res.json();
    const market = data.market_data;
    if (!market) return `No market data for "${coin}".`;
    const price = market.current_price?.usd;
    if (price == null) return `No price data available for "${coin}".`;
    const change24h = market.price_change_percentage_24h;
    const change7d = market.price_change_percentage_7d;
    const marketCap = market.market_cap?.usd;
    const volume24h = market.total_volume?.usd;
    const high24h = market.high_24h?.usd;
    const low24h = market.low_24h?.usd;
    const ath = market.ath?.usd;
    const athChange = market.ath_change_percentage?.usd;
    const rank = data.market_cap_rank;
    const lines = [
      `${data.name} (${data.symbol.toUpperCase()})${rank ? ` \u2014 Rank #${rank}` : ""}`,
      `Price: ${formatPrice(price)}`
    ];
    if (change24h != null) {
      const arrow24 = change24h >= 0 ? "\u25B2" : "\u25BC";
      const sign24 = change24h >= 0 ? "+" : "";
      lines.push(`24h Change: ${sign24}${change24h.toFixed(2)}% ${arrow24}`);
    }
    if (change7d != null) {
      const sign7 = change7d >= 0 ? "+" : "";
      lines.push(`7d Change: ${sign7}${change7d.toFixed(2)}%`);
    }
    if (high24h != null && low24h != null) lines.push(`24h Range: ${formatPrice(low24h)} \u2013 ${formatPrice(high24h)}`);
    if (marketCap) lines.push(`Market Cap: ${formatNum(marketCap)}`);
    if (volume24h) lines.push(`24h Volume: ${formatNum(volume24h)}`);
    if (ath != null && athChange != null) lines.push(`ATH: ${formatPrice(ath)} (${athChange.toFixed(1)}% from ATH)`);
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Crypto price error:", msg);
    return `Unable to get crypto price for "${coin}": ${msg}`;
  }
}

// src/maps.ts
var TIMEOUT_MS3 = 1e4;
var NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
var OSRM_BASE = "https://router.project-osrm.org";
var UA = "pi-assistant/1.0 (personal-project)";
async function fetchWithTimeout3(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS3);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: controller.signal
    });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("Request timed out");
    throw err;
  }
}
async function geocode2(query) {
  const url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`;
  const res = await fetchWithTimeout3(url);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.length) return null;
  const r = data[0];
  return {
    name: r.name || r.display_name.split(",")[0],
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    displayName: r.display_name
  };
}
function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.round(seconds % 3600 / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins} min`;
}
function formatDistance(meters) {
  const miles = meters / 1609.34;
  if (miles >= 1) return `${miles.toFixed(1)} miles`;
  const feet = meters * 3.281;
  return `${Math.round(feet)} ft`;
}
function cleanInstruction(html) {
  return html.replace(/<[^>]+>/g, "").trim();
}
async function getDirections(from, to, mode) {
  try {
    const travelMode = (mode || "driving").toLowerCase();
    const osrmProfile = travelMode === "walking" || travelMode === "walk" ? "foot" : travelMode === "cycling" || travelMode === "bike" || travelMode === "bicycle" ? "bike" : "car";
    const [originGeo, destGeo] = await Promise.all([geocode2(from), geocode2(to)]);
    if (!originGeo) return `Could not find location "${from}". Try being more specific (e.g. include city/state).`;
    if (!destGeo) return `Could not find location "${to}". Try being more specific (e.g. include city/state).`;
    const url = `${OSRM_BASE}/route/v1/${osrmProfile === "car" ? "driving" : osrmProfile}/${originGeo.lon},${originGeo.lat};${destGeo.lon},${destGeo.lat}?overview=false&steps=true&geometries=geojson`;
    const res = await fetchWithTimeout3(url);
    if (!res.ok) throw new Error(`Routing error ${res.status}`);
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes?.length) {
      return `No route found from "${from}" to "${to}" by ${travelMode}. The locations may be on different continents or unreachable.`;
    }
    const route = data.routes[0];
    const totalDist = formatDistance(route.distance);
    const totalTime = formatDuration(route.duration);
    const lines = [
      `Directions from ${originGeo.name} to ${destGeo.name}`,
      `Mode: ${travelMode.charAt(0).toUpperCase() + travelMode.slice(1)}`,
      `Distance: ${totalDist}`,
      `Estimated time: ${totalTime}`,
      ""
    ];
    const steps = route.legs?.[0]?.steps || [];
    const significantSteps = steps.filter((s) => s.distance > 30 && s.maneuver?.type !== "arrive" && s.maneuver?.type !== "depart");
    const displaySteps = significantSteps.slice(0, 15);
    if (displaySteps.length > 0) {
      lines.push("Route:");
      displaySteps.forEach((step, i) => {
        const instruction = cleanInstruction(step.name || step.maneuver?.type || "Continue");
        const dist = formatDistance(step.distance);
        const modifier = step.maneuver?.modifier ? ` ${step.maneuver.modifier}` : "";
        const type = step.maneuver?.type || "";
        const action = type === "turn" ? `Turn${modifier}` : type === "merge" ? `Merge${modifier}` : type === "fork" ? `Take${modifier} fork` : type === "roundabout" ? "Enter roundabout" : type === "new name" ? "Continue" : type.charAt(0).toUpperCase() + type.slice(1);
        lines.push(`  ${i + 1}. ${action} onto ${instruction} (${dist})`);
      });
      if (significantSteps.length > 15) {
        lines.push(`  ... and ${significantSteps.length - 15} more steps`);
      }
    }
    lines.push("", `From: ${originGeo.displayName}`);
    lines.push(`To: ${destGeo.displayName}`);
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Directions error:", msg);
    return `Unable to get directions: ${msg}`;
  }
}
async function searchPlaces(query, near) {
  try {
    let url = `${NOMINATIM_BASE}/search?q=${encodeURIComponent(query)}&format=json&limit=8&addressdetails=1`;
    if (near) {
      const geo = await geocode2(near);
      if (geo) {
        const viewbox = `${geo.lon - 0.1},${geo.lat + 0.1},${geo.lon + 0.1},${geo.lat - 0.1}`;
        url += `&viewbox=${viewbox}&bounded=0`;
      }
    }
    const res = await fetchWithTimeout3(url);
    if (!res.ok) throw new Error(`Places search error ${res.status}`);
    const data = await res.json();
    if (!data.length) return `No places found for "${query}"${near ? ` near ${near}` : ""}.`;
    const lines = data.map((place, i) => {
      const name = place.name || place.display_name.split(",")[0];
      const type = place.type ? place.type.replace(/_/g, " ") : "";
      const address = place.display_name;
      return `${i + 1}. ${name}${type ? ` (${type})` : ""}
   ${address}`;
    });
    const header = near ? `Places matching "${query}" near ${near}:` : `Places matching "${query}":`;
    return `${header}

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Places search error:", msg);
    return `Unable to search places: ${msg}`;
  }
}

// src/alerts.ts
import fs6 from "fs";
import path6 from "path";
var DEFAULT_CONFIG = {
  timezone: "America/New_York",
  location: "New York",
  briefs: {
    morning: { enabled: true, hour: 8, minute: 0, content: ["calendar", "tasks", "weather", "news", "markets", "headlines", "email"] },
    afternoon: { enabled: true, hour: 13, minute: 0, content: ["calendar", "tasks", "email", "markets", "headlines"] },
    evening: { enabled: true, hour: 19, minute: 0, content: ["calendar_tomorrow", "tasks", "markets", "headlines", "email"] }
  },
  alerts: {
    calendarReminder: { enabled: true, minutesBefore: 30 },
    stockMove: { enabled: true, thresholdPercent: 3 },
    taskDeadline: { enabled: true },
    importantEmail: { enabled: true }
  },
  watchlist: [
    { symbol: "GC=F", type: "stock", displaySymbol: "GOLD" },
    { symbol: "SI=F", type: "stock", displaySymbol: "SILVER" },
    { symbol: "bitcoin", type: "crypto", displaySymbol: "BTCUSD" },
    { symbol: "MSTR", type: "stock" }
  ],
  theme: "dark",
  lastPrices: {},
  lastBriefRun: {}
};
var configPath = "";
var config = { ...DEFAULT_CONFIG };
var broadcastFn = null;
var briefInterval = null;
var alertInterval = null;
var alertedCalendarEvents = /* @__PURE__ */ new Set();
var alertedEmailIds = /* @__PURE__ */ new Set();
var initialAlertCheckDone = false;
var briefRunning = false;
var alertRunning = false;
var lastDedupeReset = "";
function init6(root) {
  const dataDir2 = path6.join(root, "data");
  fs6.mkdirSync(dataDir2, { recursive: true });
  configPath = path6.join(dataDir2, "alerts-config.json");
  config = loadConfig();
}
function loadConfig() {
  if (!configPath) return { ...DEFAULT_CONFIG };
  try {
    if (fs6.existsSync(configPath)) {
      const raw = JSON.parse(fs6.readFileSync(configPath, "utf-8"));
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
    fs6.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error("[alerts] Failed to save config:", err);
  }
}
function getConfig() {
  const { lastPrices, lastBriefRun, ...rest } = config;
  return rest;
}
function updateConfig(partial) {
  if (partial.timezone) config.timezone = partial.timezone;
  if (partial.location) config.location = partial.location;
  if (partial.briefs) {
    for (const key of ["morning", "afternoon", "evening"]) {
      if (partial.briefs[key]) {
        config.briefs[key] = { ...config.briefs[key], ...partial.briefs[key] };
      }
    }
  }
  if (partial.alerts) {
    for (const key of ["calendarReminder", "stockMove", "taskDeadline", "importantEmail"]) {
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
function getNow() {
  const nowStr = (/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: config.timezone });
  return new Date(nowStr);
}
function getTodayKey() {
  const now = getNow();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function getTzOffset(tz, refDate) {
  const utcStr = refDate.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = refDate.toLocaleString("en-US", { timeZone: tz });
  return new Date(tzStr).getTime() - new Date(utcStr).getTime();
}
function getDateInTimezone(tz, daysOffset = 0) {
  const now = /* @__PURE__ */ new Date();
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
async function gatherSection(name) {
  try {
    switch (name) {
      case "calendar": {
        if (!isConfigured4()) return "**Calendar:** [not connected]";
        const now = /* @__PURE__ */ new Date();
        const { end: endOfDay } = getDateInTimezone(config.timezone, 0);
        console.log(`[alerts] Calendar today query: ${now.toISOString()} to ${endOfDay.toISOString()}`);
        const result = await listEvents({ timeMin: now.toISOString(), timeMax: endOfDay.toISOString(), maxResults: 10 });
        return `**Today's Calendar:**
${result}`;
      }
      case "calendar_tomorrow": {
        if (!isConfigured4()) return "**Calendar:** [not connected]";
        const { start: tomorrow, end: endTomorrow } = getDateInTimezone(config.timezone, 1);
        console.log(`[alerts] Calendar tomorrow query: ${tomorrow.toISOString()} to ${endTomorrow.toISOString()}`);
        const result = await listEvents({ timeMin: tomorrow.toISOString(), timeMax: endTomorrow.toISOString(), maxResults: 10 });
        return `**Tomorrow's Calendar:**
${result}`;
      }
      case "tasks": {
        const localTasks = listTasks();
        return `**Tasks:**
${localTasks}`;
      }
      case "weather": {
        const result = await getWeather(config.location);
        return `**Weather:**
${result}`;
      }
      case "news": {
        const [top, finance, tech] = await Promise.allSettled([
          getNews("top"),
          getNews("business"),
          getNews("technology")
        ]);
        const sections = [];
        if (top.status === "fulfilled") {
          const lines = top.value.split("\n").slice(0, 12).join("\n");
          sections.push(`**Top Headlines:**
${lines}`);
        }
        if (finance.status === "fulfilled") {
          const lines = finance.value.split("\n").slice(0, 12).join("\n");
          sections.push(`**Finance Headlines:**
${lines}`);
        }
        if (tech.status === "fulfilled") {
          const lines = tech.value.split("\n").slice(0, 12).join("\n");
          sections.push(`**Technology Headlines:**
${lines}`);
        }
        return sections.join("\n\n") || "**News:** [unavailable]";
      }
      case "markets": {
        const items = [];
        for (const w of config.watchlist) {
          try {
            const label = w.displaySymbol || w.symbol.toUpperCase();
            if (w.type === "crypto") {
              const data = await getCryptoPrice(w.symbol);
              const priceLine = data.split("\n").slice(0, 3).join(" | ");
              items.push(`${label}: ${priceLine}`);
            } else {
              const data = await getStockQuote(w.symbol);
              const priceLine = data.split("\n").slice(0, 3).join(" | ");
              items.push(`${label}: ${priceLine}`);
            }
          } catch {
            items.push(`${w.displaySymbol || w.symbol}: [unavailable]`);
          }
        }
        return `**Markets:**
${items.join("\n")}`;
      }
      case "headlines": {
        try {
          const topNews = await getNews("top");
          const items = topNews.split("\n").filter((l) => /^\d+\./.test(l)).slice(0, 5);
          const bullets = items.map((line) => {
            const cleaned = line.replace(/^\d+\.\s*/, "");
            return `\u2022 ${cleaned}`;
          });
          return `**Top Headlines:**
${bullets.join("\n")}`;
        } catch {
          return "**Top Headlines:** [unavailable]";
        }
      }
      case "email": {
        if (!isConfigured3() || !isConnected()) return "**Email:** [not connected]";
        try {
          const result = await listEmails("is:unread", 5);
          const cleaned = result.replace(/\s*\[[a-f0-9]+\]/gi, "").replace(/\(\* = unread\)\n?/g, "").replace(/^\* /gm, "").replace(/\n{3,}/g, "\n\n");
          return `**Email:**
${cleaned}`;
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
async function generateBrief(type) {
  const briefConfig = config.briefs[type];
  const sections = [];
  const results = await Promise.allSettled(
    briefConfig.content.map((name) => gatherSection(name))
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
  for (const type of ["morning", "afternoon", "evening"]) {
    const briefConfig = config.briefs[type];
    if (!briefConfig.enabled) continue;
    const runKey = `${type}_${todayKey}`;
    if (config.lastBriefRun[runKey]) continue;
    const targetMinutes = briefConfig.hour * 60 + briefConfig.minute;
    const nowMinutes = currentHour * 60 + currentMinute;
    if (nowMinutes >= targetMinutes && nowMinutes <= targetMinutes + 2) {
      console.log(`[alerts] Triggering ${type} brief`);
      config.lastBriefRun[runKey] = (/* @__PURE__ */ new Date()).toISOString();
      saveConfig();
      try {
        const content = await generateBrief(type);
        const event = {
          type: "brief",
          briefType: type,
          content,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
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
  const now = /* @__PURE__ */ new Date();
  if (config.alerts.calendarReminder.enabled && isConfigured4()) {
    try {
      const minutesBefore = config.alerts.calendarReminder.minutesBefore || 30;
      const windowEnd = new Date(now.getTime() + minutesBefore * 60 * 1e3);
      const result = await listEvents({ timeMin: now.toISOString(), timeMax: windowEnd.toISOString(), maxResults: 5 });
      if (!result.includes("No upcoming events")) {
        const lines = result.split("\n").filter((l) => l.trim());
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
              timestamp: now.toISOString()
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
        let currentPrice = null;
        if (w.type === "crypto") {
          const data = await getCryptoPrice(w.symbol);
          const priceMatch = data.match(/Price:\s*\$([0-9,]+\.?\d*)/);
          if (priceMatch) currentPrice = parseFloat(priceMatch[1].replace(/,/g, ""));
        } else {
          const data = await getStockQuote(w.symbol);
          const priceMatch = data.match(/Price:\s*\$([0-9,]+\.?\d*)/);
          if (priceMatch) currentPrice = parseFloat(priceMatch[1].replace(/,/g, ""));
        }
        if (currentPrice !== null) {
          const lastPrice = config.lastPrices[label];
          if (lastPrice) {
            const pctChange = (currentPrice - lastPrice) / lastPrice * 100;
            if (Math.abs(pctChange) >= threshold) {
              const direction = pctChange > 0 ? "UP" : "DOWN";
              const arrow = pctChange > 0 ? "\u25B2" : "\u25BC";
              broadcastFn?.({
                type: "alert",
                alertType: "stock",
                title: `${label} ${direction} ${Math.abs(pctChange).toFixed(1)}%`,
                content: `${label} moved ${arrow} ${Math.abs(pctChange).toFixed(1)}% \u2014 now $${currentPrice.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
                timestamp: now.toISOString()
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
      const taskList = listTasks();
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
                timestamp: now.toISOString()
              });
            }
          }
        }
      }
    } catch (err) {
      console.error("[alerts] Task alert check failed:", err);
    }
  }
  if (config.alerts.importantEmail.enabled && isConfigured3() && isConnected()) {
    try {
      const result = await listEmails("is:unread is:important", 5);
      if (!result.includes("No emails found") && !result.includes("not authorized")) {
        const idMatches = result.matchAll(/\[([a-f0-9]+)\]/gi);
        for (const match of idMatches) {
          const emailId = match[1];
          if (!alertedEmailIds.has(emailId)) {
            alertedEmailIds.add(emailId);
            if (initialAlertCheckDone) {
              const lineIdx = result.indexOf(`[${emailId}]`);
              const blockEnd = result.indexOf("\n\n", lineIdx);
              const block = result.slice(lineIdx, blockEnd === -1 ? void 0 : blockEnd);
              const fromMatch = block.match(/From:\s*(.+)/);
              const subjectMatch = block.match(/Subject:\s*(.+)/);
              const sender = fromMatch ? fromMatch[1].replace(/<[^>]+>/, "").trim() : "Unknown";
              const subject = subjectMatch ? subjectMatch[1].trim() : "No subject";
              broadcastFn?.({
                type: "alert",
                alertType: "email",
                title: sender,
                content: subject,
                timestamp: now.toISOString()
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
function startAlertSystem(broadcast) {
  broadcastFn = broadcast;
  briefInterval = setInterval(() => {
    checkBriefs().catch((err) => console.error("[alerts] Brief check error:", err));
  }, 6e4);
  alertInterval = setInterval(() => {
    checkAlerts().catch((err) => console.error("[alerts] Alert check error:", err));
  }, 15 * 6e4);
  console.log(`[alerts] System started \u2014 briefs: morning=${config.briefs.morning.enabled}/${config.briefs.morning.hour}:${String(config.briefs.morning.minute).padStart(2, "0")}, afternoon=${config.briefs.afternoon.enabled}/${config.briefs.afternoon.hour}:${String(config.briefs.afternoon.minute).padStart(2, "0")}, evening=${config.briefs.evening.enabled}/${config.briefs.evening.hour}:${String(config.briefs.evening.minute).padStart(2, "0")} (${config.timezone})`);
  console.log(`[alerts] Watchlist: ${config.watchlist.map((w) => w.displaySymbol || w.symbol).join(", ")}`);
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
  }, 3e4);
}
async function triggerBrief(type) {
  console.log(`[alerts] Manual trigger: ${type} brief`);
  const content = await generateBrief(type);
  const event = {
    type: "brief",
    briefType: type,
    content,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  broadcastFn?.(event);
  return event;
}

// src/agents/loader.ts
import fs7 from "fs";
import path7 from "path";
var agents = [];
var configPath2 = "";
function init7(dataDir2) {
  configPath2 = path7.join(dataDir2, "agents.json");
  loadAgents();
  let reloadTimer = null;
  try {
    fs7.watch(configPath2, () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        console.log("[agents] Config file changed \u2014 reloading");
        loadAgents();
        reloadTimer = null;
      }, 500);
    });
  } catch {
    console.warn("[agents] Could not watch agents.json \u2014 using periodic reload");
    setInterval(loadAgents, 6e4);
  }
}
function loadAgents() {
  try {
    const raw = fs7.readFileSync(configPath2, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error("[agents] agents.json must be an array");
      return;
    }
    const valid = [];
    for (const entry of parsed) {
      if (!entry.id || !entry.name || !entry.systemPrompt || !Array.isArray(entry.tools)) {
        console.warn(`[agents] Skipping malformed agent entry: ${JSON.stringify(entry.id || entry.name || "unknown")}`);
        continue;
      }
      valid.push({
        id: entry.id,
        name: entry.name,
        description: entry.description || "",
        systemPrompt: entry.systemPrompt,
        tools: entry.tools,
        enabled: entry.enabled !== false,
        timeout: entry.timeout || 120,
        model: entry.model || "default"
      });
    }
    agents = valid;
    console.log(`[agents] Loaded ${agents.length} agents: ${agents.map((a) => a.id).join(", ")}`);
  } catch (err) {
    console.error(`[agents] Failed to load agents.json: ${err.message}`);
  }
}
function getAgents() {
  return agents;
}
function getEnabledAgents() {
  return agents.filter((a) => a.enabled);
}
function getAgent(id) {
  return agents.find((a) => a.id === id);
}

// src/agents/orchestrator.ts
import Anthropic from "@anthropic-ai/sdk";
var MAX_TOOL_ITERATIONS = 15;
function convertToolsToAnthropicFormat(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: toJsonSchema(t.parameters)
  }));
}
function toJsonSchema(typeboxSchema) {
  if (!typeboxSchema) return { type: "object", properties: {} };
  const schema = JSON.parse(JSON.stringify(typeboxSchema));
  delete schema[/* @__PURE__ */ Symbol.for("TypeBox.Kind")];
  removeTypeBoxKeys(schema);
  return schema;
}
function removeTypeBoxKeys(obj) {
  if (!obj || typeof obj !== "object") return;
  for (const key of Object.keys(obj)) {
    if (key.startsWith("$") && key !== "$ref" && key !== "$defs") {
      delete obj[key];
    }
    removeTypeBoxKeys(obj[key]);
  }
}
async function runSubAgent(opts) {
  if (!opts.apiKey) throw new Error("Anthropic API key is not configured \u2014 cannot run sub-agents");
  const agent = getAgent(opts.agentId);
  if (!agent) throw new Error(`Agent "${opts.agentId}" not found. Use list_agents to see available agents.`);
  if (!agent.enabled) throw new Error(`Agent "${opts.agentId}" is currently disabled`);
  const startTime = Date.now();
  console.log(`[agent:${agent.id}] started \u2014 "${opts.task.slice(0, 80)}"`);
  const filteredTools = opts.allTools.filter((t) => agent.tools.includes(t.name));
  const anthropicTools = convertToolsToAnthropicFormat(filteredTools);
  const toolsUsed = [];
  const client = new Anthropic({ apiKey: opts.apiKey });
  const modelId = agent.model === "default" ? opts.model || "claude-sonnet-4-20250514" : agent.model;
  let userContent = opts.task;
  if (opts.context) userContent = `Context:
${opts.context}

Task:
${opts.task}`;
  const messages = [
    { role: "user", content: userContent }
  ];
  let totalInput = 0;
  let totalOutput = 0;
  let finalResponse = "";
  const timeoutMs = agent.timeout * 1e3;
  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    if (Date.now() - startTime > timeoutMs) {
      console.warn(`[agent:${agent.id}] timeout after ${agent.timeout}s`);
      break;
    }
    const apiResponse = await client.messages.create({
      model: modelId,
      max_tokens: 4096,
      system: agent.systemPrompt,
      tools: anthropicTools.length > 0 ? anthropicTools : void 0,
      messages
    });
    totalInput += apiResponse.usage?.input_tokens || 0;
    totalOutput += apiResponse.usage?.output_tokens || 0;
    const textBlocks = apiResponse.content.filter((b) => b.type === "text");
    const toolBlocks = apiResponse.content.filter((b) => b.type === "tool_use");
    if (textBlocks.length > 0) {
      finalResponse = textBlocks.map((b) => b.text).join("\n");
    }
    if (apiResponse.stop_reason === "end_turn" || toolBlocks.length === 0) {
      break;
    }
    messages.push({ role: "assistant", content: apiResponse.content });
    const toolResults = [];
    for (const toolCall of toolBlocks) {
      const impl = filteredTools.find((t) => t.name === toolCall.name);
      if (!impl) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: `Tool "${toolCall.name}" not available`,
          is_error: true
        });
        continue;
      }
      if (!toolsUsed.includes(toolCall.name)) toolsUsed.push(toolCall.name);
      console.log(`[agent:${agent.id}] calling tool: ${toolCall.name}`);
      try {
        const result = await impl.execute(toolCall.id, toolCall.input);
        const text = result.content.map((c) => c.text || JSON.stringify(c)).filter(Boolean).join("\n");
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: text || "(empty result)"
        });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: `Error: ${err.message}`,
          is_error: true
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }
  const durationMs = Date.now() - startTime;
  console.log(`[agent:${agent.id}] completed in ${(durationMs / 1e3).toFixed(1)}s (${toolsUsed.length} tools used, ${totalInput + totalOutput} tokens)`);
  return {
    agentId: agent.id,
    agentName: agent.name,
    response: finalResponse || "(No response generated)",
    toolsUsed,
    durationMs,
    tokensUsed: { input: totalInput, output: totalOutput }
  };
}

// server.ts
var PORT = parseInt(process.env.PORT || "3000", 10);
var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
var APP_PASSWORD = process.env.APP_PASSWORD || "";
var SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
var __filename = fileURLToPath(import.meta.url);
var __dirname = path8.dirname(__filename);
var PROJECT_ROOT = __filename.includes("/dist/") ? path8.resolve(__dirname, "..") : __dirname;
var PUBLIC_DIR = path8.join(PROJECT_ROOT, "public");
var AGENT_DIR = path8.join(PROJECT_ROOT, ".pi/agent");
var DATA_DIR = path8.join(PROJECT_ROOT, "data", "conversations");
var VAULT_DIR = path8.join(PROJECT_ROOT, "data", "vault");
fs8.mkdirSync(AGENT_DIR, { recursive: true });
init2(DATA_DIR);
init3(PROJECT_ROOT);
init4(PROJECT_ROOT);
init5(PROJECT_ROOT);
init6(PROJECT_ROOT);
init(VAULT_DIR);
init7(path8.join(PROJECT_ROOT, "data"));
var useLocalVault = isConfigured2();
setInterval(() => {
  const localAvailable = isConfigured2();
  if (localAvailable && !useLocalVault) {
    useLocalVault = true;
    console.log("[health] Knowledge base: switched to local vault (Obsidian Sync)");
  } else if (!localAvailable && useLocalVault) {
    useLocalVault = false;
    if (isConfigured()) {
      console.warn("[health] Local vault unavailable \u2014 falling back to remote (tunnel)");
    } else {
      console.warn("[health] Local vault unavailable \u2014 no remote fallback configured");
    }
  }
}, 15e3);
if (!ANTHROPIC_KEY) console.warn("ANTHROPIC_API_KEY is not set.");
if (useLocalVault) {
  console.log("[boot] Knowledge base: local vault (Obsidian Sync)");
} else if (isConfigured()) {
  console.log("[boot] Knowledge base: remote (tunnel)");
} else {
  console.warn("Knowledge base integration not configured.");
}
if (!isConfigured3()) console.warn("Gmail integration not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing).");
else if (!isConnected()) console.warn("Gmail configured but not yet authorized. Visit /api/gmail/auth to connect.");
else {
  getConnectedEmail().then((email) => {
    if (email) console.log(`[boot] Google account connected: ${email}`);
  }).catch(() => {
  });
}
if (!APP_PASSWORD) console.warn("APP_PASSWORD is not set \u2014 auth disabled.");
console.log(`[boot] PORT=${PORT} PUBLIC_DIR=${PUBLIC_DIR} AGENT_DIR=${AGENT_DIR}`);
console.log(`[boot] public/ exists: ${fs8.existsSync(PUBLIC_DIR)}`);
function kbList(p) {
  return useLocalVault ? listNotes2(p) : listNotes(p);
}
function kbRead(p) {
  return useLocalVault ? readNote2(p) : readNote(p);
}
function kbCreate(p, c) {
  return useLocalVault ? createNote2(p, c) : createNote(p, c);
}
function kbAppend(p, c) {
  return useLocalVault ? appendToNote2(p, c) : appendToNote(p, c);
}
function kbSearch(q) {
  return useLocalVault ? searchNotes2(q) : searchNotes(q);
}
function buildKnowledgeBaseTools() {
  if (!useLocalVault && !isConfigured()) return [];
  return [
    {
      name: "notes_list",
      label: "Notes List",
      description: "List files and folders in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Directory path inside the knowledge base. Defaults to root." }))
      }),
      async execute(_toolCallId, params) {
        const result = await kbList(params.path ?? "/");
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
        const result = await kbRead(params.path);
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
        const result = await kbCreate(params.path, params.content);
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
        const result = await kbAppend(params.path, params.content);
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
        const result = await kbSearch(params.query);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildGmailTools() {
  if (!isConfigured3()) return [];
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
        const result = await search2(params.query);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildCalendarTools() {
  if (!isConfigured4()) return [];
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
function buildTwitterTools() {
  return [
    {
      name: "x_user_profile",
      label: "X User Profile",
      description: "Get an X (Twitter) user's profile info including bio, follower count, and stats. Accepts a username or profile URL.",
      parameters: Type.Object({
        username: Type.String({ description: "X username (e.g. 'elonmusk') or profile URL" })
      }),
      async execute(_toolCallId, params) {
        const result = await getUserProfile(params.username);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "x_read_tweet",
      label: "Read Tweet",
      description: "Read the full content of a specific tweet/post. Accepts a tweet URL (x.com or twitter.com) or tweet ID.",
      parameters: Type.Object({
        tweet: Type.String({ description: "Tweet URL (e.g. 'https://x.com/user/status/123') or tweet ID" })
      }),
      async execute(_toolCallId, params) {
        const result = await getTweet(params.tweet);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "x_user_timeline",
      label: "X Timeline",
      description: "Read recent tweets/posts from an X (Twitter) user's timeline. Returns their latest public posts.",
      parameters: Type.Object({
        username: Type.String({ description: "X username (e.g. 'elonmusk') or profile URL" }),
        count: Type.Optional(Type.Number({ description: "Number of tweets to fetch (default 10, max 20)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await getUserTimeline(params.username, params.count ?? 10);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildStockTools() {
  return [
    {
      name: "stock_quote",
      label: "Stock Quote",
      description: "Get real-time stock price, change, and stats for a ticker symbol. Use standard stock symbols (e.g. AAPL, TSLA, MSFT, GOOGL, AMZN).",
      parameters: Type.Object({
        symbol: Type.String({ description: "Stock ticker symbol (e.g. 'AAPL', 'TSLA', 'MSFT')" })
      }),
      async execute(_toolCallId, params) {
        const result = await getStockQuote(params.symbol);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "crypto_price",
      label: "Crypto Price",
      description: "Get real-time cryptocurrency price, 24h/7d change, market cap, and volume. Supports common tickers (BTC, ETH, SOL, etc.) and full names (bitcoin, ethereum, etc.).",
      parameters: Type.Object({
        coin: Type.String({ description: "Cryptocurrency name or ticker (e.g. 'bitcoin', 'BTC', 'ethereum', 'ETH', 'solana')" })
      }),
      async execute(_toolCallId, params) {
        const result = await getCryptoPrice(params.coin);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildMapsTools() {
  return [
    {
      name: "maps_directions",
      label: "Directions",
      description: "Get directions between two locations with distance, estimated time, and turn-by-turn steps. Supports driving, walking, and cycling.",
      parameters: Type.Object({
        from: Type.String({ description: "Starting location (address, place name, or landmark)" }),
        to: Type.String({ description: "Destination location (address, place name, or landmark)" }),
        mode: Type.Optional(Type.String({ description: "Travel mode: 'driving' (default), 'walking', or 'cycling'" }))
      }),
      async execute(_toolCallId, params) {
        const result = await getDirections(params.from, params.to, params.mode);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "maps_search_places",
      label: "Search Places",
      description: "Search for places, businesses, or addresses. Optionally search near a specific location.",
      parameters: Type.Object({
        query: Type.String({ description: "What to search for (e.g. 'coffee shops', 'gas stations', 'Central Park')" }),
        near: Type.Optional(Type.String({ description: "Search near this location (e.g. 'Manhattan, NY', 'San Francisco')" }))
      }),
      async execute(_toolCallId, params) {
        const result = await searchPlaces(params.query, params.near);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildInterviewTool(sessionId) {
  return [
    {
      name: "interview",
      label: "Interview",
      description: "Ask the user structured clarification questions via an interactive form. Use this when you need specific choices, preferences, or detailed context from the user before proceeding. Supports single-select (pick one), multi-select (pick many), text (free input), and info (display-only context). The form appears inline in the chat. Returns the user's responses as key-value pairs.",
      parameters: Type.Object({
        title: Type.Optional(Type.String({ description: "Title shown at the top of the form" })),
        description: Type.Optional(Type.String({ description: "Brief description or context for the form" })),
        questions: Type.Array(
          Type.Object({
            id: Type.String({ description: "Unique identifier for this question" }),
            type: Type.Union([
              Type.Literal("single"),
              Type.Literal("multi"),
              Type.Literal("text"),
              Type.Literal("info")
            ], { description: "Question type: single (radio), multi (checkbox), text (free input), info (display only)" }),
            question: Type.String({ description: "The question text to display" }),
            options: Type.Optional(Type.Array(Type.String(), { description: "Options for single/multi select questions" })),
            recommended: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "Recommended option(s) shown with a badge" })),
            context: Type.Optional(Type.String({ description: "Additional helper text shown below the question" }))
          }),
          { description: "Array of questions to ask the user" }
        )
      }),
      async execute(toolCallId, params) {
        const entry = sessions.get(sessionId);
        if (!entry) {
          return { content: [{ type: "text", text: "Session expired." }], details: {} };
        }
        if (entry.interviewWaiter) {
          return { content: [{ type: "text", text: "An interview form is already active. Wait for the user to respond before sending another." }], details: {} };
        }
        const interviewEvent = JSON.stringify({
          type: "interview_form",
          toolCallId,
          title: params.title,
          description: params.description,
          questions: params.questions
        });
        for (const sub of entry.subscribers) {
          try {
            sub.write(`data: ${interviewEvent}

`);
          } catch {
          }
        }
        const responses = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (entry.interviewWaiter) {
              entry.interviewWaiter = void 0;
              const timeoutEvent = JSON.stringify({ type: "interview_timeout" });
              for (const sub of entry.subscribers) {
                try {
                  sub.write(`data: ${timeoutEvent}

`);
                } catch {
                }
              }
              resolve([]);
            }
          }, 15 * 60 * 1e3);
          entry.interviewWaiter = { resolve, reject: () => {
          }, timer };
        });
        if (responses.length === 0) {
          return {
            content: [{ type: "text", text: "The user did not respond to the interview form (timed out after 15 minutes). You can ask them directly in chat instead." }],
            details: { timedOut: true }
          };
        }
        const formatted = responses.map((r) => `**${r.id}**: ${Array.isArray(r.value) ? r.value.join(", ") : r.value}`).join("\n");
        return {
          content: [{ type: "text", text: formatted }],
          details: { responses }
        };
      }
    }
  ];
}
function buildConversationTools() {
  return [
    {
      name: "conversation_search",
      label: "Conversation Search",
      description: "Search past conversations with the user by keyword. Use this when the user asks about previous discussions, e.g. 'what did we talk about last Tuesday?' or 'find our conversation about the trip'. Returns matching conversations with context snippets.",
      parameters: Type.Object({
        query: Type.String({ description: "Search keywords to find in past conversations" }),
        days_ago: Type.Optional(Type.Number({ description: "Only search conversations from the last N days. E.g. 7 for last week." }))
      }),
      async execute(_toolCallId, params) {
        const after = params.days_ago ? Date.now() - params.days_ago * 24 * 60 * 60 * 1e3 : void 0;
        const results = search(params.query, { after, limit: 8 });
        if (results.length === 0) {
          return { content: [{ type: "text", text: `No past conversations found matching "${params.query}".` }], details: {} };
        }
        const formatted = results.map((r) => {
          const date = new Date(r.createdAt).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });
          const snippetText = r.snippets.map((s) => `  ${s}`).join("\n");
          return `**"${r.title}"** (${date}, ${r.messageCount} msgs)
${snippetText}`;
        }).join("\n\n---\n\n");
        return { content: [{ type: "text", text: formatted }], details: {} };
      }
    }
  ];
}
function buildAgentTools(allToolsFn) {
  return [
    {
      name: "delegate",
      label: "Delegate to Agent",
      description: "Delegate a complex task to a specialist agent. The agent will work independently using its own tools and return a comprehensive result. Use this for multi-step research, project planning, deep analysis, email drafting, or vault organization.",
      parameters: Type.Object({
        agent: Type.String({ description: "The specialist agent ID (e.g. 'deep-researcher', 'project-planner', 'analyst', 'email-drafter', 'knowledge-organizer')" }),
        task: Type.String({ description: "Clear description of what the agent should do" }),
        context: Type.Optional(Type.String({ description: "Additional context the agent needs (e.g. previous conversation details, specific requirements)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await runSubAgent({
            agentId: params.agent,
            task: params.task,
            context: params.context,
            allTools: allToolsFn(),
            apiKey: ANTHROPIC_KEY
          });
          return {
            content: [{ type: "text", text: result.response }],
            details: { agent: result.agentId, toolsUsed: result.toolsUsed, durationMs: result.durationMs }
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Agent delegation failed: ${err.message}` }],
            details: { error: true }
          };
        }
      }
    },
    {
      name: "list_agents",
      label: "List Agents",
      description: "List all available specialist agents with their names and descriptions. Use when the user asks what agents are available or what your team can do.",
      parameters: Type.Object({}),
      async execute() {
        const agents2 = getEnabledAgents();
        if (agents2.length === 0) {
          return { content: [{ type: "text", text: "No specialist agents are currently configured." }], details: {} };
        }
        const list2 = agents2.map((a) => `- **${a.name}** (${a.id}): ${a.description}`).join("\n");
        return {
          content: [{ type: "text", text: `Available specialist agents:

${list2}` }],
          details: { count: agents2.length }
        };
      }
    }
  ];
}
var sessions = /* @__PURE__ */ new Map();
var FAST_MODEL_ID = "claude-haiku-4-5";
var FULL_MODEL_ID = "claude-sonnet-4-6";
var FAST_PATTERNS = [
  /^(hi|hello|hey|yo|sup|good\s*(morning|afternoon|evening)|thanks|thank you|ok|okay|got it|cool|nice|great)\b/i,
  /^what('s| is) (the )?(time|date|day)\b/i,
  /^(show|check|get|list|read)\s+(my\s+)?(tasks?|todos?|email|calendar|events?|weather|stock|price|portfolio|watchlist|notes?)\b/i,
  /^(add|create|complete|delete|remove)\s+(a\s+)?(task|todo|note)\b/i,
  /^(how'?s|what'?s)\s+(the\s+)?(weather|market|stock)\b/i,
  /^(remind|timer|alarm|set)\b/i
];
function classifyIntent(message) {
  const trimmed = message.trim();
  if (trimmed.length < 80) {
    for (const pattern of FAST_PATTERNS) {
      if (pattern.test(trimmed)) return "fast";
    }
  }
  if (trimmed.length < 20 && !trimmed.includes("?")) return "fast";
  return "full";
}
var syncedConversations = /* @__PURE__ */ new Set();
function saveAndCleanSession(id) {
  const entry = sessions.get(id);
  if (!entry) return;
  if (entry.currentAgentText) {
    addMessage(entry.conversation, "agent", entry.currentAgentText);
    entry.currentAgentText = "";
  }
  if (entry.conversation.messages.length > 0) {
    save(entry.conversation);
    syncConversationToVault(entry.conversation);
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
async function syncConversationToVault(conv) {
  if (syncedConversations.has(conv.id)) return;
  if (!shouldSync(conv)) return;
  if (!isConfigured()) return;
  const existing = load(conv.id);
  if (existing && existing.syncedAt) {
    syncedConversations.add(conv.id);
    return;
  }
  try {
    const summary = generateSummaryMarkdown(conv);
    const dateStr = new Date(conv.createdAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    let safeTitle = conv.title.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 50).trim();
    if (!safeTitle) safeTitle = conv.id;
    const notePath = `Conversations/${dateStr} - ${safeTitle}.md`;
    await createNote(notePath, summary);
    syncedConversations.add(conv.id);
    conv.syncedAt = Date.now();
    save(conv);
    console.log(`[sync] Conversation synced to vault: ${notePath}`);
  } catch (err) {
    console.error(`[sync] Failed to sync conversation ${conv.id}:`, err);
  }
}
var processingQueue = /* @__PURE__ */ new Set();
async function processNextPendingMessage(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry || entry.pendingMessages.length === 0) return;
  if (processingQueue.has(sessionId) || entry.isAgentRunning) return;
  processingQueue.add(sessionId);
  const pending = entry.pendingMessages.shift();
  entry.isAgentRunning = true;
  entry.currentAgentText = "";
  const startEvent = JSON.stringify({ type: "agent_start" });
  for (const sub of entry.subscribers) {
    try {
      sub.write(`data: ${startEvent}

`);
    } catch {
    }
  }
  try {
    const etNow = (/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
    const queueContext = "[Note: This message was sent while the previous task was still running. The previous task has now completed.]\n\n";
    const augmentedText = `[Current date/time in Rickin's timezone (Eastern): ${etNow}]

${queueContext}${pending.text}`;
    const promptImages = pending.images?.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    await entry.session.prompt(augmentedText, promptImages ? { images: promptImages } : void 0);
  } catch (err) {
    entry.isAgentRunning = false;
    console.error("Queued prompt error:", err);
    const errEvent = JSON.stringify({ type: "error", error: String(err) });
    for (const sub of entry.subscribers) {
      try {
        sub.write(`data: ${errEvent}

`);
      } catch {
      }
    }
    processingQueue.delete(sessionId);
    processNextPendingMessage(sessionId);
    return;
  }
  processingQueue.delete(sessionId);
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
var TUNNEL_URL_FILE = path8.join(PROJECT_ROOT, "data", "tunnel-url.txt");
function loadPersistedTunnelUrl() {
  try {
    return fs8.readFileSync(TUNNEL_URL_FILE, "utf-8").trim() || null;
  } catch {
    return null;
  }
}
function persistTunnelUrl(url) {
  try {
    fs8.writeFileSync(TUNNEL_URL_FILE, url, "utf-8");
  } catch {
  }
}
(function initTunnelUrl() {
  const envUrl = process.env.OBSIDIAN_API_URL || "";
  if (envUrl) {
    setApiUrl(envUrl);
    if (!useLocalVault) console.log(`[boot] Using tunnel URL from env: ${envUrl}`);
  } else {
    const savedUrl = loadPersistedTunnelUrl();
    if (savedUrl) {
      setApiUrl(savedUrl);
      if (!useLocalVault) console.log(`[boot] Loaded persisted tunnel URL: ${savedUrl}`);
    }
  }
})();
var lastTunnelStatus = useLocalVault;
if (!useLocalVault && isConfigured()) {
  setInterval(async () => {
    if (useLocalVault) return;
    const alive = await ping();
    if (alive && !lastTunnelStatus) {
      console.log("[health] Knowledge base connection recovered");
    } else if (!alive && lastTunnelStatus) {
      console.warn("[health] Knowledge base connection DOWN \u2014 check that Obsidian is running and tunnel service is active");
    }
    lastTunnelStatus = alive;
  }, 30 * 1e3);
  ping().then((ok) => {
    console.log(`[health] Knowledge base: ${ok ? "connected" : "offline"}`);
    lastTunnelStatus = ok;
  });
}
var app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(cookieParser(SESSION_SECRET));
var AUTH_PUBLIC_PATHS = /* @__PURE__ */ new Set(["/login.html", "/login.css", "/api/login", "/health", "/manifest.json", "/icons/icon-180.png", "/icons/icon-192.png", "/icons/icon-512.png", "/api/healthcheck"]);
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
  if (req.path === "/" && !req.headers.accept?.includes("text/html")) {
    res.status(200).send("ok");
  } else if (req.headers.accept?.includes("text/html") || req.path === "/") {
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
app.get("/api/gmail/auth", (_req, res) => {
  if (!isConfigured3()) {
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
app.get("/api/gmail/status", async (_req, res) => {
  const status = {
    configured: isConfigured3(),
    connected: isConnected()
  };
  if (status.connected) {
    try {
      status.email = await getConnectedEmail();
    } catch {
    }
  }
  res.json(status);
});
app.post("/api/session", async (_req, res) => {
  try {
    const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const authStorage = AuthStorage.create(path8.join(AGENT_DIR, "auth.json"));
    authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_KEY);
    const modelRegistry = new ModelRegistry(authStorage, path8.join(AGENT_DIR, "models.json"));
    const fullModel = modelRegistry.find("anthropic", FULL_MODEL_ID);
    if (!fullModel) throw new Error(`Model ${FULL_MODEL_ID} not found in registry`);
    const coreTools = [
      ...buildKnowledgeBaseTools(),
      ...buildGmailTools(),
      ...buildCalendarTools(),
      ...buildWeatherTools(),
      ...buildSearchTools(),
      ...buildTaskTools(),
      ...buildNewsTools(),
      ...buildTwitterTools(),
      ...buildStockTools(),
      ...buildMapsTools(),
      ...buildConversationTools(),
      ...buildInterviewTool(sessionId)
    ];
    const allTools = [
      ...coreTools,
      ...buildAgentTools(() => coreTools)
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
      modelRegistry,
      model: fullModel,
      tools: [],
      customTools: allTools
    });
    const conv = createConversation(sessionId);
    const entry = {
      session,
      subscribers: /* @__PURE__ */ new Set(),
      createdAt: Date.now(),
      conversation: conv,
      currentAgentText: "",
      modelMode: "auto",
      activeModelName: FULL_MODEL_ID,
      isAgentRunning: false,
      pendingMessages: []
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
        entry.isAgentRunning = false;
        if (entry.currentAgentText) {
          addMessage(entry.conversation, "agent", entry.currentAgentText);
          entry.currentAgentText = "";
        }
        processNextPendingMessage(sessionId);
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
app.get("/api/session/:id/status", (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.json({ alive: false });
    return;
  }
  res.json({
    alive: true,
    agentRunning: entry.isAgentRunning,
    currentAgentText: entry.currentAgentText,
    messages: entry.conversation.messages,
    pendingCount: entry.pendingMessages.length
  });
});
app.post("/api/session/:id/prompt", async (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const { message, images } = req.body;
  if (!message?.trim() && (!images || images.length === 0)) {
    res.status(400).json({ error: "message or images required" });
    return;
  }
  const ALLOWED_MIME = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const MAX_IMAGES = 5;
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  if (images && images.length > MAX_IMAGES) {
    res.status(400).json({ error: `Maximum ${MAX_IMAGES} images allowed` });
    return;
  }
  if (images) {
    for (const img of images) {
      if (!ALLOWED_MIME.has(img.mimeType)) {
        res.status(400).json({ error: `Unsupported image type: ${img.mimeType}` });
        return;
      }
      const sizeBytes = Math.ceil(img.data.length * 3 / 4);
      if (sizeBytes > MAX_IMAGE_BYTES) {
        res.status(400).json({ error: "Image too large (max 10MB)" });
        return;
      }
    }
  }
  const text = message?.trim() || "(image attached)";
  const imgAttachments = images?.map((i) => ({ mimeType: i.mimeType, data: i.data }));
  addMessage(entry.conversation, "user", text, imgAttachments);
  if (entry.isAgentRunning) {
    entry.pendingMessages.push({ text, images, timestamp: Date.now() });
    const queuedEvent = JSON.stringify({ type: "message_queued", position: entry.pendingMessages.length });
    for (const sub of entry.subscribers) {
      try {
        sub.write(`data: ${queuedEvent}

`);
      } catch {
      }
    }
    res.json({ ok: true, queued: true, position: entry.pendingMessages.length });
    return;
  }
  let chosenModelId = FULL_MODEL_ID;
  if (entry.modelMode === "fast") {
    chosenModelId = FAST_MODEL_ID;
  } else if (entry.modelMode === "auto") {
    const intent = classifyIntent(text);
    chosenModelId = intent === "fast" ? FAST_MODEL_ID : FULL_MODEL_ID;
  }
  if (chosenModelId !== entry.activeModelName) {
    try {
      const authStorage = AuthStorage.create(path8.join(AGENT_DIR, "auth.json"));
      authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_KEY);
      const modelRegistry = new ModelRegistry(authStorage, path8.join(AGENT_DIR, "models.json"));
      const newModel = modelRegistry.find("anthropic", chosenModelId);
      if (newModel) {
        await entry.session.setModel(newModel);
        entry.activeModelName = chosenModelId;
      } else {
        console.warn(`[model] ${chosenModelId} not found, staying on ${entry.activeModelName}`);
        chosenModelId = entry.activeModelName;
      }
    } catch (err) {
      console.error(`[model] Failed to switch to ${chosenModelId}:`, err);
      chosenModelId = entry.activeModelName;
    }
  }
  const modelEvent = JSON.stringify({ type: "model_info", model: entry.activeModelName });
  for (const sub of entry.subscribers) {
    try {
      sub.write(`data: ${modelEvent}

`);
    } catch {
    }
  }
  res.json({ ok: true });
  entry.isAgentRunning = true;
  try {
    const etNow = (/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
    const augmentedText = `[Current date/time in Rickin's timezone (Eastern): ${etNow}]

${text}`;
    const promptImages = images?.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    await entry.session.prompt(augmentedText, promptImages ? { images: promptImages } : void 0);
  } catch (err) {
    entry.isAgentRunning = false;
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
app.put("/api/session/:id/model-mode", (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const { mode } = req.body;
  if (!mode || !["auto", "fast", "full"].includes(mode)) {
    res.status(400).json({ error: "mode must be auto, fast, or full" });
    return;
  }
  entry.modelMode = mode;
  console.log(`[model] Session ${req.params["id"]} mode set to: ${mode}`);
  res.json({ ok: true, mode, activeModel: entry.activeModelName });
});
app.get("/api/session/:id/model-mode", (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  res.json({ mode: entry.modelMode, activeModel: entry.activeModelName });
});
app.post("/api/session/:id/interview-response", (req, res) => {
  const entry = sessions.get(req.params["id"]);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  const { responses } = req.body;
  if (!responses || !Array.isArray(responses)) {
    res.status(400).json({ error: "responses array required" });
    return;
  }
  if (entry.interviewWaiter) {
    clearTimeout(entry.interviewWaiter.timer);
    entry.interviewWaiter.resolve(responses);
    entry.interviewWaiter = void 0;
    console.log(`[interview] Received ${responses.length} responses for session ${req.params["id"]}`);
  }
  res.json({ ok: true });
});
app.delete("/api/session/:id", (req, res) => {
  saveAndCleanSession(req.params["id"]);
  res.json({ ok: true });
});
app.get("/api/conversations/search", (req, res) => {
  const q = req.query["q"] || "";
  if (!q.trim()) {
    res.json([]);
    return;
  }
  const before = req.query["before"] ? Number(req.query["before"]) : void 0;
  const after = req.query["after"] ? Number(req.query["after"]) : void 0;
  const results = search(q, { before, after });
  res.json(results);
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
  persistTunnelUrl(url);
  console.log(`Tunnel URL updated to: ${url}`);
  res.json({ ok: true, url });
});
app.get("/api/alerts/config", (_req, res) => {
  res.json(getConfig());
});
app.put("/api/alerts/config", (req, res) => {
  const updated = updateConfig(req.body);
  res.json(updated);
});
app.post("/api/alerts/trigger/:type", async (req, res) => {
  const type = req.params["type"];
  if (!["morning", "afternoon", "evening"].includes(type)) {
    res.status(400).json({ error: "Invalid brief type. Use morning, afternoon, or evening." });
    return;
  }
  try {
    const event = await triggerBrief(type);
    res.json({ ok: true, event });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
var glanceCache = null;
var GLANCE_TTL = 5 * 60 * 1e3;
app.get("/api/glance", async (_req, res) => {
  try {
    if (glanceCache && Date.now() - glanceCache.ts < GLANCE_TTL) {
      res.json(glanceCache.data);
      return;
    }
    const cfg = getConfig();
    const tz = cfg.timezone || "America/New_York";
    const loc = cfg.location || "10016";
    const now = /* @__PURE__ */ new Date();
    let timeStr;
    try {
      timeStr = now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", weekday: "short", month: "short", day: "numeric" });
    } catch {
      timeStr = now.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", weekday: "short", month: "short", day: "numeric" });
    }
    const result = { time: timeStr, weather: null, emails: null, tasks: null, nextEvent: null };
    const promises = [];
    promises.push((async () => {
      try {
        const raw = await getWeather(loc);
        const tempMatch = raw.match(/Temperature:\s*([\d.-]+)°C\s*\((\d+)°F\)/);
        const condMatch = raw.match(/Condition:\s*(.+)/);
        if (tempMatch && condMatch) {
          const condition = condMatch[1].trim();
          const etHour = new Date((/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York" })).getHours();
          const isNight = etHour >= 18 || etHour < 6;
          let icon = "\u{1F321}\uFE0F";
          const cl = condition.toLowerCase();
          if (cl.includes("clear") || cl.includes("sunny")) icon = isNight ? "\u{1F319}" : "\u2600\uFE0F";
          else if (cl.includes("partly")) icon = isNight ? "\u2601\uFE0F" : "\u26C5";
          else if (cl.includes("cloud") || cl.includes("overcast")) icon = "\u2601\uFE0F";
          else if (cl.includes("rain") || cl.includes("drizzle") || cl.includes("shower")) icon = "\u{1F327}\uFE0F";
          else if (cl.includes("snow")) icon = "\u2744\uFE0F";
          else if (cl.includes("thunder")) icon = "\u26C8\uFE0F";
          else if (cl.includes("fog")) icon = "\u{1F32B}\uFE0F";
          result.weather = { tempC: Math.round(parseFloat(tempMatch[1])), condition, icon };
        }
      } catch {
      }
    })());
    if (isConfigured3() && isConnected()) {
      promises.push((async () => {
        try {
          const unread = await getUnreadCount();
          result.emails = { unread };
        } catch {
        }
      })());
    }
    promises.push((async () => {
      try {
        const raw = listTasks();
        if (raw.includes("No open tasks") || raw.includes("No tasks found")) {
          result.tasks = { active: 0 };
        } else {
          const countMatch = raw.match(/(\d+)\s*open/);
          result.tasks = { active: countMatch ? parseInt(countMatch[1]) : 0 };
        }
      } catch {
      }
    })());
    if (isConfigured4()) {
      promises.push((async () => {
        try {
          const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
          const tzStr = now.toLocaleString("en-US", { timeZone: tz });
          const tzOffsetMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
          const nowShifted = new Date(now.getTime() + tzOffsetMs);
          const eodInTz = new Date(Date.UTC(nowShifted.getUTCFullYear(), nowShifted.getUTCMonth(), nowShifted.getUTCDate(), 23, 59, 59, 999));
          const endOfDayUTC = new Date(eodInTz.getTime() - tzOffsetMs);
          const raw = await listEvents({ maxResults: 3, timeMax: endOfDayUTC.toISOString() });
          if (!raw.includes("No upcoming events") && !raw.includes("expired") && !raw.includes("not authorized")) {
            const events = [];
            const eventBlocks = raw.split(/\d+\.\s+/).slice(1);
            for (const block of eventBlocks) {
              const lines = block.trim().split("\n");
              const title = lines[0]?.trim() || "";
              const timeLine = lines[1]?.trim() || "";
              if (title) events.push({ title, time: timeLine });
            }
            if (events.length > 0) {
              result.nextEvent = events[0];
              result.upcomingEvents = events.slice(0, 3);
            }
          }
        } catch {
        }
      })());
    }
    await Promise.all(promises);
    glanceCache = { data: result, ts: Date.now() };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch glance data" });
  }
});
app.get("/api/kb-status", (_req, res) => {
  res.json({ online: useLocalVault || lastTunnelStatus, mode: useLocalVault ? "local" : "remote" });
});
app.get("/api/agents", (_req, res) => {
  const agents2 = getAgents().map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    enabled: a.enabled,
    tools: a.tools,
    timeout: a.timeout,
    model: a.model
  }));
  res.json({ agents: agents2 });
});
app.get("/api/vault-tree", async (_req, res) => {
  try {
    async function buildTree(dir) {
      const entries = await fs8.promises.readdir(dir, { withFileTypes: true });
      const result = [];
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isDirectory()) {
          const children = await buildTree(path8.join(dir, entry.name));
          result.push({ name: entry.name, type: "folder", children });
        } else {
          result.push({ name: entry.name, type: "file" });
        }
      }
      return result.sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    }
    const tree = await buildTree(VAULT_DIR);
    res.json({ vault: tree });
  } catch (err) {
    res.status(500).json({ error: "Failed to read vault structure" });
  }
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
function killPort(port) {
  try {
    execSync(`fuser -k -9 ${port}/tcp`, { stdio: "ignore" });
  } catch {
  }
  try {
    execSync(`lsof -ti :${port} | xargs kill -9`, { stdio: "ignore" });
  } catch {
  }
}
function isPortInUse(port) {
  try {
    const out = execSync(`fuser ${port}/tcp 2>/dev/null`, { encoding: "utf-8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
async function waitForPort(port, maxWaitMs = 3e4) {
  const start = Date.now();
  let attempt = 0;
  killPort(port);
  await new Promise((r) => setTimeout(r, 500));
  while (Date.now() - start < maxWaitMs) {
    if (!isPortInUse(port)) return true;
    attempt++;
    console.warn(`[boot] Port ${port} still in use \u2014 waiting... (attempt ${attempt})`);
    killPort(port);
    await new Promise((r) => setTimeout(r, 2e3));
  }
  return false;
}
async function startServer(maxRetries = 5) {
  const portReady = await waitForPort(PORT);
  if (!portReady) {
    console.error(`[boot] Port ${PORT} could not be freed after 30s \u2014 exiting`);
    process.exit(1);
  }
  function broadcastToAll(event) {
    const data = `data: ${JSON.stringify(event)}

`;
    for (const entry of sessions.values()) {
      for (const sub of entry.subscribers) {
        try {
          sub.write(data);
        } catch {
          entry.subscribers.delete(sub);
        }
      }
    }
  }
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        server = createServer(app);
        server.once("error", (err) => {
          if (err.code === "EADDRINUSE" && attempt < maxRetries) {
            console.warn(`[boot] EADDRINUSE on attempt ${attempt}/${maxRetries} \u2014 retrying in 3s...`);
            server.close();
            reject(err);
          } else {
            console.error(`[boot] Fatal server error:`, err);
            process.exit(1);
          }
        });
        server.listen(PORT, "0.0.0.0", () => {
          console.log(`[ready] pi-replit listening on http://localhost:${PORT}`);
          startAlertSystem(broadcastToAll);
          resolve();
        });
      });
      return;
    } catch {
      killPort(PORT);
      await new Promise((r) => setTimeout(r, 3e3));
    }
  }
  console.error(`[boot] Could not bind port ${PORT} after ${maxRetries} attempts \u2014 exiting`);
  process.exit(1);
}
startServer();
