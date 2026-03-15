var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// server.ts
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { fileURLToPath } from "url";
import path4 from "path";
import fs3 from "fs";
import { execSync, spawn } from "child_process";
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
async function deleteNote(notePath) {
  const url = `${baseUrl()}/vault/${encodePath(notePath)}`;
  const res = await fetchWithRetry(url, { method: "DELETE", headers: headers() });
  if (!res.ok) throw new Error(`Obsidian API error ${res.status}: ${await res.text()}`);
  return `Deleted note: ${notePath}`;
}
async function moveNote(fromPath, toPath) {
  const content = await readNote(fromPath);
  await createNote(toPath, content);
  await deleteNote(fromPath);
  return `Moved note: ${fromPath} \u2192 ${toPath}`;
}
async function renameFolder(fromPath, toPath) {
  const listData = await listNotes(fromPath);
  const parsed = JSON.parse(listData);
  const items = parsed.files || [];
  for (const item of items) {
    const isDir = item.endsWith("/");
    if (isDir) {
      const subFrom = item.replace(/\/+$/, "");
      const subName = subFrom.split("/").pop() || subFrom;
      await renameFolder(subFrom, `${toPath.replace(/\/+$/, "")}/${subName}`);
    } else {
      const fileName = item.split("/").pop() || item;
      await moveNote(item, `${toPath.replace(/\/+$/, "")}/${fileName}`);
    }
  }
  return `Renamed folder: ${fromPath} \u2192 ${toPath}`;
}
async function listRecursive(dirPath = "/") {
  const files = [];
  async function walk(dir) {
    const data = await listNotes(dir);
    const parsed = JSON.parse(data);
    const items = parsed.files || [];
    for (const item of items) {
      files.push(item);
      if (item.endsWith("/")) {
        await walk(item.replace(/\/+$/, ""));
      }
    }
  }
  await walk(dirPath);
  return JSON.stringify({ files }, null, 2);
}
async function fileInfo(notePath) {
  try {
    const content = await readNote(notePath);
    const size = new TextEncoder().encode(content).length;
    return JSON.stringify({
      path: notePath,
      type: "file",
      size,
      sizeHuman: size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`,
      created: "unknown (API limitation)",
      modified: "unknown (API limitation)"
    }, null, 2);
  } catch {
    try {
      const listing = await listNotes(notePath);
      const parsed = JSON.parse(listing);
      const count = (parsed.files || []).length;
      return JSON.stringify({
        path: notePath,
        type: "folder",
        items: count,
        created: "unknown (API limitation)",
        modified: "unknown (API limitation)"
      }, null, 2);
    } catch {
      throw new Error(`Not found: ${notePath}`);
    }
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
  nudgeSync(resolved);
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
  nudgeSync(resolved);
  return `Appended to note: ${notePath}`;
}
async function deleteNote2(notePath) {
  const resolved = resolvePath(notePath);
  try {
    await fs.access(resolved);
  } catch {
    throw new Error(`Note not found: ${notePath}`);
  }
  await fs.unlink(resolved);
  const dir = path.dirname(resolved);
  try {
    const entries = await fs.readdir(dir);
    const visible = entries.filter((e) => !e.startsWith("."));
    if (visible.length === 0 && dir !== vaultPath) {
      await fs.rm(dir, { recursive: true });
    }
  } catch {
  }
  return `Deleted note: ${notePath}`;
}
async function moveNote2(fromPath, toPath) {
  const resolvedFrom = resolvePath(fromPath);
  const resolvedTo = resolvePath(toPath);
  try {
    await fs.access(resolvedFrom);
  } catch {
    throw new Error(`Note not found: ${fromPath}`);
  }
  const content = await fs.readFile(resolvedFrom, "utf-8");
  const destDir = path.dirname(resolvedTo);
  await fs.mkdir(destDir, { recursive: true });
  await fs.writeFile(resolvedTo, content, "utf-8");
  await fs.unlink(resolvedFrom);
  const oldDir = path.dirname(resolvedFrom);
  try {
    const entries = await fs.readdir(oldDir);
    const visible = entries.filter((e) => !e.startsWith("."));
    if (visible.length === 0 && oldDir !== vaultPath) {
      await fs.rm(oldDir, { recursive: true });
    }
  } catch {
  }
  nudgeSync(resolvedTo);
  return `Moved note: ${fromPath} \u2192 ${toPath}`;
}
async function renameFolder2(fromPath, toPath) {
  const resolvedFrom = resolvePath(fromPath.replace(/\/+$/, ""));
  const resolvedTo = resolvePath(toPath.replace(/\/+$/, ""));
  const stat = await fs.stat(resolvedFrom).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`Folder not found: ${fromPath}`);
  const destParent = path.dirname(resolvedTo);
  await fs.mkdir(destParent, { recursive: true });
  await fs.rename(resolvedFrom, resolvedTo);
  async function nudgeAll(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await nudgeAll(full);
      else nudgeSync(full);
    }
  }
  await nudgeAll(resolvedTo);
  return `Renamed folder: ${fromPath} \u2192 ${toPath}`;
}
async function listRecursive2(dirPath = "/") {
  const resolved = resolvePath(dirPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`Folder not found: ${dirPath}`);
  const files = [];
  async function walk(dir, relBase) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        files.push(rel + "/");
        await walk(path.join(dir, entry.name), rel);
      } else {
        files.push(rel);
      }
    }
  }
  await walk(resolved, dirPath === "/" ? "" : dirPath);
  return JSON.stringify({ files }, null, 2);
}
async function fileInfo2(notePath) {
  const resolved = resolvePath(notePath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat) throw new Error(`Not found: ${notePath}`);
  return JSON.stringify({
    path: notePath,
    type: stat.isDirectory() ? "folder" : "file",
    size: stat.size,
    sizeHuman: stat.size < 1024 ? `${stat.size} B` : stat.size < 1048576 ? `${(stat.size / 1024).toFixed(1)} KB` : `${(stat.size / 1048576).toFixed(1)} MB`,
    created: stat.birthtime.toISOString(),
    modified: stat.mtime.toISOString()
  }, null, 2);
}
function nudgeSync(filePath) {
  setTimeout(async () => {
    try {
      const now = /* @__PURE__ */ new Date();
      await fs.utimes(filePath, now, now);
    } catch {
    }
  }, 600);
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

// src/db.ts
import pg from "pg";
var pool = null;
async function init2() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("[db] DATABASE_URL not set");
  }
  pool = new pg.Pool({ connectionString, max: 10 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New conversation',
      messages JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      synced_at BIGINT
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      due_date TEXT,
      priority TEXT NOT NULL DEFAULT 'medium',
      completed BOOLEAN NOT NULL DEFAULT false,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      tags JSONB DEFAULT '[]'::jsonb
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at BIGINT NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      service TEXT PRIMARY KEY,
      tokens JSONB NOT NULL,
      updated_at BIGINT NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS job_history (
      id SERIAL PRIMARY KEY,
      job_id TEXT NOT NULL,
      job_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      summary TEXT,
      saved_to TEXT,
      duration_ms INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_job_history_created ON job_history(created_at DESC)`);
  console.log("[db] PostgreSQL initialized (shared pool, 5 tables)");
  return pool;
}
function getPool() {
  if (!pool) throw new Error("[db] Not initialized \u2014 call init() first");
  return pool;
}

// src/conversations.ts
import Anthropic from "@anthropic-ai/sdk";
async function init3() {
  console.log("[conversations] initialized");
}
async function save(conv) {
  conv.updatedAt = Date.now();
  await getPool().query(
    `INSERT INTO conversations (id, title, messages, created_at, updated_at, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       messages = EXCLUDED.messages,
       updated_at = EXCLUDED.updated_at,
       synced_at = EXCLUDED.synced_at`,
    [conv.id, conv.title, JSON.stringify(conv.messages), conv.createdAt, conv.updatedAt, conv.syncedAt || null]
  );
}
async function load(id) {
  const result = await getPool().query(
    `SELECT id, title, messages, created_at, updated_at, synced_at FROM conversations WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  return rowToConversation(result.rows[0]);
}
async function list() {
  const result = await getPool().query(
    `SELECT DISTINCT ON (title) id, title, messages, created_at, updated_at
     FROM conversations ORDER BY title, updated_at DESC`
  );
  const rows = result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    messageCount: Array.isArray(row.messages) ? row.messages.length : 0
  }));
  rows.sort((a, b) => b.updatedAt - a.updatedAt);
  return rows;
}
async function remove(id) {
  const result = await getPool().query(`DELETE FROM conversations WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}
async function getRecentSummary(count = 5) {
  const result = await getPool().query(
    `SELECT id, title, messages, created_at, updated_at
     FROM conversations
     WHERE jsonb_array_length(messages) > 0
     ORDER BY updated_at DESC LIMIT $1`,
    [count]
  );
  if (result.rows.length === 0) return "";
  const lines = result.rows.map((row) => {
    const conv = rowToConversation(row);
    const date = new Date(conv.createdAt).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric"
    });
    const userMsgs = conv.messages.filter((m) => m.role === "user").slice(0, 3).map((m) => m.text.length > 120 ? m.text.slice(0, 120) + "\u2026" : m.text);
    const topicHint = userMsgs.length > 0 ? ` \u2014 Topics: ${userMsgs.join("; ")}` : "";
    return `- "${conv.title}" (${date}, ${conv.messages.length} msgs)${topicHint}`;
  });
  return `Recent conversations:
${lines.join("\n")}`;
}
async function getLastConversationContext(maxMessages = 10) {
  const result = await getPool().query(
    `SELECT id, title, messages, created_at, updated_at FROM conversations
     WHERE jsonb_array_length(messages) > 0
     ORDER BY updated_at DESC LIMIT 3`
  );
  if (result.rows.length === 0) return "";
  const sections = [];
  for (let i = 0; i < result.rows.length; i++) {
    const conv = rowToConversation(result.rows[i]);
    const msgsToShow = i === 0 ? maxMessages : 4;
    const relevantMsgs = conv.messages.filter((m) => m.role !== "system").slice(-msgsToShow);
    if (relevantMsgs.length === 0) continue;
    const date = new Date(conv.createdAt).toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric"
    });
    const time = new Date(conv.updatedAt).toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit"
    });
    const charLimit = i === 0 ? 800 : 400;
    const exchanges = relevantMsgs.map((m) => {
      const role = m.role === "user" ? "Rickin" : "You";
      const text = m.text.length > charLimit ? m.text.slice(0, charLimit) + "\u2026" : m.text;
      return `**${role}:** ${text}`;
    }).join("\n\n");
    const label = i === 0 ? "Most recent conversation" : `Earlier conversation`;
    sections.push(`${label}: "${conv.title}" (${date}, last active ${time})

${exchanges}`);
  }
  if (sections.length === 0) return "";
  return sections.join("\n\n---\n\n");
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
async function generateTitle(conv) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const nonSystem = conv.messages.filter((m) => m.role !== "system");
  if (nonSystem.length < 2) return null;
  const transcript = nonSystem.slice(0, 6).map((m) => {
    const role = m.role === "user" ? "User" : "Assistant";
    const text = m.text.length > 300 ? m.text.slice(0, 300) + "..." : m.text;
    return `${role}: ${text}`;
  }).join("\n");
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 40,
      messages: [{
        role: "user",
        content: `Write a short title (max 6 words) for this conversation. Just the title, no quotes or punctuation at the end.

${transcript}`
      }]
    });
    const title = response.content[0]?.type === "text" ? response.content[0].text.trim() : null;
    if (title && title.length > 0 && title.length <= 80) {
      conv.title = title;
      return title;
    }
  } catch (err) {
    console.warn("[conversations] Title generation failed:", err);
  }
  return null;
}
async function search(query, options) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return [];
  const limit = options?.limit ?? 10;
  let sql = `SELECT id, title, messages, created_at, updated_at FROM conversations WHERE 1=1`;
  const params = [];
  let paramIdx = 1;
  if (options?.before) {
    sql += ` AND created_at <= $${paramIdx++}`;
    params.push(options.before);
  }
  if (options?.after) {
    sql += ` AND created_at >= $${paramIdx++}`;
    params.push(options.after);
  }
  sql += ` ORDER BY updated_at DESC`;
  const result = await getPool().query(sql, params);
  const results = [];
  for (const row of result.rows) {
    const conv = rowToConversation(row);
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
    if (results.length >= limit) break;
  }
  return results;
}
function shouldSync(conv) {
  const userMessages = conv.messages.filter((m) => m.role === "user");
  return userMessages.length >= 1;
}
function generateSnippetSummary(conv) {
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
async function generateAISummary(conv) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("[conversations] No ANTHROPIC_API_KEY \u2014 falling back to snippet summary");
    return generateSnippetSummary(conv);
  }
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
  const transcript = conv.messages.filter((m) => m.role !== "system").map((m) => {
    const role = m.role === "user" ? "Rickin" : "Assistant";
    const text = m.text.length > 500 ? m.text.slice(0, 500) + "..." : m.text;
    return `${role}: ${text}`;
  }).join("\n\n");
  try {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `Summarize this conversation between Rickin and his AI assistant. Write in third person about what was discussed.

Format your response EXACTLY as markdown with these sections:
## Summary
2-3 sentences capturing the main topics and purpose of the conversation.

## Key Decisions & Outcomes
- Bullet points of any decisions made, answers given, or outcomes reached
- If none, write "- General discussion, no specific decisions"

## Action Items
- Any tasks, follow-ups, or things to do that came up
- If none, write "- No action items"

## Topics for Follow-up
- Things that were mentioned but not fully resolved, or areas to revisit
- If none, write "- None identified"

CONVERSATION:
${transcript}`
      }]
    });
    const aiText = response.content[0]?.type === "text" ? response.content[0].text : "";
    return `# ${conv.title}

**Date:** ${date} at ${time}
**Messages:** ${conv.messages.length}

${aiText}

---
*Session ID: ${conv.id}*
`;
  } catch (err) {
    console.error("[conversations] AI summary failed, falling back to snippet:", err);
    return generateSnippetSummary(conv);
  }
}
function rowToConversation(row) {
  const conv = {
    id: row.id,
    title: row.title,
    messages: Array.isArray(row.messages) ? row.messages : JSON.parse(row.messages || "[]"),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
  if (row.synced_at) {
    conv.syncedAt = Number(row.synced_at);
  }
  return conv;
}

// src/gmail.ts
import { google } from "googleapis";
var SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/youtube.readonly"
];
async function init4() {
  const existing = await getPool().query(`SELECT tokens FROM oauth_tokens WHERE service = 'google'`);
  if (existing.rows.length === 0) {
    try {
      const fs4 = await import("fs");
      const path5 = await import("path");
      const legacyPath = path5.default.join(process.cwd(), "data", "gmail-tokens.json");
      if (fs4.default.existsSync(legacyPath)) {
        const tokens = JSON.parse(fs4.default.readFileSync(legacyPath, "utf-8"));
        await getPool().query(
          `INSERT INTO oauth_tokens (service, tokens, updated_at) VALUES ('google', $1, $2)`,
          [JSON.stringify(tokens), Date.now()]
        );
        cachedTokens = tokens;
        tokensCacheTime = Date.now();
        console.log("[gmail] Migrated tokens from data/gmail-tokens.json to PostgreSQL");
      }
    } catch (err) {
      console.error("[gmail] Token migration failed:", err);
    }
  } else {
    cachedTokens = existing.rows[0].tokens;
    tokensCacheTime = Date.now();
  }
  console.log("[gmail] initialized");
}
function isConfigured3() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
function isConnected() {
  if (!isConfigured3()) return false;
  return !!(cachedTokens && cachedTokens.refresh_token);
}
var cachedTokens = null;
var tokensCacheTime = 0;
async function loadTokens() {
  try {
    const result = await getPool().query(`SELECT tokens FROM oauth_tokens WHERE service = 'google'`);
    if (result.rows.length > 0) {
      cachedTokens = result.rows[0].tokens;
      tokensCacheTime = Date.now();
      return cachedTokens;
    }
  } catch (err) {
    console.error("[gmail] Failed to load tokens:", err);
  }
  return null;
}
async function saveTokens(tokens) {
  cachedTokens = tokens;
  tokensCacheTime = Date.now();
  try {
    await getPool().query(
      `INSERT INTO oauth_tokens (service, tokens, updated_at)
       VALUES ('google', $1, $2)
       ON CONFLICT (service) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(tokens), Date.now()]
    );
  } catch (err) {
    console.error("[gmail] Failed to save tokens:", err);
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
  await saveTokens(tokens);
}
async function getGmailClient() {
  const tokens = await loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Gmail not connected");
  }
  const client = getOAuth2Client();
  client.setCredentials(tokens);
  client.on("tokens", async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveTokens(merged);
  });
  const isExpired = !tokens.expiry_date || Date.now() >= tokens.expiry_date - 6e4;
  if (isExpired) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      const merged = { ...tokens, ...credentials };
      await saveTokens(merged);
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
          threadId: msg.data.threadId || "",
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
      return `${marker} ${i + 1}. [${e.id}] (thread: ${e.threadId})
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
    const threadId = msg.data.threadId || "";
    const body = decodeBody(msg.data.payload) || "(no readable content)";
    const attachments = findAttachments(msg.data.payload);
    const truncatedBody = body.length > 3e3 ? body.slice(0, 3e3) + "\n\n[...truncated]" : body;
    let result = `From: ${from}
To: ${to}
Subject: ${subject}
Date: ${date}
Thread ID: ${threadId}
`;
    if (attachments.length > 0) {
      result += `Attachments: ${attachments.map((a) => `${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)}KB) [id: ${a.attachmentId}]`).join("; ")}
`;
    }
    result += `
${truncatedBody}`;
    return result;
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
async function searchEmailsStructured(query, maxResults = 5) {
  try {
    const client = await getGmailClient();
    const listRes = await client.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(maxResults, 10)
    });
    const messageRefs = listRes.data.messages || [];
    if (messageRefs.length === 0) return [];
    const details = await Promise.all(
      messageRefs.map(async (ref) => {
        const msg = await client.users.messages.get({
          userId: "me",
          id: ref.id,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"]
        });
        const headers2 = msg.data.payload?.headers || [];
        const getH = (name) => headers2.find((h) => h.name === name)?.value || "";
        return {
          subject: getH("Subject") || "(no subject)",
          from: getH("From").replace(/<.*>/, "").trim(),
          date: getH("Date"),
          unread: (msg.data.labelIds || []).includes("UNREAD")
        };
      })
    );
    return details;
  } catch {
    return [];
  }
}
async function getUnreadCount() {
  try {
    const client = await getGmailClient();
    const res = await client.users.messages.list({
      userId: "me",
      q: "is:unread category:primary",
      maxResults: 1
    });
    return res.data.resultSizeEstimate || 0;
  } catch (err) {
    console.error("Gmail getUnreadCount error:", err instanceof Error ? err.message : err);
    return 0;
  }
}
async function countUnread(query) {
  try {
    const client = await getGmailClient();
    const res = await client.users.messages.list({
      userId: "me",
      q: query,
      maxResults: 1
    });
    return res.data.resultSizeEstimate || 0;
  } catch (err) {
    console.error("Gmail countUnread error:", err instanceof Error ? err.message : err);
    return 0;
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
async function getAccessToken() {
  try {
    const tokens = await loadTokens();
    if (!tokens || !tokens.refresh_token) return null;
    const client = getOAuth2Client();
    client.setCredentials(tokens);
    const isExpired = !tokens.expiry_date || Date.now() >= tokens.expiry_date - 6e4;
    if (isExpired) {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      const merged = { ...tokens, ...credentials };
      await saveTokens(merged);
      return credentials.access_token || null;
    }
    return tokens.access_token || null;
  } catch (err) {
    console.error("[gmail] Failed to get access token:", err instanceof Error ? err.message : err);
    return null;
  }
}
var TRUSTED_SENDERS = [
  "rickin.patel@gmail.com",
  "rickin@rickin.live"
];
function isTrustedSender(from) {
  const emailMatch = from.match(/<([^>]+)>/);
  const email = emailMatch ? emailMatch[1].toLowerCase() : from.toLowerCase().trim();
  return TRUSTED_SENDERS.some((trusted) => email === trusted || email.endsWith(`<${trusted}>`));
}
async function getDarkNodeEmails() {
  try {
    const gmail = await getGmailClient();
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: "is:unread from:me @darknode",
      maxResults: 5
    });
    const messageRefs = listRes.data.messages || [];
    if (messageRefs.length === 0) return [];
    const processedIds = await getProcessedDarkNodeIds();
    const results = [];
    for (const ref of messageRefs) {
      if (processedIds.has(ref.id)) continue;
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: ref.id,
        format: "full"
      });
      const headers2 = msg.data.payload?.headers || [];
      const from = decodeHeader(headers2, "From");
      if (!isTrustedSender(from)) {
        console.log(`[gmail] getDarkNodeEmails: skipping untrusted sender: ${from}`);
        await markDarkNodeProcessed(ref.id);
        continue;
      }
      const subject = decodeHeader(headers2, "Subject") || "(no subject)";
      const date = decodeHeader(headers2, "Date");
      const body = decodeBody(msg.data.payload) || "(no readable content)";
      const instruction = extractDarkNodeInstruction(body);
      if (!instruction) continue;
      results.push({
        messageId: ref.id,
        subject,
        from,
        date,
        body: body.length > 5e3 ? body.slice(0, 5e3) + "\n\n[...truncated]" : body,
        instruction
      });
    }
    return results;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[gmail] getDarkNodeEmails error:", msg);
    return [];
  }
}
function extractDarkNodeInstruction(body) {
  const lines = body.split(/\n/);
  for (const line of lines) {
    if (line.trimStart().startsWith(">")) continue;
    const match = line.match(/@darknode\s*[-–—:]?\s*(.+)/i);
    if (match) {
      let instruction = match[1].trim();
      if (instruction.length === 0) continue;
      if (instruction.length > 200) instruction = instruction.slice(0, 200);
      return instruction;
    }
  }
  return null;
}
async function getProcessedDarkNodeIds() {
  try {
    const result = await getPool().query(`SELECT value FROM app_config WHERE key = 'darknode_processed_emails'`);
    if (result.rows.length > 0) {
      const ids = result.rows[0].value.ids || [];
      return new Set(ids);
    }
  } catch {
  }
  return /* @__PURE__ */ new Set();
}
async function markDarkNodeProcessed(messageId) {
  try {
    const existing = await getProcessedDarkNodeIds();
    existing.add(messageId);
    const ids = [...existing].slice(-200);
    await getPool().query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ('darknode_processed_emails', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify({ ids }), Date.now()]
    );
  } catch (err) {
    console.error("[gmail] markDarkNodeProcessed error:", err);
  }
}
function findAttachments(payload) {
  const attachments = [];
  function walk(part) {
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
        attachmentId: part.body.attachmentId,
        size: part.body.size || 0
      });
    }
    if (part.parts) {
      for (const p of part.parts) walk(p);
    }
  }
  walk(payload);
  return attachments;
}
async function getAttachment(messageId, attachmentId, filename) {
  try {
    const gmail = await getGmailClient();
    const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const allAttachments = findAttachments(msg.data.payload);
    if (allAttachments.length === 0) {
      return "This email has no attachments.";
    }
    let target = allAttachments[0];
    if (attachmentId) {
      const found = allAttachments.find((a) => a.attachmentId === attachmentId);
      if (found) {
        target = found;
      } else {
        const listStr2 = allAttachments.map((a) => `- ${a.filename} (${a.mimeType}) [id: ${a.attachmentId}]`).join("\n");
        return `Attachment ID not found. Available attachments:
${listStr2}`;
      }
    } else if (filename) {
      const found = allAttachments.find((a) => a.filename.toLowerCase().includes(filename.toLowerCase()));
      if (found) {
        target = found;
      } else {
        const listStr2 = allAttachments.map((a) => `- ${a.filename} (${a.mimeType})`).join("\n");
        return `No attachment matching "${filename}". Available attachments:
${listStr2}`;
      }
    }
    const attRes = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: target.attachmentId
    });
    const rawData = attRes.data.data;
    if (!rawData) return "Attachment data could not be retrieved.";
    const buffer = Buffer.from(rawData, "base64url");
    if (target.mimeType === "application/pdf" || target.filename.toLowerCase().endsWith(".pdf")) {
      try {
        const { PDFParse } = await import("pdf-parse");
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        await parser.load();
        const textResult = await parser.getText();
        const text = (typeof textResult === "string" ? textResult : textResult?.text ?? "").trim();
        const info = await parser.getInfo();
        const numPages = info?.total ?? "?";
        await parser.destroy();
        if (text.length > 0) {
          const truncated = text.length > 8e3 ? text.slice(0, 8e3) + "\n\n[...truncated]" : text;
          return `\u{1F4CE} ${target.filename} (PDF, ${numPages} pages)

${truncated}`;
        }
        return `\u{1F4CE} ${target.filename} \u2014 PDF has no extractable text (may be scanned/image-based).`;
      } catch (pdfErr) {
        return `\u{1F4CE} ${target.filename} \u2014 PDF parsing failed: ${pdfErr instanceof Error ? pdfErr.message : String(pdfErr)}`;
      }
    }
    if (target.mimeType.startsWith("text/") || target.mimeType === "application/json" || target.mimeType === "application/xml") {
      const textContent = buffer.toString("utf-8");
      const truncated = textContent.length > 8e3 ? textContent.slice(0, 8e3) + "\n\n[...truncated]" : textContent;
      return `\u{1F4CE} ${target.filename}

${truncated}`;
    }
    if (target.mimeType.startsWith("image/")) {
      const b64 = buffer.toString("base64");
      return `\u{1F4CE} ${target.filename} (${target.mimeType}, ${Math.round(buffer.length / 1024)}KB)
[Image attachment \u2014 base64 data available but not displayed as text]`;
    }
    const listStr = allAttachments.map((a, i) => `${i + 1}. ${a.filename} (${a.mimeType}, ${Math.round(a.size / 1024)}KB) [attachmentId: ${a.attachmentId}]`).join("\n");
    return `\u{1F4CE} ${target.filename} is a binary file (${target.mimeType}, ${Math.round(buffer.length / 1024)}KB). Cannot display as text.

All attachments:
${listStr}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail getAttachment error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("404")) return "Email or attachment not found.";
    return `Unable to read attachment: ${msg}`;
  }
}
function sanitizeHeader(value) {
  return value.replace(/[\r\n]+/g, " ").trim();
}
function buildRfc2822Message(to, subject, body, options) {
  const lines = [];
  lines.push(`To: ${sanitizeHeader(to)}`);
  if (options?.cc) lines.push(`Cc: ${sanitizeHeader(options.cc)}`);
  if (options?.bcc) lines.push(`Bcc: ${sanitizeHeader(options.bcc)}`);
  lines.push(`Subject: ${sanitizeHeader(subject)}`);
  lines.push(`Content-Type: text/plain; charset="UTF-8"`);
  if (options?.inReplyTo) lines.push(`In-Reply-To: ${sanitizeHeader(options.inReplyTo)}`);
  if (options?.references) lines.push(`References: ${sanitizeHeader(options.references)}`);
  lines.push("");
  lines.push(body);
  return lines.join("\r\n");
}
async function sendEmail(to, subject, body, cc, bcc) {
  try {
    const gmail = await getGmailClient();
    const raw = buildRfc2822Message(to, subject, body, { cc, bcc });
    const encoded = Buffer.from(raw).toString("base64url");
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded }
    });
    return `\u2705 Email sent successfully.
To: ${to}
Subject: ${subject}
Message ID: ${res.data.id}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail sendEmail error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("invalid_grant") || msg.includes("authorization expired")) {
      return "Gmail authorization expired \u2014 need to reconnect. Visit /api/gmail/auth.";
    }
    return `Failed to send email: ${msg}`;
  }
}
async function replyToEmail(messageId, body, replyAll = false) {
  try {
    const gmail = await getGmailClient();
    const original = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const headers2 = original.data.payload?.headers || [];
    const origFrom = decodeHeader(headers2, "From");
    const origTo = decodeHeader(headers2, "To");
    const origCc = decodeHeader(headers2, "Cc");
    const origSubject = decodeHeader(headers2, "Subject");
    const origMessageId = decodeHeader(headers2, "Message-ID") || decodeHeader(headers2, "Message-Id");
    const origReferences = decodeHeader(headers2, "References");
    const threadId = original.data.threadId || void 0;
    const replyTo = origFrom;
    let cc;
    if (replyAll) {
      const allRecipients = [origTo, origCc].filter(Boolean).join(", ");
      cc = allRecipients || void 0;
    }
    const subject = origSubject.startsWith("Re:") ? origSubject : `Re: ${origSubject}`;
    const references = origReferences ? `${origReferences} ${origMessageId}` : origMessageId;
    const raw = buildRfc2822Message(replyTo, subject, body, {
      cc,
      inReplyTo: origMessageId,
      references,
      threadId
    });
    const encoded = Buffer.from(raw).toString("base64url");
    const res = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded, threadId }
    });
    return `\u2705 Reply sent successfully.
To: ${replyTo}${cc ? `
Cc: ${cc}` : ""}
Subject: ${subject}
Message ID: ${res.data.id}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail replyToEmail error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    return `Failed to send reply: ${msg}`;
  }
}
async function getThread(threadId) {
  try {
    const gmail = await getGmailClient();
    const thread = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    const messages = thread.data.messages || [];
    if (messages.length === 0) return "Thread has no messages.";
    const formatted = messages.map((msg, i) => {
      const headers2 = msg.payload?.headers || [];
      const from = decodeHeader(headers2, "From");
      const to = decodeHeader(headers2, "To");
      const date = decodeHeader(headers2, "Date");
      const subject = decodeHeader(headers2, "Subject");
      const body = decodeBody(msg.payload) || "(no readable content)";
      const truncatedBody = body.length > 2e3 ? body.slice(0, 2e3) + "\n[...truncated]" : body;
      return `--- Message ${i + 1} of ${messages.length} [${msg.id}] ---
From: ${from}
To: ${to}
Date: ${date}
Subject: ${subject}

${truncatedBody}`;
    });
    return `Thread: ${messages.length} messages

${formatted.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail getThread error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("404")) return "Thread not found.";
    return `Unable to read thread: ${msg}`;
  }
}
async function createDraft(to, subject, body, cc, bcc) {
  try {
    const gmail = await getGmailClient();
    const raw = buildRfc2822Message(to, subject, body, { cc, bcc });
    const encoded = Buffer.from(raw).toString("base64url");
    const res = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw: encoded } }
    });
    return `\u2705 Draft saved.
To: ${to}
Subject: ${subject}
Draft ID: ${res.data.id}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail createDraft error:", msg);
    return `Failed to save draft: ${msg}`;
  }
}
async function archiveEmail(messageId) {
  try {
    const gmail = await getGmailClient();
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["INBOX"] }
    });
    return `\u2705 Email archived (removed from inbox).`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail archiveEmail error:", msg);
    if (msg.includes("404")) return "Email not found.";
    return `Failed to archive: ${msg}`;
  }
}
async function modifyLabels(messageId, addLabels, removeLabels) {
  try {
    const gmail = await getGmailClient();
    const body = {};
    if (addLabels && addLabels.length > 0) body.addLabelIds = addLabels;
    if (removeLabels && removeLabels.length > 0) body.removeLabelIds = removeLabels;
    await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: body });
    const parts = [];
    if (addLabels?.length) parts.push(`Added: ${addLabels.join(", ")}`);
    if (removeLabels?.length) parts.push(`Removed: ${removeLabels.join(", ")}`);
    return `\u2705 Labels updated. ${parts.join(". ")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail modifyLabels error:", msg);
    if (msg.includes("404")) return "Email not found.";
    return `Failed to modify labels: ${msg}`;
  }
}
async function markRead(messageId, read) {
  try {
    const gmail = await getGmailClient();
    const body = read ? { removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"] };
    await gmail.users.messages.modify({ userId: "me", id: messageId, requestBody: body });
    return `\u2705 Email marked as ${read ? "read" : "unread"}.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail markRead error:", msg);
    if (msg.includes("404")) return "Email not found.";
    return `Failed to update read status: ${msg}`;
  }
}
async function trashEmail(messageId) {
  try {
    const gmail = await getGmailClient();
    await gmail.users.messages.trash({ userId: "me", id: messageId });
    return `\u2705 Email moved to trash.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail trashEmail error:", msg);
    if (msg.includes("404")) return "Email not found.";
    return `Failed to trash email: ${msg}`;
  }
}
async function listLabels() {
  try {
    const gmail = await getGmailClient();
    const res = await gmail.users.labels.list({ userId: "me" });
    const labels = res.data.labels || [];
    if (labels.length === 0) return "No labels found.";
    const system = [];
    const user = [];
    for (const l of labels) {
      const entry = { id: l.id, name: l.name };
      if (l.type === "system") system.push(entry);
      else user.push(entry);
    }
    system.sort((a, b) => a.name.localeCompare(b.name));
    user.sort((a, b) => a.name.localeCompare(b.name));
    const lines = [];
    if (user.length > 0) {
      lines.push(`Custom labels (${user.length}):`);
      for (const l of user) lines.push(`  \u2022 ${l.name}  [id: ${l.id}]`);
    }
    lines.push(`
System labels (${system.length}):`);
    for (const l of system) lines.push(`  \u2022 ${l.name}  [id: ${l.id}]`);
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail listLabels error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    return `Failed to list labels: ${msg}`;
  }
}
async function createLabel(name, options) {
  try {
    const gmail = await getGmailClient();
    const body = {
      name,
      labelListVisibility: options?.labelListVisibility || "labelShow",
      messageListVisibility: options?.messageListVisibility || "show"
    };
    if (options?.backgroundColor || options?.textColor) {
      body.color = {};
      if (options.backgroundColor) body.color.backgroundColor = options.backgroundColor;
      if (options.textColor) body.color.textColor = options.textColor;
    }
    const res = await gmail.users.labels.create({ userId: "me", requestBody: body });
    return `\u2705 Label created.
Name: ${res.data.name}
ID: ${res.data.id}

Use this ID with the email_label tool to apply it to emails.`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail createLabel error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("already exists") || msg.includes("409")) return `Label "${name}" already exists. Use gmail_list_labels to find its ID.`;
    return `Failed to create label: ${msg}`;
  }
}
async function deleteLabel(labelId) {
  try {
    const gmail = await getGmailClient();
    await gmail.users.labels.delete({ userId: "me", id: labelId });
    return `\u2705 Label deleted (ID: ${labelId}).`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Gmail deleteLabel error:", msg);
    if (msg.includes("not connected")) return "Gmail is not connected.";
    if (msg.includes("404")) return "Label not found. It may have already been deleted.";
    if (msg.includes("invalid")) return "Cannot delete system labels \u2014 only custom labels can be deleted.";
    return `Failed to delete label: ${msg}`;
  }
}
async function checkConnectionStatus() {
  if (!isConfigured3()) return { connected: false, error: "GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set" };
  if (!isConnected()) return { connected: false, error: "No OAuth tokens \u2014 visit /api/gmail/auth to connect" };
  try {
    const email = await getConnectedEmail();
    if (email) return { connected: true, email };
    return { connected: false, error: "Token invalid \u2014 visit /api/gmail/auth to reconnect" };
  } catch (err) {
    return { connected: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// src/calendar.ts
import { google as google2 } from "googleapis";
function getOAuth2Client2() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || "";
  return new google2.auth.OAuth2(clientId, clientSecret, redirectUri);
}
async function loadTokens2() {
  try {
    const result = await getPool().query(`SELECT tokens FROM oauth_tokens WHERE service = 'google'`);
    if (result.rows.length > 0) {
      return result.rows[0].tokens;
    }
  } catch (err) {
    console.error("[calendar] Failed to load tokens:", err);
  }
  return null;
}
async function saveTokens2(tokens) {
  try {
    await getPool().query(
      `INSERT INTO oauth_tokens (service, tokens, updated_at)
       VALUES ('google', $1, $2)
       ON CONFLICT (service) DO UPDATE SET tokens = EXCLUDED.tokens, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(tokens), Date.now()]
    );
  } catch (err) {
    console.error("[calendar] Failed to save tokens:", err);
  }
}
async function getCalendarClient() {
  const tokens = await loadTokens2();
  if (!tokens || !tokens.refresh_token) {
    throw new Error("Google not connected \u2014 need to authorize first");
  }
  const client = getOAuth2Client2();
  client.setCredentials(tokens);
  client.on("tokens", async (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    await saveTokens2(merged);
  });
  const isExpired = !tokens.expiry_date || Date.now() >= tokens.expiry_date - 6e4;
  if (isExpired) {
    try {
      const { credentials } = await client.refreshAccessToken();
      client.setCredentials(credentials);
      await saveTokens2({ ...tokens, ...credentials });
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
async function listEventsStructured(options) {
  try {
    const cal = await getCalendarClient();
    const now = /* @__PURE__ */ new Date();
    const timeMin = options?.timeMin || now.toISOString();
    const maxResults = options?.maxResults || 10;
    let calendars = [{ id: "primary", name: "Rickin" }];
    try {
      const calList = await cal.calendarList.list({ minAccessRole: "reader" });
      const items = calList.data.items || [];
      if (items.length > 0) {
        calendars = items.filter((c) => c.selected !== false && c.id).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id }));
        if (calendars.length === 0) calendars = [{ id: "primary", name: "Rickin" }];
      }
    } catch {
    }
    const allEvents = [];
    for (const c of calendars) {
      try {
        const params = { calendarId: c.id, timeMin, maxResults, singleEvents: true, orderBy: "startTime" };
        if (options?.timeMax) params.timeMax = options.timeMax;
        const res = await cal.events.list(params);
        for (const ev of res.data.items || []) {
          allEvents.push({ event: ev, calName: c.name });
        }
      } catch {
      }
    }
    allEvents.sort((a, b) => {
      const aT = a.event.start?.dateTime || a.event.start?.date || "";
      const bT = b.event.start?.dateTime || b.event.start?.date || "";
      return aT.localeCompare(bT);
    });
    return allEvents.slice(0, maxResults).map(({ event, calName }) => {
      const start = event.start?.dateTime ? new Date(event.start.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : event.start?.date || "TBD";
      const end = event.end?.dateTime ? new Date(event.end.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "";
      return {
        title: event.summary || "(No title)",
        time: `${start}${end ? " - " + end : ""}`,
        calendar: calName
      };
    });
  } catch (err) {
    console.error("[calendar] listEventsStructured error:", err instanceof Error ? err.message : String(err));
    return [];
  }
}
async function listCalendars() {
  try {
    const cal = await getCalendarClient();
    const calList = await cal.calendarList.list({ minAccessRole: "reader" });
    const items = calList.data.items || [];
    return items.filter((c) => c.id).map((c) => ({
      id: c.id,
      name: c.summaryOverride || c.summary || c.id,
      accessRole: c.accessRole || "reader"
    }));
  } catch (err) {
    console.error("[calendar] listCalendars error:", err instanceof Error ? err.message : String(err));
    return [];
  }
}
function fuzzyMatchCalendar(calendars, query) {
  const q = query.toLowerCase().trim();
  const exact = calendars.find((c) => c.name.toLowerCase() === q);
  if (exact) return exact.id;
  const starts = calendars.find((c) => c.name.toLowerCase().startsWith(q));
  if (starts) return starts.id;
  const contains = calendars.find((c) => c.name.toLowerCase().includes(q));
  if (contains) return contains.id;
  return "primary";
}
async function createEvent(summary, options) {
  try {
    const calendar = await getCalendarClient();
    let targetCalendarId = "primary";
    let targetCalendarName = "primary";
    if (options.calendarName && options.calendarName.trim()) {
      const cals = await listCalendars();
      if (cals.length === 0) {
        return `Unable to create event: could not retrieve calendar list to match "${options.calendarName}". Try again or omit calendarName to use the primary calendar.`;
      }
      const writableCals = cals.filter((c) => c.accessRole === "owner" || c.accessRole === "writer");
      const matchedId = fuzzyMatchCalendar(writableCals, options.calendarName);
      if (matchedId === "primary") {
        const readOnlyMatch = fuzzyMatchCalendar(cals, options.calendarName);
        if (readOnlyMatch !== "primary") {
          const roName = cals.find((c) => c.id === readOnlyMatch)?.name || readOnlyMatch;
          return `Cannot create event on "${roName}" \u2014 it is read-only. Available writable calendars: ${writableCals.map((c) => c.name).join(", ")}`;
        }
      }
      targetCalendarId = matchedId;
      const matched = writableCals.find((c) => c.id === targetCalendarId);
      targetCalendarName = matched ? matched.name : targetCalendarId;
    }
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
      calendarId: targetCalendarId,
      requestBody: event
    });
    const created = res.data;
    const startStr = created.start?.dateTime ? new Date(created.start.dateTime).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : created.start?.date || "";
    const calLabel = targetCalendarId !== "primary" ? ` on calendar "${targetCalendarName}"` : "";
    return `Created event: "${summary}" on ${startStr}${calLabel}`;
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
async function findOrCreateCalendar(name) {
  const cal = await getCalendarClient();
  const list2 = await cal.calendarList.list({ minAccessRole: "owner" });
  const existing = (list2.data.items || []).find(
    (c) => (c.summaryOverride || c.summary || "").toLowerCase() === name.toLowerCase()
  );
  if (existing?.id) return existing.id;
  const res = await cal.calendars.insert({ requestBody: { summary: name, timeZone: "America/New_York" } });
  return res.data.id;
}
async function createRecurringEvent(calendarId, options) {
  const cal = await getCalendarClient();
  const d = new Date(options.date);
  d.setDate(d.getDate() + 1);
  const endDate = d.toISOString().split("T")[0];
  const event = {
    summary: options.summary,
    start: { date: options.date },
    end: { date: endDate }
  };
  if (options.description) event.description = options.description;
  if (options.colorId) event.colorId = options.colorId;
  if (options.recurrence) event.recurrence = options.recurrence;
  if (options.reminders) event.reminders = options.reminders;
  const res = await cal.events.insert({ calendarId, requestBody: event });
  return res.data.id || "created";
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
async function getWeather(location, forecastDays = 3) {
  try {
    const geo = await geocode(location);
    if (!geo) return `Could not find location "${location}". Try a city name like "New York" or "London".`;
    const days = Math.max(1, Math.min(forecastDays, 7));
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,apparent_temperature,weathercode,windspeed_10m,winddirection_10m,relative_humidity_2m,uv_index&hourly=precipitation_probability&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max&temperature_unit=celsius&windspeed_unit=mph&timezone=${encodeURIComponent(geo.timezone)}&forecast_days=${days}`;
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
    const hourly = data.hourly;
    if (hourly?.time?.length > 0 && hourly?.precipitation_probability?.length > 0) {
      result += `
Hourly Precipitation:
`;
      for (let i = 0; i < Math.min(24, hourly.time.length); i++) {
        const h = hourly.time[i];
        const prob = hourly.precipitation_probability[i];
        if (prob > 0) {
          result += `  ${h}: ${prob}%
`;
        }
      }
    }
    const daily = data.daily;
    if (daily?.time?.length > 0) {
      result += `
${days}-Day Forecast:
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

// src/webfetch.ts
var USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var ENTITY_MAP = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&ndash;": "\u2013",
  "&mdash;": "\u2014",
  "&lsquo;": "'",
  "&rsquo;": "'",
  "&ldquo;": "\u201C",
  "&rdquo;": "\u201D",
  "&bull;": "\u2022",
  "&hellip;": "\u2026",
  "&copy;": "\xA9",
  "&reg;": "\xAE",
  "&trade;": "\u2122",
  "&euro;": "\u20AC",
  "&pound;": "\xA3",
  "&yen;": "\xA5",
  "&cent;": "\xA2",
  "&deg;": "\xB0",
  "&times;": "\xD7",
  "&divide;": "\xF7",
  "&rarr;": "\u2192",
  "&larr;": "\u2190",
  "&uarr;": "\u2191",
  "&darr;": "\u2193",
  "&para;": "\xB6",
  "&sect;": "\xA7",
  "&frac12;": "\xBD",
  "&frac14;": "\xBC",
  "&frac34;": "\xBE"
};
function decodeEntities(text) {
  let result = text;
  for (const [entity, char] of Object.entries(ENTITY_MAP)) {
    result = result.replaceAll(entity, char);
  }
  result = result.replace(/&#(\d+);/g, (_, code) => {
    const n = parseInt(code, 10);
    return n > 0 && n < 1114111 ? String.fromCodePoint(n) : "";
  });
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const n = parseInt(hex, 16);
    return n > 0 && n < 1114111 ? String.fromCodePoint(n) : "";
  });
  return result;
}
function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/<[^>]+>/g, "").trim()) : "";
}
function extractMetaDescription(html) {
  const m = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i) || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
  return m ? decodeEntities(m[1].trim()) : "";
}
function htmlToText(html) {
  let text = html;
  text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "\n");
  text = text.replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_m, tag, content) => {
    const level = parseInt(tag[1]);
    const prefix = "#".repeat(level);
    const clean = content.replace(/<[^>]+>/g, "").trim();
    return `

${prefix} ${clean}

`;
  });
  text = text.replace(/<(p|div|section|article|main|blockquote)[^>]*>/gi, "\n\n");
  text = text.replace(/<\/(p|div|section|article|main|blockquote)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n---\n");
  text = text.replace(/<li[^>]*>/gi, "\n\u2022 ");
  text = text.replace(/<\/li>/gi, "");
  text = text.replace(/<\/?[ou]l[^>]*>/gi, "\n");
  text = text.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, content) => {
    const label = content.replace(/<[^>]+>/g, "").trim();
    if (!label) return "";
    if (href.startsWith("#") || href.startsWith("javascript:")) return label;
    return `${label} (${href})`;
  });
  text = text.replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, "[image: $1]");
  text = text.replace(/<(td|th)[^>]*>/gi, " | ");
  text = text.replace(/<\/tr>/gi, "\n");
  text = text.replace(/<\/?table[^>]*>/gi, "\n");
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "_$2_");
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, content) => {
    const code = content.replace(/<[^>]+>/g, "");
    return `
\`\`\`
${code}
\`\`\`
`;
  });
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text);
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/ *\n */g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();
  return text;
}
var BLOCKED_HOSTS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]$/,
  /^\[fc/i,
  /^\[fd/i,
  /^\[fe80:/i,
  /metadata\.google\.internal/i
];
var MAX_BODY_BYTES = 2 * 1024 * 1024;
function isBlockedHost(hostname) {
  return BLOCKED_HOSTS.some((re) => re.test(hostname));
}
async function readBodyCapped(res, cap) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    chunks.push(decoder.decode(value, { stream: true }));
    if (totalBytes >= cap) {
      reader.cancel();
      break;
    }
  }
  return chunks.join("");
}
async function fetchPage(url, options) {
  const maxLen = Math.min(Math.max(options?.maxLength ?? 8e4, 1e3), 2e5);
  const timeoutMs = options?.timeoutMs ?? 15e3;
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Blocked: only http/https URLs are allowed (got ${parsed.protocol})`);
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error(`Blocked: cannot fetch private/internal addresses`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers2 = {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
      "Accept-Language": "en-US,en;q=0.9",
      ...options?.includeHeaders || {}
    };
    const res = await fetch(url, {
      headers: headers2,
      signal: controller.signal,
      redirect: "follow"
    });
    const finalHost = new URL(res.url).hostname;
    if (isBlockedHost(finalHost)) {
      throw new Error(`Blocked: redirect to private/internal address`);
    }
    const contentType = res.headers.get("content-type") || "";
    const rawBody = await readBodyCapped(res, MAX_BODY_BYTES);
    if (contentType.includes("application/json")) {
      let content2 = rawBody;
      let truncated2 = false;
      if (content2.length > maxLen) {
        content2 = content2.slice(0, maxLen);
        truncated2 = true;
      }
      return {
        url: res.url || url,
        title: "",
        description: "",
        content: content2,
        statusCode: res.status,
        contentType,
        byteLength: rawBody.length,
        truncated: truncated2
      };
    }
    if (contentType.includes("text/plain")) {
      let content2 = rawBody;
      let truncated2 = false;
      if (content2.length > maxLen) {
        content2 = content2.slice(0, maxLen);
        truncated2 = true;
      }
      return {
        url: res.url || url,
        title: "",
        description: "",
        content: content2,
        statusCode: res.status,
        contentType,
        byteLength: rawBody.length,
        truncated: truncated2
      };
    }
    const title = extractTitle(rawBody);
    const description = extractMetaDescription(rawBody);
    let content = htmlToText(rawBody);
    let truncated = false;
    if (content.length > maxLen) {
      content = content.slice(0, maxLen);
      const lastNewline = content.lastIndexOf("\n");
      if (lastNewline > maxLen * 0.8) {
        content = content.slice(0, lastNewline);
      }
      truncated = true;
    }
    return {
      url: res.url || url,
      title,
      description,
      content,
      statusCode: res.status,
      contentType,
      byteLength: rawBody.length,
      truncated
    };
  } finally {
    clearTimeout(timer);
  }
}
function formatResult(result) {
  const parts = [];
  if (result.title) parts.push(`# ${result.title}`);
  parts.push(`URL: ${result.url}`);
  parts.push(`Status: ${result.statusCode} | Type: ${result.contentType} | Size: ${(result.byteLength / 1024).toFixed(1)}KB`);
  if (result.description) parts.push(`Description: ${result.description}`);
  if (result.truncated) parts.push(`\u26A0\uFE0F Content truncated to ~${(result.content.length / 1024).toFixed(0)}KB`);
  parts.push("");
  parts.push(result.content);
  return parts.join("\n");
}

// src/tasks.ts
async function init5() {
  const existing = await getPool().query(`SELECT count(*) FROM tasks`);
  if (parseInt(existing.rows[0].count) === 0) {
    try {
      const fs4 = await import("fs");
      const pathMod = await import("path");
      const legacyPath = pathMod.default.join(process.cwd(), "data", "tasks.json");
      if (fs4.default.existsSync(legacyPath)) {
        const legacyTasks = JSON.parse(fs4.default.readFileSync(legacyPath, "utf-8"));
        for (const t of legacyTasks) {
          await getPool().query(
            `INSERT INTO tasks (id, title, description, due_date, priority, completed, created_at, completed_at, tags)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
            [t.id, t.title, t.description || null, t.dueDate || null, t.priority || "medium", t.completed || false, t.createdAt, t.completedAt || null, JSON.stringify(t.tags || [])]
          );
        }
        console.log(`[tasks] Migrated ${legacyTasks.length} tasks from data/tasks.json to PostgreSQL`);
      }
    } catch (err) {
      console.error("[tasks] Task migration failed:", err);
    }
  }
  console.log("[tasks] initialized");
}
function generateId() {
  return `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}
async function loadTasks() {
  const result = await getPool().query(`SELECT * FROM tasks ORDER BY created_at DESC`);
  return result.rows.map(rowToTask);
}
async function getActiveTasks() {
  const all = await loadTasks();
  return all.filter((t) => !t.completed).map((t) => ({ id: t.id, title: t.title, priority: t.priority, dueDate: t.dueDate }));
}
async function saveTask(task) {
  await getPool().query(
    `INSERT INTO tasks (id, title, description, due_date, priority, completed, created_at, completed_at, tags)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       description = EXCLUDED.description,
       due_date = EXCLUDED.due_date,
       priority = EXCLUDED.priority,
       completed = EXCLUDED.completed,
       completed_at = EXCLUDED.completed_at,
       tags = EXCLUDED.tags`,
    [task.id, task.title, task.description || null, task.dueDate || null, task.priority, task.completed, task.createdAt, task.completedAt || null, JSON.stringify(task.tags || [])]
  );
}
function rowToTask(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description || void 0,
    dueDate: row.due_date || void 0,
    priority: row.priority,
    completed: row.completed,
    createdAt: row.created_at,
    completedAt: row.completed_at || void 0,
    tags: Array.isArray(row.tags) ? row.tags : JSON.parse(row.tags || "[]")
  };
}
async function addTask(title, options) {
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
  await saveTask(task);
  return `Added task: "${title}"${task.dueDate ? ` (due: ${task.dueDate})` : ""}${task.priority !== "medium" ? ` [${task.priority} priority]` : ""}`;
}
async function listTasks(filter) {
  const tasks = await loadTasks();
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
async function getCompletedTasks() {
  const result = await getPool().query(`SELECT * FROM tasks WHERE completed = true ORDER BY completed_at DESC`);
  return result.rows.map(rowToTask).map((t) => ({ id: t.id, title: t.title, priority: t.priority, completedAt: t.completedAt }));
}
async function restoreTask(taskId) {
  const result = await getPool().query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  if (result.rows.length === 0) return `Task not found: ${taskId}`;
  const task = rowToTask(result.rows[0]);
  if (!task.completed) return `Task is already active: "${task.title}"`;
  task.completed = false;
  task.completedAt = void 0;
  await saveTask(task);
  return `Restored task: "${task.title}"`;
}
async function completeTask(taskId) {
  const result = await getPool().query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  if (result.rows.length === 0) return `Task not found: ${taskId}`;
  const task = rowToTask(result.rows[0]);
  if (task.completed) return `Task already completed: "${task.title}"`;
  task.completed = true;
  task.completedAt = (/* @__PURE__ */ new Date()).toISOString();
  await saveTask(task);
  return `Completed task: "${task.title}"`;
}
async function deleteTask(taskId) {
  const result = await getPool().query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  if (result.rows.length === 0) return `Task not found: ${taskId}`;
  const task = rowToTask(result.rows[0]);
  await getPool().query(`DELETE FROM tasks WHERE id = $1`, [taskId]);
  return `Deleted task: "${task.title}"`;
}
async function updateTask(taskId, updates) {
  const result = await getPool().query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
  if (result.rows.length === 0) return `Task not found: ${taskId}`;
  const task = rowToTask(result.rows[0]);
  if (updates.title) task.title = updates.title;
  if (updates.description !== void 0) task.description = updates.description;
  if (updates.dueDate !== void 0) task.dueDate = updates.dueDate;
  if (updates.priority) task.priority = updates.priority;
  if (updates.tags) task.tags = updates.tags;
  await saveTask(task);
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
async function getTopHeadlines(count = 3) {
  try {
    const res = await fetch(RSS_FEEDS["top"], {
      headers: { "User-Agent": "pi-assistant/1.0" }
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items = parseRssItems(xml);
    return items.slice(0, count).map((item) => ({ title: item.title, source: item.source }));
  } catch {
    return [];
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
var API_BASE = "https://twitter241.p.rapidapi.com";
var API_HOST = "twitter241.p.rapidapi.com";
var RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "";
var TIMEOUT_MS = 15e3;
function cleanUsername(input) {
  return input.replace(/^@/, "").replace(/^https?:\/\/(x\.com|twitter\.com)\//, "").replace(/\/.*$/, "").trim();
}
function extractTweetId(input) {
  const match = input.match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/);
  if (match) return match[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}
async function apiFetch(endpoint, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = `${API_BASE}${endpoint}?${new URLSearchParams(params)}`;
    const res = await fetch(url, {
      headers: {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": API_HOST
      },
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error("X request timed out");
    throw err;
  }
}
function extractTweetFromResult(result) {
  if (!result) return null;
  if (result.__typename === "TweetWithVisibilityResults") return result.tweet || null;
  if (result.__typename === "Tweet" || result.legacy) return result;
  return null;
}
function extractTweetsFromEntries(entries) {
  const results = [];
  for (const entry of entries) {
    const content = entry?.content || {};
    const directResult = content?.itemContent?.tweet_results?.result;
    if (directResult) {
      const tweet = extractTweetFromResult(directResult);
      if (tweet) results.push(tweet);
    }
    const items = content?.items || [];
    for (const sub of items) {
      const subResult = sub?.item?.itemContent?.tweet_results?.result;
      if (subResult) {
        const tweet = extractTweetFromResult(subResult);
        if (tweet) results.push(tweet);
      }
    }
  }
  return results;
}
function formatTweetData(tweet) {
  if (!tweet) return null;
  const legacy = tweet.legacy || {};
  const userResult = tweet.core?.user_results?.result || {};
  const userCore = userResult.core || {};
  const fullText = legacy.full_text || "";
  if (!fullText && !legacy.id_str) return null;
  const mediaEntities = legacy.extended_entities?.media || legacy.entities?.media || [];
  let quoteText = null;
  let quoteAuthor = null;
  const qt = tweet.quoted_status_result?.result;
  if (qt) {
    const qtTweet = extractTweetFromResult(qt);
    if (qtTweet?.legacy?.full_text) {
      quoteText = qtTweet.legacy.full_text;
      quoteAuthor = qtTweet.core?.user_results?.result?.core?.screen_name || "unknown";
    }
  }
  return {
    text: fullText,
    author: userCore.name || "",
    handle: userCore.screen_name || "",
    likes: legacy.favorite_count || 0,
    retweets: legacy.retweet_count || 0,
    replies: legacy.reply_count || 0,
    views: tweet.views?.count || null,
    date: legacy.created_at || "",
    id: legacy.id_str || tweet.rest_id || "",
    media: mediaEntities.map((m) => m.type || "photo"),
    quoteText,
    quoteAuthor
  };
}
async function getUserProfile(username) {
  try {
    if (!RAPIDAPI_KEY) return "X/Twitter API not configured (missing API key).";
    const handle = cleanUsername(username);
    const data = await apiFetch("/user", { username: handle });
    const user = data?.result?.data?.user?.result;
    if (!user) return `Could not find X user @${handle}`;
    const core = user.core || {};
    const legacy = user.legacy || {};
    const location = user.location || {};
    const parts = [
      `@${core.screen_name || handle} (${core.name || ""})`,
      legacy.description ? `Bio: ${legacy.description}` : null,
      location.location ? `Location: ${location.location}` : null,
      `Followers: ${(legacy.followers_count || 0).toLocaleString()} | Following: ${(legacy.friends_count || 0).toLocaleString()}`,
      `Tweets: ${(legacy.statuses_count || 0).toLocaleString()} | Likes: ${(legacy.favourites_count || 0).toLocaleString()}`,
      user.is_blue_verified ? "\u2713 Verified" : null,
      core.created_at ? `Joined: ${new Date(core.created_at).toLocaleDateString("en-US", { month: "long", year: "numeric" })}` : null,
      legacy.entities?.url?.urls?.[0]?.expanded_url ? `Website: ${legacy.entities.url.urls[0].expanded_url}` : null,
      `Profile: https://x.com/${core.screen_name || handle}`
    ];
    return parts.filter(Boolean).join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching X profile: ${msg}`;
  }
}
async function getTweet(tweetInput) {
  try {
    if (!RAPIDAPI_KEY) return "X/Twitter API not configured (missing API key).";
    const tweetId = extractTweetId(tweetInput);
    if (!tweetId) return "Please provide a valid tweet URL or tweet ID.";
    const data = await apiFetch("/tweet", { pid: tweetId });
    const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
    for (const inst of instructions) {
      for (const entry of inst.entries || []) {
        const rawResult = entry?.content?.itemContent?.tweet_results?.result;
        const tweet = extractTweetFromResult(rawResult);
        const formatted = formatTweetData(tweet);
        if (formatted && (formatted.id === tweetId || entry.entryId?.includes(tweetId))) {
          const parts = [
            `@${formatted.handle} (${formatted.author})`,
            formatted.text,
            "",
            `${formatted.likes.toLocaleString()} likes | ${formatted.retweets.toLocaleString()} retweets | ${formatted.replies.toLocaleString()} replies${formatted.views ? ` | ${Number(formatted.views).toLocaleString()} views` : ""}`,
            formatted.date ? `Posted: ${new Date(formatted.date).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}` : null,
            `Link: https://x.com/${formatted.handle}/status/${formatted.id}`
          ];
          if (formatted.media.length > 0) {
            parts.push(`Media: ${formatted.media.length} attachment(s) (${formatted.media.join(", ")})`);
          }
          if (formatted.quoteText) {
            parts.push("", `Quoting @${formatted.quoteAuthor}:`, formatted.quoteText);
          }
          return parts.filter((p) => p !== null).join("\n");
        }
      }
    }
    return "Tweet not found or may have been deleted.";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching tweet: ${msg}`;
  }
}
async function resolveUserId(username) {
  const data = await apiFetch("/user", { username });
  return data?.result?.data?.user?.result?.rest_id || null;
}
async function getUserTimeline(username, count = 10) {
  try {
    if (!RAPIDAPI_KEY) return "X/Twitter API not configured (missing API key).";
    const handle = cleanUsername(username);
    const maxTweets = Math.min(count, 20);
    const userId = await resolveUserId(handle);
    if (!userId) return `Could not find X user @${handle}`;
    const data = await apiFetch("/user-tweets", { user: userId, count: String(maxTweets) });
    const instructions = data?.result?.timeline?.instructions || [];
    const tweets = [];
    const seen = /* @__PURE__ */ new Set();
    for (const inst of instructions) {
      const allTweets = extractTweetsFromEntries(inst.entries || []);
      for (const tweet of allTweets) {
        const formatted = formatTweetData(tweet);
        if (formatted && !seen.has(formatted.id) && !formatted.text.startsWith("RT @")) {
          seen.add(formatted.id);
          tweets.push(formatted);
          if (tweets.length >= maxTweets) break;
        }
      }
      if (tweets.length >= maxTweets) break;
    }
    if (tweets.length === 0) return `No recent tweets found for @${handle}. The account may be private or have no recent activity.`;
    const lines = tweets.map((t, i) => {
      if (!t) return "";
      const dateStr = t.date ? new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
      const stats = `${t.likes.toLocaleString()} likes | ${t.retweets.toLocaleString()} RTs${t.views ? ` | ${Number(t.views).toLocaleString()} views` : ""}`;
      return `${i + 1}. @${t.handle} \u2014 ${dateStr}
   ${t.text.slice(0, 280)}${t.text.length > 280 ? "..." : ""}
   ${stats} | https://x.com/${t.handle}/status/${t.id}`;
    });
    return `Recent tweets from @${handle}:

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error fetching timeline: ${msg}`;
  }
}
async function searchTweets(query, count = 10, type = "Latest") {
  try {
    if (!RAPIDAPI_KEY) return "X/Twitter API not configured (missing API key).";
    const maxResults = Math.min(count, 20);
    const data = await apiFetch("/search", { query, count: String(maxResults), type });
    const instructions = data?.result?.timeline?.instructions || [];
    const tweets = [];
    const seen = /* @__PURE__ */ new Set();
    for (const inst of instructions) {
      const allTweets = extractTweetsFromEntries(inst.entries || []);
      for (const tweet of allTweets) {
        const formatted = formatTweetData(tweet);
        if (formatted && !seen.has(formatted.id)) {
          seen.add(formatted.id);
          tweets.push(formatted);
          if (tweets.length >= maxResults) break;
        }
      }
      if (tweets.length >= maxResults) break;
    }
    if (tweets.length === 0) return `No tweets found matching "${query}".`;
    const lines = tweets.map((t, i) => {
      if (!t) return "";
      const dateStr = t.date ? new Date(t.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
      const stats = `${t.likes.toLocaleString()} likes | ${t.retweets.toLocaleString()} RTs${t.views ? ` | ${Number(t.views).toLocaleString()} views` : ""}`;
      let line = `${i + 1}. @${t.handle} \u2014 ${dateStr}
   ${t.text.slice(0, 280)}${t.text.length > 280 ? "..." : ""}
   ${stats} | https://x.com/${t.handle}/status/${t.id}`;
      if (t.quoteText) {
        line += `
   \u21B3 Quoting @${t.quoteAuthor}: ${t.quoteText.slice(0, 150)}${(t.quoteText.length || 0) > 150 ? "..." : ""}`;
      }
      return line;
    });
    return `X search results for "${query}" (${type}):

${lines.join("\n\n")}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Error searching X: ${msg}`;
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
async function fetchWithTimeout(url, headers2 = {}) {
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
    const res = await fetchWithTimeout(url);
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
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      if (res.status === 404) {
        const searchUrl = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(input)}`;
        const searchRes = await fetchWithTimeout(searchUrl);
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
async function fetchWithTimeout2(url) {
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
  const res = await fetchWithTimeout2(url);
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
    const res = await fetchWithTimeout2(url);
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
    const res = await fetchWithTimeout2(url);
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

// src/gws.ts
import { execFile } from "child_process";
import path2 from "path";
var GWS_BIN = path2.join(process.cwd(), "bin", "gws");
var TIMEOUT_MS4 = 15e3;
function parseHexColor(hex) {
  return {
    red: parseInt(hex.slice(1, 3), 16) / 255,
    green: parseInt(hex.slice(3, 5), 16) / 255,
    blue: parseInt(hex.slice(5, 7), 16) / 255
  };
}
async function runGws(args) {
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, data: null, raw: "Google not connected \u2014 visit /api/gmail/auth to connect" };
  }
  return new Promise((resolve) => {
    const env = { ...process.env, GOOGLE_WORKSPACE_CLI_TOKEN: token };
    execFile(GWS_BIN, args, { env, timeout: TIMEOUT_MS4, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const errMsg = [stderr, stdout, err.message].filter(Boolean).join("\n").trim() || "Unknown error";
        console.error(`[gws] Error running: gws ${args.join(" ")}`, errMsg);
        if (errMsg.includes("401") || errMsg.includes("Unauthorized") || errMsg.includes("invalid_credentials")) {
          resolve({ ok: false, data: null, raw: "Google authorization expired \u2014 visit /api/gmail/auth to reconnect" });
          return;
        }
        if (errMsg.includes("403") || errMsg.includes("Forbidden") || errMsg.includes("insufficient")) {
          resolve({ ok: false, data: null, raw: "Insufficient permissions \u2014 visit /api/gmail/auth to reconnect with required scopes" });
          return;
        }
        resolve({ ok: false, data: null, raw: `Error: ${errMsg.slice(0, 1e3)}` });
        return;
      }
      const output = stdout.trim();
      try {
        const data = JSON.parse(output);
        resolve({ ok: true, data, raw: output });
      } catch {
        resolve({ ok: false, data: null, raw: output });
      }
    });
  });
}
async function driveList(query, pageSize = 20) {
  const params = {
    pageSize,
    fields: "files(id,name,mimeType,modifiedTime,size,parents,webViewLink)",
    orderBy: "modifiedTime desc"
  };
  if (query) params.q = query;
  const args = ["drive", "files", "list", "--params", JSON.stringify(params)];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const files = result.data?.files;
  if (!files || files.length === 0) return query ? `No files found matching query.` : "No files in Drive.";
  const lines = files.map((f, i) => {
    const type = f.mimeType === "application/vnd.google-apps.folder" ? "\u{1F4C1}" : f.mimeType === "application/vnd.google-apps.spreadsheet" ? "\u{1F4CA}" : f.mimeType === "application/vnd.google-apps.document" ? "\u{1F4C4}" : f.mimeType === "application/vnd.google-apps.presentation" ? "\u{1F4FD}\uFE0F" : "\u{1F4CE}";
    const modified = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
    return `${i + 1}. ${type} ${f.name}
   ID: ${f.id}
   Modified: ${modified}${f.webViewLink ? `
   Link: ${f.webViewLink}` : ""}`;
  });
  return `Drive files (${files.length}):

${lines.join("\n\n")}`;
}
async function driveGet(fileId) {
  const args = ["drive", "files", "get", "--params", JSON.stringify({ fileId, fields: "id,name,mimeType,modifiedTime,size,parents,webViewLink,description,owners,shared" })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const f = result.data;
  if (!f) return "File not found.";
  const lines = [
    `Name: ${f.name}`,
    `ID: ${f.id}`,
    `Type: ${f.mimeType}`,
    f.size ? `Size: ${(parseInt(f.size) / 1024).toFixed(1)} KB` : null,
    f.modifiedTime ? `Modified: ${new Date(f.modifiedTime).toLocaleString("en-US", { timeZone: "America/New_York" })}` : null,
    f.owners ? `Owner: ${f.owners.map((o) => o.displayName || o.emailAddress).join(", ")}` : null,
    f.shared !== void 0 ? `Shared: ${f.shared}` : null,
    f.webViewLink ? `Link: ${f.webViewLink}` : null,
    f.description ? `Description: ${f.description}` : null,
    f.parents ? `Parent folder ID: ${f.parents.join(", ")}` : null
  ].filter(Boolean);
  return lines.join("\n");
}
async function driveCreateFolder(name, parentId) {
  const body = {
    name,
    mimeType: "application/vnd.google-apps.folder"
  };
  if (parentId) body.parents = [parentId];
  const args = ["drive", "files", "create", "--json", JSON.stringify(body), "--params", JSON.stringify({ fields: "id,name,webViewLink" })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const f = result.data;
  return `Created folder: "${f?.name || name}"
ID: ${f?.id || "unknown"}${f?.webViewLink ? `
Link: ${f.webViewLink}` : ""}`;
}
async function driveMove(fileId, newParentId) {
  const getResult = await runGws(["drive", "files", "get", "--params", JSON.stringify({ fileId, fields: "id,name,parents" })]);
  if (!getResult.ok) return getResult.raw;
  const currentParents = getResult.data?.parents?.join(",") || "";
  const args = ["drive", "files", "update", "--params", JSON.stringify({
    fileId,
    addParents: newParentId,
    removeParents: currentParents,
    fields: "id,name,parents"
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Moved "${result.data?.name || fileId}" to folder ${newParentId}`;
}
async function driveRename(fileId, newName) {
  const args = ["drive", "files", "update", "--params", JSON.stringify({ fileId }), "--json", JSON.stringify({ name: newName })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Renamed to: "${result.data?.name || newName}"`;
}
async function driveDelete(fileId) {
  const args = ["drive", "files", "update", "--params", JSON.stringify({ fileId }), "--json", JSON.stringify({ trashed: true })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Moved "${result.data?.name || fileId}" to trash.`;
}
async function sheetsRead(spreadsheetId, range) {
  const args = ["sheets", "+read", "--spreadsheet", spreadsheetId, "--range", range];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  if (result.data?.values) {
    const rows = result.data.values;
    if (rows.length === 0) return "No data in the specified range.";
    const formatted = rows.map((row, i) => `Row ${i + 1}: ${row.join(" | ")}`).join("\n");
    return `${range} (${rows.length} rows):

${formatted}`;
  }
  return result.raw || "No data returned.";
}
async function sheetsList() {
  return driveList("mimeType='application/vnd.google-apps.spreadsheet'");
}
async function sheetsAppend(spreadsheetId, values) {
  const jsonValues = JSON.stringify(values);
  const args = ["sheets", "+append", "--spreadsheet", spreadsheetId, "--json-values", jsonValues];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Appended ${values.length} row(s) to spreadsheet.`;
}
async function sheetsUpdate(spreadsheetId, range, values) {
  const args = [
    "sheets",
    "spreadsheets",
    "values",
    "update",
    "--params",
    JSON.stringify({
      spreadsheetId,
      range,
      valueInputOption: "USER_ENTERED"
    }),
    "--json",
    JSON.stringify({ values })
  ];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Updated ${range} with ${values.length} row(s).`;
}
async function sheetsCreate(title) {
  const args = ["sheets", "spreadsheets", "create", "--json", JSON.stringify({ properties: { title } })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const s = result.data;
  return `Created spreadsheet: "${s?.properties?.title || title}"
ID: ${s?.spreadsheetId || "unknown"}
URL: ${s?.spreadsheetUrl || ""}`;
}
async function sheetsAddSheet(spreadsheetId, title) {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{ addSheet: { properties: { title } } }]
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const reply = result.data?.replies?.[0]?.addSheet;
  const sheetId = reply?.properties?.sheetId ?? "unknown";
  return `Added sheet "${title}" (sheetId: ${sheetId}) to spreadsheet ${spreadsheetId}.`;
}
async function sheetsDeleteSheet(spreadsheetId, sheetId) {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{ deleteSheet: { sheetId } }]
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Deleted sheet ${sheetId} from spreadsheet ${spreadsheetId}.`;
}
async function sheetsClear(spreadsheetId, range) {
  const args = ["sheets", "spreadsheets", "values", "clear", "--params", JSON.stringify({ spreadsheetId, range }), "--json", JSON.stringify({})];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Cleared range ${range} in spreadsheet ${spreadsheetId}.`;
}
async function sheetsFormatCells(spreadsheetId, sheetId, startRow, endRow, startCol, endCol, bold, bgColor, textColor, fontSize) {
  const cellFormat = {};
  const fields = [];
  if (bold !== void 0) {
    cellFormat.textFormat = { ...cellFormat.textFormat, bold };
    fields.push("userEnteredFormat.textFormat.bold");
  }
  if (fontSize !== void 0) {
    cellFormat.textFormat = { ...cellFormat.textFormat, fontSize };
    fields.push("userEnteredFormat.textFormat.fontSize");
  }
  if (bgColor) {
    cellFormat.backgroundColor = bgColor;
    fields.push("userEnteredFormat.backgroundColor");
  }
  if (textColor) {
    cellFormat.textFormat = { ...cellFormat.textFormat, foregroundColor: textColor };
    fields.push("userEnteredFormat.textFormat.foregroundColor");
  }
  if (fields.length === 0) return "Error: At least one formatting option (bold, fontSize, bgColor, textColor) must be specified.";
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{
      repeatCell: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
        cell: { userEnteredFormat: cellFormat },
        fields: fields.join(",")
      }
    }]
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Formatted cells [${startRow}:${endRow}, ${startCol}:${endCol}] in sheet ${sheetId}.`;
}
async function sheetsAutoResize(spreadsheetId, sheetId, startCol, endCol) {
  const dimension = { sheetId, dimension: "COLUMNS" };
  if (startCol !== void 0) dimension.startIndex = startCol;
  if (endCol !== void 0) dimension.endIndex = endCol;
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{ autoResizeDimensions: { dimensions: dimension } }]
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Auto-resized columns in sheet ${sheetId}.`;
}
async function sheetsMergeCells(spreadsheetId, sheetId, startRow, endRow, startCol, endCol) {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{
      mergeCells: {
        range: { sheetId, startRowIndex: startRow, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
        mergeType: "MERGE_ALL"
      }
    }]
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Merged cells [${startRow}:${endRow}, ${startCol}:${endCol}] in sheet ${sheetId}.`;
}
async function sheetsBatchUpdate(spreadsheetId, requests) {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const replyCount = result.data?.replies?.length ?? 0;
  return `Batch update completed: ${requests.length} request(s) sent, ${replyCount} reply(ies) received.

${result.raw}`;
}
async function sheetsSort(spreadsheetId, sheetId, sortCol, ascending) {
  const args = ["sheets", "spreadsheets", "batchUpdate", "--params", JSON.stringify({ spreadsheetId }), "--json", JSON.stringify({
    requests: [{
      sortRange: {
        range: { sheetId },
        sortSpecs: [{ dimensionIndex: sortCol, sortOrder: ascending === false ? "DESCENDING" : "ASCENDING" }]
      }
    }]
  })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Sorted sheet ${sheetId} by column ${sortCol} (${ascending === false ? "descending" : "ascending"}).`;
}
async function docsList() {
  return driveList("mimeType='application/vnd.google-apps.document'");
}
async function docsGet(documentId) {
  const args = ["docs", "documents", "get", "--params", JSON.stringify({ documentId })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const doc = result.data;
  if (!doc) return "Document not found.";
  const title = doc.title || "Untitled";
  const docId = doc.documentId || documentId;
  const textParts = [];
  if (doc.body?.content) {
    for (const element of doc.body.content) {
      if (element.paragraph?.elements) {
        for (const el of element.paragraph.elements) {
          if (el.textRun?.content) textParts.push(el.textRun.content);
        }
      }
      if (element.table) {
        textParts.push("[Table]\n");
      }
    }
  }
  const textContent = textParts.join("");
  const lines = [
    `Title: ${title}`,
    `ID: ${docId}`,
    ``,
    `--- Content ---`,
    textContent.trim() || "(empty document)"
  ];
  return lines.join("\n");
}
async function docsCreate(title) {
  const args = ["docs", "documents", "create", "--json", JSON.stringify({ title })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const doc = result.data;
  return `Created document: "${doc?.title || title}"
ID: ${doc?.documentId || "unknown"}`;
}
async function docsAppend(documentId, text) {
  const args = ["docs", "+write", "--document", documentId, "--text", text];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Appended text to document ${documentId}.`;
}
async function docsInsertText(documentId, text, index) {
  const requests = [];
  if (index !== void 0) {
    requests.push({ insertText: { location: { index }, text } });
  } else {
    requests.push({ insertText: { endOfSegmentLocation: {}, text } });
  }
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted text into document ${documentId}${index !== void 0 ? ` at index ${index}` : " at end"}.`;
}
async function docsDeleteContent(documentId, startIndex, endIndex) {
  const requests = [{ deleteContentRange: { range: { startIndex, endIndex } } }];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Deleted content from index ${startIndex} to ${endIndex} in document ${documentId}.`;
}
async function docsInsertTable(documentId, rows, cols) {
  const requests = [{ insertTable: { rows, columns: cols, endOfSegmentLocation: {} } }];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted ${rows}\xD7${cols} table into document ${documentId}.`;
}
async function docsFormatText(documentId, startIndex, endIndex, bold, italic, fontSize, foregroundColor) {
  const textStyle = {};
  const fields = [];
  if (bold !== void 0) {
    textStyle.bold = bold;
    fields.push("bold");
  }
  if (italic !== void 0) {
    textStyle.italic = italic;
    fields.push("italic");
  }
  if (fontSize !== void 0) {
    textStyle.fontSize = { magnitude: fontSize, unit: "PT" };
    fields.push("fontSize");
  }
  if (foregroundColor) {
    textStyle.foregroundColor = { color: { rgbColor: parseHexColor(foregroundColor) } };
    fields.push("foregroundColor");
  }
  if (fields.length === 0) return "Error: At least one formatting option (bold, italic, fontSize, foregroundColor) must be specified.";
  const requests = [{ updateTextStyle: { range: { startIndex, endIndex }, textStyle, fields: fields.join(",") } }];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Formatted text (index ${startIndex}\u2013${endIndex}) in document ${documentId}.`;
}
async function docsInsertImage(documentId, imageUri, index) {
  const request = { insertInlineImage: { uri: imageUri } };
  if (index !== void 0) {
    request.insertInlineImage.location = { index };
  } else {
    request.insertInlineImage.endOfSegmentLocation = {};
  }
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests: [request] })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted image into document ${documentId}.`;
}
async function docsReplaceText(documentId, findText, replaceText) {
  const requests = [{ replaceAllText: { containsText: { text: findText, matchCase: true }, replaceText } }];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const count = result.data?.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;
  return `Replaced ${count} occurrence(s) of "${findText}" with "${replaceText}" in document ${documentId}.`;
}
async function docsInsertHeading(documentId, text, level) {
  const headingStyle = `HEADING_${Math.min(Math.max(level, 1), 6)}`;
  const getArgs = ["docs", "documents", "get", "--params", JSON.stringify({ documentId })];
  const getResult = await runGws(getArgs);
  if (!getResult.ok) return getResult.raw;
  const body = getResult.data?.body?.content;
  const endIndex = body && body.length > 0 ? (body[body.length - 1]?.endIndex || 1) - 1 : 1;
  const insertAt = Math.max(endIndex, 1);
  const requests = [
    { insertText: { location: { index: insertAt }, text: text + "\n" } },
    { updateParagraphStyle: { range: { startIndex: insertAt, endIndex: insertAt + text.length + 1 }, paragraphStyle: { namedStyleType: headingStyle }, fields: "namedStyleType" } }
  ];
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted heading (H${level}) "${text}" into document ${documentId}.`;
}
async function docsBatchUpdate(documentId, requests) {
  const args = ["docs", "documents", "batchUpdate", "--params", JSON.stringify({ documentId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Batch update applied ${requests.length} request(s) to document ${documentId}.
${JSON.stringify(result.data?.replies || [], null, 2)}`;
}
async function slidesList() {
  return driveList("mimeType='application/vnd.google-apps.presentation'");
}
async function slidesGet(presentationId) {
  const args = ["slides", "presentations", "get", "--params", JSON.stringify({ presentationId })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const pres = result.data;
  if (!pres) return "Presentation not found.";
  const title = pres.title || "Untitled";
  const presId = pres.presentationId || presentationId;
  const slideCount = pres.slides?.length || 0;
  const lines = [
    `Title: ${title}`,
    `ID: ${presId}`,
    `Slides: ${slideCount}`,
    `Page size: ${pres.pageSize?.width?.magnitude || "?"}\xD7${pres.pageSize?.height?.magnitude || "?"} ${pres.pageSize?.width?.unit || ""}`
  ];
  if (pres.slides) {
    lines.push("", "--- Slides ---");
    for (let i = 0; i < pres.slides.length; i++) {
      const slide = pres.slides[i];
      let slideText = "";
      if (slide.pageElements) {
        for (const el of slide.pageElements) {
          if (el.shape?.text?.textElements) {
            for (const te of el.shape.text.textElements) {
              if (te.textRun?.content) slideText += te.textRun.content;
            }
          }
        }
      }
      lines.push(`
Slide ${i + 1} (${slide.objectId}):`);
      lines.push(slideText.trim() || "(no text)");
    }
  }
  return lines.join("\n");
}
async function slidesCreate(title) {
  const args = ["slides", "presentations", "create", "--json", JSON.stringify({ title })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const pres = result.data;
  return `Created presentation: "${pres?.title || title}"
ID: ${pres?.presentationId || "unknown"}`;
}
async function slidesAppend(presentationId, title, body) {
  const slideId = `slide_${Date.now()}`;
  const createArgs = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({
    requests: [
      {
        createSlide: {
          objectId: slideId,
          slideLayoutReference: { predefinedLayout: "TITLE_AND_BODY" }
        }
      }
    ]
  })];
  const createResult = await runGws(createArgs);
  if (!createResult.ok) return createResult.raw;
  const pageResult = await runGws(["slides", "presentations", "pages", "get", "--params", JSON.stringify({ presentationId, pageObjectId: slideId })]);
  if (!pageResult.ok) return pageResult.raw;
  const page = pageResult.data;
  let titleId = "";
  let bodyId = "";
  if (page?.pageElements) {
    for (const el of page.pageElements) {
      const phType = el.shape?.placeholder?.type;
      if (phType === "TITLE" || phType === "CENTERED_TITLE") titleId = el.objectId;
      else if (phType === "BODY" || phType === "SUBTITLE") bodyId = el.objectId;
    }
  }
  const textRequests = [];
  if (titleId && title) {
    textRequests.push({ insertText: { objectId: titleId, text: title, insertionIndex: 0 } });
  }
  if (bodyId && body) {
    textRequests.push({ insertText: { objectId: bodyId, text: body, insertionIndex: 0 } });
  }
  if (textRequests.length > 0) {
    const textArgs = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests: textRequests })];
    const textResult = await runGws(textArgs);
    if (!textResult.ok) return `Slide created but text insertion failed: ${textResult.raw}`;
  }
  return `Added slide "${title}" to presentation ${presentationId}.`;
}
async function slidesInsertTable(presentationId, slideObjectId, rows, cols, data) {
  const tableId = `table_${Date.now()}`;
  const requests = [
    {
      createTable: {
        objectId: tableId,
        elementProperties: {
          pageObjectId: slideObjectId,
          size: {
            width: { magnitude: 72e5, unit: "EMU" },
            height: { magnitude: rows * 4e5, unit: "EMU" }
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: 4e5,
            translateY: 15e5,
            unit: "EMU"
          }
        },
        rows,
        columns: cols
      }
    }
  ];
  if (data) {
    for (let r = 0; r < Math.min(data.length, rows); r++) {
      for (let c = 0; c < Math.min(data[r].length, cols); c++) {
        if (data[r][c]) {
          requests.push({
            insertText: {
              objectId: tableId,
              cellLocation: { rowIndex: r, columnIndex: c },
              text: data[r][c],
              insertionIndex: 0
            }
          });
        }
      }
    }
  }
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted ${rows}\xD7${cols} table on slide ${slideObjectId}.`;
}
async function slidesInsertImage(presentationId, slideObjectId, imageUrl, width, height) {
  const requests = [
    {
      createImage: {
        url: imageUrl,
        elementProperties: {
          pageObjectId: slideObjectId,
          size: {
            width: { magnitude: width || 3e6, unit: "EMU" },
            height: { magnitude: height || 3e6, unit: "EMU" }
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: 2e6,
            translateY: 15e5,
            unit: "EMU"
          }
        }
      }
    }
  ];
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted image on slide ${slideObjectId}.`;
}
async function slidesInsertShape(presentationId, slideObjectId, shapeType, text, left, top, width, height) {
  const shapeId = `shape_${Date.now()}`;
  const requests = [
    {
      createShape: {
        objectId: shapeId,
        shapeType,
        elementProperties: {
          pageObjectId: slideObjectId,
          size: {
            width: { magnitude: width, unit: "EMU" },
            height: { magnitude: height, unit: "EMU" }
          },
          transform: {
            scaleX: 1,
            scaleY: 1,
            translateX: left,
            translateY: top,
            unit: "EMU"
          }
        }
      }
    }
  ];
  if (text) {
    requests.push({
      insertText: {
        objectId: shapeId,
        text,
        insertionIndex: 0
      }
    });
  }
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Inserted ${shapeType} shape on slide ${slideObjectId}. Shape ID: ${shapeId}`;
}
async function slidesFormatText(presentationId, objectId, startIndex, endIndex, bold, italic, fontSize, color) {
  const style = {};
  const fields = [];
  if (bold !== void 0) {
    style.bold = bold;
    fields.push("bold");
  }
  if (italic !== void 0) {
    style.italic = italic;
    fields.push("italic");
  }
  if (fontSize !== void 0) {
    style.fontSize = { magnitude: fontSize, unit: "PT" };
    fields.push("fontSize");
  }
  if (color) {
    style.foregroundColor = { opaqueColor: { rgbColor: parseHexColor(color) } };
    fields.push("foregroundColor");
  }
  if (fields.length === 0) return "Error: At least one formatting option (bold, italic, fontSize, color) must be specified.";
  const requests = [
    {
      updateTextStyle: {
        objectId,
        textRange: { type: "FIXED_RANGE", startIndex, endIndex },
        style,
        fields: fields.join(",")
      }
    }
  ];
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Formatted text in object ${objectId} (chars ${startIndex}-${endIndex}).`;
}
async function slidesDeleteSlide(presentationId, slideObjectId) {
  const requests = [{ deleteObject: { objectId: slideObjectId } }];
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Deleted slide ${slideObjectId} from presentation ${presentationId}.`;
}
async function slidesDuplicateSlide(presentationId, slideObjectId) {
  const requests = [{ duplicateObject: { objectId: slideObjectId } }];
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const newId = result.data?.replies?.[0]?.duplicateObject?.objectId || "unknown";
  return `Duplicated slide ${slideObjectId}. New slide ID: ${newId}`;
}
async function slidesReplaceText(presentationId, findText, replaceText) {
  const requests = [
    {
      replaceAllText: {
        containsText: { text: findText, matchCase: true },
        replaceText
      }
    }
  ];
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  const count = result.data?.replies?.[0]?.replaceAllText?.occurrencesChanged || 0;
  return `Replaced ${count} occurrence(s) of "${findText}" with "${replaceText}".`;
}
async function slidesBatchUpdate(presentationId, requests) {
  const args = ["slides", "presentations", "batchUpdate", "--params", JSON.stringify({ presentationId }), "--json", JSON.stringify({ requests })];
  const result = await runGws(args);
  if (!result.ok) return result.raw;
  return `Batch update completed (${requests.length} request(s)). Response: ${JSON.stringify(result.data?.replies || []).slice(0, 2e3)}`;
}

// src/youtube.ts
var BASE_URL = "https://www.googleapis.com/youtube/v3";
var TIMEOUT_MS5 = 15e3;
async function ytFetch(endpoint, params) {
  const token = await getAccessToken();
  if (!token) {
    return { ok: false, data: null, raw: "Google not connected \u2014 visit /api/gmail/auth to connect" };
  }
  const url = new URL(`${BASE_URL}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS5);
    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    clearTimeout(timeout);
    const text = await res.text();
    if (!res.ok) {
      const errMsg = text.slice(0, 1e3);
      console.error(`[youtube] Error ${res.status} on ${endpoint}:`, errMsg);
      if (res.status === 401) {
        return { ok: false, data: null, raw: "Google authorization expired \u2014 visit /api/gmail/auth to reconnect" };
      }
      if (res.status === 403) {
        return { ok: false, data: null, raw: `Insufficient permissions or quota exceeded: ${errMsg}` };
      }
      return { ok: false, data: null, raw: `YouTube API error ${res.status}: ${errMsg}` };
    }
    try {
      const data = JSON.parse(text);
      return { ok: true, data, raw: text };
    } catch {
      return { ok: true, data: null, raw: text };
    }
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, data: null, raw: "YouTube API request timed out" };
    }
    console.error(`[youtube] Fetch error on ${endpoint}:`, err.message);
    return { ok: false, data: null, raw: `Error: ${err.message}` };
  }
}
function formatDuration2(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return iso;
  const h = match[1] ? `${match[1]}:` : "";
  const m = (match[2] || "0").padStart(h ? 2 : 1, "0");
  const s = (match[3] || "0").padStart(2, "0");
  return `${h}${m}:${s}`;
}
function formatCount(n) {
  const num = typeof n === "string" ? parseInt(n) : n;
  if (num >= 1e9) return `${(num / 1e9).toFixed(1)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)}K`;
  return num.toString();
}
async function youtubeSearch(query, maxResults = 10) {
  const result = await ytFetch("search", {
    part: "snippet",
    type: "video",
    q: query,
    maxResults: String(maxResults),
    order: "relevance"
  });
  if (!result.ok) return result.raw;
  const items = result.data?.items;
  if (!items || items.length === 0) return `No videos found for "${query}".`;
  const lines = items.map((item, i) => {
    const s = item.snippet;
    const videoId = item.id?.videoId;
    const published = s.publishedAt ? new Date(s.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
    return `${i + 1}. ${s.title}
   Channel: ${s.channelTitle}
   Published: ${published}
   ID: ${videoId}
   URL: https://youtube.com/watch?v=${videoId}`;
  });
  return `YouTube results for "${query}" (${items.length}):

${lines.join("\n\n")}`;
}
async function youtubeVideoDetails(videoId) {
  const result = await ytFetch("videos", {
    part: "snippet,statistics,contentDetails",
    id: videoId
  });
  if (!result.ok) return result.raw;
  const items = result.data?.items;
  if (!items || items.length === 0) return "Video not found.";
  const v = items[0];
  const s = v.snippet;
  const stats = v.statistics;
  const duration = v.contentDetails?.duration ? formatDuration2(v.contentDetails.duration) : "?";
  const lines = [
    `Title: ${s.title}`,
    `Channel: ${s.channelTitle}`,
    `Published: ${s.publishedAt ? new Date(s.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "?"}`,
    `Duration: ${duration}`,
    `Views: ${stats.viewCount ? formatCount(stats.viewCount) : "?"}`,
    `Likes: ${stats.likeCount ? formatCount(stats.likeCount) : "hidden"}`,
    `Comments: ${stats.commentCount ? formatCount(stats.commentCount) : "disabled"}`,
    `URL: https://youtube.com/watch?v=${videoId}`,
    ``,
    `Description:`,
    (s.description || "(no description)").slice(0, 500)
  ];
  return lines.join("\n");
}
async function youtubeChannelInfo(channelIdentifier) {
  let params = {
    part: "snippet,statistics"
  };
  if (channelIdentifier.startsWith("UC") && channelIdentifier.length >= 20) {
    params.id = channelIdentifier;
  } else {
    const searchResult = await ytFetch("search", {
      part: "snippet",
      type: "channel",
      q: channelIdentifier,
      maxResults: "1"
    });
    if (!searchResult.ok) return searchResult.raw;
    const channelId = searchResult.data?.items?.[0]?.id?.channelId;
    if (!channelId) return `Channel "${channelIdentifier}" not found.`;
    params.id = channelId;
  }
  const result = await ytFetch("channels", params);
  if (!result.ok) return result.raw;
  const items = result.data?.items;
  if (!items || items.length === 0) return "Channel not found.";
  const ch = items[0];
  const s = ch.snippet;
  const stats = ch.statistics;
  const lines = [
    `Channel: ${s.title}`,
    `ID: ${ch.id}`,
    s.customUrl ? `Handle: ${s.customUrl}` : null,
    `Created: ${s.publishedAt ? new Date(s.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "?"}`,
    `Subscribers: ${stats.subscriberCount ? formatCount(stats.subscriberCount) : "hidden"}`,
    `Videos: ${stats.videoCount ? formatCount(stats.videoCount) : "?"}`,
    `Total views: ${stats.viewCount ? formatCount(stats.viewCount) : "?"}`,
    `URL: https://youtube.com/channel/${ch.id}`,
    ``,
    `Description:`,
    (s.description || "(no description)").slice(0, 500)
  ].filter(Boolean);
  return lines.join("\n");
}
async function youtubeTrending(regionCode = "US", maxResults = 10) {
  const result = await ytFetch("videos", {
    part: "snippet,statistics",
    chart: "mostPopular",
    regionCode,
    maxResults: String(maxResults)
  });
  if (!result.ok) return result.raw;
  const items = result.data?.items;
  if (!items || items.length === 0) return `No trending videos found for region ${regionCode}.`;
  const lines = items.map((v, i) => {
    const s = v.snippet;
    const stats = v.statistics;
    return `${i + 1}. ${s.title}
   Channel: ${s.channelTitle}
   Views: ${stats.viewCount ? formatCount(stats.viewCount) : "?"}
   URL: https://youtube.com/watch?v=${v.id}`;
  });
  return `Trending on YouTube (${regionCode}, ${items.length}):

${lines.join("\n\n")}`;
}

// src/alerts.ts
import Anthropic2 from "@anthropic-ai/sdk";
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
var config = { ...DEFAULT_CONFIG };
var broadcastFn = null;
var saveBriefFn = null;
var briefInterval = null;
var alertInterval = null;
var alertedCalendarEvents = /* @__PURE__ */ new Set();
var alertedEmailIds = /* @__PURE__ */ new Set();
var initialAlertCheckDone = false;
var briefRunning = false;
var alertRunning = false;
var lastDedupeReset = "";
async function init6() {
  const existing = await getPool().query(`SELECT value FROM app_config WHERE key = 'alerts'`);
  if (existing.rows.length === 0) {
    try {
      const fs4 = await import("fs");
      const path5 = await import("path");
      const legacyPath = path5.default.join(process.cwd(), "data", "alerts-config.json");
      if (fs4.default.existsSync(legacyPath)) {
        const raw = JSON.parse(fs4.default.readFileSync(legacyPath, "utf-8"));
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
async function loadConfig() {
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
async function saveConfig() {
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
        const localTasks = await listTasks();
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
async function synthesizeBrief(type, rawSections) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return rawSections;
  try {
    const client = new Anthropic2({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `You are Rickin's personal assistant delivering his ${type} briefing. Synthesize the following raw data into a concise, natural-language briefing. Lead with the most important and actionable items. Be direct \u2014 no filler.

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
      }]
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    return text || rawSections;
  } catch (err) {
    console.error(`[alerts] AI synthesis failed for ${type} brief:`, err);
    return rawSections;
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
  const rawContent = sections.join("\n\n---\n\n");
  const synthesized = await synthesizeBrief(type, rawContent);
  if (saveBriefFn) {
    try {
      const dateStr = (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: config.timezone });
      const briefPath = `Daily Digests/${dateStr}-${type}.md`;
      const header = `# ${type.charAt(0).toUpperCase() + type.slice(1)} Brief \u2014 ${dateStr}

`;
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
      await saveConfig();
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
    await saveConfig();
  }
  if (config.alerts.taskDeadline.enabled) {
    try {
      const todayKey = getTodayKey();
      const taskList = await listTasks();
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
function startAlertSystem(broadcast, saveBrief) {
  broadcastFn = broadcast;
  saveBriefFn = saveBrief || null;
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

// src/scheduled-jobs.ts
function getJobSavePath(jobId, dateStr, safeName) {
  if (jobId === "moodys-daily-intel") return `Scheduled Reports/Moody's Intelligence/Daily/${dateStr}-Brief.md`;
  if (jobId === "moodys-profile-updates") return `Scheduled Reports/Moody's Intelligence/Daily/${dateStr}-Profile-Updates.md`;
  if (jobId === "moodys-weekly-digest") return `Scheduled Reports/Moody's Intelligence/Weekly/${dateStr}-Digest.md`;
  if (jobId === "real-estate-daily-scan") return `Scheduled Reports/Real Estate/${dateStr}-Property-Scan.md`;
  if (jobId === "darknode-inbox-monitor") return `Scheduled Reports/Inbox Monitor/${dateStr}-${safeName}.md`;
  if (jobId === "life-audit") return `Scheduled Reports/Life-Audit/${dateStr}.md`;
  if (jobId === "daily-inbox-triage-am") return `Scheduled Reports/Inbox Cleanup/${dateStr}-AM-triage.md`;
  if (jobId === "daily-inbox-triage-pm") return `Scheduled Reports/Inbox Cleanup/${dateStr}-PM-triage.md`;
  if (jobId === "weekly-inbox-deep-clean") return `Scheduled Reports/Inbox Cleanup/${dateStr}-weekly-summary.md`;
  if (jobId === "baby-dashboard-weekly-update") return `Scheduled Reports/Baby Dashboard/${dateStr}-Weekly-Log.md`;
  if (jobId === "birthday-calendar-sync") return `Scheduled Reports/Birthday Sync/${dateStr}-Sync.md`;
  return `Scheduled Reports/${dateStr}-${safeName}.md`;
}
var jobStatusCache = {};
async function writeJobStatus(jobId, entry) {
  jobStatusCache[jobId] = entry;
  if (kbCreateFn) {
    await kbCreateFn("Scheduled Reports/job-status.json", JSON.stringify(jobStatusCache, null, 2));
  }
}
var DEFAULT_JOBS = [
  {
    id: "kb-organizer",
    name: "Knowledge Base Cleanup",
    agentId: "knowledge-organizer",
    prompt: `Audit the vault and produce a report \u2014 do NOT modify, move, or delete any files. Read-only scan only.

Check for these issues and list each finding with a suggested action:
1. Empty folders \u2014 list them and suggest removal
2. Orphaned or misplaced files \u2014 list them with suggested new locations
3. Duplicate or near-duplicate notes \u2014 list pairs with a suggestion to consolidate
4. Inconsistent naming \u2014 list files that don't follow conventions (kebab-case or Title Case) with suggested renames
5. Large files or folders that could be reorganised

Save the report to "Scheduled Reports/KB Audit Report.md" (overwrite previous). Format as a clear checklist so I can review and action items manually.`,
    schedule: { type: "daily", hour: 2, minute: 0 },
    enabled: false
  },
  {
    id: "daily-news",
    name: "Daily News Brief",
    agentId: "deep-researcher",
    prompt: `Research and compile today's top news across these categories:
1. Technology & AI developments
2. Financial markets & economy
3. World events

For each story, provide a 2-3 sentence summary with context on why it matters.
Save the compiled brief to "Scheduled Reports/Daily News.md" (overwrite previous).`,
    schedule: { type: "daily", hour: 6, minute: 30 },
    enabled: false
  },
  {
    id: "market-summary",
    name: "Market Summary",
    agentId: "analyst",
    prompt: `Analyze the current market conditions:
1. Check the watchlist stocks and crypto prices
2. Search X for ticker sentiment and market chatter \u2014 x_search("$GOLD OR $BTC OR $MSTR OR stock market") for real-time trader sentiment
3. Note any significant moves (>2%) with brief analysis
4. Summarize overall market sentiment (include X/social sentiment alongside data)
5. Flag any notable earnings or economic events today

Save the report to "Scheduled Reports/Market Summary.md" (overwrite previous).`,
    schedule: { type: "daily", hour: 7, minute: 30 },
    enabled: false
  },
  {
    id: "moodys-daily-intel",
    name: "Moody's Intelligence Brief",
    agentId: "moodys",
    prompt: `You are a competitive intelligence analyst for Moody's Banking Solutions. Compile a comprehensive daily intelligence brief by ACTIVELY researching each category using web_search, web_fetch, AND x_search. You MUST call these tools \u2014 do not rely on prior knowledge.

RESEARCH METHOD \u2014 For EVERY category below:
1. Run web_search with the specified queries to find articles
2. Use web_fetch on the top 2-3 result URLs to read actual article content for richer summaries
3. Run x_search with the specified queries for real-time signals
4. Write 3-5 bullet items per category (not just 1)

CATEGORY 1 \u2014 Moody's Corporate:
web_search("Moody's Analytics news 2026") AND web_search("site:moodys.com press release")
web_fetch the top 2 results from moodys.com
x_search("from:MoodysAnalytics OR from:MoodysInvSvc OR Moody's Analytics OR Credit Lens")
Focus: press releases, product launches, leadership, earnings, Credit Lens, Banking Solutions, KYC, risk analytics.

CATEGORY 2 \u2014 Banking Segment:
web_search("Moody's Credit Lens banking") AND web_search("Moody's Analytics banking product launch OR partnership")
web_fetch any relevant moodys.com product pages
x_search("Credit Lens OR Moody's banking OR OnlineALM OR BankFocus")
Focus: Credit Lens updates, customer wins, partnerships, banking vertical product news.

CATEGORY 3 \u2014 Competitor Intelligence:
Run SEPARATE searches for each competitor group:
web_search("Bloomberg Terminal AI 2026 OR Bloomberg Enterprise Data") \u2192 web_fetch top result
web_search("S&P Global Capital IQ AI OR S&P Market Intelligence 2026") \u2192 web_fetch top result
web_search("Fitch Solutions banking analytics OR Fitch Ratings 2026") \u2192 web_fetch top result
web_search("Nasdaq AxiomSL OR Nasdaq Financial Technology 2026") \u2192 web_fetch top result
web_search("nCino banking AI OR nCino 2026 news") \u2192 web_fetch top result
web_search("Quantexa banking OR Databricks financial services 2026")
web_search("ValidMind AI governance OR Regnology regulatory reporting 2026")
x_search("Bloomberg data AI OR S&P Global Capital IQ OR Fitch Solutions OR nCino")
x_search("Quantexa OR Databricks financial services OR ValidMind OR Regnology")
Write at least 3-5 competitor items with specific details from the articles.

CATEGORY 4 \u2014 Enterprise AI Trends:
web_search("agentic AI banking financial services 2026") \u2192 web_fetch top 2 results
web_search("enterprise LLM deployment regulated industries") \u2192 web_fetch top result
web_search("AI governance banking regulation EU AI Act")
x_search("agentic AI banking OR enterprise LLM financial services OR AI governance banking")
Focus: agentic AI in banking, LLM deployments, AI regulation, MCP adoption, CDM standards.

CATEGORY 5 \u2014 Industry Analyst Coverage:
web_search("site:celent.com Moody's OR Credit Lens OR banking AI")
web_search("site:chartis-research.com RiskTech100 OR credit risk technology 2026")
web_search("Forrester banking technology 2026 OR Gartner risk analytics OR IDC financial services AI")
x_search("from:CelentResearch OR from:Chartis_Research OR Celent banking OR RiskTech100")
web_fetch any analyst report pages found.

OUTPUT FORMAT \u2014 Do NOT use notes_create. Instead, output the full brief as your final response. The system will save it automatically. Format:

## \u{1F3E2} Moody's Corporate
- \u{1F534}/\u{1F7E1}/\u{1F7E2} {item summary \u2014 1-2 sentences with specific details} ([source](url))
- {3-5 items minimum}

## \u{1F3E6} Banking Segment
- \u{1F534}/\u{1F7E1}/\u{1F7E2} {item summary} ([source](url))
- {3-5 items minimum}

## \u{1F50D} Competitor Watch
- \u{1F534}/\u{1F7E1}/\u{1F7E2} **{Competitor Name}**: {what happened \u2014 specific details from article} ([source](url))
- {5-8 items covering multiple competitors}

## \u{1F916} Enterprise AI Trends
- \u{1F534}/\u{1F7E1}/\u{1F7E2} {item summary} ([source](url))
- {3-5 items minimum}

## \u{1F4CA} Industry Analyst Coverage
- \u{1F534}/\u{1F7E1}/\u{1F7E2} {item summary} ([source](url))
- {3-5 items minimum}

## \u26A1 Key Takeaways
1. {takeaway with strategic implication for Moody's}
2. {3-5 numbered takeaways}

IMPORTANT:
- Each category MUST have at least 3 bullets. If web_search returns few results, broaden the query or try alternate terms.
- Use web_fetch to read article content \u2014 summaries from search snippets alone are too thin.
- Tag each item: \u{1F534} High (directly impacts Moody's Banking), \u{1F7E1} Medium (industry trend), \u{1F7E2} Low (background).
- Do NOT produce a summary table \u2014 write full bullet content under each ## section header.
- Do NOT use notes_create or notes_append \u2014 just output the brief directly. The system saves it for you.
- Do NOT update competitor profiles \u2014 a separate job handles that.`,
    schedule: { type: "daily", hour: 6, minute: 0 },
    enabled: true
  },
  {
    id: "moodys-profile-updates",
    name: "Moody's Profile Updates",
    agentId: "moodys",
    prompt: `Read today's intelligence brief and update competitor/analyst profiles with the findings.

STEP 1: Use notes_list on "Scheduled Reports/Moody's Intelligence/Daily/" to find today's brief (filename format: YYYY-MM-DD-Brief.md). Read it with notes_read.

STEP 2: For each competitor that has actual findings in the brief (not "No new developments"), use notes_append on the corresponding profile file to add a date-stamped entry:

Competitor Profiles \u2014 append to "Projects/Moody's/Competitive Intelligence/Competitor Profiles/{Name}.md":
- Bloomberg, S&P Global, Fitch, Nasdaq, nCino, QRM, Empyrean, Quantexa, Databricks, Regnology, FinregE, ValidMind

Industry Analyst Profiles \u2014 append to "Projects/Moody's/Competitive Intelligence/Industry Analysts/{Name}.md":
- Celent, Chartis Research, Forrester, Gartner, IDC

Entry format for each profile:
### {today's date YYYY-MM-DD}
- {bullet findings from today's brief}

Only append to profiles that had actual findings \u2014 skip any with "No new developments" or no mention in the brief.

After completing all updates, provide a summary of how many profiles were updated and which ones.`,
    schedule: { type: "daily", hour: 6, minute: 15 },
    enabled: true
  },
  {
    id: "moodys-weekly-digest",
    name: "Moody's Weekly Strategic Digest",
    agentId: "moodys",
    prompt: `Generate the weekly Moody's strategic digest by reading and synthesising all daily intelligence briefs from this past week.

STEP 1: List files in "Scheduled Reports/Moody's Intelligence/Daily/" folder using notes_list.
STEP 2: Read every file matching "*-Brief.md" from the last 7 days.
STEP 3: Synthesise all daily briefs into the weekly digest format below.

Save using notes_create to "Scheduled Reports/Moody's Intelligence/Weekly/{today's date YYYY-MM-DD}-Digest.md":

# Moody's Weekly Strategic Digest \u2014 Week of {date}

## \u{1F4C8} Week in Review
- {3-5 sentence executive summary of the most important developments}

## \u{1F3E2} Moody's Moves This Week
- {consolidated list of Moody's news, deduplicated across daily briefs}

## \u{1F50D} Competitor Patterns
- {trends across competitors \u2014 who's gaining, who's shipping, strategic shifts}
- {any new partnerships, acquisitions, or product launches}

## \u{1F916} AI & Tech Trajectory
- {emerging patterns in enterprise AI, agentic AI, banking tech}
- {regulatory developments that impact Moody's strategy}

## \u{1F4CA} Analyst Signals
- {any new rankings, quadrant reports, or vendor assessments}
- {shifts in analyst sentiment toward Moody's or competitors}

## \u26A0\uFE0F Strategic Implications for Moody's Banking
- {what these developments mean for Rickin's data moat strategy}
- {opportunities to exploit or threats to watch}
- {specific actions or talking points for the coming week}

## \u{1F3AF} Recommended Focus This Week
- {top 3 things to pay attention to or act on}

Be thorough in reading all available daily briefs. If fewer than 7 daily briefs exist, work with what's available.`,
    schedule: { type: "weekly", hour: 7, minute: 0, daysOfWeek: [0] },
    enabled: true
  },
  {
    id: "real-estate-daily-scan",
    name: "Daily Property Scan",
    agentId: "real-estate",
    prompt: `You are running the daily property scan. First read "Real Estate/Search Criteria.md" for full criteria and target areas.

For each of the 6 target areas, search for hidden gem properties matching: $1.3M\u2013$1.8M, 4+ bedrooms, 3+ bathrooms, Houses.

STEP 1 \u2014 ZILLOW SEARCH: Use property_search with these locations (one call per area):
1. "Upper Saddle River, NJ" (also try "Ridgewood, NJ", "Ho-Ho-Kus, NJ")
2. "Montclair, NJ" (also try "Glen Ridge, NJ")
3. "Princeton, NJ" (also try "West Windsor, NJ")
4. "Garden City, NY" (also try "Manhasset, NY", "Great Neck, NY", "Cold Spring Harbor, NY")
5. "Tarrytown, NY" (also try "Scarsdale, NY", "Chappaqua, NY", "Bronxville, NY")
6. "Westport, CT" (also try "Darien, CT", "Stamford, CT")
For each search: set minPrice=1300000, maxPrice=1800000, minBeds=4, minBaths=3, sort="Newest".

STEP 2 \u2014 REDFIN SEARCH: Use redfin_search with these pre-verified URLs (one call per area):
1. https://www.redfin.com/city/19045/NJ/Upper-Saddle-River/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
2. https://www.redfin.com/city/35939/NJ/Montclair/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
3. https://www.redfin.com/city/15686/NJ/Princeton/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
4. https://www.redfin.com/city/7197/NY/Garden-City/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
5. https://www.redfin.com/city/18651/NY/Tarrytown/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
6. https://www.redfin.com/city/26700/CT/Westport/filter/min-price=1.3M,max-price=1.8M,min-beds=4,min-baths=3
Only use redfin_autocomplete as a fallback if a URL returns no results.

STEP 3 \u2014 CROSS-REFERENCE: Compare Zillow and Redfin results by address. Flag:
- \u{1F535} Redfin-only exclusives (not on Zillow)
- \u{1F7E1} Zillow-only exclusives (not on Redfin)
- Note any price discrepancies between platforms

STEP 4 \u2014 DEEP DIVE: For the top 3-5 most interesting properties per area:
- Use property_details (Zillow zpid + location) for zestimate, open house info, listing details
- Use redfin_details (Redfin URL path) for photos, room details, market data

STEP 5 \u2014 X/SOCIAL SIGNALS: Search X for hyper-local real estate intel in each target area:
- x_search("Upper Saddle River NJ home OR house OR listing OR real estate")
- x_search("Montclair NJ real estate OR new listing OR open house")
- x_search("Princeton NJ home OR listing OR real estate market")
- x_search("Garden City NY real estate OR new listing")
- x_search("Tarrytown NY OR Scarsdale NY real estate OR home")
- x_search("Westport CT real estate OR new listing OR open house")
Look for: pocket listings, agent buzz about upcoming listings, local market sentiment, neighborhood chatter, price trend discussions. Note any relevant finds in the Executive Summary under "Social Signals".

STEP 6 \u2014 COMMUTE RESEARCH: For any area where the area note's commute section still has placeholder text ("To be populated") or only rough estimates, use web_search to look up current peak-hour transit schedules (NJ Transit, LIRR, Metro-North) and update the area note with actual commute times to Brookfield Place. Include route, transfers, and total door-to-door time.

For each property include: address, price, beds/baths, sqft, lot size, year built, key features, school district + rating, estimated commute to Brookfield Place (route + transfers + time from area note), days on market, listing URL(s) from both platforms, source (Zillow/Redfin/Both), and WHY it's interesting (1-2 sentences on character/charm/value).

Focus on:
- New listings (< 7 days on market)
- Price reductions
- Back-on-market properties
- Hidden gems: unique architecture, mature landscaping, walkable location, overlooked value
- Platform exclusives (listed on one but not the other)

Flag \u2B50 standout properties (great schools + walkable + good commute + character) and save each to "Real Estate/Favorites/{Address slug}.md" with full details using notes_create.

OUTPUT \u2014 Save using notes_create to "Scheduled Reports/Real Estate/{today's date YYYY-MM-DD}-Property-Scan.md":

# Daily Property Scan \u2014 {today's date}

## \u26A1 Executive Summary
- Total new listings found across all areas (Zillow + Redfin combined)
- Platform coverage: X on both, Y Zillow-only, Z Redfin-only
- Top gems of the day (\u2B50 properties)
- Price trends or market observations
- Commute comparison across areas
- \u{1F426} Social Signals: {any notable X chatter about target areas \u2014 pocket listings, agent buzz, market sentiment}

## \u{1F3E1} Upper Saddle River / Bergen County, NJ
{property listings with full details, source noted}

## \u{1F3E1} Montclair, NJ
{property listings with full details, source noted}

## \u{1F3E1} Princeton, NJ
{property listings with full details, source noted}

## \u{1F3E1} Long Island, NY
{property listings with full details, source noted}

## \u{1F3E1} Hudson Valley / Upstate NY
{property listings with full details, source noted}

## \u{1F3E1} Stamford\u2013Westport, CT
{property listings with full details, source noted}

## \u{1F3AF} Top Gems Today
{ranked list of \u2B50 properties with one-line reasons}

STEP 7 \u2014 MARKET OVERVIEW: After saving the scan report, overwrite "Real Estate/Market Overview.md" using notes_create with:
- Market Snapshot: today's date, total listings found, notable market trends
- Area Comparison table: | Area | Listings | Price Range | Avg $/sqft | New (<7d) |
- Commute Comparison: transit route + estimated time per area (from area notes)

After the Market Overview, append any notable new listings to the corresponding area file in "Real Estate/Areas/" using notes_append with a date-stamped header (### YYYY-MM-DD).

If no properties are found in an area, note "No new listings matching criteria" rather than omitting the section.`,
    schedule: { type: "daily", hour: 7, minute: 30 },
    enabled: true
  },
  {
    id: "life-audit",
    name: "Weekly Life Audit",
    agentId: "deep-researcher",
    prompt: `You are running a proactive Life Audit for Rickin's family.

## Your Task
1. Read the constraints register: "About Me/Active Constraints.md"
2. Read all notes in "Vacation Planning/" for upcoming trips
3. Check the calendar for events in the next 60 days using calendar_list
4. For EACH upcoming trip or travel event:
   a. Cross-reference against EVERY active constraint (pregnancy weeks, age limits, passport requirements, visa needs, health restrictions)
   b. Web search for specific policies (airline pregnancy cutoffs, cruise line policies, resort age minimums, entry requirements for destination)
   c. Calculate exact dates/ages/weeks at time of travel
5. Check all Watch Items & Deadlines in the constraints file for approaching deadlines (within 14 days)
6. Check Document Checklist for any missing/unverified items needed before the next trip

## Output Format
Save a report to "Scheduled Reports/Life-Audit/" with:
- \u{1F534} CRITICAL: Conflicts that could prevent travel (denied boarding, expired documents, policy violations)
- \u{1F7E1} WARNING: Items that need attention within 14 days (deadlines, missing documents, insurance windows)
- \u{1F7E2} OK: Confirmed-clear items (gives confidence)
- \u{1F4CB} ACTION ITEMS: Numbered list of specific things Rickin should do, ordered by urgency

Be thorough. Be specific. Calculate exact gestational weeks, exact ages, exact document dates. Don't assume \u2014 verify via web search.`,
    schedule: { type: "weekly", hour: 8, minute: 0, daysOfWeek: [0] },
    enabled: true
  },
  {
    id: "daily-inbox-triage-am",
    name: "Daily Inbox Triage (AM)",
    agentId: "email-drafter",
    prompt: `You are running a daily inbox triage for Rickin. This is an autonomous job \u2014 do NOT use interview forms or ask for confirmation. Process everything directly.

## Step 1: Read Label Structure
Read "Preferences/Gmail Label Structure.md" from the vault using notes_read. This contains all label IDs you'll need.

## Step 2: Scan New Emails
Use email_list with query "in:inbox newer_than:1d" and maxResults 20. This scans only recent emails since roughly the last run. Process up to 50 emails. Track message IDs to avoid duplicates if you make multiple calls with narrower queries.

For each email, read the sender (From), subject, and snippet. If the category is unclear from metadata alone, use email_read to check the body.

## Step 3: Apply Labels
Apply labels using email_label with the label IDs from Step 1. Each email gets a CATEGORY label + an ACTION label:

### Category Rules (apply the FIRST match):
- From contains "@delta.com", "@jetblue.com", "@united.com", "@aa.com", "@spirit.com", "@southwest.com" OR subject contains "flight", "boarding pass", "itinerary" \u2192 Travel/Flights (Label_32)
- Subject contains "reservation", "hotel", "resort", "check-in", "booking" (non-flight) \u2192 Travel/Bookings (Label_31)
- Subject contains "Marriott", "Hilton", "Hyatt", "Airbnb" \u2192 Travel/Hotels (Label_33)
- From contains "@schools.nyc.gov" or "KCicio" OR subject contains "school", "class", "PTA", "curriculum" \u2192 Family/School (Label_22)
- From "pooja.bhatt@gmail.com" \u2192 Family/Pooja (Label_20)
- Subject contains "Reya" or relates to Reya's schedule \u2192 Family/Reya (Label_21)
- Subject contains "baby", "prenatal", "OB", "nursery", "registry" \u2192 Family/Baby (Label_23)
- From contains "@chase.com", "@bankofamerica.com", "@citi.com", "@wellsfargo.com", "@capitalone.com" OR subject contains "bank", "account", "statement" \u2192 Finance/Banking (Label_24)
- From contains "@fidelity.com", "@vanguard.com", "@schwab.com", "@robinhood.com" OR subject contains "investment", "portfolio", "dividend", "401k" \u2192 Finance/Investments (Label_25)
- Subject contains "tax", "W-2", "1099", "TurboTax", "CPA" \u2192 Finance/Tax (Label_26)
- Subject contains "bill", "invoice", "payment due", "autopay", "utility" \u2192 Finance/Bills (Label_27)
- From contains "@zillow.com", "@redfin.com", "@realtor.com", "@streeteasy.com" OR subject contains "listing", "open house", "property" \u2192 Real Estate/Listings (Label_28)
- Subject contains "mortgage", "pre-approval", "loan", "rate lock" \u2192 Real Estate/Mortgage (Label_30)
- Subject contains "closing", "title", "deed" (real estate) \u2192 Real Estate/Legal (Label_29)
- From contains "@healthfirst.org", "@mycharthealth.com", "@zocdoc.com" OR subject contains "appointment", "prescription", "lab results", "doctor" \u2192 Health (Label_34 for Pooja-related, Label_35 for Rickin-related)
- Subject contains "subscription", "renewal", "your plan", "membership" \u2192 Personal/Subscriptions (Label_36)
- From contains "@amazon.com", "@ebay.com", "@target.com" OR subject contains "order", "shipped", "delivered", "tracking" \u2192 Personal/Shopping (Label_37)
- Subject contains "insurance", "policy", "claim", "coverage", "premium" \u2192 Personal/Insurance (Label_38)

### Action Rules (apply ONE per email):
- Needs a response or decision from Rickin \u2192 \u26A1 Action Required (Label_16)
- Rickin sent something and is waiting for reply \u2192 \u23F3 Waiting On (Label_17)
- Confirms a scheduled event/appointment \u2192 \u{1F4C5} Scheduled (Label_18)
- Informational only, no action needed \u2192 \u{1F501} Reference (Label_19)

## Step 4: Auto-Archive
After labeling, archive (email_archive) these:
- From "@linkedin.com" with subject containing "invitation", "endorsed", "who viewed", "new connection"
- From marketing/noreply addresses (sender contains "noreply@", "no-reply@", "marketing@", "news@", "promo@")
- Calendar sharing notifications ("added you to the shared calendar", "shared a calendar")
- Newsletters \u2014 if the body or snippet mentions "unsubscribe" and the sender is not a known contact (family, school, financial institution)

Do NOT archive:
- Anything labeled \u26A1 Action Required (Label_16)
- Emails from Pooja, family, school, or financial institutions with action items
- Security alerts from Google, Apple, or banks \u2014 always keep these in inbox
- Anything you're unsure about \u2014 when in doubt, leave it in inbox

## Step 5: Save Triage Log
Save a lightweight log using notes_create to "Scheduled Reports/Inbox Cleanup/{today YYYY-MM-DD}-AM-triage.md":

# Inbox Triage \u2014 {date} AM

- Emails processed: X
- Labeled: X
- Archived: X
- Action items left in inbox: X

### Action Items
1. [Subject] \u2014 [Sender] \u2014 reason flagged

Process everything autonomously. Be thorough but efficient.`,
    schedule: { type: "daily", hour: 6, minute: 0 },
    enabled: true
  },
  {
    id: "daily-inbox-triage-pm",
    name: "Daily Inbox Triage (PM)",
    agentId: "email-drafter",
    prompt: `You are running a daily inbox triage for Rickin. This is an autonomous job \u2014 do NOT use interview forms or ask for confirmation. Process everything directly.

## Step 1: Read Label Structure
Read "Preferences/Gmail Label Structure.md" from the vault using notes_read. This contains all label IDs you'll need.

## Step 2: Scan New Emails
Use email_list with query "in:inbox newer_than:1d" and maxResults 20. This scans only recent emails since roughly the last run. Process up to 50 emails. Track message IDs to avoid duplicates if you make multiple calls with narrower queries.

For each email, read the sender (From), subject, and snippet. If the category is unclear from metadata alone, use email_read to check the body.

## Step 3: Apply Labels
Apply labels using email_label with the label IDs from Step 1. Each email gets a CATEGORY label + an ACTION label:

### Category Rules (apply the FIRST match):
- From contains "@delta.com", "@jetblue.com", "@united.com", "@aa.com", "@spirit.com", "@southwest.com" OR subject contains "flight", "boarding pass", "itinerary" \u2192 Travel/Flights (Label_32)
- Subject contains "reservation", "hotel", "resort", "check-in", "booking" (non-flight) \u2192 Travel/Bookings (Label_31)
- Subject contains "Marriott", "Hilton", "Hyatt", "Airbnb" \u2192 Travel/Hotels (Label_33)
- From contains "@schools.nyc.gov" or "KCicio" OR subject contains "school", "class", "PTA", "curriculum" \u2192 Family/School (Label_22)
- From "pooja.bhatt@gmail.com" \u2192 Family/Pooja (Label_20)
- Subject contains "Reya" or relates to Reya's schedule \u2192 Family/Reya (Label_21)
- Subject contains "baby", "prenatal", "OB", "nursery", "registry" \u2192 Family/Baby (Label_23)
- From contains "@chase.com", "@bankofamerica.com", "@citi.com", "@wellsfargo.com", "@capitalone.com" OR subject contains "bank", "account", "statement" \u2192 Finance/Banking (Label_24)
- From contains "@fidelity.com", "@vanguard.com", "@schwab.com", "@robinhood.com" OR subject contains "investment", "portfolio", "dividend", "401k" \u2192 Finance/Investments (Label_25)
- Subject contains "tax", "W-2", "1099", "TurboTax", "CPA" \u2192 Finance/Tax (Label_26)
- Subject contains "bill", "invoice", "payment due", "autopay", "utility" \u2192 Finance/Bills (Label_27)
- From contains "@zillow.com", "@redfin.com", "@realtor.com", "@streeteasy.com" OR subject contains "listing", "open house", "property" \u2192 Real Estate/Listings (Label_28)
- Subject contains "mortgage", "pre-approval", "loan", "rate lock" \u2192 Real Estate/Mortgage (Label_30)
- Subject contains "closing", "title", "deed" (real estate) \u2192 Real Estate/Legal (Label_29)
- From contains "@healthfirst.org", "@mycharthealth.com", "@zocdoc.com" OR subject contains "appointment", "prescription", "lab results", "doctor" \u2192 Health (Label_34 for Pooja-related, Label_35 for Rickin-related)
- Subject contains "subscription", "renewal", "your plan", "membership" \u2192 Personal/Subscriptions (Label_36)
- From contains "@amazon.com", "@ebay.com", "@target.com" OR subject contains "order", "shipped", "delivered", "tracking" \u2192 Personal/Shopping (Label_37)
- Subject contains "insurance", "policy", "claim", "coverage", "premium" \u2192 Personal/Insurance (Label_38)

### Action Rules (apply ONE per email):
- Needs a response or decision from Rickin \u2192 \u26A1 Action Required (Label_16)
- Rickin sent something and is waiting for reply \u2192 \u23F3 Waiting On (Label_17)
- Confirms a scheduled event/appointment \u2192 \u{1F4C5} Scheduled (Label_18)
- Informational only, no action needed \u2192 \u{1F501} Reference (Label_19)

## Step 4: Auto-Archive
After labeling, archive (email_archive) these:
- From "@linkedin.com" with subject containing "invitation", "endorsed", "who viewed", "new connection"
- From marketing/noreply addresses (sender contains "noreply@", "no-reply@", "marketing@", "news@", "promo@")
- Calendar sharing notifications ("added you to the shared calendar", "shared a calendar")
- Newsletters \u2014 if the body or snippet mentions "unsubscribe" and the sender is not a known contact (family, school, financial institution)

Do NOT archive:
- Anything labeled \u26A1 Action Required (Label_16)
- Emails from Pooja, family, school, or financial institutions with action items
- Security alerts from Google, Apple, or banks \u2014 always keep these in inbox
- Anything you're unsure about \u2014 when in doubt, leave it in inbox

## Step 5: Save Triage Log
Save a lightweight log using notes_create to "Scheduled Reports/Inbox Cleanup/{today YYYY-MM-DD}-PM-triage.md":

# Inbox Triage \u2014 {date} PM

- Emails processed: X
- Labeled: X
- Archived: X
- Action items left in inbox: X

### Action Items
1. [Subject] \u2014 [Sender] \u2014 reason flagged

Process everything autonomously. Be thorough but efficient.`,
    schedule: { type: "daily", hour: 18, minute: 0 },
    enabled: true
  },
  {
    id: "baby-dashboard-weekly-update",
    name: "Baby Dashboard Weekly Update",
    agentId: "deep-researcher",
    prompt: `You are updating the Baby Chikki #2 dashboard at rickin.live/pages/baby-dashboard. This is an autonomous job \u2014 do NOT ask for confirmation. Process everything directly.

## Key Facts
- Due date: July 7, 2026 (Week 40)
- OB: Dr. Boester
- Google Sheet: 1fhtMkDSTUlRCFqY4hQiSdZg7cOe4FYNkmOIIHWo4KSU
- Dashboard slug: baby-dashboard

The dashboard HTML auto-calculates week/trimester/countdown/size via inline JS. Your job is to inject LIVE DATA that the static page can't compute on its own: appointments, names, tasks, and checklist progress from Google Sheets.

## Step 1: Pull OB Appointments from Calendar
Use calendar_list with timeMin = today, timeMax = 2026-07-15.
Filter events containing "Dr. Boester", "OB", "appointment", "glucose", "NICU", "nursery", "ultrasound", "tour".
Build a JSON array sorted by date: [{"title":"Video Appointment","date":"2026-03-19","time":"11:00 AM","detail":"Week 25 check-in via video call."},...]
- title: event summary
- date: YYYY-MM-DD format only (no time in date field)
- time: optional, human-readable time if available
- detail: optional one-line description

Always add a final entry: {"title":"\u{1F389} Due Date","date":"2026-07-07","detail":"Baby Chikki #2 arrives! \u{1F499}"}

## Step 2: Pull Data from Google Sheets
Read these tabs from spreadsheet 1fhtMkDSTUlRCFqY4hQiSdZg7cOe4FYNkmOIIHWo4KSU:

### 2a: Timeline (tab "Timeline")
Read range "Timeline!A1:F19". Row 1 = header (week, dates, trimester, development, milestone, status).
Find the current week: the row where column F contains "\u2705 Current Week".
Extract: week number, dates, trimester, development, milestone.

### 2b: Baby Names (tab "Baby Names")
Read range "Baby Names!A1:F16". Columns: A=name, B=meaning, C=origin, D=rickin rating, E=pooja rating, F=notes.
SKIP section header rows where col A == "\u2B50 FAVORITES" or "\u{1F4CB} SHORTLIST".
Favorites = rows where col D contains "\u2B50 Fav" or "\u{1F195} New Fav" or col E contains "\u2B50 Fav".
Build two arrays of {name, meaning} \u2014 favorites and others.
If tab doesn't exist or is empty, skip (HTML has defaults).

### 2c: To-Do List (tab "To-Do List")
Read range "To-Do List!A1:F23". Columns: A=task, B=category, C=due_week, D=owner, E=status, F=notes.
Status values: "\u2B1C Pending", "\u{1F504} In Progress", "\u2705 Done".
Build array: [{"text":"...","priority":"high","week":25,"done":false,"owner":"Rickin","category":"\u{1F3E5} Medical"},...]
Mark done=true if status contains "\u2705 Done".
If tab doesn't exist, skip.

### 2d: Shopping List (tab "Shopping List")
Read range "Shopping List!A1:F40". Columns: A=category, B=item, C=priority, D=status, E=budget, F=notes.
Status values: "\u2B1C Pending", "\u{1F504} In Progress", "\u2705 Done".
Count total items (non-header rows with item in col B) and items where col D contains "\u2705 Done". Format as "X/Y".
If tab doesn't exist, skip.

### 2e: Appointments (tab "Appointments")
Read range "Appointments!A1:E14". Columns: A=date, B=type, C=provider, D=notes, E=status.
Status values: "\u{1F5D3}\uFE0F Upcoming", "\u2B1C Scheduled", "\u2705 Done", "\u{1F38A} Due Date!".
Use this data to SUPPLEMENT the calendar data from Step 1 \u2014 if the Sheet has appointments not found in Calendar, include them. Merge by date, preferring Calendar data for duplicates.
If tab doesn't exist, skip (Step 1 calendar data is still used).

### 2f: Build Checklist Progress Object
Combine counts: {"shoppingDone":"5/39","tasksDone":"3/22"}
If any tab was missing, omit that field.

## Step 3: Inject Data into Dashboard HTML
Read the current file at "Scheduled Reports/baby-dashboard-source.html" using notes_read. If not found, read "data/pages/baby-dashboard.html".

DO NOT regenerate the HTML. Only inject data blocks before </body>. For each data type, if a \`<script id="..."\` block already exists, REPLACE it. Otherwise INSERT before </body>.

### 3a: Appointments
\`<script id="appt-data" type="application/json">[...appointments array...]</script>\`

### 3b: Tasks
\`<script id="tasks-data" type="application/json">[...tasks array...]</script>\`

### 3c: Checklist Progress
\`<script id="checklist-data" type="application/json">{"shoppingDone":"5/39","tasksDone":"3/22"}</script>\`

### 3d: Names (only if Sheets data available)
Find these lines and replace the array contents:
  var defaultFavNames = [...]
  var defaultOtherNames = [...]
Use format: {name:'Kian',meaning:'Ancient / King'}
Escape apostrophes in names/meanings with backslash.

Save the modified HTML using web_save with slug "baby-dashboard".

## Step 4: Output Summary

# Baby Dashboard Update \u2014 {date}
- **Week**: {N} of 40 ({trimester})
- **Appointments**: {count} injected, next: {title} on {date}
- **Names**: {fav count} favorites, {other count} others (source: Sheets / fallback)
- **To-Do**: {done}/{total} complete
- **Shopping List**: {bought}/{total} items
- **Hospital Bag**: {packed}/{total} packed
- **Dashboard**: Updated at rickin.live/pages/baby-dashboard

Process everything autonomously. Be thorough but efficient.`,
    schedule: { type: "weekly", hour: 7, minute: 0, daysOfWeek: [1] },
    enabled: true
  },
  {
    id: "baby-timeline-advance",
    name: "Baby Timeline Auto-Advance",
    agentId: "system",
    prompt: "Advances the \u2705 Current Week marker in the Timeline tab to match the calculated pregnancy week.",
    schedule: { type: "weekly", hour: 23, minute: 59, daysOfWeek: [0] },
    enabled: true
  },
  {
    id: "weekly-inbox-deep-clean",
    name: "Weekly Inbox Deep Clean",
    agentId: "email-drafter",
    prompt: `You are running a weekly deep clean of Rickin's inbox. This is an autonomous job \u2014 do NOT use interview forms or ask for confirmation. Process everything directly.

This job catches anything the daily triage jobs missed and does subscription detection.

## Step 1: Read Label Structure
Read "Preferences/Gmail Label Structure.md" from the vault using notes_read. This contains all label IDs you'll need.

## Step 2: Full Inbox Scan
Use email_list with query "in:inbox" and maxResults 20. This returns the 20 most recent inbox emails. Make additional calls with narrower queries (e.g., "in:inbox older_than:3d", "in:inbox from:linkedin.com", "in:inbox category:promotions") to catch more. Track message IDs to avoid duplicates. Aim for up to 100 emails total.

For each email, read the sender (From), subject, and snippet. If the category is unclear from metadata alone, use email_read to check the body.

## Step 3: Apply Labels (catch-all pass)
Apply labels using email_label with the label IDs from Step 1. Each email gets a CATEGORY label + an ACTION label. Skip emails that already have the correct labels from daily triage.

### Category Rules (apply the FIRST match):
- From contains "@delta.com", "@jetblue.com", "@united.com", "@aa.com", "@spirit.com", "@southwest.com" OR subject contains "flight", "boarding pass", "itinerary" \u2192 Travel/Flights (Label_32)
- Subject contains "reservation", "hotel", "resort", "check-in", "booking" (non-flight) \u2192 Travel/Bookings (Label_31)
- Subject contains "Marriott", "Hilton", "Hyatt", "Airbnb" \u2192 Travel/Hotels (Label_33)
- From contains "@schools.nyc.gov" or "KCicio" OR subject contains "school", "class", "PTA", "curriculum" \u2192 Family/School (Label_22)
- From "pooja.bhatt@gmail.com" \u2192 Family/Pooja (Label_20)
- Subject contains "Reya" or relates to Reya's schedule \u2192 Family/Reya (Label_21)
- Subject contains "baby", "prenatal", "OB", "nursery", "registry" \u2192 Family/Baby (Label_23)
- From contains "@chase.com", "@bankofamerica.com", "@citi.com", "@wellsfargo.com", "@capitalone.com" OR subject contains "bank", "account", "statement" \u2192 Finance/Banking (Label_24)
- From contains "@fidelity.com", "@vanguard.com", "@schwab.com", "@robinhood.com" OR subject contains "investment", "portfolio", "dividend", "401k" \u2192 Finance/Investments (Label_25)
- Subject contains "tax", "W-2", "1099", "TurboTax", "CPA" \u2192 Finance/Tax (Label_26)
- Subject contains "bill", "invoice", "payment due", "autopay", "utility" \u2192 Finance/Bills (Label_27)
- From contains "@zillow.com", "@redfin.com", "@realtor.com", "@streeteasy.com" OR subject contains "listing", "open house", "property" \u2192 Real Estate/Listings (Label_28)
- Subject contains "mortgage", "pre-approval", "loan", "rate lock" \u2192 Real Estate/Mortgage (Label_30)
- Subject contains "closing", "title", "deed" (real estate) \u2192 Real Estate/Legal (Label_29)
- From contains "@healthfirst.org", "@mycharthealth.com", "@zocdoc.com" OR subject contains "appointment", "prescription", "lab results", "doctor" \u2192 Health (Label_34 for Pooja-related, Label_35 for Rickin-related)
- Subject contains "subscription", "renewal", "your plan", "membership" \u2192 Personal/Subscriptions (Label_36)
- From contains "@amazon.com", "@ebay.com", "@target.com" OR subject contains "order", "shipped", "delivered", "tracking" \u2192 Personal/Shopping (Label_37)
- Subject contains "insurance", "policy", "claim", "coverage", "premium" \u2192 Personal/Insurance (Label_38)

### Action Rules (apply ONE per email):
- Needs a response or decision from Rickin \u2192 \u26A1 Action Required (Label_16)
- Rickin sent something and is waiting for reply \u2192 \u23F3 Waiting On (Label_17)
- Confirms a scheduled event/appointment \u2192 \u{1F4C5} Scheduled (Label_18)
- Informational only, no action needed \u2192 \u{1F501} Reference (Label_19)

## Step 4: Auto-Archive
After labeling, archive (email_archive) these:
- From "@linkedin.com" with subject containing "invitation", "endorsed", "who viewed", "new connection"
- From marketing/noreply addresses (sender contains "noreply@", "no-reply@", "marketing@", "news@", "promo@")
- Calendar sharing notifications ("added you to the shared calendar", "shared a calendar")
- Newsletters \u2014 if the body or snippet mentions "unsubscribe" and the sender is not a known contact (family, school, financial institution)

Do NOT archive:
- Anything labeled \u26A1 Action Required (Label_16)
- Emails from Pooja, family, school, or financial institutions with action items
- Security alerts from Google, Apple, or banks \u2014 always keep these in inbox
- Anything you're unsure about \u2014 when in doubt, leave it in inbox

## Step 5: Subscription Detection
While scanning, note any senders that appear to be subscriptions or recurring newsletters. After processing, append detected subscriptions to Google Sheet "Bhatt Family \u2014 Subscriptions & Bills Tracker" (spreadsheet ID: 1j5-EOdfIyqMFewDkXQ09a1o9HZAeSDGv4w52zWa0ELs) in the "Email Subscriptions" tab using sheets_append. Columns: Sender, Email Address, Type (newsletter/subscription/marketing), Frequency (daily/weekly/monthly), First Seen Date. Check existing rows first with sheets_read to avoid duplicates.

## Step 6: Save Weekly Summary
Save a summary report using notes_create to "Scheduled Reports/Inbox Cleanup/{today YYYY-MM-DD}-weekly-summary.md":

# Weekly Inbox Summary \u2014 {date}

## Week at a Glance
- Total emails processed: X
- Labeled: X | Archived: X | Left in inbox: X

## Label Breakdown
| Label | Count |
|-------|-------|
| Travel/Flights | 3 |
| Finance/Bills | 2 |
| Family/School | 4 |
| ... | ... |

## Action Items Remaining
1. [Subject] \u2014 [Sender] \u2014 flagged reason

## New Subscriptions Detected
- sender@domain.com \u2014 "Newsletter Name" \u2014 added to tracker sheet

## Archived Noise
- Xx LinkedIn notifications
- Xx promotional emails
- Xx newsletters

Process everything autonomously. Be thorough but efficient.`,
    schedule: { type: "weekly", hour: 10, minute: 0, daysOfWeek: [6] },
    enabled: true
  },
  {
    id: "birthday-calendar-sync",
    name: "Birthday Calendar Sync",
    agentId: "system",
    prompt: "Reads unsynced rows from the Birthday Tracker sheet and creates recurring annual events in the Birthdays calendar.",
    schedule: { type: "daily", hour: 8, minute: 0 },
    enabled: true
  },
  {
    id: "darknode-inbox-monitor",
    name: "Inbox Monitor (@darknode)",
    agentId: "orchestrator",
    prompt: "",
    schedule: { type: "interval", hour: 0, minute: 0, intervalMinutes: 30 },
    enabled: true
  }
];
var config2 = {
  jobs: [...DEFAULT_JOBS],
  lastJobRun: {},
  timezone: "America/New_York"
};
var checkInterval = null;
var jobRunning = false;
var currentRunningJobId = null;
var runAgentFn = null;
var broadcastFn2 = null;
var kbCreateFn = null;
var kbListFn = null;
var kbMoveFn = null;
var dbPoolFn = null;
async function writeJobHistory(jobId, jobName, status, summary, savedTo, durationMs) {
  if (!dbPoolFn) return;
  try {
    const pool2 = dbPoolFn();
    await pool2.query(
      `INSERT INTO job_history (job_id, job_name, status, summary, saved_to, duration_ms) VALUES ($1, $2, $3, $4, $5, $6)`,
      [jobId, jobName, status, summary?.slice(0, 1e3) || null, savedTo, durationMs]
    );
    await pool2.query(
      `DELETE FROM job_history WHERE id IN (
        SELECT id FROM job_history WHERE job_id = $1 ORDER BY created_at DESC OFFSET 50
      )`,
      [jobId]
    );
  } catch (err) {
    console.warn(`[scheduled-jobs] Failed to write job history:`, err);
  }
}
async function getJobHistory(limit = 20) {
  if (!dbPoolFn) return [];
  try {
    const pool2 = dbPoolFn();
    const result = await pool2.query(
      `SELECT job_id, job_name, status, summary, saved_to, duration_ms, created_at FROM job_history ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  } catch (err) {
    console.warn(`[scheduled-jobs] Failed to read job history:`, err);
    return [];
  }
}
async function archiveOldReports() {
  if (!kbListFn || !kbMoveFn) return;
  const cutoff = /* @__PURE__ */ new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const folders = [
    { src: "Scheduled Reports/Moody's Intelligence/Daily", dest: "Archive/Moody's Intelligence/Daily" },
    { src: "Scheduled Reports/Moody's Intelligence/Weekly", dest: "Archive/Moody's Intelligence/Weekly" },
    { src: "Scheduled Reports/Real Estate", dest: "Archive/Real Estate" },
    { src: "Scheduled Reports/Life-Audit", dest: "Archive/Life-Audit" },
    { src: "Scheduled Reports/Inbox Cleanup", dest: "Archive/Inbox Cleanup" },
    { src: "Scheduled Reports/Baby Dashboard", dest: "Archive/Baby Dashboard" }
  ];
  let archived = 0;
  for (const { src, dest } of folders) {
    try {
      const listing = await kbListFn(src);
      let files = [];
      try {
        const parsed = JSON.parse(listing);
        files = (parsed.files || []).filter((f) => f.endsWith(".md"));
      } catch {
        continue;
      }
      for (const filePath of files) {
        const basename = filePath.split("/").pop() || "";
        const dateMatch = basename.match(/^(\d{4}-\d{2}-\d{2})/);
        if (dateMatch && dateMatch[1] < cutoffStr) {
          const destPath = `${dest}/${basename}`;
          try {
            await kbMoveFn(filePath, destPath);
            archived++;
          } catch (e) {
            console.error(`[scheduled-jobs] Archive move failed: ${filePath}`, e);
          }
        }
      }
    } catch {
    }
  }
  if (archived > 0) {
    console.log(`[scheduled-jobs] Archived ${archived} old brief(s)`);
  }
}
async function init7() {
  try {
    const result = await getPool().query(`SELECT value FROM app_config WHERE key = 'scheduled_jobs'`);
    if (result.rows.length > 0) {
      const raw = result.rows[0].value;
      const existingIds = new Set((raw.jobs || []).map((j) => j.id));
      const mergedJobs = [...raw.jobs || []];
      for (const preset of DEFAULT_JOBS) {
        if (!existingIds.has(preset.id)) {
          mergedJobs.push(preset);
        }
      }
      config2 = {
        ...config2,
        ...raw,
        jobs: mergedJobs,
        lastJobRun: raw.lastJobRun || {}
      };
      const kbJob = config2.jobs.find((j) => j.id === "kb-organizer");
      if (kbJob && kbJob.prompt.includes("Find and remove empty folders")) {
        const preset = DEFAULT_JOBS.find((j) => j.id === "kb-organizer");
        kbJob.prompt = preset.prompt;
        await saveConfig2();
      }
      const intelJob = config2.jobs.find((j) => j.id === "moodys-daily-intel");
      if (intelJob && intelJob.prompt.includes("AFTER saving the brief, update competitor")) {
        const preset = DEFAULT_JOBS.find((j) => j.id === "moodys-daily-intel");
        intelJob.prompt = preset.prompt;
        console.log("[scheduled-jobs] Migrated moodys-daily-intel: removed profile update step (now handled by moodys-profile-updates)");
        await saveConfig2();
      }
      const scanJob = config2.jobs.find((j) => j.id === "real-estate-daily-scan");
      if (scanJob && (scanJob.prompt.includes("minPrice=1500000") || scanJob.prompt.includes("$1.5M\u2013$2M") || scanJob.prompt.includes("minBeds=5"))) {
        const preset = DEFAULT_JOBS.find((j) => j.id === "real-estate-daily-scan");
        scanJob.prompt = preset.prompt;
        console.log("[scheduled-jobs] Migrated real-estate-daily-scan: updated budget to $1.3M\u2013$1.8M, 4+ bed, added commute/market-overview steps");
        await saveConfig2();
      }
    } else {
      await saveConfig2();
    }
    const alertsResult = await getPool().query(`SELECT value FROM app_config WHERE key = 'alerts'`);
    if (alertsResult.rows.length > 0) {
      config2.timezone = alertsResult.rows[0].value.timezone || "America/New_York";
    }
  } catch (err) {
    console.error("[scheduled-jobs] Init error:", err);
  }
  console.log(`[scheduled-jobs] initialized (${config2.jobs.length} jobs, ${config2.jobs.filter((j) => j.enabled).length} enabled)`);
}
async function saveConfig2() {
  try {
    await getPool().query(
      `INSERT INTO app_config (key, value, updated_at)
       VALUES ('scheduled_jobs', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [JSON.stringify(config2), Date.now()]
    );
  } catch (err) {
    console.error("[scheduled-jobs] Save config error:", err);
  }
}
function getJobs() {
  return config2.jobs;
}
function getNextJob() {
  const tz = config2.timezone || "America/New_York";
  const now = /* @__PURE__ */ new Date();
  const nowLocal = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const nowH = nowLocal.getHours();
  const nowM = nowLocal.getMinutes();
  const nowDay = nowLocal.getDay();
  const enabled = config2.jobs.filter((j) => j.enabled);
  if (enabled.length === 0) return null;
  let bestJob = null;
  let bestMinutesAway = Infinity;
  for (const job of enabled) {
    if (job.schedule.type === "interval") {
      const intervalMs = (job.schedule.intervalMinutes || 30) * 6e4;
      const lastRunTime = job.lastRun ? new Date(job.lastRun).getTime() : 0;
      const elapsed = Date.now() - lastRunTime;
      const remaining = Math.max(0, intervalMs - elapsed);
      const mins = Math.ceil(remaining / 6e4);
      if (mins < bestMinutesAway) {
        bestMinutesAway = mins;
        bestJob = job;
      }
      continue;
    }
    const jH = job.schedule.hour;
    const jM = job.schedule.minute;
    if (job.schedule.type === "weekly" && job.schedule.daysOfWeek) {
      for (const dow of job.schedule.daysOfWeek) {
        let dayDiff = dow - nowDay;
        if (dayDiff < 0) dayDiff += 7;
        let mins = dayDiff * 1440 + (jH * 60 + jM) - (nowH * 60 + nowM);
        if (mins <= 0) mins += 7 * 1440;
        if (mins < bestMinutesAway) {
          bestMinutesAway = mins;
          bestJob = job;
        }
      }
    } else {
      let mins = jH * 60 + jM - (nowH * 60 + nowM);
      if (mins <= 0) mins += 1440;
      if (mins < bestMinutesAway) {
        bestMinutesAway = mins;
        bestJob = job;
      }
    }
  }
  if (!bestJob) return null;
  let timeStr;
  if (bestJob.schedule.type === "interval") {
    timeStr = `every ${bestJob.schedule.intervalMinutes || 30}m`;
  } else {
    const h = bestJob.schedule.hour;
    const m = bestJob.schedule.minute;
    const ampm = h < 12 ? "AM" : "PM";
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    timeStr = `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  }
  return { name: bestJob.name, id: bestJob.id, time: timeStr };
}
function updateConfig2(partial) {
  if (partial.jobs) {
    config2.jobs = partial.jobs;
  }
  if (partial.timezone) {
    config2.timezone = partial.timezone;
  }
  saveConfig2();
  return config2;
}
function updateJob(jobId, updates) {
  const job = config2.jobs.find((j) => j.id === jobId);
  if (!job) return null;
  if (updates.enabled !== void 0) job.enabled = updates.enabled;
  if (updates.name) job.name = updates.name;
  if (updates.prompt) job.prompt = updates.prompt;
  if (updates.schedule) job.schedule = { ...job.schedule, ...updates.schedule };
  if (updates.agentId) job.agentId = updates.agentId;
  saveConfig2();
  return job;
}
function addJob(job) {
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const newJob = { id, ...job };
  config2.jobs.push(newJob);
  saveConfig2();
  return newJob;
}
function removeJob(jobId) {
  const idx = config2.jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) return false;
  config2.jobs.splice(idx, 1);
  for (const key of Object.keys(config2.lastJobRun)) {
    if (key === jobId || key.startsWith(`${jobId}_`)) {
      delete config2.lastJobRun[key];
    }
  }
  saveConfig2();
  return true;
}
function getNow2() {
  const nowStr = (/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: config2.timezone });
  return new Date(nowStr);
}
function getTodayKey2() {
  const now = getNow2();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
function shouldJobRun(job, now, nowMinutes, todayKey, dayOfWeek) {
  if (job.schedule.type === "interval") {
    const intervalMs = (job.schedule.intervalMinutes || 30) * 6e4;
    const lastRunTime = job.lastRun ? new Date(job.lastRun).getTime() : 0;
    return Date.now() - lastRunTime >= intervalMs;
  }
  const targetMinutes = job.schedule.hour * 60 + job.schedule.minute;
  if (nowMinutes < targetMinutes || nowMinutes > targetMinutes + 2) return false;
  if (job.schedule.type === "weekly" && job.schedule.daysOfWeek) {
    if (!job.schedule.daysOfWeek.includes(dayOfWeek)) return false;
  }
  const runKey = `${job.id}_${todayKey}`;
  return !config2.lastJobRun[runKey];
}
var BABY_SHEET_ID = "1fhtMkDSTUlRCFqY4hQiSdZg7cOe4FYNkmOIIHWo4KSU";
var BABY_DUE_DATE = /* @__PURE__ */ new Date("2026-07-07T00:00:00");
async function runTimelineAdvance(job) {
  console.log(`[scheduled-jobs] Timeline advance: calculating current week...`);
  try {
    const now = getNow2();
    const msLeft = BABY_DUE_DATE.getTime() - now.getTime();
    const weeksLeft = Math.floor(msLeft / (7 * 24 * 60 * 60 * 1e3));
    const currentWeek = Math.min(40, Math.max(1, 40 - weeksLeft));
    console.log(`[scheduled-jobs] Timeline advance: current pregnancy week = ${currentWeek}`);
    const raw = await sheetsRead(BABY_SHEET_ID, "Timeline!A1:F50");
    const lines = raw.split("\n").filter((l) => l.trim());
    let currentSheetRow = -1;
    let currentWeekLabel = "?";
    let targetSheetRow = -1;
    let targetWeekNum = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const rowMatch = line.match(/^Row\s+(\d+):\s*(.*)/);
      if (!rowMatch) continue;
      const sheetRow = parseInt(rowMatch[1], 10);
      const cols = rowMatch[2].split(" | ").map((c) => c.trim());
      const weekNum = parseInt(cols[0], 10);
      if (isNaN(weekNum)) continue;
      if (cols.length > 5 && cols[5]?.includes("\u2705")) {
        currentSheetRow = sheetRow;
        currentWeekLabel = cols[0];
      }
      if (weekNum === currentWeek) {
        targetSheetRow = sheetRow;
        targetWeekNum = weekNum;
      }
    }
    if (targetSheetRow === -1) {
      console.log(`[scheduled-jobs] Timeline advance: week ${currentWeek} row not found in sheet, skipping`);
      job.lastRun = now.toISOString();
      job.lastResult = `Week ${currentWeek} row not found`;
      job.lastStatus = "error";
      await saveConfig2();
      await writeJobHistory(job.id, job.name, "error", job.lastResult, null, null);
      return;
    }
    if (currentSheetRow === targetSheetRow) {
      console.log(`[scheduled-jobs] Timeline advance: already at week ${currentWeek}, no change needed`);
      job.lastRun = now.toISOString();
      job.lastResult = `Already at week ${currentWeek}`;
      job.lastStatus = "success";
      await saveConfig2();
      await writeJobHistory(job.id, job.name, "success", job.lastResult, null, null);
      return;
    }
    if (currentSheetRow >= 0 && currentSheetRow !== targetSheetRow) {
      const prevWeek = parseInt(currentWeekLabel, 10);
      const oldStatus = prevWeek >= 40 ? "\u{1F38A} Due Jul 7!" : `\u2714\uFE0F Week ${prevWeek}`;
      await sheetsUpdate(BABY_SHEET_ID, `Timeline!F${currentSheetRow}`, [[oldStatus]]);
      console.log(`[scheduled-jobs] Timeline advance: marked row ${currentSheetRow} as "${oldStatus}"`);
    }
    const newStatus = targetWeekNum >= 40 ? "\u{1F38A} Due Jul 7!" : "\u2705 Current Week";
    await sheetsUpdate(BABY_SHEET_ID, `Timeline!F${targetSheetRow}`, [[newStatus]]);
    console.log(`[scheduled-jobs] Timeline advance: set row ${targetSheetRow} (week ${currentWeek}) as "${newStatus}"`);
    job.lastRun = now.toISOString();
    job.lastResult = `Advanced from week ${currentWeekLabel} to week ${currentWeek}`;
    job.lastStatus = "success";
    await saveConfig2();
    await writeJobHistory(job.id, job.name, "success", job.lastResult, null, null);
    if (broadcastFn2) {
      broadcastFn2({
        type: "job_complete",
        jobId: job.id,
        jobName: job.name,
        summary: `Timeline advanced to week ${currentWeek}`,
        timestamp: Date.now()
      });
    }
  } catch (err) {
    console.error(`[scheduled-jobs] Timeline advance error:`, err);
    job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
    job.lastResult = String(err).slice(0, 300);
    job.lastStatus = "error";
    await saveConfig2();
    await writeJobHistory(job.id, job.name, "error", String(err).slice(0, 300), null, null);
  }
}
var BIRTHDAY_SHEET_ID = "1m4T-vniOylUSyVMSirtun5u9M6gJZlXS3iLy5hGxfuY";
var RELATIONSHIP_COLORS = {
  family: "11",
  friend: "9",
  coworker: "10"
};
async function runBirthdayCalendarSync(job) {
  console.log(`[scheduled-jobs] Birthday sync: reading sheet...`);
  const now = getNow2();
  const results = [];
  let created = 0;
  let skipped = 0;
  let errors = 0;
  try {
    const raw = await sheetsRead(BIRTHDAY_SHEET_ID, "Sheet1!A1:F100");
    const lines = raw.split("\n").filter((l) => l.trim());
    const rows = [];
    for (const line of lines) {
      const rowMatch = line.match(/^Row\s+(\d+):\s*(.*)/);
      if (!rowMatch) continue;
      const sheetRow = parseInt(rowMatch[1], 10);
      if (sheetRow === 1) continue;
      const cols = rowMatch[2].split(" | ").map((c) => c.trim());
      rows.push({
        sheetRow,
        name: cols[0] || "",
        relationship: cols[1] || "",
        birthday: cols[2] || "",
        birthYear: cols[3] || "",
        notes: cols[4] || "",
        synced: cols[5] || ""
      });
    }
    const unsynced = rows.filter((r) => r.name && r.birthday && r.synced.toLowerCase() !== "yes");
    if (unsynced.length === 0) {
      console.log(`[scheduled-jobs] Birthday sync: no unsynced rows`);
      job.lastRun = now.toISOString();
      job.lastResult = "No unsynced birthdays";
      job.lastStatus = "success";
      await saveConfig2();
      await writeJobHistory(job.id, job.name, "success", "No unsynced birthdays", null, null);
      return;
    }
    console.log(`[scheduled-jobs] Birthday sync: ${unsynced.length} unsynced row(s) found`);
    const calendarId = await findOrCreateCalendar("Birthdays");
    console.log(`[scheduled-jobs] Birthday sync: using calendar ${calendarId}`);
    for (const row of unsynced) {
      try {
        const parts = row.birthday.match(/^(\d{1,2})\/(\d{1,2})$/);
        if (!parts) {
          console.log(`[scheduled-jobs] Birthday sync: invalid date "${row.birthday}" for ${row.name}, skipping`);
          results.push(`\u26A0\uFE0F Skipped ${row.name}: invalid date "${row.birthday}"`);
          await sheetsUpdate(BIRTHDAY_SHEET_ID, `Sheet1!F${row.sheetRow}`, [["Invalid"]]);
          errors++;
          continue;
        }
        const month = parseInt(parts[1], 10);
        const day = parseInt(parts[2], 10);
        if (month < 1 || month > 12 || day < 1 || day > 31) {
          console.log(`[scheduled-jobs] Birthday sync: out-of-range date "${row.birthday}" for ${row.name}, skipping`);
          results.push(`\u26A0\uFE0F Skipped ${row.name}: invalid month/day "${row.birthday}"`);
          await sheetsUpdate(BIRTHDAY_SHEET_ID, `Sheet1!F${row.sheetRow}`, [["Invalid"]]);
          errors++;
          continue;
        }
        const testDate = new Date(2024, month - 1, day);
        if (testDate.getMonth() !== month - 1 || testDate.getDate() !== day) {
          console.log(`[scheduled-jobs] Birthday sync: non-existent date "${row.birthday}" for ${row.name}, skipping`);
          results.push(`\u26A0\uFE0F Skipped ${row.name}: date doesn't exist "${row.birthday}"`);
          await sheetsUpdate(BIRTHDAY_SHEET_ID, `Sheet1!F${row.sheetRow}`, [["Invalid"]]);
          errors++;
          continue;
        }
        let year = now.getFullYear();
        const thisYearDate = new Date(year, month - 1, day);
        if (thisYearDate < now) {
          year++;
        }
        const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const description = [
          `Relationship: ${row.relationship}`,
          row.birthYear ? `Birth Year: ${row.birthYear}` : "",
          row.notes ? `Notes: ${row.notes}` : ""
        ].filter(Boolean).join("\n");
        const colorId = RELATIONSHIP_COLORS[row.relationship.toLowerCase()] || "9";
        const eventId = await createRecurringEvent(calendarId, {
          summary: `\u{1F382} ${row.name}'s Birthday`,
          date: dateStr,
          description,
          colorId,
          recurrence: ["RRULE:FREQ=YEARLY"],
          reminders: {
            useDefault: false,
            overrides: [{ method: "popup", minutes: 0 }]
          }
        });
        try {
          await sheetsUpdate(BIRTHDAY_SHEET_ID, `Sheet1!F${row.sheetRow}`, [["Yes"]]);
        } catch (markErr) {
          console.error(`[scheduled-jobs] Birthday sync: event created for ${row.name} (${eventId}) but failed to mark sheet \u2014 may create duplicate on next run`);
        }
        results.push(`\u2705 ${row.name} \u2014 ${row.birthday} (${row.relationship})`);
        created++;
        console.log(`[scheduled-jobs] Birthday sync: created event for ${row.name} (${eventId})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[scheduled-jobs] Birthday sync error for ${row.name}:`, msg);
        results.push(`\u274C ${row.name}: ${msg.slice(0, 100)}`);
        errors++;
      }
    }
    const summary = `Synced ${created}, skipped/errors ${errors + skipped}`;
    job.lastRun = now.toISOString();
    job.lastResult = summary;
    job.lastStatus = errors > 0 && created === 0 ? "error" : errors > 0 ? "partial" : "success";
    await saveConfig2();
    const reportContent = `# Birthday Calendar Sync
*${now.toLocaleString("en-US", { timeZone: "America/New_York" })}*

## Results
- Created: ${created}
- Errors: ${errors}

${results.join("\n")}`;
    const savePath = getJobSavePath(job.id, getTodayKey2(), "Birthday-Sync");
    if (kbCreateFn) {
      try {
        await kbCreateFn(savePath, reportContent);
      } catch {
      }
    }
    await writeJobHistory(job.id, job.name, job.lastStatus, summary, savePath, null);
    if (broadcastFn2) {
      broadcastFn2({
        type: "job_complete",
        jobId: job.id,
        jobName: job.name,
        summary,
        timestamp: Date.now()
      });
    }
    console.log(`[scheduled-jobs] Birthday sync complete: ${summary}`);
  } catch (err) {
    console.error(`[scheduled-jobs] Birthday sync error:`, err);
    job.lastRun = now.toISOString();
    job.lastResult = String(err).slice(0, 300);
    job.lastStatus = "error";
    await saveConfig2();
    await writeJobHistory(job.id, job.name, "error", String(err).slice(0, 300), null, null);
  }
}
async function runInboxMonitor(job) {
  console.log(`[scheduled-jobs] Inbox monitor: checking for @darknode emails...`);
  let emails;
  try {
    emails = await getDarkNodeEmails();
  } catch (err) {
    console.error("[scheduled-jobs] Inbox monitor: failed to fetch emails:", err);
    job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
    job.lastResult = `Error fetching emails: ${err}`;
    job.lastStatus = "error";
    await saveConfig2();
    return;
  }
  if (emails.length === 0) {
    console.log("[scheduled-jobs] Inbox monitor: no new @darknode emails");
    job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
    job.lastResult = "No new @darknode emails found";
    job.lastStatus = "success";
    await saveConfig2();
    return;
  }
  console.log(`[scheduled-jobs] Inbox monitor: found ${emails.length} @darknode email(s)`);
  const results = [];
  for (const email of emails) {
    const prompt = `You received a forwarded email with a @darknode instruction. Process it accordingly.

**Instruction**: ${email.instruction}

**Email Details**:
- Subject: ${email.subject}
- From: ${email.from}
- Date: ${email.date}

**Email Body**:
${email.body}

Process the email content according to the instruction "${email.instruction}". Common instructions:
- "add to KB" / "save" = Save the email content as a well-organized note in the knowledge base
- "summarize" = Create a concise summary and save it
- "add to calendar" = Extract event details and create calendar events
- "action items" / "tasks" = Extract action items and create tasks
- For any other instruction, use your best judgment to fulfill the request

After processing, briefly confirm what you did.`;
    try {
      const agentResult = await runAgentFn(job.agentId === "orchestrator" ? "deep-researcher" : job.agentId, prompt);
      results.push(`## ${email.subject}
**Instruction**: ${email.instruction}
**Result**: ${agentResult.response}`);
      await markDarkNodeProcessed(email.messageId);
      console.log(`[scheduled-jobs] Inbox monitor: processed "${email.subject}" (${email.instruction})`);
    } catch (err) {
      results.push(`## ${email.subject}
**Instruction**: ${email.instruction}
**Error**: ${err}`);
      console.error(`[scheduled-jobs] Inbox monitor: failed to process "${email.subject}":`, err);
    }
  }
  const fullResult = results.join("\n\n---\n\n");
  job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
  job.lastResult = fullResult.slice(0, 500);
  job.lastStatus = results.some((r) => r.includes("**Error**")) ? "partial" : "success";
  await saveConfig2();
  let inboxSavePath = null;
  if (kbCreateFn) {
    const todayKey = getTodayKey2();
    const timestamp = (/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: config2.timezone }).replace(/[/:]/g, "-").replace(/,\s*/g, "_");
    inboxSavePath = `Scheduled Reports/Inbox Monitor/${todayKey}-${timestamp}.md`;
    try {
      await kbCreateFn(inboxSavePath, `# Inbox Monitor Results
*Processed: ${(/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: config2.timezone })}*
*Emails processed: ${emails.length}*

${fullResult}`);
    } catch {
    }
    try {
      await writeJobStatus(job.id, { lastRun: job.lastRun, status: job.lastStatus, savedTo: inboxSavePath, error: null });
    } catch {
    }
  }
  await writeJobHistory(job.id, job.name, job.lastStatus || "success", `Processed ${emails.length} email(s)`, inboxSavePath, null);
  if (broadcastFn2) {
    broadcastFn2({
      type: "job_complete",
      jobId: job.id,
      jobName: job.name,
      summary: `Processed ${emails.length} @darknode email(s): ${emails.map((e) => e.instruction).join(", ")}`,
      timestamp: Date.now()
    });
  }
}
async function checkJobs() {
  if (jobRunning || !runAgentFn) return;
  const now = getNow2();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const todayKey = getTodayKey2();
  const dayOfWeek = now.getDay();
  for (const job of config2.jobs) {
    if (!job.enabled) continue;
    if (!shouldJobRun(job, now, nowMinutes, todayKey, dayOfWeek)) continue;
    if (job.schedule.type !== "interval") {
      const runKey = `${job.id}_${todayKey}`;
      config2.lastJobRun[runKey] = true;
      await saveConfig2();
    }
    jobRunning = true;
    currentRunningJobId = job.id;
    console.log(`[scheduled-jobs] Running job: ${job.name} (${job.id})`);
    if (broadcastFn2) {
      broadcastFn2({
        type: "job_start",
        jobId: job.id,
        jobName: job.name,
        timestamp: Date.now()
      });
    }
    try {
      if (job.id === "darknode-inbox-monitor") {
        await runInboxMonitor(job);
      } else if (job.id === "baby-timeline-advance") {
        await runTimelineAdvance(job);
      } else if (job.id === "birthday-calendar-sync") {
        await runBirthdayCalendarSync(job);
      } else {
        const jobStartMs = Date.now();
        const progressCb = (info) => {
          if (broadcastFn2) {
            broadcastFn2({ type: "job_progress", jobId: job.id, jobName: job.name, toolName: info.toolName, timestamp: Date.now() });
          }
        };
        const agentResult = await runAgentFn(job.agentId, job.prompt, progressCb);
        const result = agentResult.response;
        const isPartial = agentResult.timedOut || result.includes("\u26A0\uFE0F PARTIAL");
        job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
        job.lastResult = result.slice(0, 500);
        job.lastStatus = isPartial ? "partial" : "success";
        await saveConfig2();
        const dateStr = todayKey;
        const safeName = job.name.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "-");
        const savePath = getJobSavePath(job.id, dateStr, safeName);
        let vaultSaved = false;
        if (kbCreateFn) {
          try {
            await kbCreateFn(savePath, `# ${job.name}
*Generated: ${(/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: config2.timezone })}*

${result}`);
            vaultSaved = true;
          } catch (e) {
            console.error(`[scheduled-jobs] Failed to save to vault:`, e);
          }
          try {
            await writeJobStatus(job.id, { lastRun: job.lastRun, status: job.lastStatus, savedTo: vaultSaved ? savePath : null, error: vaultSaved ? null : "vault save failed" });
          } catch {
          }
        }
        if (broadcastFn2) {
          broadcastFn2({
            type: "job_complete",
            jobId: job.id,
            jobName: job.name,
            summary: result.slice(0, 300),
            savedTo: vaultSaved ? savePath : null,
            status: job.lastStatus,
            timestamp: Date.now()
          });
          if (job.id === "life-audit" && result.includes("\u{1F534} CRITICAL")) {
            const criticalLine = result.split("\n").find((l) => l.includes("\u{1F534} CRITICAL")) || "Critical finding detected";
            broadcastFn2({
              type: "alert",
              alertType: "life-audit-critical",
              title: "\u{1F534} Life Audit: Critical Finding",
              content: criticalLine.slice(0, 300),
              timestamp: Date.now()
            });
            console.log(`[scheduled-jobs] Life Audit CRITICAL alert broadcast`);
          }
        }
        console.log(`[scheduled-jobs] Job completed${isPartial ? " (partial)" : ""}: ${job.name}`);
        await writeJobHistory(job.id, job.name, job.lastStatus || "success", result.slice(0, 500), vaultSaved ? savePath : null, Date.now() - jobStartMs);
        if ((job.id.startsWith("moodys") || job.id.startsWith("real-estate") || job.id === "life-audit" || job.id === "weekly-inbox-deep-clean" || job.id === "baby-dashboard-weekly-update") && kbListFn && kbMoveFn) {
          await archiveOldReports();
        }
      }
    } catch (err) {
      job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
      job.lastResult = String(err);
      job.lastStatus = "error";
      await saveConfig2();
      if (kbCreateFn) {
        try {
          await writeJobStatus(job.id, { lastRun: job.lastRun, status: "error", savedTo: null, error: String(err).slice(0, 300) });
        } catch {
        }
      }
      await writeJobHistory(job.id, job.name, "error", String(err).slice(0, 500), null, null);
      if (broadcastFn2) {
        broadcastFn2({
          type: "job_complete",
          jobId: job.id,
          jobName: job.name,
          summary: String(err).slice(0, 200),
          savedTo: null,
          status: "error",
          timestamp: Date.now()
        });
      }
      console.error(`[scheduled-jobs] Job failed: ${job.name}`, err);
    } finally {
      jobRunning = false;
      currentRunningJobId = null;
    }
  }
  const keys = Object.keys(config2.lastJobRun);
  if (keys.length > 100) {
    const sorted = keys.sort();
    for (let i = 0; i < keys.length - 50; i++) {
      delete config2.lastJobRun[sorted[i]];
    }
    saveConfig2();
  }
}
function startJobSystem(runAgent, broadcast, kbCreate2, kbList2, kbMove2, getDbPool) {
  runAgentFn = runAgent;
  broadcastFn2 = broadcast;
  kbCreateFn = kbCreate2 || null;
  kbListFn = kbList2 || null;
  kbMoveFn = kbMove2 || null;
  dbPoolFn = getDbPool || null;
  checkInterval = setInterval(() => {
    checkJobs().catch((err) => console.error("[scheduled-jobs] Check error:", err));
  }, 6e4);
  const enabledJobs = config2.jobs.filter((j) => j.enabled);
  const jobList = enabledJobs.length > 0 ? enabledJobs.map((j) => {
    if (j.schedule.type === "interval") return `${j.name}/every ${j.schedule.intervalMinutes || 30}m`;
    return `${j.name}/${j.schedule.hour}:${String(j.schedule.minute).padStart(2, "0")}`;
  }).join(", ") : "none enabled";
  console.log(`[scheduled-jobs] System started \u2014 ${jobList} (${config2.timezone})`);
}
function getRunningJob() {
  if (!jobRunning || !currentRunningJobId) return { running: false, jobId: null, jobName: null };
  const job = config2.jobs.find((j) => j.id === currentRunningJobId);
  return { running: true, jobId: currentRunningJobId, jobName: job?.name || null };
}
function stopJobSystem() {
  if (checkInterval) clearInterval(checkInterval);
  runAgentFn = null;
  broadcastFn2 = null;
  console.log("[scheduled-jobs] System stopped");
}
async function triggerJob(jobId) {
  const job = config2.jobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (!runAgentFn) throw new Error("Job system not started");
  if (jobRunning) throw new Error("Another job is currently running");
  jobRunning = true;
  currentRunningJobId = job.id;
  console.log(`[scheduled-jobs] Manual trigger: ${job.name}`);
  if (broadcastFn2) {
    broadcastFn2({ type: "job_start", jobId: job.id, jobName: job.name, timestamp: Date.now() });
  }
  try {
    if (job.id === "darknode-inbox-monitor") {
      await runInboxMonitor(job);
      return job.lastResult || "Inbox monitor completed";
    }
    if (job.id === "baby-timeline-advance") {
      await runTimelineAdvance(job);
      return job.lastResult || "Timeline advance completed";
    }
    if (job.id === "birthday-calendar-sync") {
      await runBirthdayCalendarSync(job);
      return job.lastResult || "Birthday sync completed";
    }
    const triggerStartMs = Date.now();
    const progressCb = (info) => {
      if (broadcastFn2) {
        broadcastFn2({ type: "job_progress", jobId: job.id, jobName: job.name, toolName: info.toolName, timestamp: Date.now() });
      }
    };
    const agentResult = await runAgentFn(job.agentId, job.prompt, progressCb);
    let result = agentResult.response;
    const isPartial = agentResult.timedOut || result.includes("\u26A0\uFE0F PARTIAL");
    job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
    job.lastResult = result.slice(0, 500);
    job.lastStatus = isPartial ? "partial" : "success";
    await saveConfig2();
    const todayKey = getTodayKey2();
    const safeName = job.name.replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "-");
    const savePath = getJobSavePath(job.id, todayKey, safeName);
    if (job.id === "moodys-daily-intel") {
      try {
        const fs4 = await import("fs");
        const path5 = await import("path");
        const briefDir = path5.join(process.cwd(), "data/vault/Scheduled Reports/Moody's Intelligence/Daily");
        if (fs4.existsSync(briefDir)) {
          const files = fs4.readdirSync(briefDir).filter((f) => f.endsWith("-Brief.md") && f > `${todayKey}-Brief.md`).sort().reverse();
          for (const fname of files) {
            const content = fs4.readFileSync(path5.join(briefDir, fname), "utf-8");
            if (content.length > 1e3 && content.includes("## \u{1F3E2}")) {
              result = content;
              console.log(`[scheduled-jobs] Moody's brief: using agent-saved file ${fname} (${result.length} chars)`);
              break;
            }
          }
        }
      } catch (e) {
        console.error("[scheduled-jobs] Moody's brief recovery failed:", e);
      }
    }
    let vaultSaved = false;
    if (kbCreateFn) {
      try {
        await kbCreateFn(savePath, `# ${job.name}
*Generated: ${(/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: config2.timezone })}*

${result}`);
        vaultSaved = true;
      } catch {
      }
      try {
        await writeJobStatus(job.id, { lastRun: job.lastRun, status: job.lastStatus, savedTo: vaultSaved ? savePath : null, error: vaultSaved ? null : "vault save failed" });
      } catch {
      }
    }
    if ((job.id.startsWith("moodys") || job.id.startsWith("real-estate") || job.id === "life-audit" || job.id === "weekly-inbox-deep-clean" || job.id === "baby-dashboard-weekly-update") && kbListFn && kbMoveFn) {
      await archiveOldReports();
    }
    await writeJobHistory(job.id, job.name, job.lastStatus || "success", result.slice(0, 500), vaultSaved ? savePath : null, Date.now() - triggerStartMs);
    if (broadcastFn2) {
      broadcastFn2({
        type: "job_complete",
        jobId: job.id,
        jobName: job.name,
        summary: result.slice(0, 300),
        savedTo: vaultSaved ? savePath : null,
        status: job.lastStatus,
        timestamp: Date.now()
      });
    }
    return result;
  } catch (err) {
    job.lastRun = (/* @__PURE__ */ new Date()).toISOString();
    job.lastResult = String(err);
    job.lastStatus = "error";
    await saveConfig2();
    if (kbCreateFn) {
      try {
        await writeJobStatus(job.id, { lastRun: job.lastRun, status: "error", savedTo: null, error: String(err).slice(0, 300) });
      } catch {
      }
    }
    await writeJobHistory(job.id, job.name, "error", String(err).slice(0, 500), null, null);
    if (broadcastFn2) {
      broadcastFn2({
        type: "job_complete",
        jobId: job.id,
        jobName: job.name,
        summary: String(err).slice(0, 200),
        savedTo: null,
        status: "error",
        timestamp: Date.now()
      });
    }
    throw err;
  } finally {
    jobRunning = false;
    currentRunningJobId = null;
  }
}

// src/agents/loader.ts
import fs2 from "fs";
import path3 from "path";
var agents = [];
var configPath = "";
var registeredToolNames = null;
function init8(dataDir) {
  configPath = path3.join(dataDir, "agents.json");
  loadAgents();
  let reloadTimer = null;
  try {
    fs2.watch(configPath, () => {
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
function setRegisteredTools(toolNames) {
  registeredToolNames = new Set(toolNames);
  validateAgentTools();
}
function validateAgentTools() {
  if (!registeredToolNames || agents.length === 0) return;
  for (const agent of agents) {
    const unknownTools = agent.tools.filter((t) => !registeredToolNames.has(t));
    if (unknownTools.length > 0) {
      console.warn(`[agents] WARNING: agent "${agent.id}" references unknown tools: ${unknownTools.join(", ")}`);
    }
  }
}
function loadAgents() {
  try {
    const raw = fs2.readFileSync(configPath, "utf-8");
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
    if (registeredToolNames) validateAgentTools();
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
import Anthropic3 from "@anthropic-ai/sdk";
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
function parseApiError(err) {
  const status = err?.status || err?.statusCode || 0;
  let type = "unknown_error";
  let message = err?.message || String(err);
  try {
    const body = err?.error || err?.body;
    if (body?.error) {
      type = body.error.type || type;
      message = body.error.message || message;
    }
  } catch {
  }
  return { status, type, message };
}
async function runSubAgent(opts) {
  if (!opts.apiKey) throw new Error("Anthropic API key is not configured \u2014 cannot run sub-agents");
  const agent = getAgent(opts.agentId);
  if (!agent) throw new Error(`Agent "${opts.agentId}" not found. Use list_agents to see available agents.`);
  if (!agent.enabled) throw new Error(`Agent "${opts.agentId}" is currently disabled`);
  const startTime = Date.now();
  console.log(`[agent:${agent.id}] started \u2014 "${opts.task.slice(0, 80)}"`);
  const filteredTools = opts.allTools.filter((t) => agent.tools.includes(t.name));
  console.log(`[agent:${agent.id}] tools: ${filteredTools.length} of ${opts.allTools.length} (${filteredTools.map((t) => t.name).join(", ")})`);
  const anthropicTools = convertToolsToAnthropicFormat(filteredTools);
  const toolsUsed = [];
  const client = new Anthropic3({ apiKey: opts.apiKey });
  const modelId = agent.model === "default" ? opts.model || "claude-opus-4-6" : agent.model;
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
  let softTimeoutSent = false;
  let hardTimedOut = false;
  let containerId;
  const timeoutMs = agent.timeout * 1e3;
  const softTimeoutMs = timeoutMs * 0.8;
  const buildResult = (extra) => ({
    agentId: agent.id,
    agentName: agent.name,
    response: finalResponse || "(No response generated)",
    toolsUsed,
    durationMs: Date.now() - startTime,
    tokensUsed: { input: totalInput, output: totalOutput },
    timedOut: hardTimedOut,
    ...extra || {}
  });
  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const elapsed = Date.now() - startTime;
    if (elapsed > timeoutMs) {
      console.warn(`[agent:${agent.id}] timeout after ${agent.timeout}s`);
      hardTimedOut = true;
      break;
    }
    if (!softTimeoutSent && elapsed > softTimeoutMs) {
      softTimeoutSent = true;
      console.log(`[agent:${agent.id}] soft timeout at 80% \u2014 nudging to save`);
      messages.push({
        role: "user",
        content: "\u26A0\uFE0F TIME WARNING: You are running low on time. Immediately save whatever findings you have so far using notes_create. Prefix the filename with '\u26A0\uFE0F PARTIAL \u2014 ' to indicate incomplete results. Then provide your final summary."
      });
    }
    let apiResponse;
    try {
      const requestParams = {
        model: modelId,
        max_tokens: 16384,
        system: agent.systemPrompt,
        tools: anthropicTools,
        messages
      };
      if (containerId) {
        requestParams.container_id = containerId;
      }
      apiResponse = await client.messages.create(requestParams);
    } catch (err) {
      const parsed = parseApiError(err);
      console.error(`[agent:${agent.id}] API error (${parsed.status}): ${parsed.type} \u2014 ${parsed.message}`);
      if (parsed.status === 400) {
        if (containerId && parsed.message.includes("container")) {
          console.warn(`[agent:${agent.id}] stale container_id \u2014 clearing and retrying`);
          containerId = void 0;
          try {
            apiResponse = await client.messages.create({
              model: modelId,
              max_tokens: 16384,
              system: agent.systemPrompt,
              tools: anthropicTools,
              messages
            });
          } catch (retryErr) {
            const retryParsed = parseApiError(retryErr);
            console.error(`[agent:${agent.id}] retry without container_id also failed: ${retryParsed.message}`);
            finalResponse = finalResponse ? `${finalResponse}

[Agent hit API error: ${retryParsed.message}]` : `Agent "${agent.id}" encountered an API error: ${retryParsed.message}`;
            return buildResult({ error: retryParsed.message });
          }
        } else {
          finalResponse = finalResponse ? `${finalResponse}

[Agent hit API error: ${parsed.message}]` : `Agent "${agent.id}" encountered an API error on iteration ${iteration + 1}: ${parsed.message}`;
          return buildResult({ error: parsed.message });
        }
      }
      if (parsed.status === 429 || parsed.status === 529) {
        console.log(`[agent:${agent.id}] rate limited \u2014 waiting 5s before retry`);
        await new Promise((r) => setTimeout(r, 5e3));
        try {
          const retryParams = {
            model: modelId,
            max_tokens: 16384,
            system: agent.systemPrompt,
            tools: anthropicTools,
            messages
          };
          if (containerId) retryParams.container_id = containerId;
          apiResponse = await client.messages.create(retryParams);
        } catch (retryErr) {
          const retryParsed = parseApiError(retryErr);
          console.error(`[agent:${agent.id}] retry also failed (${retryParsed.status}): ${retryParsed.message}`);
          finalResponse = finalResponse ? `${finalResponse}

[Agent hit API error after retry: ${retryParsed.message}]` : `Agent "${agent.id}" failed after retry: ${retryParsed.message}`;
          return buildResult({ error: retryParsed.message });
        }
      } else {
        finalResponse = finalResponse ? `${finalResponse}

[Agent hit API error: ${parsed.message}]` : `Agent "${agent.id}" encountered an API error: ${parsed.message}`;
        return buildResult({ error: parsed.message });
      }
    }
    if (apiResponse.container_id) {
      containerId = apiResponse.container_id;
    }
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
      if (opts.onProgress) {
        try {
          opts.onProgress({ toolName: toolCall.name, iteration });
        } catch {
        }
      }
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
    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }
  }
  if (!finalResponse && messages.length > 1 && !hardTimedOut) {
    try {
      console.log(`[agent:${agent.id}] no final response \u2014 requesting summary`);
      messages.push({ role: "user", content: "Please provide your final summary and findings based on the work you've done so far." });
      const summaryParams = {
        model: modelId,
        max_tokens: 4096,
        system: agent.systemPrompt,
        messages
      };
      if (containerId) summaryParams.container_id = containerId;
      const summaryResponse = await client.messages.create(summaryParams);
      totalInput += summaryResponse.usage?.input_tokens || 0;
      totalOutput += summaryResponse.usage?.output_tokens || 0;
      const summaryText = summaryResponse.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (summaryText) finalResponse = summaryText;
    } catch (err) {
      console.error(`[agent:${agent.id}] summary request failed:`, err.message);
    }
  }
  const durationMs = Date.now() - startTime;
  console.log(`[agent:${agent.id}] completed in ${(durationMs / 1e3).toFixed(1)}s (${toolsUsed.length} tools used, ${totalInput + totalOutput} tokens)`);
  return buildResult();
}

// src/memory-extractor.ts
import Anthropic4 from "@anthropic-ai/sdk";
async function extractAndFileInsights(messages, currentProfile) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { profileUpdates: [], actionItems: [], skipReason: "no_api_key" };
  }
  const transcript = messages.filter((m) => m.role !== "system").map((m) => {
    const role = m.role === "user" ? "Rickin" : "Assistant";
    const text = m.text.length > 600 ? m.text.slice(0, 600) + "..." : m.text;
    return `${role}: ${text}`;
  }).join("\n\n");
  if (transcript.length < 50) {
    return { profileUpdates: [], actionItems: [], skipReason: "too_short" };
  }
  try {
    const client = new Anthropic4({ apiKey });
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `You analyze conversations between Rickin and his AI assistant to extract new facts worth remembering.

CURRENT PROFILE (already known):
${currentProfile || "(empty)"}

CONVERSATION:
${transcript}

Extract ONLY genuinely new information not already in the profile. Respond with valid JSON:
{
  "profileUpdates": ["string array of new facts about Rickin \u2014 preferences, people, projects, routines, interests, decisions. Each item is a short sentence."],
  "actionItems": ["string array of action items or tasks mentioned \u2014 things to do, follow up on, or remember. Each item is a short sentence."],
  "skipReason": "If nothing new was learned, set this to 'nothing_new'. Otherwise omit this field."
}

Rules:
- Only include facts that are NOT already in the current profile
- Do not include generic observations or AI-side actions
- Action items must be things Rickin needs to do, not things the assistant did
- If the conversation was purely functional (weather check, quick lookup) with no new personal info, return skipReason: "nothing_new"
- Keep each item concise \u2014 one sentence max
- Return ONLY the JSON, no markdown fencing`
      }]
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      profileUpdates: Array.isArray(parsed.profileUpdates) ? parsed.profileUpdates : [],
      actionItems: Array.isArray(parsed.actionItems) ? parsed.actionItems : [],
      skipReason: parsed.skipReason || void 0
    };
  } catch (err) {
    console.error("[memory-extractor] Extraction failed:", err);
    return { profileUpdates: [], actionItems: [], skipReason: "extraction_error" };
  }
}

// server.ts
var PORT = parseInt(process.env.PORT || "3000", 10);
var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
var APP_PASSWORD = process.env.APP_PASSWORD || "";
var POOJA_PASSWORD = process.env.POOJA_PASSWORD || "";
var DARKNODE_PASSWORD = process.env.DARKNODE_PASSWORD || "";
var USERS = {
  rickin: { password: APP_PASSWORD, displayName: "Rickin" },
  pooja: { password: POOJA_PASSWORD, displayName: "Pooja" },
  darknode: { password: DARKNODE_PASSWORD, displayName: "DarkNode" }
};
var SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
var __filename = fileURLToPath(import.meta.url);
var __dirname = path4.dirname(__filename);
var PROJECT_ROOT = __filename.includes("/dist/") ? path4.resolve(__dirname, "..") : __dirname;
var PUBLIC_DIR = path4.join(PROJECT_ROOT, "public");
var AGENT_DIR = path4.join(PROJECT_ROOT, ".pi/agent");
var VAULT_DIR = path4.join(PROJECT_ROOT, "data", "vault");
fs3.mkdirSync(AGENT_DIR, { recursive: true });
init(VAULT_DIR);
init8(path4.join(PROJECT_ROOT, "data"));
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
if (!APP_PASSWORD) console.warn("APP_PASSWORD is not set \u2014 auth disabled.");
console.log(`[boot] PORT=${PORT} PUBLIC_DIR=${PUBLIC_DIR} AGENT_DIR=${AGENT_DIR}`);
console.log(`[boot] public/ exists: ${fs3.existsSync(PUBLIC_DIR)}`);
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
function kbDelete(p) {
  return useLocalVault ? deleteNote2(p) : deleteNote(p);
}
function kbMove(from, to) {
  return useLocalVault ? moveNote2(from, to) : moveNote(from, to);
}
function kbRenameFolder(from, to) {
  return useLocalVault ? renameFolder2(from, to) : renameFolder(from, to);
}
function kbListRecursive(p) {
  return useLocalVault ? listRecursive2(p) : listRecursive(p);
}
function kbFileInfo(p) {
  return useLocalVault ? fileInfo2(p) : fileInfo(p);
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
        const p = params.path ?? "/";
        try {
          const result = await kbList(p);
          console.log(`[vault] notes_list OK: ${p}`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_list FAILED: ${p} \u2014 ${err.message}`);
          throw err;
        }
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
        try {
          const result = await kbRead(params.path);
          console.log(`[vault] notes_read OK: ${params.path}`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_read FAILED: ${params.path} \u2014 ${err.message}`);
          throw err;
        }
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
        try {
          const result = await kbCreate(params.path, params.content);
          console.log(`[vault] notes_create OK: ${params.path} (${params.content.length} chars)`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_create FAILED: ${params.path} \u2014 ${err.message}`);
          throw err;
        }
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
        try {
          const result = await kbAppend(params.path, params.content);
          console.log(`[vault] notes_append OK: ${params.path} (+${params.content.length} chars)`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_append FAILED: ${params.path} \u2014 ${err.message}`);
          throw err;
        }
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
        try {
          const result = await kbSearch(params.query);
          const count = JSON.parse(result).length;
          console.log(`[vault] notes_search OK: "${params.query}" (${count} matches)`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_search FAILED: "${params.query}" \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_delete",
      label: "Notes Delete",
      description: "Permanently delete a note from the user's knowledge base. This cannot be undone. Use when reorganizing notes (e.g. after moving content to a new location). Empty parent folders are cleaned up automatically.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the note to delete (e.g. 'Projects/old-file.md')" })
      }),
      async execute(_toolCallId, params) {
        console.log(`[vault] notes_delete: ${params.path}`);
        try {
          const result = await kbDelete(params.path);
          console.log(`[vault] notes_delete OK: ${params.path}`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_delete FAILED: ${params.path} \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_move",
      label: "Notes Move",
      description: "Move or rename a note in the user's knowledge base. Moves the file from one path to another, creating destination folders as needed. Empty source folders are cleaned up automatically.",
      parameters: Type.Object({
        from: Type.String({ description: "Current path of the note (e.g. 'Projects/old-name.md')" }),
        to: Type.String({ description: "New path for the note (e.g. 'Projects/Subfolder/new-name.md')" })
      }),
      async execute(_toolCallId, params) {
        console.log(`[vault] notes_move: ${params.from} \u2192 ${params.to}`);
        try {
          const result = await kbMove(params.from, params.to);
          console.log(`[vault] notes_move OK: ${params.from} \u2192 ${params.to}`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_move FAILED: ${params.from} \u2192 ${params.to} \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_rename_folder",
      label: "Notes Rename Folder",
      description: "Rename or move an entire folder in the knowledge base. All files and subfolders inside are moved to the new location. Use for reorganizing vault structure.",
      parameters: Type.Object({
        from: Type.String({ description: "Current folder path (e.g. 'Projects/Old Name')" }),
        to: Type.String({ description: "New folder path (e.g. 'Projects/New Name')" })
      }),
      async execute(_toolCallId, params) {
        console.log(`[vault] notes_rename_folder: ${params.from} \u2192 ${params.to}`);
        try {
          const result = await kbRenameFolder(params.from, params.to);
          console.log(`[vault] notes_rename_folder OK: ${params.from} \u2192 ${params.to}`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_rename_folder FAILED: ${params.from} \u2192 ${params.to} \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_list_recursive",
      label: "Notes List Recursive",
      description: "List all files and subfolders within a folder recursively. Unlike notes_list which only shows one level, this shows the entire tree. Useful for auditing folder structure.",
      parameters: Type.Object({
        path: Type.String({ description: "Folder path to list recursively (e.g. 'Projects/' or '/')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await kbListRecursive(params.path);
          const count = JSON.parse(result).files?.length ?? 0;
          console.log(`[vault] notes_list_recursive OK: ${params.path} (${count} items)`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_list_recursive FAILED: ${params.path} \u2014 ${err.message}`);
          throw err;
        }
      }
    },
    {
      name: "notes_file_info",
      label: "Notes File Info",
      description: "Get metadata about a note or folder: file size, creation date, and last modified date. Use to identify stale or oversized notes.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the file or folder (e.g. 'Projects/Research.md')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const result = await kbFileInfo(params.path);
          console.log(`[vault] notes_file_info OK: ${params.path}`);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (err) {
          console.error(`[vault] notes_file_info FAILED: ${params.path} \u2014 ${err.message}`);
          throw err;
        }
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
    },
    {
      name: "email_get_attachment",
      label: "Email Attachment",
      description: "Download and read an email attachment. For PDFs, extracts text content automatically. Specify the email message ID and optionally a filename to target a specific attachment. Use email_read first to see what attachments exist.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID containing the attachment." }),
        attachmentId: Type.Optional(Type.String({ description: "Specific attachment ID (from email_read). If omitted, reads the first attachment." })),
        filename: Type.Optional(Type.String({ description: "Partial filename to match (e.g. 'invoice' to find 'invoice.pdf'). Used if attachmentId not provided." }))
      }),
      async execute(_toolCallId, params) {
        const result = await getAttachment(params.messageId, params.attachmentId, params.filename);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_send",
      label: "Send Email",
      description: "Send a new email. IMPORTANT: Always confirm with the user via interview form BEFORE calling this tool \u2014 show them the recipient, subject, and full body for review. Never auto-send.",
      parameters: Type.Object({
        to: Type.String({ description: "Recipient email address(es), comma-separated for multiple." }),
        subject: Type.String({ description: "Email subject line." }),
        body: Type.String({ description: "Email body text (plain text)." }),
        cc: Type.Optional(Type.String({ description: "CC recipients, comma-separated." })),
        bcc: Type.Optional(Type.String({ description: "BCC recipients, comma-separated." }))
      }),
      async execute(_toolCallId, params) {
        const result = await sendEmail(params.to, params.subject, params.body, params.cc, params.bcc);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_reply",
      label: "Reply to Email",
      description: "Reply to an existing email in-thread with proper threading headers. IMPORTANT: Always confirm with the user via interview form BEFORE calling this tool \u2014 show them the reply body for review. Never auto-send.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID to reply to." }),
        body: Type.String({ description: "Reply body text (plain text)." }),
        replyAll: Type.Optional(Type.Boolean({ description: "If true, reply to all recipients. Default: false (reply to sender only)." }))
      }),
      async execute(_toolCallId, params) {
        const result = await replyToEmail(params.messageId, params.body, params.replyAll ?? false);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_thread",
      label: "Email Thread",
      description: "Read an entire email conversation thread. Returns all messages in order. Get the threadId from email_list or email_read results.",
      parameters: Type.Object({
        threadId: Type.String({ description: "The Gmail thread ID." })
      }),
      async execute(_toolCallId, params) {
        const result = await getThread(params.threadId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_draft",
      label: "Save Email Draft",
      description: "Save a composed email as a Gmail draft without sending it. The draft will appear in Gmail's Drafts folder for later review and sending.",
      parameters: Type.Object({
        to: Type.String({ description: "Recipient email address(es)." }),
        subject: Type.String({ description: "Email subject line." }),
        body: Type.String({ description: "Email body text (plain text)." }),
        cc: Type.Optional(Type.String({ description: "CC recipients, comma-separated." })),
        bcc: Type.Optional(Type.String({ description: "BCC recipients, comma-separated." }))
      }),
      async execute(_toolCallId, params) {
        const result = await createDraft(params.to, params.subject, params.body, params.cc, params.bcc);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_archive",
      label: "Archive Email",
      description: "Archive an email (remove from inbox without deleting). The email remains searchable and in All Mail.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID to archive." })
      }),
      async execute(_toolCallId, params) {
        const result = await archiveEmail(params.messageId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_label",
      label: "Email Labels",
      description: "Add or remove Gmail labels on an email. Use system label IDs (STARRED, IMPORTANT, UNREAD, SPAM, TRASH, CATEGORY_PERSONAL, CATEGORY_SOCIAL, CATEGORY_PROMOTIONS, CATEGORY_UPDATES, CATEGORY_FORUMS) or custom label IDs from gmail_list_labels.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID." }),
        addLabels: Type.Optional(Type.Array(Type.String(), { description: "Label IDs to add." })),
        removeLabels: Type.Optional(Type.Array(Type.String(), { description: "Label IDs to remove." }))
      }),
      async execute(_toolCallId, params) {
        const result = await modifyLabels(params.messageId, params.addLabels, params.removeLabels);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_mark_read",
      label: "Mark Email Read/Unread",
      description: "Mark an email as read or unread.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID." }),
        read: Type.Boolean({ description: "true to mark as read, false to mark as unread." })
      }),
      async execute(_toolCallId, params) {
        const result = await markRead(params.messageId, params.read);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "email_trash",
      label: "Trash Email",
      description: "Move an email to the trash. It can be recovered from Trash within 30 days.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID to trash." })
      }),
      async execute(_toolCallId, params) {
        const result = await trashEmail(params.messageId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "gmail_list_labels",
      label: "List Gmail Labels",
      description: "List all Gmail labels (system and custom). Returns label names and IDs. Use before email_label to find the correct label ID, or before gmail_delete_label to find the ID of a label to remove.",
      parameters: Type.Object({}),
      async execute() {
        const result = await listLabels();
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "gmail_create_label",
      label: "Create Gmail Label",
      description: "Create a new custom Gmail label for inbox organization. Supports nested labels with '/' separator (e.g. 'Family/School'). The returned label ID can be used with email_label to tag emails.",
      parameters: Type.Object({
        name: Type.String({ description: "Label name (e.g. 'Travel', 'Family/School', 'Finance')." }),
        labelListVisibility: Type.Optional(Type.String({ description: "Visibility in label list: 'labelShow' (default), 'labelHide', or 'labelShowIfUnread'." })),
        messageListVisibility: Type.Optional(Type.String({ description: "Visibility in message list: 'show' (default) or 'hide'." })),
        backgroundColor: Type.Optional(Type.String({ description: "Background color hex (e.g. '#4986e7')." })),
        textColor: Type.Optional(Type.String({ description: "Text color hex (e.g. '#ffffff')." }))
      }),
      async execute(_toolCallId, params) {
        const result = await createLabel(params.name, {
          labelListVisibility: params.labelListVisibility,
          messageListVisibility: params.messageListVisibility,
          backgroundColor: params.backgroundColor,
          textColor: params.textColor
        });
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "gmail_delete_label",
      label: "Delete Gmail Label",
      description: "Delete a custom Gmail label by its ID. System labels cannot be deleted. Use gmail_list_labels first to find the label ID.",
      parameters: Type.Object({
        labelId: Type.String({ description: "The Gmail label ID to delete (from gmail_list_labels)." })
      }),
      async execute(_toolCallId, params) {
        const result = await deleteLabel(params.labelId);
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
function buildWebFetchTools() {
  return [
    {
      name: "web_fetch",
      label: "Web Fetch",
      description: "Fetch a web page and return its content as clean readable text. Use when you need to read the actual content of a URL \u2014 articles, documentation, blog posts, product pages, API docs, etc. Returns the page title, description, and full text content with HTML stripped. Handles HTML, JSON, and plain text responses. For searching the web (when you don't have a URL), use web_search instead.",
      parameters: Type.Object({
        url: Type.String({ description: "The full URL to fetch (must start with http:// or https://)" }),
        max_length: Type.Optional(Type.Number({ description: "Maximum content length in characters (default 80000). Use a smaller value like 20000 if you only need a summary or the beginning of a page." }))
      }),
      async execute(_toolCallId, params) {
        try {
          let url = params.url.trim();
          if (!url.match(/^https?:\/\//i)) url = "https://" + url;
          const result = await fetchPage(url, { maxLength: params.max_length });
          return {
            content: [{ type: "text", text: formatResult(result) }],
            details: { statusCode: result.statusCode, truncated: result.truncated }
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Failed to fetch "${params.url}": ${msg}` }],
            details: { error: msg }
          };
        }
      }
    }
  ];
}
function buildImageTools() {
  if (!ANTHROPIC_KEY) return [];
  return [
    {
      name: "describe_image",
      label: "Describe Image",
      description: "Fetch an image from a URL and describe its visual content using a vision model. Use when you need to 'see' an image, verify how a web page looks, check a chart/graph, or describe a photo. Supports JPEG, PNG, WebP, GIF. Returns a detailed text description of what the image contains.",
      parameters: Type.Object({
        url: Type.String({ description: "The URL of the image to describe (must be a direct image URL ending in .jpg, .png, .webp, .gif, or a URL that returns an image content type)" }),
        question: Type.Optional(Type.String({ description: "Optional specific question about the image, e.g. 'What text is visible?' or 'Are the appointments showing correctly?'" }))
      }),
      async execute(_toolCallId, params) {
        try {
          let url = params.url.trim();
          if (!url.match(/^https?:\/\//i)) url = "https://" + url;
          const imgRes = await fetch(url, {
            headers: { "User-Agent": "DarkNode/1.0" },
            signal: AbortSignal.timeout(15e3)
          });
          if (!imgRes.ok) return { content: [{ type: "text", text: `Failed to fetch image: HTTP ${imgRes.status}` }], details: { error: `HTTP ${imgRes.status}` } };
          const contentType = imgRes.headers.get("content-type") || "";
          const validTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
          const mediaType = validTypes.find((t) => contentType.includes(t.split("/")[1])) || "image/jpeg";
          const buffer = Buffer.from(await imgRes.arrayBuffer());
          if (buffer.length > 20 * 1024 * 1024) return { content: [{ type: "text", text: "Image too large (>20MB)" }], details: { error: "too_large" } };
          const base64 = buffer.toString("base64");
          const prompt = params.question ? `Describe this image in detail, then answer this specific question: ${params.question}` : "Describe this image in detail. Include all visible text, layout, colors, and any notable elements.";
          const { default: Anthropic5 } = await import("@anthropic-ai/sdk");
          const client = new Anthropic5({ apiKey: ANTHROPIC_KEY });
          const response = await client.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1500,
            messages: [{
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
                { type: "text", text: prompt }
              ]
            }]
          });
          const description = response.content.map((b) => b.type === "text" ? b.text : "").join("");
          return {
            content: [{ type: "text", text: `**Image Description** (${url})

${description}` }],
            details: { size: buffer.length, contentType: mediaType }
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Failed to describe image: ${msg}` }], details: { error: msg } };
        }
      }
    }
  ];
}
function buildRenderPageTools() {
  const lightpandaBin = path4.join(PROJECT_ROOT, ".bin/lightpanda");
  if (!fs3.existsSync(lightpandaBin)) return [];
  return [
    {
      name: "render_page",
      label: "Render Page",
      description: "Render a web page in a headless browser and return the fully rendered content as markdown. Unlike web_fetch which returns raw HTML, this tool executes JavaScript and returns the page as a human would see it \u2014 with all dynamic content loaded, counters populated, and JS-rendered elements visible. Perfect for verifying rickin.live pages, checking the baby dashboard, or reading any JS-heavy page. For rickin.live pages, include auth: ?user=darknode&token=dn@rickin26",
      parameters: Type.Object({
        url: Type.String({ description: "The full URL to render (must start with http:// or https://)" }),
        format: Type.Optional(Type.String({ description: "Output format: 'markdown' (default, clean readable text) or 'html' (full rendered HTML)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          let url = params.url.trim();
          if (!url.match(/^https?:\/\//i)) url = "https://" + url;
          const fmt = params.format === "html" ? "html" : "markdown";
          const { execFile: execFile2 } = await import("child_process");
          const result = await new Promise((resolve, reject) => {
            execFile2(lightpandaBin, ["fetch", "--dump", fmt, "--http_timeout", "15000", url], { timeout: 2e4, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
              if (err) reject(new Error(stderr || err.message));
              else resolve(stdout);
            });
          });
          const truncated = result.length > 8e4;
          const content = truncated ? result.slice(0, 8e4) + "\n\n[TRUNCATED \u2014 content too long]" : result;
          return {
            content: [{ type: "text", text: `**Rendered Page** (${fmt}) \u2014 ${url}

${content}` }],
            details: { format: fmt, length: result.length, truncated }
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Failed to render page: ${msg}` }], details: { error: msg } };
        }
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
      description: `Create a new calendar event. Can target a specific calendar by name (e.g. 'Reya' to match "Reya's Schedule"). Use calendar_list_available to see available calendars.`,
      parameters: Type.Object({
        summary: Type.String({ description: "Event title" }),
        startTime: Type.String({ description: "Start time in ISO 8601 format (e.g. '2025-03-15T14:00:00')" }),
        endTime: Type.Optional(Type.String({ description: "End time in ISO 8601 format (defaults to 1 hour after start)" })),
        description: Type.Optional(Type.String({ description: "Event description" })),
        location: Type.Optional(Type.String({ description: "Event location" })),
        allDay: Type.Optional(Type.Boolean({ description: "Whether this is an all-day event" })),
        calendarName: Type.Optional(Type.String({ description: "Target calendar name to fuzzy-match (e.g. 'Reya', 'Pooja'). Defaults to primary calendar if omitted." }))
      }),
      async execute(_toolCallId, params) {
        const { summary, ...options } = params;
        const result = await createEvent(summary, options);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "calendar_list_available",
      label: "List Calendars",
      description: "List all available Google calendars with their names and access levels. Use this to find the correct calendar name for calendar_create.",
      parameters: Type.Object({}),
      async execute() {
        const cals = await listCalendars();
        if (cals.length === 0) return { content: [{ type: "text", text: "No calendars found or not connected." }], details: {} };
        const lines = cals.map((c, i) => `${i + 1}. ${c.name} (${c.accessRole})${c.id === "primary" ? " [PRIMARY]" : ""}`);
        return { content: [{ type: "text", text: `Available calendars (${cals.length}):

${lines.join("\n")}` }], details: {} };
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
        const result = await addTask(title, options);
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
        const result = await listTasks(params);
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
        const result = await completeTask(params.taskId);
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
        const result = await deleteTask(params.taskId);
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
        const result = await updateTask(taskId, updates);
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
      description: "Read recent tweets/posts from an X (Twitter) user's timeline. Returns their latest public posts with engagement stats and view counts.",
      parameters: Type.Object({
        username: Type.String({ description: "X username (e.g. 'elonmusk') or profile URL" }),
        count: Type.Optional(Type.Number({ description: "Number of tweets to fetch (default 10, max 20)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await getUserTimeline(params.username, params.count ?? 10);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "x_search",
      label: "X Search",
      description: "Search X (Twitter) for tweets matching a query. Returns matching posts with engagement stats and view counts. Useful for finding mentions, discussions, news, and sentiment on any topic.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query \u2014 supports keywords, phrases, @mentions, #hashtags, from:user, to:user, etc." }),
        count: Type.Optional(Type.Number({ description: "Number of results to return (default 10, max 20)" })),
        type: Type.Optional(Type.String({ description: "Search type: 'Latest' (most recent) or 'Top' (most popular). Default: 'Latest'" }))
      }),
      async execute(_toolCallId, params) {
        const searchType = params.type === "Top" ? "Top" : "Latest";
        const result = await searchTweets(params.query, params.count ?? 10, searchType);
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
var RAPIDAPI_KEY2 = process.env.RAPIDAPI_KEY || "";
var ZILLOW_API_HOST = "private-zillow.p.rapidapi.com";
function buildZillowLocationSlug(location) {
  return location.toLowerCase().replace(/[,]+/g, "").replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
function buildZillowSearchUrl(location, filters) {
  const slug = buildZillowLocationSlug(location);
  const filterState = {
    tow: { value: false },
    mf: { value: false },
    con: { value: false },
    land: { value: false },
    apa: { value: false },
    manu: { value: false },
    apco: { value: false }
  };
  if (filters?.minPrice || filters?.maxPrice) {
    filterState.price = {};
    if (filters.minPrice) filterState.price.min = filters.minPrice;
    if (filters.maxPrice) filterState.price.max = filters.maxPrice;
  }
  if (filters?.minBeds) filterState.beds = { min: filters.minBeds };
  if (filters?.minBaths) filterState.baths = { min: filters.minBaths };
  if (filters?.sort) filterState.sort = { value: filters.sort === "Newest" ? "days" : filters.sort };
  const searchQueryState = { filterState };
  if (filters?.page && filters.page > 1) {
    searchQueryState.pagination = { currentPage: filters.page };
  }
  const qs = encodeURIComponent(JSON.stringify(searchQueryState));
  return `https://www.zillow.com/${slug}/?searchQueryState=${qs}`;
}
function normalizeZillowUrl(url) {
  if (!url) return null;
  if (url.startsWith("http")) return url;
  return `https://www.zillow.com${url.startsWith("/") ? "" : "/"}${url}`;
}
function getZillowResults(data) {
  return data?.Results || data?.results || [];
}
function getZillowTotalResults(data, fallbackCount) {
  return data?.total_results || data?.totalResultCount || fallbackCount;
}
async function fetchZillow(endpoint, params) {
  const url = `https://${ZILLOW_API_HOST}/${endpoint}?${new URLSearchParams(params)}`;
  let resp = await fetch(url, {
    headers: { "X-RapidAPI-Key": RAPIDAPI_KEY2, "X-RapidAPI-Host": ZILLOW_API_HOST }
  });
  if (resp.status === 429) {
    await new Promise((r) => setTimeout(r, 1500));
    resp = await fetch(url, {
      headers: { "X-RapidAPI-Key": RAPIDAPI_KEY2, "X-RapidAPI-Host": ZILLOW_API_HOST }
    });
  }
  if (!resp.ok) throw new Error(`Zillow API error: ${resp.status} ${resp.statusText}`);
  return resp.json();
}
function buildRealEstateTools() {
  if (!RAPIDAPI_KEY2) return [];
  return [
    {
      name: "property_search",
      label: "Property Search",
      description: "Search Zillow for property listings by location with filters. Returns structured listing data including address, price, beds, baths, sqft, and listing URLs.",
      parameters: Type.Object({
        location: Type.String({ description: "Location to search \u2014 city and state, zip code, or neighborhood (e.g. 'Montclair, NJ', '07042', 'Garden City, NY')" }),
        minPrice: Type.Optional(Type.Number({ description: "Minimum price filter (e.g. 1500000)" })),
        maxPrice: Type.Optional(Type.Number({ description: "Maximum price filter (e.g. 2000000)" })),
        minBeds: Type.Optional(Type.Number({ description: "Minimum bedrooms (e.g. 5)" })),
        minBaths: Type.Optional(Type.Number({ description: "Minimum bathrooms (e.g. 3)" })),
        sort: Type.Optional(Type.String({ description: "Sort order: 'Newest', 'Price_High_Low', 'Price_Low_High', 'Bedrooms', 'Bathrooms'" })),
        page: Type.Optional(Type.Number({ description: "Page number for pagination (default 1)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const zillowUrl = buildZillowSearchUrl(params.location, {
            minPrice: params.minPrice,
            maxPrice: params.maxPrice,
            minBeds: params.minBeds,
            minBaths: params.minBaths,
            sort: params.sort,
            page: params.page
          });
          const data = await fetchZillow("search/byurl", { url: zillowUrl });
          const props = getZillowResults(data);
          if (props.length === 0) return { content: [{ type: "text", text: `No properties found in ${params.location} matching criteria. Try broadening filters or checking the location name.` }], details: {} };
          const summary = props.slice(0, 20).map((p) => {
            const info = p.hdpData?.homeInfo || {};
            return {
              address: p.address,
              price: p.unformattedPrice ? `$${p.unformattedPrice.toLocaleString()}` : p.price || "N/A",
              beds: p.beds ?? info.bedrooms,
              baths: p.baths ?? info.bathrooms,
              sqft: info.livingArea || p.area,
              lotSize: info.lotAreaValue ? `${info.lotAreaValue} ${info.lotAreaUnit || "sqft"}` : "N/A",
              zpid: p.zpid,
              daysOnZillow: info.daysOnZillow ?? p.variableData?.text,
              listingUrl: normalizeZillowUrl(p.detailUrl),
              propertyType: info.homeType || p.statusType,
              listingStatus: p.statusText || info.homeStatus
            };
          });
          return { content: [{ type: "text", text: JSON.stringify({ totalResults: getZillowTotalResults(data, props.length), resultsReturned: summary.length, properties: summary }, null, 2) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Property search failed: ${err.message}` }], details: {} };
        }
      }
    },
    {
      name: "property_details",
      label: "Property Details",
      description: "Get detailed information about a specific property from Zillow. Provide the zpid and the city/state location from property_search results. Returns price, beds, baths, sqft, zestimate, open house info, and listing details.",
      parameters: Type.Object({
        zpid: Type.Number({ description: "Zillow property ID (from property_search results)" }),
        location: Type.String({ description: "City and state where the property is located (e.g. 'Montclair, NJ') \u2014 needed to search the area and find the property" }),
        address: Type.Optional(Type.String({ description: "Full property address for display (e.g. '10 Mountain Ter, Montclair, NJ 07043')" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const zillowUrl = buildZillowSearchUrl(params.location);
          const data = await fetchZillow("search/byurl", { url: zillowUrl });
          const allResults = getZillowResults(data);
          const match = allResults.find((r) => String(r.zpid) === String(params.zpid));
          if (!match) {
            return { content: [{ type: "text", text: `Property zpid ${params.zpid} not found in ${params.location} listings (searched ${allResults.length} results). The listing may have been removed or the location may not match. Try property_search to find current listings.` }], details: {} };
          }
          const info = match.hdpData?.homeInfo || {};
          const details = {
            address: match.address || info.streetAddress,
            price: match.unformattedPrice ? `$${match.unformattedPrice.toLocaleString()}` : match.price || "N/A",
            beds: match.beds ?? info.bedrooms,
            baths: match.baths ?? info.bathrooms,
            sqft: info.livingArea || match.area,
            lotSize: info.lotAreaValue ? `${info.lotAreaValue} ${info.lotAreaUnit || "sqft"}` : "N/A",
            propertyType: info.homeType,
            daysOnZillow: info.daysOnZillow,
            listingUrl: normalizeZillowUrl(match.detailUrl) || `https://www.zillow.com/homedetails/${params.zpid}_zpid/`,
            zestimate: info.zestimate ? `$${info.zestimate.toLocaleString()}` : "N/A",
            rentZestimate: info.rentZestimate ? `$${info.rentZestimate.toLocaleString()}/mo` : "N/A",
            homeStatus: info.homeStatus || match.statusText,
            listingStatus: match.statusText
          };
          if (info.openHouse || match.flexFieldText) {
            details.openHouse = info.openHouse || match.flexFieldText;
          }
          if (info.open_house_info?.open_house_showing?.length > 0) {
            details.openHouseShowings = info.open_house_info.open_house_showing.map((s) => ({
              start: new Date(s.open_house_start).toLocaleString("en-US", { timeZone: "America/New_York" }),
              end: new Date(s.open_house_end).toLocaleString("en-US", { timeZone: "America/New_York" })
            }));
          }
          if (info.listing_sub_type) {
            details.listingSubType = info.listing_sub_type;
          }
          details.note = "For school ratings, walkability, price history, and tax details, use web_search with the Zillow listing URL or the property address.";
          return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Property details failed: ${err.message}` }], details: {} };
        }
      }
    },
    {
      name: "neighborhood_search",
      label: "Neighborhood Search",
      description: "Search for neighborhood information including demographics, school ratings, and nearby amenities for a given location. Useful for evaluating walkability, schools, and community character.",
      parameters: Type.Object({
        location: Type.String({ description: "Location to research \u2014 city and state or zip code (e.g. 'Montclair, NJ', '07042')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const zillowUrl = buildZillowSearchUrl(params.location);
          const data = await fetchZillow("search/byurl", { url: zillowUrl });
          const props = getZillowResults(data);
          const result = {
            location: params.location,
            totalListings: getZillowTotalResults(data, props.length),
            medianPrice: null
          };
          if (props.length > 0) {
            const prices = props.filter((p) => p.unformattedPrice).map((p) => p.unformattedPrice).sort((a, b) => a - b);
            if (prices.length > 0) result.medianPrice = `$${prices[Math.floor(prices.length / 2)].toLocaleString()}`;
            const sqftPrices = props.filter((p) => p.hdpData?.homeInfo?.livingArea && p.unformattedPrice).map((p) => p.unformattedPrice / p.hdpData.homeInfo.livingArea);
            if (sqftPrices.length > 0) result.avgPricePerSqft = `$${Math.round(sqftPrices.reduce((a, b) => a + b, 0) / sqftPrices.length)}`;
          }
          result.note = "Use web_search for detailed school ratings (GreatSchools), walkability scores, and neighborhood character. Use property_details with a specific zpid for school data near a property.";
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Neighborhood search failed: ${err.message}` }], details: {} };
        }
      }
    },
    {
      name: "redfin_search",
      label: "Redfin Property Search",
      description: "Search Redfin for property listings using a Redfin search URL with filters. Use properties/auto-complete first to get the correct region URL, then build a full search URL. Returns listings with address, price, beds, baths, sqft, listing remarks, key facts, and days on market.",
      parameters: Type.Object({
        url: Type.String({ description: "Full Redfin search URL with filters, e.g. 'https://www.redfin.com/city/35939/NJ/Montclair/filter/min-price=1.5M,max-price=2M,min-beds=5,min-baths=3'. Build from auto-complete results: /city/{id}/{state}/{city}/filter/min-price=X,max-price=X,min-beds=X,min-baths=X" })
      }),
      async execute(_toolCallId, params) {
        try {
          const resp = await fetch(`https://redfin-com-data.p.rapidapi.com/property/search-url?url=${encodeURIComponent(params.url)}`, {
            headers: { "X-RapidAPI-Key": RAPIDAPI_KEY2, "X-RapidAPI-Host": "redfin-com-data.p.rapidapi.com" }
          });
          if (!resp.ok) return { content: [{ type: "text", text: `Redfin API error: ${resp.status} ${resp.statusText}` }], details: {} };
          const data = await resp.json();
          const homes = data?.data?.nearbyHomes?.homes || data?.data?.homes || [];
          if (homes.length === 0) return { content: [{ type: "text", text: `No Redfin listings found for this search. Try broadening filters or checking the URL.` }], details: {} };
          const summary = homes.slice(0, 20).map((h) => ({
            address: `${h.streetLine?.value || ""}, ${h.city || ""}, ${h.state || ""} ${h.zip || ""}`.trim(),
            price: h.price?.value ? `$${h.price.value.toLocaleString()}` : "N/A",
            beds: h.beds,
            baths: h.baths,
            sqft: h.sqFt?.value || null,
            lotSize: h.lotSize?.value ? `${h.lotSize.value.toLocaleString()} sqft` : null,
            daysOnMarket: h.dom?.value ?? null,
            listingId: h.listingId,
            redfinUrl: h.url ? `https://www.redfin.com${h.url}` : null,
            mlsId: h.mlsId?.value || null,
            mlsStatus: h.mlsStatus,
            propertyType: h.propertyType,
            listingRemarks: h.listingRemarks ? h.listingRemarks.substring(0, 300) : null,
            keyFacts: h.keyFacts?.map((f) => f.description) || [],
            listingTags: h.listingTags || [],
            broker: h.listingBroker?.name || null,
            lat: h.latLong?.value?.latitude,
            lng: h.latLong?.value?.longitude
          }));
          return { content: [{ type: "text", text: JSON.stringify({ source: "Redfin", totalResults: homes.length, resultsReturned: summary.length, properties: summary }, null, 2) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Redfin search failed: ${err.message}` }], details: {} };
        }
      }
    },
    {
      name: "redfin_details",
      label: "Redfin Property Details",
      description: "Get detailed Redfin property information including photos, room descriptions, features, and market data. Use the property URL from redfin_search results (e.g. '/NJ/Glen-Ridge/210-Baldwin-St-07028/home/36166097').",
      parameters: Type.Object({
        url: Type.String({ description: "Redfin property URL path from search results (e.g. '/NJ/Glen-Ridge/210-Baldwin-St-07028/home/36166097')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const resp = await fetch(`https://redfin-com-data.p.rapidapi.com/property/detail?url=${encodeURIComponent(params.url)}`, {
            headers: { "X-RapidAPI-Key": RAPIDAPI_KEY2, "X-RapidAPI-Host": "redfin-com-data.p.rapidapi.com" }
          });
          if (!resp.ok) return { content: [{ type: "text", text: `Redfin API error: ${resp.status} ${resp.statusText}` }], details: {} };
          const data = await resp.json();
          if (!data?.data) return { content: [{ type: "text", text: `No details found for this property URL. Ensure the URL is a property path like '/NJ/City/123-Main-St-07028/home/12345678'.` }], details: {} };
          const d = data.data;
          const numericKey = Object.keys(d).find((k) => /^\d+$/.test(k));
          const photoSection = numericKey ? d[numericKey] : null;
          const tagsByPhoto = photoSection && typeof photoSection === "object" && photoSection.tagsByPhotoId ? photoSection.tagsByPhotoId : {};
          const photoSummary = Object.values(tagsByPhoto).slice(0, 10).map((p) => ({
            caption: p.shortCaption || p.longCaption || "",
            tags: p.tags || [],
            url: p.photoUrl || ""
          }));
          const affordability = d.affordability || {};
          const result = {
            source: "Redfin",
            propertyUrl: params.url,
            listingId: photoSection?.listingId || null,
            photoCount: photoSection?.includedFilterTags?.All || Object.keys(tagsByPhoto).length || 0,
            photos: photoSummary.length > 0 ? photoSummary : "No photos available"
          };
          if (affordability.bedroomAggregates) {
            result.marketData = {
              activeListingTrend: affordability.activeListingYearlyTrend != null ? `${affordability.activeListingYearlyTrend.toFixed(1)}%` : null,
              bedroomBreakdown: (affordability.bedroomAggregates || []).filter((b) => b.aggregate?.listPriceMedian).map((b) => ({
                beds: b.aggregationType,
                medianPrice: `$${b.aggregate.listPriceMedian.toLocaleString()}`,
                activeListings: b.aggregate.activeListingsCount
              }))
            };
          }
          const knownKeys = Object.keys(d).filter((k) => k !== numericKey && k !== "affordability");
          if (knownKeys.length > 0) {
            result.additionalSections = knownKeys;
          }
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Redfin details failed: ${err.message}` }], details: {} };
        }
      }
    },
    {
      name: "redfin_autocomplete",
      label: "Redfin Location Lookup",
      description: "Look up a location on Redfin to get the correct region ID and URL path for use with redfin_search. Returns matching cities, neighborhoods, and schools.",
      parameters: Type.Object({
        query: Type.String({ description: "Location to look up (e.g. 'Montclair, NJ', 'Upper Saddle River', 'Princeton NJ')" })
      }),
      async execute(_toolCallId, params) {
        try {
          const resp = await fetch(`https://redfin-com-data.p.rapidapi.com/properties/auto-complete?query=${encodeURIComponent(params.query)}`, {
            headers: { "X-RapidAPI-Key": RAPIDAPI_KEY2, "X-RapidAPI-Host": "redfin-com-data.p.rapidapi.com" }
          });
          if (!resp.ok) return { content: [{ type: "text", text: `Redfin API error: ${resp.status} ${resp.statusText}` }], details: {} };
          const data = await resp.json();
          const rows = data?.data?.flatMap((section) => section.rows || []) || [];
          if (rows.length === 0) return { content: [{ type: "text", text: `No Redfin locations found for "${params.query}". Try a different spelling.` }], details: {} };
          const results = rows.slice(0, 10).map((r) => ({
            name: r.name,
            subName: r.subName,
            url: r.url,
            id: r.id,
            type: r.type
          }));
          return { content: [{ type: "text", text: JSON.stringify({ source: "Redfin", note: "Use the 'url' field to build redfin_search URLs: https://www.redfin.com{url}/filter/min-price=X,max-price=X,min-beds=X,min-baths=X", locations: results }, null, 2) }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Redfin autocomplete failed: ${err.message}` }], details: {} };
        }
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
        entry.pendingInterviewForm = {
          toolCallId,
          title: params.title,
          description: params.description,
          questions: params.questions
        };
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
              entry.pendingInterviewForm = void 0;
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
function buildDriveTools() {
  return [
    {
      name: "drive_list",
      label: "Google Drive List",
      description: `List or search files in Google Drive. Use query parameter for Drive search syntax (e.g. "name contains 'report'", "mimeType='application/vnd.google-apps.folder'", "'FOLDER_ID' in parents"). Without query, returns most recently modified files.`,
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Google Drive search query (Drive API q parameter syntax)" })),
        maxResults: Type.Optional(Type.Number({ description: "Max files to return (default 20)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await driveList(params.query, params.maxResults || 20);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "drive_get",
      label: "Google Drive Get",
      description: "Get detailed metadata for a specific file or folder in Google Drive by its ID.",
      parameters: Type.Object({
        fileId: Type.String({ description: "The Google Drive file ID" })
      }),
      async execute(_toolCallId, params) {
        const result = await driveGet(params.fileId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "drive_create_folder",
      label: "Google Drive Create Folder",
      description: "Create a new folder in Google Drive. Optionally specify a parent folder ID to create it inside an existing folder.",
      parameters: Type.Object({
        name: Type.String({ description: "Name for the new folder" }),
        parentId: Type.Optional(Type.String({ description: "Parent folder ID (creates at root if omitted)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await driveCreateFolder(params.name, params.parentId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "drive_move",
      label: "Google Drive Move",
      description: "Move a file or folder to a different folder in Google Drive.",
      parameters: Type.Object({
        fileId: Type.String({ description: "ID of the file/folder to move" }),
        newParentId: Type.String({ description: "ID of the destination folder" })
      }),
      async execute(_toolCallId, params) {
        const result = await driveMove(params.fileId, params.newParentId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "drive_rename",
      label: "Google Drive Rename",
      description: "Rename a file or folder in Google Drive.",
      parameters: Type.Object({
        fileId: Type.String({ description: "ID of the file/folder to rename" }),
        newName: Type.String({ description: "New name for the file/folder" })
      }),
      async execute(_toolCallId, params) {
        const result = await driveRename(params.fileId, params.newName);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "drive_delete",
      label: "Google Drive Delete",
      description: "Move a file or folder to trash in Google Drive. This does not permanently delete \u2014 it can be recovered from trash.",
      parameters: Type.Object({
        fileId: Type.String({ description: "ID of the file/folder to trash" })
      }),
      async execute(_toolCallId, params) {
        const result = await driveDelete(params.fileId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildSheetsTools() {
  return [
    {
      name: "sheets_list",
      label: "Google Sheets List",
      description: "List all Google Sheets spreadsheets in Drive.",
      parameters: Type.Object({}),
      async execute() {
        const result = await sheetsList();
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_read",
      label: "Google Sheets Read",
      description: "Read data from a Google Sheets spreadsheet. Specify a range like 'Sheet1!A1:D10' or just 'Sheet1' for the whole sheet.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID (from the URL or drive_list)" }),
        range: Type.String({ description: "Cell range to read, e.g. 'Sheet1!A1:D10' or 'Sheet1'" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsRead(params.spreadsheetId, params.range);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_append",
      label: "Google Sheets Append",
      description: "Append one or more rows to a Google Sheets spreadsheet. Each row is an array of cell values.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        values: Type.Array(Type.Array(Type.String()), { description: 'Array of rows, each row is an array of cell values. Example: [["Name", "Age"], ["Alice", "30"]]' })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsAppend(params.spreadsheetId, params.values);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_update",
      label: "Google Sheets Update",
      description: "Update specific cells in a Google Sheets spreadsheet. Specify the range and new values.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        range: Type.String({ description: "Cell range to update, e.g. 'Sheet1!A1:B2'" }),
        values: Type.Array(Type.Array(Type.String()), { description: "Array of rows with new values" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsUpdate(params.spreadsheetId, params.range, params.values);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_create",
      label: "Google Sheets Create",
      description: "Create a new Google Sheets spreadsheet.",
      parameters: Type.Object({
        title: Type.String({ description: "Title for the new spreadsheet" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsCreate(params.title);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_add_sheet",
      label: "Google Sheets Add Sheet",
      description: "Add a new sheet (tab) to an existing Google Sheets spreadsheet.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        title: Type.String({ description: "Title for the new sheet tab" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsAddSheet(params.spreadsheetId, params.title);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_delete_sheet",
      label: "Google Sheets Delete Sheet",
      description: "Delete a sheet (tab) from a Google Sheets spreadsheet by its numeric sheet ID.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID to delete (from sheets_read or sheets_add_sheet)" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsDeleteSheet(params.spreadsheetId, params.sheetId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_clear",
      label: "Google Sheets Clear",
      description: "Clear all values from a specified range in a Google Sheets spreadsheet without removing formatting.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        range: Type.String({ description: "Cell range to clear, e.g. 'Sheet1!A1:D10'" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsClear(params.spreadsheetId, params.range);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_format_cells",
      label: "Google Sheets Format",
      description: "Format cells in a Google Sheets spreadsheet. Set bold, background color, text color, and font size for a range of cells.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID (0 for the first sheet)" }),
        startRow: Type.Number({ description: "Start row index (0-based)" }),
        endRow: Type.Number({ description: "End row index (exclusive, 0-based)" }),
        startCol: Type.Number({ description: "Start column index (0-based)" }),
        endCol: Type.Number({ description: "End column index (exclusive, 0-based)" }),
        bold: Type.Optional(Type.Boolean({ description: "Whether to bold the text" })),
        bgColor: Type.Optional(Type.Object({ red: Type.Optional(Type.Number()), green: Type.Optional(Type.Number()), blue: Type.Optional(Type.Number()) }, { description: "Background color as RGB values 0-1" })),
        textColor: Type.Optional(Type.Object({ red: Type.Optional(Type.Number()), green: Type.Optional(Type.Number()), blue: Type.Optional(Type.Number()) }, { description: "Text color as RGB values 0-1" })),
        fontSize: Type.Optional(Type.Number({ description: "Font size in points" }))
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsFormatCells(params.spreadsheetId, params.sheetId, params.startRow, params.endRow, params.startCol, params.endCol, params.bold, params.bgColor, params.textColor, params.fontSize);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_auto_resize",
      label: "Google Sheets Auto Resize",
      description: "Auto-resize columns in a Google Sheets spreadsheet to fit their content.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID (0 for the first sheet)" }),
        startCol: Type.Optional(Type.Number({ description: "Start column index (0-based, optional)" })),
        endCol: Type.Optional(Type.Number({ description: "End column index (exclusive, 0-based, optional)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsAutoResize(params.spreadsheetId, params.sheetId, params.startCol, params.endCol);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_merge_cells",
      label: "Google Sheets Merge",
      description: "Merge a range of cells in a Google Sheets spreadsheet.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID (0 for the first sheet)" }),
        startRow: Type.Number({ description: "Start row index (0-based)" }),
        endRow: Type.Number({ description: "End row index (exclusive, 0-based)" }),
        startCol: Type.Number({ description: "Start column index (0-based)" }),
        endCol: Type.Number({ description: "End column index (exclusive, 0-based)" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsMergeCells(params.spreadsheetId, params.sheetId, params.startRow, params.endRow, params.startCol, params.endCol);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_batch_update",
      label: "Google Sheets Batch Update",
      description: "Execute a raw batchUpdate on a Google Sheets spreadsheet. Accepts an array of Sheets API request objects for complex multi-step operations.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        requests: Type.Array(Type.Any(), { description: "Array of Sheets API request objects (e.g. addSheet, mergeCells, updateBorders, etc.)" })
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsBatchUpdate(params.spreadsheetId, params.requests);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "sheets_sort",
      label: "Google Sheets Sort",
      description: "Sort a sheet by a specific column.",
      parameters: Type.Object({
        spreadsheetId: Type.String({ description: "The spreadsheet ID" }),
        sheetId: Type.Number({ description: "The numeric sheet ID (0 for the first sheet)" }),
        sortCol: Type.Number({ description: "Column index to sort by (0-based)" }),
        ascending: Type.Optional(Type.Boolean({ description: "Sort ascending (default true). Set false for descending." }))
      }),
      async execute(_toolCallId, params) {
        const result = await sheetsSort(params.spreadsheetId, params.sheetId, params.sortCol, params.ascending);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildDocsTools() {
  return [
    {
      name: "docs_list",
      label: "Google Docs List",
      description: "List all Google Docs documents in Drive. Returns most recently modified documents.",
      parameters: Type.Object({}),
      async execute() {
        const result = await docsList();
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_get",
      label: "Google Docs Read",
      description: "Read the full content of a Google Doc by its document ID. Returns the title and extracted text content.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID (from the URL or drive_list)" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsGet(params.documentId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_create",
      label: "Google Docs Create",
      description: "Create a new blank Google Doc with the given title.",
      parameters: Type.Object({
        title: Type.String({ description: "Title for the new document" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsCreate(params.title);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_append",
      label: "Google Docs Append",
      description: "Append text to the end of an existing Google Doc. For rich formatting, this uses plain text insertion.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        text: Type.String({ description: "Text to append to the document" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsAppend(params.documentId, params.text);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_insert_text",
      label: "Google Docs Insert Text",
      description: "Insert text at a specific position in a Google Doc. If no index is provided, inserts at the end of the document.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        text: Type.String({ description: "Text to insert" }),
        index: Type.Optional(Type.Number({ description: "Character index to insert at (1-based). Omit to insert at end." }))
      }),
      async execute(_toolCallId, params) {
        const result = await docsInsertText(params.documentId, params.text, params.index);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_delete_content",
      label: "Google Docs Delete Content",
      description: "Delete a range of content from a Google Doc by start and end character index.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        startIndex: Type.Number({ description: "Start character index (1-based, inclusive)" }),
        endIndex: Type.Number({ description: "End character index (exclusive)" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsDeleteContent(params.documentId, params.startIndex, params.endIndex);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_insert_table",
      label: "Google Docs Insert Table",
      description: "Insert an empty table at the end of a Google Doc.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        rows: Type.Number({ description: "Number of rows" }),
        cols: Type.Number({ description: "Number of columns" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsInsertTable(params.documentId, params.rows, params.cols);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_format_text",
      label: "Google Docs Format Text",
      description: "Apply formatting (bold, italic, font size, color) to a range of text in a Google Doc.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        startIndex: Type.Number({ description: "Start character index (1-based, inclusive)" }),
        endIndex: Type.Number({ description: "End character index (exclusive)" }),
        bold: Type.Optional(Type.Boolean({ description: "Set text bold" })),
        italic: Type.Optional(Type.Boolean({ description: "Set text italic" })),
        fontSize: Type.Optional(Type.Number({ description: "Font size in points (e.g. 12, 18, 24)" })),
        foregroundColor: Type.Optional(Type.String({ description: "Text color as hex string (e.g. '#FF0000' for red)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await docsFormatText(params.documentId, params.startIndex, params.endIndex, params.bold, params.italic, params.fontSize, params.foregroundColor);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_insert_image",
      label: "Google Docs Insert Image",
      description: "Insert an inline image into a Google Doc from a URL.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        imageUri: Type.String({ description: "Public URL of the image to insert" }),
        index: Type.Optional(Type.Number({ description: "Character index to insert at. Omit to insert at end." }))
      }),
      async execute(_toolCallId, params) {
        const result = await docsInsertImage(params.documentId, params.imageUri, params.index);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_replace_text",
      label: "Google Docs Replace Text",
      description: "Find and replace all occurrences of a text string in a Google Doc.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        findText: Type.String({ description: "Text to find" }),
        replaceText: Type.String({ description: "Replacement text" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsReplaceText(params.documentId, params.findText, params.replaceText);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_insert_heading",
      label: "Google Docs Insert Heading",
      description: "Insert a heading (H1\u2013H6) at the end of a Google Doc.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        text: Type.String({ description: "Heading text" }),
        level: Type.Number({ description: "Heading level 1\u20136 (1 = largest)" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsInsertHeading(params.documentId, params.text, params.level);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "docs_batch_update",
      label: "Google Docs Batch Update",
      description: "Send a raw batchUpdate request to the Google Docs API. Use for complex multi-step document operations not covered by other tools.",
      parameters: Type.Object({
        documentId: Type.String({ description: "The Google Doc document ID" }),
        requests: Type.Array(Type.Any(), { description: "Array of Google Docs API request objects (e.g. insertText, updateTextStyle, etc.)" })
      }),
      async execute(_toolCallId, params) {
        const result = await docsBatchUpdate(params.documentId, params.requests);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildSlidesTools() {
  return [
    {
      name: "slides_list",
      label: "Google Slides List",
      description: "List all Google Slides presentations in Drive. Returns most recently modified presentations.",
      parameters: Type.Object({}),
      async execute() {
        const result = await slidesList();
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_get",
      label: "Google Slides Read",
      description: "Read the content of a Google Slides presentation by ID. Returns slide count, page size, and text content from each slide.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID (from the URL or drive_list)" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesGet(params.presentationId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_create",
      label: "Google Slides Create",
      description: "Create a new blank Google Slides presentation with the given title.",
      parameters: Type.Object({
        title: Type.String({ description: "Title for the new presentation" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesCreate(params.title);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_append",
      label: "Google Slides Add Slide",
      description: "Add a new slide with a title and body text to an existing Google Slides presentation. The slide uses a Title and Body layout.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID (from the URL or drive_list)" }),
        title: Type.String({ description: "Title text for the new slide" }),
        body: Type.String({ description: "Body text content for the new slide" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesAppend(params.presentationId, params.title, params.body);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_insert_table",
      label: "Google Slides Insert Table",
      description: "Insert a table on a slide. Optionally populate cells with data.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The slide object ID to insert the table on" }),
        rows: Type.Number({ description: "Number of rows" }),
        cols: Type.Number({ description: "Number of columns" }),
        data: Type.Optional(Type.Array(Type.Array(Type.String()), { description: '2D array of cell values, e.g. [["Header1","Header2"],["A","B"]]' }))
      }),
      async execute(_toolCallId, params) {
        const result = await slidesInsertTable(params.presentationId, params.slideObjectId, params.rows, params.cols, params.data);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_insert_image",
      label: "Google Slides Insert Image",
      description: "Insert an image on a slide from a public URL.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The slide object ID to insert the image on" }),
        imageUrl: Type.String({ description: "Public URL of the image to insert" }),
        width: Type.Optional(Type.Number({ description: "Image width in EMU (default 3000000). 914400 EMU = 1 inch." })),
        height: Type.Optional(Type.Number({ description: "Image height in EMU (default 3000000)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await slidesInsertImage(params.presentationId, params.slideObjectId, params.imageUrl, params.width, params.height);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_insert_shape",
      label: "Google Slides Insert Shape",
      description: "Insert a shape (rectangle, ellipse, etc.) with optional text on a slide. Positions and sizes are in EMU (914400 EMU = 1 inch).",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The slide object ID" }),
        shapeType: Type.String({ description: "Shape type: TEXT_BOX, RECTANGLE, ROUND_RECTANGLE, ELLIPSE, TRIANGLE, ARROW_NORTH, ARROW_EAST, STAR_5, etc." }),
        text: Type.Optional(Type.String({ description: "Text to insert inside the shape" })),
        left: Type.Number({ description: "Left position in EMU" }),
        top: Type.Number({ description: "Top position in EMU" }),
        width: Type.Number({ description: "Shape width in EMU" }),
        height: Type.Number({ description: "Shape height in EMU" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesInsertShape(params.presentationId, params.slideObjectId, params.shapeType, params.text, params.left, params.top, params.width, params.height);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_format_text",
      label: "Google Slides Format Text",
      description: "Format text within a shape or text box on a slide. Specify character range and styling options.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        objectId: Type.String({ description: "The shape/text box object ID containing the text" }),
        startIndex: Type.Number({ description: "Start character index (0-based)" }),
        endIndex: Type.Number({ description: "End character index (exclusive)" }),
        bold: Type.Optional(Type.Boolean({ description: "Set bold" })),
        italic: Type.Optional(Type.Boolean({ description: "Set italic" })),
        fontSize: Type.Optional(Type.Number({ description: "Font size in points" })),
        color: Type.Optional(Type.String({ description: "Text color as hex string, e.g. '#FF0000'" }))
      }),
      async execute(_toolCallId, params) {
        const result = await slidesFormatText(params.presentationId, params.objectId, params.startIndex, params.endIndex, params.bold, params.italic, params.fontSize, params.color);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_delete_slide",
      label: "Google Slides Delete Slide",
      description: "Delete a slide from a presentation by its slide object ID.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The object ID of the slide to delete" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesDeleteSlide(params.presentationId, params.slideObjectId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_duplicate_slide",
      label: "Google Slides Duplicate Slide",
      description: "Duplicate an existing slide in a presentation. Returns the new slide's object ID.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        slideObjectId: Type.String({ description: "The object ID of the slide to duplicate" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesDuplicateSlide(params.presentationId, params.slideObjectId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_replace_text",
      label: "Google Slides Replace Text",
      description: "Find and replace text across all slides in a presentation.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        findText: Type.String({ description: "Text to find" }),
        replaceText: Type.String({ description: "Replacement text" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesReplaceText(params.presentationId, params.findText, params.replaceText);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "slides_batch_update",
      label: "Google Slides Batch Update",
      description: "Execute raw batch update requests against the Google Slides API. For complex multi-step operations not covered by other slides tools. See Google Slides API batchUpdate documentation for request format.",
      parameters: Type.Object({
        presentationId: Type.String({ description: "The presentation ID" }),
        requests: Type.Array(Type.Any(), { description: "Array of Slides API request objects" })
      }),
      async execute(_toolCallId, params) {
        const result = await slidesBatchUpdate(params.presentationId, params.requests);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    }
  ];
}
function buildYouTubeTools() {
  return [
    {
      name: "youtube_search",
      label: "YouTube Search",
      description: "Search for YouTube videos by keyword. Returns video titles, channels, publish dates, and URLs.",
      parameters: Type.Object({
        query: Type.String({ description: "Search keywords (e.g. 'TypeScript tutorial', 'SpaceX launch')" }),
        maxResults: Type.Optional(Type.Number({ description: "Max videos to return (default 10, max 25)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await youtubeSearch(params.query, params.maxResults || 10);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "youtube_video",
      label: "YouTube Video Details",
      description: "Get detailed information about a YouTube video \u2014 title, channel, views, likes, comments, duration, and description. Requires the video ID (the part after v= in the URL).",
      parameters: Type.Object({
        videoId: Type.String({ description: "YouTube video ID (e.g. 'dQw4w9WgXcQ' from youtube.com/watch?v=dQw4w9WgXcQ)" })
      }),
      async execute(_toolCallId, params) {
        const result = await youtubeVideoDetails(params.videoId);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "youtube_channel",
      label: "YouTube Channel Info",
      description: "Get information about a YouTube channel \u2014 name, subscriber count, video count, total views, and description. Accepts a channel ID (starts with UC) or channel name to search for.",
      parameters: Type.Object({
        channel: Type.String({ description: "Channel ID (e.g. 'UCBcRF18a7Qf58cCRy5xuWwQ') or channel name to search for (e.g. 'MKBHD')" })
      }),
      async execute(_toolCallId, params) {
        const result = await youtubeChannelInfo(params.channel);
        return { content: [{ type: "text", text: result }], details: {} };
      }
    },
    {
      name: "youtube_trending",
      label: "YouTube Trending",
      description: "Get currently trending/popular videos on YouTube. Optionally specify a country code.",
      parameters: Type.Object({
        regionCode: Type.Optional(Type.String({ description: "ISO 3166-1 alpha-2 country code (default 'US', e.g. 'GB', 'IN', 'JP')" })),
        maxResults: Type.Optional(Type.Number({ description: "Max videos to return (default 10, max 25)" }))
      }),
      async execute(_toolCallId, params) {
        const result = await youtubeTrending(params.regionCode || "US", params.maxResults || 10);
        return { content: [{ type: "text", text: result }], details: {} };
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
        const results = await search(params.query, { after, limit: 8 });
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
function buildWebPublishTools() {
  const PUBLISH_SCRIPT = path4.join(PROJECT_ROOT, "scripts", "herenow-publish.sh");
  return [
    {
      name: "web_publish",
      label: "Publish Temp Page",
      description: "Publish a file or folder as a temporary, public shareable link via here.now. Use when the user says: 'temp page', 'temporary', 'quick share', 'send a link', 'share this with someone', 'public link', or needs a URL to send to others. NOT for personal/private pages \u2014 use web_save for those. Sites expire in 24h without an API key. Supports HTML, images, PDFs, any file. Paths resolve from project root first, then vault.",
      parameters: Type.Object({
        path: Type.String({
          description: "Path to the file or directory to publish. Can be a project-relative path or a vault-relative path (e.g. 'bahamas-trip' resolves to data/vault/bahamas-trip). For HTML sites, the directory should contain index.html at its root."
        }),
        slug: Type.Optional(
          Type.String({
            description: "Slug of an existing site to update (e.g. 'bright-canvas-a7k2'). Omit to create a new site."
          })
        )
      }),
      async execute(_toolCallId, params) {
        try {
          let targetPath = path4.resolve(params.path);
          if (!fs3.existsSync(targetPath)) {
            const vaultPath2 = path4.join(VAULT_DIR, params.path);
            if (fs3.existsSync(vaultPath2)) {
              targetPath = vaultPath2;
            } else {
              return {
                content: [{ type: "text", text: `Error: Path "${params.path}" does not exist (checked project root and vault).` }],
                details: {}
              };
            }
          }
          const realTarget = fs3.realpathSync(targetPath);
          const projectReal = fs3.realpathSync(PROJECT_ROOT);
          if (!realTarget.startsWith(projectReal + "/") && realTarget !== projectReal) {
            return {
              content: [{ type: "text", text: `Error: Can only publish files within the project directory.` }],
              details: {}
            };
          }
          const blocked = [".env", "auth.json", "credentials", ".herenow"];
          const relPath = path4.relative(projectReal, realTarget);
          if (blocked.some((b) => relPath.split("/").includes(b) || relPath === b)) {
            return {
              content: [{ type: "text", text: `Error: Cannot publish sensitive files.` }],
              details: {}
            };
          }
          if (params.slug && !/^[a-z0-9][a-z0-9-]*$/.test(params.slug)) {
            return {
              content: [{ type: "text", text: `Error: Invalid slug format. Use only lowercase letters, numbers, and hyphens.` }],
              details: {}
            };
          }
          const args = [PUBLISH_SCRIPT, realTarget];
          if (params.slug) {
            args.push("--slug", params.slug);
          }
          args.push("--client", "darknode");
          const { execFileSync } = await import("child_process");
          const result = execFileSync("bash", args, {
            encoding: "utf-8",
            timeout: 6e4,
            cwd: PROJECT_ROOT
          });
          const urlMatch = result.match(/https:\/\/[^\s]+\.here\.now\/?/);
          const siteUrl = urlMatch ? urlMatch[0] : null;
          let response = result.trim();
          if (siteUrl) {
            response = `Published successfully!

Live URL: ${siteUrl}

${response}`;
          }
          return {
            content: [{ type: "text", text: response }],
            details: { siteUrl }
          };
        } catch (err) {
          const stderr = err.stderr ? err.stderr.toString() : "";
          const stdout = err.stdout ? err.stdout.toString() : "";
          return {
            content: [
              {
                type: "text",
                text: `Publish failed:
${stderr || stdout || err.message}`
              }
            ],
            details: { error: true }
          };
        }
      }
    },
    {
      name: "web_save",
      label: "Save Personal Page",
      description: "Save HTML as a permanent, password-protected personal page on rickin.live/pages/<slug>. Use when the user says: 'personal page', 'my page', 'page on my site', 'private page', 'create a page', 'put on rickin.live', 'dashboard page', 'report page', 'web page', or wants a rendered HTML page (not a note). This is for HTML pages \u2014 NOT for saving text/notes to the knowledge base (use notes_create for that). Default when page-related request has no 'temp'/'share'/'public' keywords. NOT for sharing with others \u2014 use web_publish for temporary public links.",
      parameters: Type.Object({
        slug: Type.String({
          description: "URL-friendly name for the page (lowercase, hyphens, no spaces). E.g. 'moody-report' becomes rickin.live/pages/moody-report"
        }),
        html: Type.String({
          description: "The full HTML content to save. Should be a complete HTML document with <!DOCTYPE html>, <head>, and <body>."
        })
      }),
      async execute(_toolCallId, params) {
        try {
          const slug = params.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/--+/g, "-").replace(/^-|-$/g, "");
          if (!slug) {
            return { content: [{ type: "text", text: "Error: Invalid slug \u2014 must contain at least one alphanumeric character." }], details: {} };
          }
          const pagesDir = path4.join(PROJECT_ROOT, "data", "pages");
          if (!fs3.existsSync(pagesDir)) fs3.mkdirSync(pagesDir, { recursive: true });
          const filePath = path4.join(pagesDir, `${slug}.html`);
          const existed = fs3.existsSync(filePath);
          fs3.writeFileSync(filePath, params.html, "utf-8");
          const domain = process.env.REPLIT_DEPLOYMENT_URL || process.env.REPLIT_DEV_DOMAIN || "rickin.live";
          const protocol = domain.includes("localhost") ? "http" : "https";
          const pageUrl = `${protocol}://${domain}/pages/${slug}`;
          return {
            content: [{
              type: "text",
              text: `\u2705 Page ${existed ? "updated" : "saved"}!

URL: ${pageUrl}

This page is password-protected behind your login. Visit rickin.live/pages to see all saved pages.`
            }],
            details: { pageUrl, slug }
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Failed to save page: ${err.message}` }],
            details: { error: true }
          };
        }
      }
    },
    {
      name: "web_list_pages",
      label: "List Saved Pages",
      description: "List all saved pages on rickin.live/pages. Returns slugs, file sizes, and last modified dates.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const pagesDir = path4.join(PROJECT_ROOT, "data", "pages");
          if (!fs3.existsSync(pagesDir)) {
            return { content: [{ type: "text", text: "No pages saved yet." }], details: {} };
          }
          const files = fs3.readdirSync(pagesDir).filter((f) => f.endsWith(".html")).sort();
          if (files.length === 0) {
            return { content: [{ type: "text", text: "No pages saved yet." }], details: {} };
          }
          const domain = process.env.REPLIT_DEPLOYMENT_URL || process.env.REPLIT_DEV_DOMAIN || "rickin.live";
          const protocol = domain.includes("localhost") ? "http" : "https";
          const list2 = files.map((f) => {
            const slug = f.replace(/\.html$/, "");
            const stat = fs3.statSync(path4.join(pagesDir, f));
            const sizeKB = Math.round(stat.size / 1024);
            const date = stat.mtime.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
            return `- ${slug} (${sizeKB}KB, ${date}) \u2014 ${protocol}://${domain}/pages/${slug}`;
          }).join("\n");
          return {
            content: [{ type: "text", text: `${files.length} saved page(s):

${list2}

All pages: ${protocol}://${domain}/pages` }],
            details: {}
          };
        } catch (err) {
          return { content: [{ type: "text", text: `Error listing pages: ${err.message}` }], details: {} };
        }
      }
    },
    {
      name: "web_delete_page",
      label: "Delete Saved Page",
      description: "Delete a previously saved page from rickin.live/pages.",
      parameters: Type.Object({
        slug: Type.String({ description: "The slug of the page to delete." })
      }),
      async execute(_toolCallId, params) {
        try {
          const slug = params.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/--+/g, "-").replace(/^-|-$/g, "");
          if (!slug) {
            return { content: [{ type: "text", text: "Error: Invalid slug." }], details: {} };
          }
          const filePath = path4.join(PROJECT_ROOT, "data", "pages", `${slug}.html`);
          if (!fs3.existsSync(filePath)) {
            return { content: [{ type: "text", text: `Page "${slug}" not found.` }], details: {} };
          }
          fs3.unlinkSync(filePath);
          return { content: [{ type: "text", text: `\u2705 Page "${slug}" deleted.` }], details: {} };
        } catch (err) {
          return { content: [{ type: "text", text: `Failed to delete page: ${err.message}` }], details: {} };
        }
      }
    }
  ];
}
function buildAgentTools(allToolsFn, sessionId) {
  return [
    {
      name: "delegate",
      label: "Delegate to Agent",
      description: "Delegate a complex task to a specialist agent. The agent will work independently using its own tools and return a comprehensive result. Use this for multi-step research, project planning, deep analysis, email drafting, or vault organization.",
      parameters: Type.Object({
        agent: Type.String({ description: "The specialist agent ID. Available agents: 'deep-researcher' (web research), 'project-planner' (project plans), 'email-drafter' (compose emails), 'analyst' (markets/stocks), 'moodys' (Moody's/ValidMind/work projects \u2014 use for ANY work-related task), 'real-estate' (property search), 'nutritionist' (meal planning), 'family-planner' (financial/legal planning), 'knowledge-organizer' (vault management)" }),
        task: Type.String({ description: "Clear description of what the agent should do" }),
        context: Type.Optional(Type.String({ description: "Additional context the agent needs (e.g. previous conversation details, specific requirements)" }))
      }),
      async execute(_toolCallId, params) {
        try {
          const sessionEntry = sessions.get(sessionId);
          const modelOverride = sessionEntry?.modelMode === "max" ? MAX_MODEL_ID : void 0;
          const result = await runSubAgent({
            agentId: params.agent,
            task: params.task,
            context: params.context,
            allTools: allToolsFn(),
            apiKey: ANTHROPIC_KEY,
            model: modelOverride
          });
          if (result.response && result.response.length > 200) {
            try {
              const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
              await kbCreate(`Scheduled Reports/Agent Results/${params.agent}-${ts}.md`, `# ${params.agent} result
*Task: ${params.task.slice(0, 200)}*
*Duration: ${((result.durationMs || 0) / 1e3).toFixed(0)}s*

${result.response}`);
            } catch {
            }
          }
          const details = { agent: result.agentId, toolsUsed: result.toolsUsed, durationMs: result.durationMs };
          if (result.error) details.error = result.error;
          if (result.timedOut) details.timedOut = true;
          return {
            content: [{ type: "text", text: result.response }],
            details
          };
        } catch (err) {
          console.error(`[delegate] Unhandled error delegating to agent: ${err.message}`);
          return {
            content: [{ type: "text", text: `Agent delegation failed: ${err.message}. Try running the tools directly instead of delegating.` }],
            details: { error: err.message, unhandled: true }
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
var FAST_MODEL_ID = "claude-haiku-4-5-20251001";
var FULL_MODEL_ID = "claude-sonnet-4-6";
var MAX_MODEL_ID = "claude-opus-4-6";
var FAST_PATTERNS = [
  /^(hi|hello|hey|yo|sup|good\s*(morning|afternoon|evening)|thanks|thank you|ok|okay|got it|cool|nice|great)\b/i,
  /^what('s| is) (the )?(time|date|day)\b/i,
  /^(show|check|get|list|read)\s+(my\s+)?(tasks?|todos?|email|calendar|events?|weather|stock|price|portfolio|watchlist|notes?)\b/i,
  /^(add|create|complete|delete|remove)\s+(a\s+)?(task|todo|note)\b/i,
  /^(how'?s|what'?s)\s+(the\s+)?(weather|market|stock)\b/i,
  /^(remind|timer|alarm|set)\b/i
];
var MAX_PATTERNS = [
  /\b(project|strategy|architecture|roadmap|proposal|initiative)\b/i,
  /\b(sprint|milestone|deliverable|stakeholder|requirements?)\b/i,
  /\b(analysis|analyze|evaluate|assess|audit|review|compare)\b/i,
  /\b(forecast|budget|revenue|investment|valuation|financial)\b/i,
  /\b(presentation|deck|report|memo|brief|whitepaper)\b/i,
  /\b(moody'?s|validmind|data\s*moat|competitive|acquisition)\b/i,
  /\b(design|implement|build|develop|engineer|refactor)\b/i,
  /\b(plan\s+(out|for|the)|create\s+a\s+plan|help\s+me\s+(plan|think|figure))\b/i,
  /\b(research|deep\s*dive|investigate|explore\s+(the|how|why))\b/i,
  /\b(retirement|estate|wealth|portfolio\s+(review|strategy|allocation))\b/i
];
function classifyIntent(message) {
  const trimmed = message.trim();
  if (trimmed.length < 80) {
    for (const pattern of FAST_PATTERNS) {
      if (pattern.test(trimmed)) return "fast";
    }
  }
  if (trimmed.length < 20 && !trimmed.includes("?")) return "fast";
  for (const pattern of MAX_PATTERNS) {
    if (pattern.test(trimmed)) return "max";
  }
  return "full";
}
var syncedConversations = /* @__PURE__ */ new Set();
async function saveAndCleanSession(id) {
  const entry = sessions.get(id);
  if (!entry) return;
  if (entry.currentAgentText) {
    addMessage(entry.conversation, "agent", entry.currentAgentText);
    entry.currentAgentText = "";
  }
  if (entry.conversation.messages.length > 0) {
    await save(entry.conversation);
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
  if (!useLocalVault && !isConfigured()) return;
  const existing = await load(conv.id);
  if (existing && existing.syncedAt) {
    syncedConversations.add(conv.id);
    return;
  }
  const userMsgCount = conv.messages.filter((m) => m.role === "user").length;
  const useAI = userMsgCount >= 3;
  try {
    const summary = useAI ? await generateAISummary(conv) : generateSnippetSummary(conv);
    const dateStr = new Date(conv.createdAt).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    let safeTitle = conv.title.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 50).trim();
    if (!safeTitle) safeTitle = conv.id;
    const notePath = `Conversations/${dateStr} - ${safeTitle}.md`;
    await kbCreate(notePath, summary);
    syncedConversations.add(conv.id);
    conv.syncedAt = Date.now();
    await save(conv);
    console.log(`[sync] Conversation synced to vault: ${notePath} (${useAI ? "AI" : "snippet"} summary)`);
    if (useAI) {
      runInsightExtraction(conv).catch(
        (err) => console.error(`[sync] Insight extraction failed for ${conv.id}:`, err)
      );
    }
  } catch (err) {
    console.error(`[sync] Failed to sync conversation ${conv.id}:`, err);
  }
}
async function runInsightExtraction(conv) {
  try {
    let currentProfile = "";
    try {
      currentProfile = await kbRead("About Me/My Profile.md");
    } catch {
    }
    const result = await extractAndFileInsights(conv.messages, currentProfile);
    if (result.skipReason) {
      console.log(`[memory] Skipped extraction for ${conv.id}: ${result.skipReason}`);
      return;
    }
    if (result.profileUpdates.length > 0) {
      const newEntries = result.profileUpdates.map((u) => `- ${u}`).join("\n");
      const appendText = `

### Learned (${(/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: "America/New_York" })})
${newEntries}`;
      try {
        await kbAppend("About Me/My Profile.md", appendText);
        console.log(`[memory] Appended ${result.profileUpdates.length} profile updates`);
      } catch {
        await kbCreate("About Me/My Profile.md", currentProfile + appendText);
        console.log(`[memory] Created/overwrote profile with ${result.profileUpdates.length} updates`);
      }
    }
    if (result.actionItems.length > 0) {
      const dateStr = (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const items = result.actionItems.map((a) => `- [ ] ${a}`).join("\n");
      const appendText = `

### From conversation (${dateStr}): ${conv.title}
${items}`;
      try {
        await kbAppend("Tasks & TODOs/Extracted Tasks.md", appendText);
      } catch {
        await kbCreate("Tasks & TODOs/Extracted Tasks.md", `# Extracted Tasks
${appendText}`);
      }
      console.log(`[memory] Filed ${result.actionItems.length} action items`);
    }
  } catch (err) {
    console.error(`[memory] Insight extraction error:`, err);
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
  const queuedPromptStart = Date.now();
  const etNow = (/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
  const queueContext = "[Note: This message was sent while the previous task was still running. The previous task has now completed.]\n\n";
  const augmentedText = `[Current date/time in Rickin's timezone (Eastern): ${etNow}]

${queueContext}${pending.text}`;
  const promptImages = pending.images?.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
  const PROMPT_TIMEOUT = 9e5;
  const actualPromise = entry.session.prompt(augmentedText, promptImages ? { images: promptImages } : void 0);
  const timeoutPromise = new Promise(
    (_, reject) => setTimeout(() => reject(new Error("Response timed out after 15 minutes")), PROMPT_TIMEOUT)
  );
  try {
    await Promise.race([actualPromise, timeoutPromise]);
    console.log(`[prompt] queued prompt completed in ${((Date.now() - queuedPromptStart) / 1e3).toFixed(1)}s`);
  } catch (err) {
    const elapsed = ((Date.now() - queuedPromptStart) / 1e3).toFixed(1);
    const isTimeout = String(err).includes("timed out");
    console.error(`[prompt] queued ${isTimeout ? "timeout" : "error"} after ${elapsed}s:`, err);
    const errEvent = JSON.stringify({ type: isTimeout ? "timeout" : "error", error: String(err) });
    for (const sub of entry.subscribers) {
      try {
        sub.write(`data: ${errEvent}

`);
      } catch {
      }
    }
    if (isTimeout) {
      console.log(`[prompt] queued agent still running in background \u2014 new messages will be queued`);
      actualPromise.then(() => {
        console.log(`[prompt] queued background prompt completed after ${((Date.now() - queuedPromptStart) / 1e3).toFixed(1)}s total`);
        entry.isAgentRunning = false;
        entry.currentToolName = null;
        processingQueue.delete(sessionId);
        processNextPendingMessage(sessionId);
      }).catch(() => {
        console.log(`[prompt] queued background prompt failed after ${((Date.now() - queuedPromptStart) / 1e3).toFixed(1)}s total`);
        entry.isAgentRunning = false;
        entry.currentToolName = null;
        processingQueue.delete(sessionId);
        processNextPendingMessage(sessionId);
      });
      return;
    }
    entry.isAgentRunning = false;
    entry.currentToolName = null;
    processingQueue.delete(sessionId);
    processNextPendingMessage(sessionId);
    return;
  }
  processingQueue.delete(sessionId);
}
setInterval(async () => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1e3;
  for (const [id, entry] of sessions.entries()) {
    if (entry.createdAt < cutoff) {
      await saveAndCleanSession(id);
    }
  }
}, 10 * 60 * 1e3);
setInterval(async () => {
  for (const entry of sessions.values()) {
    if (entry.currentAgentText) {
      addMessage(entry.conversation, "agent", entry.currentAgentText);
      entry.currentAgentText = "";
    }
    if (entry.conversation.messages.length > 0) {
      await save(entry.conversation);
    }
  }
}, 5 * 60 * 1e3);
var TUNNEL_URL_FILE = path4.join(PROJECT_ROOT, "data", "tunnel-url.txt");
function loadPersistedTunnelUrl() {
  try {
    return fs3.readFileSync(TUNNEL_URL_FILE, "utf-8").trim() || null;
  } catch {
    return null;
  }
}
function persistTunnelUrl(url) {
  try {
    fs3.writeFileSync(TUNNEL_URL_FILE, url, "utf-8");
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
var AUTH_PUBLIC_PATHS = /* @__PURE__ */ new Set(["/login.html", "/login.css", "/api/login", "/health", "/manifest.json", "/baby-manifest.json", "/icons/icon-180.png", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/baby/icon-180.png", "/icons/baby/icon-192.png", "/icons/baby/icon-512.png", "/api/healthcheck"]);
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
  if (token && USERS[token]) {
    req.user = token;
    next();
    return;
  }
  if (token === "authenticated") {
    req.user = "rickin";
    next();
    return;
  }
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const bearerToken = authHeader.slice(7);
    for (const [uname, u] of Object.entries(USERS)) {
      if (u.password && bearerToken === u.password) {
        req.user = uname;
        next();
        return;
      }
    }
  }
  const queryUser = req.query.user;
  const queryToken = req.query.token;
  if (queryUser && queryToken && USERS[queryUser.toLowerCase()]?.password === queryToken) {
    req.user = queryUser.toLowerCase();
    next();
    return;
  }
  const devToken = process.env.DEV_TOKEN;
  if (devToken && req.query.dev_token === devToken) {
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
    res.cookie("auth", "authenticated", { signed: true, httpOnly: true, secure: isSecure, maxAge: 7 * 24 * 60 * 60 * 1e3 });
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
  const { username, password } = req.body;
  let matchedUser = null;
  if (username && USERS[username.toLowerCase()]) {
    const u = USERS[username.toLowerCase()];
    if (password && u.password && password === u.password) matchedUser = username.toLowerCase();
  } else if (!username && password && password === APP_PASSWORD) {
    matchedUser = "rickin";
  }
  if (!matchedUser) {
    res.status(401).json({ error: "ACCESS DENIED" });
    return;
  }
  const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
  res.cookie("auth", matchedUser, {
    signed: true,
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1e3
  });
  const user = USERS[matchedUser];
  const redirect = matchedUser === "pooja" ? "/pages/baby-dashboard" : "/";
  res.json({ ok: true, displayName: user.displayName, redirect });
});
app.get("/api/me", (req, res) => {
  const token = req.signedCookies?.auth;
  if (token && USERS[token]) {
    res.json({ username: token, displayName: USERS[token].displayName });
  } else if (token === "authenticated") {
    res.json({ username: "rickin", displayName: "Rickin" });
  } else {
    res.status(401).json({ error: "Not logged in" });
  }
});
app.get("/api/logout", (_req, res) => {
  res.clearCookie("auth");
  res.redirect("/login.html");
});
app.use(express.static(PUBLIC_DIR));
var PAGES_DIR = path4.join(PROJECT_ROOT, "data", "pages");
if (!fs3.existsSync(PAGES_DIR)) fs3.mkdirSync(PAGES_DIR, { recursive: true });
app.get("/pages", (_req, res) => {
  try {
    const files = fs3.readdirSync(PAGES_DIR).filter((f) => f.endsWith(".html")).sort();
    if (files.length === 0) {
      res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages \u2014 RICKIN</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;padding:2rem;max-width:600px;margin:0 auto}h1{font-size:1.4rem;color:#fff}p{color:#888}</style></head><body><h1>Pages</h1><p>No pages published yet.</p></body></html>`);
      return;
    }
    const items = files.map((f) => {
      const slug = f.replace(/\.html$/, "");
      const stat = fs3.statSync(path4.join(PAGES_DIR, f));
      const date = stat.mtime.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      return `<a href="/pages/${slug}">${slug}</a><span class="date">${date}</span>`;
    }).join("");
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pages \u2014 RICKIN</title><style>body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;padding:2rem;max-width:600px;margin:0 auto}h1{font-size:1.4rem;color:#fff;margin-bottom:1.5rem}a{display:block;color:#7cacf8;text-decoration:none;padding:.75rem 0;border-bottom:1px solid #222;font-size:1rem}a:hover{color:#aac8ff}.date{float:right;color:#666;font-size:.85rem}</style></head><body><h1>Pages</h1>${items}</body></html>`);
  } catch (err) {
    res.status(500).send("Error loading pages.");
  }
});
var dailyBriefCache = null;
var welcomeCache = null;
var WELCOME_CACHE_TTL = 30 * 60 * 1e3;
async function generateWelcomeMessage(context) {
  try {
    if (welcomeCache && Date.now() - welcomeCache.ts < WELCOME_CACHE_TTL) return welcomeCache.message;
    const { default: Anthropic5 } = await import("@anthropic-ai/sdk");
    const client = new Anthropic5({ apiKey: ANTHROPIC_KEY });
    const weatherPart = context.tempC !== null && context.condition ? `Current weather in NYC: ${context.tempC}\xB0C, ${context.condition}.` : "";
    const babyPart = context.babyWeeks !== null ? `His wife is ${context.babyWeeks} weeks pregnant with a baby boy.` : "";
    const prompt = `Generate a friendly morning briefing for Rickin who is checking his daily dashboard. Time: ${context.greeting.toLowerCase()} on ${context.dayOfWeek}. ${weatherPart} He has ${context.taskCount} tasks and ${context.eventCount} calendar events today. ${babyPart}

Format as a short greeting line followed by bullet points summarizing what's ahead. Use this exact format:
[greeting line]
\u2022 [weather note]
\u2022 [tasks/calendar summary]
\u2022 [baby milestone or encouragement]
\u2022 [motivational or day-specific note]

Keep each bullet concise (under 15 words). Don't use emojis. Don't say "I" or reference yourself. 4-5 bullets max.`;
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }]
    });
    const text = response.content[0].text?.trim() || "";
    if (text) {
      welcomeCache = { message: text, ts: Date.now() };
      return text;
    }
  } catch (err) {
    console.error("Welcome message generation failed:", err);
  }
  return `${context.greeting}, Rickin. Here's your brief for ${context.dayOfWeek}.`;
}
var DAILY_BRIEF_TTL = 12e4;
async function fetchQuoteStructured(symbol, type) {
  try {
    if (type === "crypto") {
      const CRYPTO_MAP = { BTCUSD: "bitcoin", ETHUSD: "ethereum" };
      const coinId = CRYPTO_MAP[symbol.toUpperCase()] || symbol.toLowerCase();
      const url = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`;
      const res = await fetch(url, { headers: { "User-Agent": "pi-assistant/1.0" } });
      if (!res.ok) return null;
      const data = await res.json();
      const m = data.market_data;
      if (!m?.current_price?.usd) return null;
      return {
        symbol: data.symbol.toUpperCase(),
        name: data.name,
        price: m.current_price.usd,
        change24h: m.price_change_percentage_24h || 0,
        change7d: m.price_change_percentage_7d || 0,
        high24h: m.high_24h?.usd,
        low24h: m.low_24h?.usd,
        marketCap: m.market_cap?.usd
      };
    } else {
      const ticker = symbol.toUpperCase();
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d&includePrePost=false`;
      const res = await fetch(url, { headers: { "User-Agent": "pi-assistant/1.0" } });
      if (!res.ok) return null;
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) return null;
      const meta = result.meta;
      const price = meta.regularMarketPrice;
      if (price == null) return null;
      const prevClose = meta.chartPreviousClose || meta.previousClose;
      const change = prevClose ? price - prevClose : 0;
      const changePct = prevClose ? change / prevClose * 100 : 0;
      return {
        symbol: ticker,
        name: meta.shortName || meta.longName || ticker,
        price,
        change,
        changePct,
        prevClose,
        currency: meta.currency || "USD"
      };
    }
  } catch {
    return null;
  }
}
app.get("/api/vault/reya-school", async (_req, res) => {
  try {
    const tz = "America/New_York";
    const now = /* @__PURE__ */ new Date();
    const dayName = now.toLocaleString("en-US", { timeZone: tz, weekday: "long" });
    const isWeekend = ["Saturday", "Sunday"].includes(dayName);
    if (isWeekend) {
      res.json({ schoolInSession: false, lunch: null, pickupCountdown: null, alert: null });
      return;
    }
    const month = parseInt(now.toLocaleString("en-US", { timeZone: tz, month: "numeric" }));
    const day = parseInt(now.toLocaleString("en-US", { timeZone: tz, day: "numeric" }));
    let lunch = "Menu not available";
    try {
      const mealFile = await kbRead("Family/Reya's Education/Reya - School Meals.md");
      if (mealFile) {
        const datePattern = new RegExp(`\\|\\s*\\w+\\s+${month}/${day}\\s*\\|([^|]+)\\|([^|]+)\\|([^|]+)\\|`, "i");
        const match = mealFile.match(datePattern);
        if (match) {
          const mainDish = match[1].replace(/\*\*/g, "").trim();
          const vegStatus = match[2].trim();
          const sides = match[3].trim();
          const isVeg = vegStatus.includes("\u2705");
          lunch = isVeg ? `\u2705 ${mainDish}` : `\u274C ${mainDish} \u2014 Sides: ${sides}`;
        }
      }
    } catch {
    }
    const etNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const pickupTime = new Date(etNow);
    pickupTime.setHours(16, 30, 0, 0);
    let pickupCountdown = null;
    if (etNow < pickupTime) {
      const diffMs = pickupTime.getTime() - etNow.getTime();
      const h = Math.floor(diffMs / 36e5);
      const m = Math.floor(diffMs % 36e5 / 6e4);
      pickupCountdown = h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
    } else {
      pickupCountdown = "\u2705 Picked up";
    }
    let alert = null;
    try {
      if (isConnected()) {
        const alerts = await searchEmailsStructured("from:kristen OR from:cicio is:unread newer_than:2d", 1);
        if (alerts.length > 0) alert = alerts[0].subject;
      }
    } catch {
    }
    res.json({ schoolInSession: true, lunch, pickupCountdown, alert });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch Reya school data" });
  }
});
app.get("/api/vault/moodys-brief", async (_req, res) => {
  try {
    const tz = "America/New_York";
    const now = /* @__PURE__ */ new Date();
    const year = now.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
    const month = now.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
    const day = now.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
    const dateStr = `${year}-${month}-${day}`;
    const paths = [
      `Scheduled Reports/Moody's Intelligence/Daily/${dateStr}-Brief.md`
    ];
    const etHour = parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
    let briefContent = null;
    let briefDate = dateStr;
    if (etHour >= 6) {
      for (const p of paths) {
        try {
          const content = await kbRead(p);
          if (content && content.length > 100) {
            briefContent = content;
            break;
          }
        } catch {
        }
      }
    }
    if (!briefContent) {
      const yesterday = new Date(now.getTime() - 864e5);
      const yYear = yesterday.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
      const yMonth = yesterday.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
      const yDay = yesterday.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
      const yDateStr = `${yYear}-${yMonth}-${yDay}`;
      try {
        const content = await kbRead(`Scheduled Reports/Moody's Intelligence/Daily/${yDateStr}-Brief.md`);
        if (content && content.length > 100) {
          briefContent = content;
          briefDate = yDateStr;
        }
      } catch {
      }
    }
    if (!briefContent) {
      res.json({ available: false, reason: "missing", message: "Brief unavailable \u2014 check pipeline" });
      return;
    }
    const categories = { corporate: [], banking: [], competitors: [], aiTrends: [], analysts: [] };
    const MAX_PER_CAT = 5;
    const sectionMap = [
      { pattern: /^##\s+🏢\s+Moody/im, key: "corporate" },
      { pattern: /^##\s+🏦\s+Banking/im, key: "banking" },
      { pattern: /^##\s+🔍\s+Competitor/im, key: "competitors" },
      { pattern: /^##\s+🤖\s+Enterprise\s*AI/im, key: "aiTrends" },
      { pattern: /^##\s+📊\s+Industry\s*Analyst/im, key: "analysts" }
    ];
    const bLines = briefContent.split("\n");
    let curKey = null;
    for (const line of bLines) {
      for (const { pattern, key } of sectionMap) {
        if (pattern.test(line)) {
          curKey = key;
          break;
        }
      }
      if (/^##\s+⚡\s+Key\s+Takeaway/i.test(line) || /^##\s+🐦/i.test(line)) {
        curKey = null;
        continue;
      }
      if (curKey && /^-\s+.+/.test(line)) {
        if (categories[curKey].length < MAX_PER_CAT) {
          let text = line.replace(/^-\s+/, "").replace(/🔴|🟡|🟢/g, "").replace(/\*\*/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
          if (text.length > 160) text = text.slice(0, 157) + "...";
          if (text) categories[curKey].push(text);
        }
      }
    }
    let totalItems = Object.values(categories).reduce((s, a) => s + a.length, 0);
    if (totalItems === 0) {
      const catKeywords = [
        { pattern: /moody'?s\s*corporate/i, key: "corporate" },
        { pattern: /banking/i, key: "banking" },
        { pattern: /competitor/i, key: "competitors" },
        { pattern: /enterprise\s*ai/i, key: "aiTrends" },
        { pattern: /industry\s*analyst/i, key: "analysts" }
      ];
      const tableRows = briefContent.match(/^\|[^|]*\|[^|]*\|[^|]*\|/gm) || [];
      for (const row of tableRows) {
        const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
        if (cells.length < 3 || /^[#-]+$/.test(cells[0])) continue;
        const item = cells[1].replace(/\*\*/g, "").replace(/\(?\[.*?\]\(.*?\)\)?/g, "").trim();
        const catCell = cells[2];
        if (!item || !catCell || /^Category$/i.test(catCell) || /^-+$/.test(catCell)) continue;
        for (const { pattern, key } of catKeywords) {
          if (pattern.test(catCell)) {
            if (categories[key].length < MAX_PER_CAT) {
              const clean = item.length > 160 ? item.slice(0, 157) + "..." : item;
              categories[key].push(clean);
            }
            break;
          }
        }
      }
      totalItems = Object.values(categories).reduce((s, a) => s + a.length, 0);
    }
    if (totalItems === 0) {
      const bullets = briefContent.match(/^- .+$/gm) || [];
      if (bullets.length === 0) {
        res.json({ available: false, reason: "unstructured", message: "Brief format not recognized" });
        return;
      }
      for (const b of bullets.slice(0, 5)) {
        let text = b.replace(/^- /, "").replace(/\*\*/g, "").trim();
        if (text.length > 160) text = text.slice(0, 157) + "...";
        categories.corporate.push(text);
      }
    }
    const tsMatch = briefContent.match(/Generated:\s*(.+)/);
    res.json({ available: true, date: briefDate, categories, timestamp: tsMatch ? tsMatch[1].trim() : null });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch Moody's brief" });
  }
});
app.get("/api/vault/real-estate-scan", async (_req, res) => {
  try {
    const tz = "America/New_York";
    const now = /* @__PURE__ */ new Date();
    const year = now.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
    const month = now.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
    const day = now.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
    const dateStr = `${year}-${month}-${day}`;
    let scanContent = null;
    let scanDate = dateStr;
    try {
      const content = await kbRead(`Scheduled Reports/Real Estate/${dateStr}-Property-Scan.md`);
      if (content) scanContent = content;
    } catch {
    }
    if (!scanContent) {
      const yesterday = new Date(now.getTime() - 864e5);
      const yDateStr = `${yesterday.toLocaleString("en-US", { timeZone: tz, year: "numeric" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, month: "2-digit" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, day: "2-digit" })}`;
      try {
        const content = await kbRead(`Scheduled Reports/Real Estate/${yDateStr}-Property-Scan.md`);
        if (content) {
          scanContent = content;
          scanDate = yDateStr;
        }
      } catch {
      }
    }
    if (!scanContent) {
      res.json({ available: false });
      return;
    }
    const scannedMatch = scanContent.match(/\*\*(\d+)\+?\s*listings?\s*scanned\*\*/i);
    const totalListings = scannedMatch ? parseInt(scannedMatch[1]) : 0;
    const newMatch = scanContent.match(/\*\*(\d+)\s*new\s*listings?\*\*/i);
    const newListings = newMatch ? parseInt(newMatch[1]) : 0;
    const tsMatch = scanContent.match(/Generated:\s*(.+)/);
    const scanTime = tsMatch ? tsMatch[1].trim() : null;
    res.json({ available: true, date: scanDate, totalListings, newListings, scanTime });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch real estate scan" });
  }
});
app.get("/api/daily-brief/data", async (_req, res) => {
  try {
    if (dailyBriefCache && Date.now() - dailyBriefCache.ts < DAILY_BRIEF_TTL) {
      res.json(dailyBriefCache.data);
      return;
    }
    const cfg = getConfig();
    const tz = cfg.timezone || "America/New_York";
    const loc = cfg.location || "10016";
    const now = /* @__PURE__ */ new Date();
    const result = {
      timestamp: now.toISOString(),
      greeting: "",
      date: "",
      welcomeMessage: "",
      weather: null,
      commuteAlert: null,
      markets: [],
      tasks: [],
      calendars: { rickin: [], pooja: [], reya: [], other: [] },
      headlines: [],
      headlinesBtc: [],
      headlinesMacro: [],
      headlinesTech: [],
      xSignals: [],
      baby: null,
      reya: null,
      moodys: null,
      realEstate: null,
      focusToday: null,
      jobs: null
    };
    try {
      const etHour = parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
      result.greeting = etHour < 12 ? "Good morning" : etHour < 17 ? "Good afternoon" : "Good evening";
      result.date = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", year: "numeric" });
      result.timeStr = now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true });
    } catch {
    }
    const promises = [];
    promises.push((async () => {
      try {
        const raw = await getWeather(loc, 5);
        const tempMatch = raw.match(/Temperature:\s*([\d.-]+)°C\s*\((-?\d+)°F\)/);
        const condMatch = raw.match(/Condition:\s*(.+)/);
        const feelsMatch = raw.match(/Feels like:\s*([\d.-]+)°C\s*\((-?\d+)°F\)/);
        const humMatch = raw.match(/Humidity:\s*(\d+)%/);
        const windMatch = raw.match(/Wind:\s*(.+)/);
        if (tempMatch && condMatch) {
          const condition = condMatch[1].trim();
          const etHour = parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
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
          const w = { tempC: Math.round(parseFloat(tempMatch[1])), tempF: parseInt(tempMatch[2]), condition, icon };
          if (feelsMatch) {
            w.feelsLikeC = Math.round(parseFloat(feelsMatch[1]));
            w.feelsLikeF = parseInt(feelsMatch[2]);
          }
          if (humMatch) w.humidity = parseInt(humMatch[1]);
          if (windMatch) w.wind = windMatch[1].trim();
          const forecastLines = raw.match(/\d{4}-\d{2}-\d{2}:\s*.+/g);
          if (forecastLines) {
            w.forecast = forecastLines.map((line) => {
              const m = line.match(/(\d{4}-\d{2}-\d{2}):\s*(.+?),\s*([\d-]+)-([\d-]+)°C.*?Rain:\s*(\d+)%/);
              if (!m) return null;
              const lowC = parseInt(m[3]), highC = parseInt(m[4]);
              return { date: m[1], condition: m[2].trim(), lowC, highC, lowF: Math.round(lowC * 9 / 5 + 32), highF: Math.round(highC * 9 / 5 + 32), rainPct: parseInt(m[5]) };
            }).filter(Boolean);
          }
          const hourlyPrecip = raw.match(/Hourly Precipitation:\n([\s\S]*?)(?:\n\d+-Day|\n$|$)/);
          if (hourlyPrecip) {
            const lines = hourlyPrecip[1].match(/\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):\s*(\d+)%/g) || [];
            for (const line of lines) {
              const m = line.match(/T(\d{2}):(\d{2}):\s*(\d+)%/);
              if (m) {
                const hour = parseInt(m[1]);
                const minute = parseInt(m[2]);
                const pct = parseInt(m[3]);
                const timeMinutes = hour * 60 + minute;
                if (timeMinutes >= 450 && timeMinutes <= 540 && pct > 40) {
                  const cond = (w.condition || "").toLowerCase();
                  const label = cond.includes("snow") || cond.includes("sleet") ? "snow" : "rain";
                  const timeLabel = hour > 12 ? `${hour - 12}:${m[2]} PM` : `${hour}:${m[2]} AM`;
                  result.commuteAlert = `\u2602\uFE0F ${pct}% chance of ${label} at school drop-off (~${timeLabel})`;
                  break;
                }
              }
            }
          }
          result.weather = w;
        }
      } catch {
      }
    })());
    const watchlistSymbols = [
      { symbol: "BTCUSD", type: "crypto", display: "BTC", emoji: "\u20BF" },
      { symbol: "MSTR", type: "stock", display: "MSTR", emoji: "\u{1F4CA}" },
      { symbol: "^GSPC", type: "stock", display: "SPX", emoji: "\u{1F4C8}" },
      { symbol: "GC=F", type: "stock", display: "GOLD", emoji: "\u{1F947}" },
      { symbol: "SI=F", type: "stock", display: "SILVER", emoji: "\u{1F948}" },
      { symbol: "CL=F", type: "stock", display: "OIL", emoji: "\u{1F6E2}\uFE0F" }
    ];
    promises.push((async () => {
      const quotePromises = watchlistSymbols.map(async (w) => {
        const q = await fetchQuoteStructured(w.symbol, w.type);
        if (q) return { ...q, display: w.display, emoji: w.emoji, type: w.type };
        return null;
      });
      const quotes = await Promise.all(quotePromises);
      result.markets = quotes.filter(Boolean);
    })());
    promises.push((async () => {
      try {
        const active = await getActiveTasks();
        result.tasks = active.slice(0, 8);
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
          const eodTomorrowInTz = new Date(Date.UTC(nowShifted.getUTCFullYear(), nowShifted.getUTCMonth(), nowShifted.getUTCDate() + 1, 23, 59, 59, 999));
          const endOfTomorrowUTC = new Date(eodTomorrowInTz.getTime() - tzOffsetMs);
          const events = await listEventsStructured({ maxResults: 15, timeMax: endOfTomorrowUTC.toISOString() });
          const cals = { rickin: [], pooja: [], reya: [], other: [] };
          for (const ev of events) {
            const calName = (ev.calendar || "").toLowerCase();
            if (calName.includes("rickin") || calName.includes("primary") || calName === "" || calName.includes("rickin.patel")) cals.rickin.push(ev);
            else if (calName.includes("pooja")) cals.pooja.push(ev);
            else if (calName.includes("reya")) cals.reya.push(ev);
            else cals.other.push(ev);
          }
          result.calendars = cals;
        } catch {
        }
      })());
    }
    const xHeadlineQueries = [
      { key: "headlines", query: "breaking news OR just announced OR developing story" },
      { key: "headlinesBtc", query: "world news OR geopolitics OR international conflict OR diplomacy" },
      { key: "headlinesMacro", query: "Federal Reserve OR inflation OR GDP OR interest rates OR economy" },
      { key: "headlinesTech", query: "artificial intelligence OR AI startup OR LLM OR GPT OR Anthropic OR OpenAI" }
    ];
    for (const { key, query } of xHeadlineQueries) {
      promises.push((async () => {
        try {
          const raw = await searchTweets(query, 7, "Top");
          if (!raw.startsWith("Error") && !raw.includes("not configured")) {
            const items = [];
            const blocks = raw.split(/\n\d+\.\s+@/);
            for (let i = 1; i < blocks.length && items.length < 5; i++) {
              const b = blocks[i];
              const handleMatch = b.match(/^(\w+)/);
              const textMatch = b.match(/\n\s+(.+?)(?:\n\s+\d|$)/s);
              if (handleMatch && textMatch) {
                const text = textMatch[1].trim().slice(0, 200);
                items.push({ title: text, source: "@" + handleMatch[1] });
              }
            }
            result[key] = items;
          }
        } catch {
        }
      })());
    }
    promises.push((async () => {
      try {
        const raw = await searchTweets("AI OR artificial intelligence OR AGI OR OpenAI OR Anthropic OR GPT", 5, "Top");
        if (!raw.startsWith("Error") && !raw.includes("not configured")) {
          const tweets = [];
          const blocks = raw.split(/\n\d+\.\s+@/);
          for (let i = 1; i < blocks.length && tweets.length < 5; i++) {
            const b = blocks[i];
            const handleMatch = b.match(/^(\w+)/);
            const textMatch = b.match(/\n\s+(.+?)(?:\n\s+\d|$)/s);
            const statsMatch = b.match(/([\d,]+)\s*likes/);
            if (handleMatch && textMatch) {
              tweets.push({
                handle: handleMatch[1],
                text: textMatch[1].trim().slice(0, 200),
                likes: statsMatch ? statsMatch[1] : "0"
              });
            }
          }
          result.xSignals = tweets;
        }
      } catch {
      }
    })());
    promises.push((async () => {
      try {
        const dueDate = /* @__PURE__ */ new Date("2026-07-07");
        const daysLeft = Math.ceil((dueDate.getTime() - now.getTime()) / 864e5);
        const weeksPregnant = 40 - Math.ceil(daysLeft / 7);
        let nextAppt = null;
        if (isConnected()) {
          try {
            const readTab = async (range) => {
              try {
                const r = await sheetsRead(BABY_SHEET_ID2, range);
                if (r.includes("Error") || r.includes("not connected")) return "";
                return r;
              } catch {
                return "";
              }
            };
            const apptResult = await readTab("Appointments!A1:E14");
            if (apptResult && !apptResult.includes("No data")) {
              const apptRows = apptResult.split("\n").filter((l) => l.startsWith("Row ")).map((l) => l.replace(/^Row \d+: /, "").split(" | "));
              const today = now.toISOString().split("T")[0];
              for (let i = 1; i < apptRows.length; i++) {
                const r = apptRows[i];
                const date = (r[0] || "").trim();
                if (date && date >= today) {
                  nextAppt = { date, title: (r[1] || "").trim() };
                  break;
                }
              }
            }
          } catch {
          }
        }
        result.baby = { weeksPregnant, daysLeft, nextAppt };
      } catch {
      }
    })());
    promises.push((async () => {
      try {
        const dayName = now.toLocaleString("en-US", { timeZone: tz, weekday: "long" });
        const isWeekend = ["Saturday", "Sunday"].includes(dayName);
        if (!isWeekend) {
          const month = parseInt(now.toLocaleString("en-US", { timeZone: tz, month: "numeric" }));
          const day = parseInt(now.toLocaleString("en-US", { timeZone: tz, day: "numeric" }));
          let lunch = "Menu not available";
          try {
            const mealFile = await kbRead("Family/Reya's Education/Reya - School Meals.md");
            if (mealFile) {
              const datePattern = new RegExp(`\\|\\s*\\w+\\s+${month}/${day}\\s*\\|([^|]+)\\|([^|]+)\\|([^|]+)\\|`, "i");
              const match = mealFile.match(datePattern);
              if (match) {
                const mainDish = match[1].replace(/\*\*/g, "").trim();
                const vegStatus = match[2].trim();
                const sides = match[3].trim();
                const isVeg = vegStatus.includes("\u2705");
                lunch = isVeg ? `\u2705 ${mainDish}` : `\u274C ${mainDish} \u2014 Sides: ${sides}`;
              }
            }
          } catch {
          }
          const etNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
          const pickupTime = new Date(etNow);
          pickupTime.setHours(16, 30, 0, 0);
          let pickupCountdown;
          if (etNow < pickupTime) {
            const diffMs = pickupTime.getTime() - etNow.getTime();
            const h = Math.floor(diffMs / 36e5);
            const m = Math.floor(diffMs % 36e5 / 6e4);
            pickupCountdown = h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
          } else {
            pickupCountdown = "\u2705 Picked up";
          }
          let schoolAlert = null;
          try {
            if (isConnected()) {
              const a = await searchEmailsStructured("from:kristen OR from:cicio is:unread newer_than:2d", 1);
              if (a.length > 0) schoolAlert = a[0].subject;
            }
          } catch {
          }
          result.reya = { schoolInSession: true, lunch, pickupCountdown, alert: schoolAlert };
        } else {
          result.reya = { schoolInSession: false };
        }
      } catch {
      }
    })());
    promises.push((async () => {
      try {
        const year = now.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
        const month = now.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
        const day = now.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
        const dateStr = `${year}-${month}-${day}`;
        const etHour = parseInt(now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }));
        let briefContent = null;
        let briefDate = dateStr;
        if (etHour >= 6) {
          try {
            const content = await kbRead(`Scheduled Reports/Moody's Intelligence/Daily/${dateStr}-Brief.md`);
            if (content && content.length > 100) briefContent = content;
          } catch {
          }
        }
        if (!briefContent) {
          const yesterday = new Date(now.getTime() - 864e5);
          const yDateStr = `${yesterday.toLocaleString("en-US", { timeZone: tz, year: "numeric" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, month: "2-digit" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, day: "2-digit" })}`;
          try {
            const content = await kbRead(`Scheduled Reports/Moody's Intelligence/Daily/${yDateStr}-Brief.md`);
            if (content && content.length > 100) {
              briefContent = content;
              briefDate = yDateStr;
            }
          } catch {
          }
        }
        if (!briefContent) {
          result.moodys = { available: false, reason: etHour < 6 ? "pending" : "missing", message: etHour < 6 ? "Daily brief generates at 6:00 AM" : "Brief unavailable \u2014 check pipeline" };
          return;
        }
        const categories = { corporate: [], banking: [], competitors: [], aiTrends: [], analysts: [] };
        const MAX_PER_CAT = 5;
        const sectionMap = [
          { pattern: /^##\s+🏢\s+Moody/im, key: "corporate" },
          { pattern: /^##\s+🏦\s+Banking/im, key: "banking" },
          { pattern: /^##\s+🔍\s+Competitor/im, key: "competitors" },
          { pattern: /^##\s+🤖\s+Enterprise\s*AI/im, key: "aiTrends" },
          { pattern: /^##\s+📊\s+Industry\s*Analyst/im, key: "analysts" }
        ];
        const lines = briefContent.split("\n");
        let currentKey = null;
        for (const line of lines) {
          for (const { pattern, key } of sectionMap) {
            if (pattern.test(line)) {
              currentKey = key;
              break;
            }
          }
          if (/^##\s+⚡\s+Key\s+Takeaway/i.test(line) || /^##\s+🐦/i.test(line)) {
            currentKey = null;
            continue;
          }
          if (currentKey && /^-\s+.+/.test(line)) {
            if (categories[currentKey].length < MAX_PER_CAT) {
              let text = line.replace(/^-\s+/, "").replace(/🔴|🟡|🟢/g, "").replace(/\*\*/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
              if (text.length > 160) text = text.slice(0, 157) + "...";
              if (text) categories[currentKey].push(text);
            }
          }
        }
        let totalItems = Object.values(categories).reduce((s, a) => s + a.length, 0);
        if (totalItems === 0) {
          const catKeywords = [
            { pattern: /moody'?s\s*corporate/i, key: "corporate" },
            { pattern: /banking/i, key: "banking" },
            { pattern: /competitor/i, key: "competitors" },
            { pattern: /enterprise\s*ai/i, key: "aiTrends" },
            { pattern: /industry\s*analyst/i, key: "analysts" }
          ];
          const tableRows = briefContent.match(/^\|[^|]*\|[^|]*\|[^|]*\|/gm) || [];
          for (const row of tableRows) {
            const cells = row.split("|").map((c) => c.trim()).filter(Boolean);
            if (cells.length < 3 || /^[#-]+$/.test(cells[0])) continue;
            const item = cells[1].replace(/\*\*/g, "").replace(/\(?\[.*?\]\(.*?\)\)?/g, "").trim();
            const catCell = cells[2];
            if (!item || !catCell || /^Category$/i.test(catCell) || /^-+$/.test(catCell)) continue;
            for (const { pattern, key } of catKeywords) {
              if (pattern.test(catCell)) {
                if (categories[key].length < MAX_PER_CAT) {
                  const clean = item.length > 160 ? item.slice(0, 157) + "..." : item;
                  categories[key].push(clean);
                }
                break;
              }
            }
          }
          totalItems = Object.values(categories).reduce((s, a) => s + a.length, 0);
        }
        if (totalItems === 0) {
          const bullets = briefContent.match(/^- .+$/gm) || [];
          for (const b of bullets.slice(0, 5)) {
            let text = b.replace(/^- /, "").replace(/\*\*/g, "").trim();
            if (text.length > 160) text = text.slice(0, 157) + "...";
            categories.corporate.push(text);
          }
          totalItems = categories.corporate.length;
        }
        const takeaways = briefContent.match(/^\d+\.\s+\*\*.+$/gm) || [];
        if (totalItems === 0 && takeaways.length === 0) {
          result.moodys = { available: false, reason: "unstructured", message: "Brief format not recognized" };
          return;
        }
        const tsMatch = briefContent.match(/Generated:\s*(.+)/);
        result.moodys = { available: true, date: briefDate, categories, timestamp: tsMatch ? tsMatch[1].trim() : null };
      } catch {
      }
    })());
    promises.push((async () => {
      try {
        const year = now.toLocaleString("en-US", { timeZone: tz, year: "numeric" });
        const month = now.toLocaleString("en-US", { timeZone: tz, month: "2-digit" });
        const day = now.toLocaleString("en-US", { timeZone: tz, day: "2-digit" });
        const dateStr = `${year}-${month}-${day}`;
        let scanContent = null;
        let scanDate = dateStr;
        try {
          const content = await kbRead(`Scheduled Reports/Real Estate/${dateStr}-Property-Scan.md`);
          if (content) scanContent = content;
        } catch {
        }
        if (!scanContent) {
          const yesterday = new Date(now.getTime() - 864e5);
          const yDateStr = `${yesterday.toLocaleString("en-US", { timeZone: tz, year: "numeric" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, month: "2-digit" })}-${yesterday.toLocaleString("en-US", { timeZone: tz, day: "2-digit" })}`;
          try {
            const content = await kbRead(`Scheduled Reports/Real Estate/${yDateStr}-Property-Scan.md`);
            if (content) {
              scanContent = content;
              scanDate = yDateStr;
            }
          } catch {
          }
        }
        if (scanContent) {
          const scannedMatch = scanContent.match(/\*\*(\d+)\+?\s*listings?\s*scanned\*\*/i);
          const totalListings = scannedMatch ? parseInt(scannedMatch[1]) : 0;
          const newMatch = scanContent.match(/\*\*(\d+)\s*new\s*listings?\*\*/i);
          const newListings = newMatch ? parseInt(newMatch[1]) : 0;
          const tsMatch = scanContent.match(/Generated:\s*(.+)/);
          result.realEstate = { available: true, date: scanDate, totalListings, newListings, scanTime: tsMatch ? tsMatch[1].trim() : null };
        }
      } catch {
      }
    })());
    promises.push((async () => {
      try {
        const active = await getActiveTasks();
        const today = now.toISOString().split("T")[0];
        const urgent = active.filter((t) => t.priority === "high" || t.dueDate && t.dueDate <= today);
        const urgentIds = new Set(urgent.map((t) => t.id));
        const rest = active.filter((t) => !urgentIds.has(t.id));
        const focusTasks = [...urgent, ...rest].slice(0, 3);
        let actionEmails = [];
        let actionCount = 0;
        try {
          if (isConnected()) {
            const [emails, countResult] = await Promise.all([
              searchEmailsStructured("label:Action-Required is:unread", 3),
              countUnread ? countUnread("label:Action-Required is:unread") : Promise.resolve(-1)
            ]);
            actionEmails = emails;
            actionCount = typeof countResult === "number" && countResult >= 0 ? countResult : emails.length;
          }
        } catch {
        }
        result.focusToday = { tasks: focusTasks, actionEmails, actionCount };
      } catch {
      }
    })());
    await Promise.all(promises);
    try {
      const dayOfWeek = now.toLocaleString("en-US", { timeZone: tz, weekday: "long" });
      const cals = result.calendars || { rickin: [], pooja: [], reya: [], other: [] };
      const eventCount = cals.rickin.length + cals.pooja.length + cals.reya.length + (cals.other || []).length;
      const taskCount = result.tasks ? result.tasks.length : 0;
      result.welcomeMessage = await generateWelcomeMessage({
        greeting: result.greeting,
        dayOfWeek,
        tempC: result.weather?.tempC ?? null,
        condition: result.weather?.condition ?? null,
        taskCount,
        eventCount,
        babyWeeks: result.baby?.weeksPregnant ?? null
      });
    } catch {
      const dayOfWeek = now.toLocaleString("en-US", { timeZone: tz, weekday: "long" });
      result.welcomeMessage = `${result.greeting}, Rickin. Here's your brief for ${dayOfWeek}.`;
    }
    const allJobs = getJobs();
    const enabledJobs = allJobs.filter((j) => j.enabled);
    const okCount = enabledJobs.filter((j) => j.lastStatus === "success").length;
    const failedCount = enabledJobs.filter((j) => j.lastStatus === "error").length;
    result.jobs = { total: enabledJobs.length, ok: okCount, failed: failedCount };
    result.nextJob = getNextJob();
    dailyBriefCache = { data: result, ts: Date.now() };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch daily brief data" });
  }
});
var BABY_SHEET_ID2 = "1fhtMkDSTUlRCFqY4hQiSdZg7cOe4FYNkmOIIHWo4KSU";
var babyDashboardCache = null;
var BABY_CACHE_TTL = 6e4;
app.get("/api/baby-dashboard/data", async (_req, res) => {
  try {
    let parseRows2 = function(raw) {
      if (!raw || raw.includes("No data") || raw.includes("Error") || raw.includes("not connected")) return [];
      return raw.split("\n").filter((l) => l.startsWith("Row ")).map((l) => {
        const content = l.replace(/^Row \d+: /, "");
        return content.split(" | ");
      });
    };
    var parseRows = parseRows2;
    if (babyDashboardCache && Date.now() - babyDashboardCache.timestamp < BABY_CACHE_TTL) {
      res.json(babyDashboardCache.data);
      return;
    }
    if (!isConnected()) {
      res.status(503).json({ error: "google_disconnected", message: "Google not connected" });
      return;
    }
    const tabErrors = [];
    const readTab = async (range) => {
      try {
        const result2 = await sheetsRead(BABY_SHEET_ID2, range);
        if (result2.includes("Error") || result2.includes("not connected") || result2.includes("expired")) {
          tabErrors.push(range.split("!")[0]);
          return "";
        }
        return result2;
      } catch {
        tabErrors.push(range.split("!")[0]);
        return "";
      }
    };
    const [timelineResult, apptResult, tasksResult, shoppingResult, namesResult] = await Promise.all([
      readTab("Timeline!A1:F19"),
      readTab("Appointments!A1:E14"),
      readTab("To-Do List!A1:F23"),
      readTab("Shopping List!A1:F40"),
      readTab("Baby Names!A1:F16")
    ]);
    const timelineRows = parseRows2(timelineResult);
    let currentWeekData = null;
    const timelineWeeks = [];
    timelineRows.slice(1).forEach((r) => {
      const week = parseInt(r[0]?.trim()) || 0;
      const status = (r[5] || "").trim();
      const entry = {
        week,
        dates: r[1]?.trim() || "",
        trimester: r[2]?.trim() || "",
        development: r[3]?.trim() || "",
        rickin: r[4]?.trim() || "",
        status
      };
      timelineWeeks.push(entry);
      if (status.includes("\u2705") && status.toLowerCase().includes("current")) {
        currentWeekData = entry;
      }
    });
    const apptRows = parseRows2(apptResult);
    const appointments = apptRows.slice(1).filter((r) => r[0]).map((r) => {
      const status = (r[4] || "").trim();
      return {
        date: r[0]?.trim() || "",
        type: r[1]?.trim() || "",
        provider: r[2]?.trim() || "",
        notes: r[3]?.trim() || "",
        status,
        done: status.includes("\u2705")
      };
    });
    const taskRows = parseRows2(tasksResult);
    const tasks = taskRows.slice(1).filter((r) => r[0]).map((r) => {
      const status = (r[4] || "").trim();
      return {
        text: r[0]?.trim() || "",
        category: r[1]?.trim() || "",
        dueWeek: r[2]?.trim() || "",
        owner: r[3]?.trim() || "",
        status,
        notes: r[5]?.trim() || "",
        done: status.includes("\u2705"),
        inProgress: status.includes("\u{1F504}")
      };
    });
    const shoppingRows = parseRows2(shoppingResult);
    const shoppingItems = shoppingRows.slice(1).filter((r) => r[1]);
    const shopping = shoppingItems.map((r) => {
      const status = (r[3] || "").trim();
      return {
        category: r[0]?.trim() || "",
        item: r[1]?.trim() || "",
        priority: r[2]?.trim() || "",
        status,
        budget: r[4]?.trim() || "",
        notes: r[5]?.trim() || "",
        done: status.includes("\u2705"),
        inProgress: status.includes("\u{1F504}")
      };
    });
    const nameRows = parseRows2(namesResult);
    const favNames = [];
    const otherNames = [];
    nameRows.slice(1).filter((r) => r[0]).forEach((r) => {
      const nameVal = (r[0] || "").trim();
      if (nameVal === "\u2B50 FAVORITES" || nameVal === "\u{1F4CB} SHORTLIST" || !nameVal) return;
      const entry = {
        name: nameVal,
        meaning: r[1]?.trim() || "",
        origin: r[2]?.trim() || "",
        notes: r[5]?.trim() || ""
      };
      const rickinFav = (r[3] || "").trim();
      const poojaFav = (r[4] || "").trim();
      if (rickinFav.includes("\u2B50") || rickinFav.includes("\u{1F195}") || poojaFav.includes("\u2B50")) {
        favNames.push(entry);
      } else {
        otherNames.push(entry);
      }
    });
    const tasksDone = tasks.filter((t) => t.done).length;
    const shoppingDone = shopping.filter((s) => s.done).length;
    const apptsUpcoming = appointments.filter((a) => !a.done && !a.status.includes("\u{1F38A}")).length;
    const allFailed = tabErrors.length === 5;
    if (allFailed) {
      res.status(502).json({ error: "sheets_unavailable", message: "All sheet reads failed", errors: tabErrors });
      return;
    }
    const result = {
      timeline: { currentWeek: currentWeekData, weeks: timelineWeeks },
      appointments,
      tasks,
      shopping,
      names: { fav: favNames, other: otherNames },
      counters: {
        shoppingDone: `${shoppingDone}/${shoppingItems.length}`,
        tasksDone: `${tasksDone}/${tasks.length}`,
        apptsUpcoming
      },
      sync: {
        source: "live",
        partial: tabErrors.length > 0,
        errors: tabErrors
      },
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    babyDashboardCache = { data: result, timestamp: Date.now() };
    res.json(result);
  } catch (err) {
    console.error("[baby-dashboard] API error:", err.message);
    res.status(500).json({ error: "fetch_failed", message: "Failed to fetch dashboard data" });
  }
});
app.get("/api/baby-dashboard/status", async (_req, res) => {
  const connected = isConnected();
  let tokenValid = false;
  if (connected) {
    try {
      const token = await getAccessToken();
      tokenValid = !!token;
    } catch {
    }
  }
  res.json({
    googleConnected: connected,
    tokenValid,
    cacheAge: babyDashboardCache ? Math.round((Date.now() - babyDashboardCache.timestamp) / 1e3) : null,
    reconnectUrl: !tokenValid ? "/api/gmail/auth" : null
  });
});
app.get("/pages/:slug", async (req, res) => {
  const slug = req.params.slug.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!slug) {
    res.status(400).send("Invalid page slug.");
    return;
  }
  const filePath = path4.join(PAGES_DIR, `${slug}.html`);
  if (!fs3.existsSync(filePath)) {
    res.status(404).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not Found</title><style>body{font-family:-apple-system,sans-serif;background:#0a0a0a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}h1{font-size:1.2rem;color:#888}</style></head><body><h1>Page not found.</h1></body></html>`);
    return;
  }
  const isTokenAuth = !!(req.query.user && req.query.token) || !!req.headers.authorization?.startsWith("Bearer ");
  if (slug === "baby-dashboard" && isTokenAuth && isConnected()) {
    try {
      let html = fs3.readFileSync(filePath, "utf-8");
      let data = babyDashboardCache?.data;
      if (!data || Date.now() - (babyDashboardCache?.timestamp || 0) > BABY_CACHE_TTL) {
        let parseRows2 = function(raw) {
          if (!raw || raw.includes("No data")) return [];
          return raw.split("\n").filter((l) => l.startsWith("Row ")).map((l) => l.replace(/^Row \d+: /, "").split(" | "));
        };
        var parseRows = parseRows2;
        const readTab = async (range) => {
          try {
            const result = await sheetsRead(BABY_SHEET_ID2, range);
            if (result.includes("Error") || result.includes("not connected")) return "";
            return result;
          } catch {
            return "";
          }
        };
        const [timelineResult, apptResult, tasksResult, shoppingResult, namesResult] = await Promise.all([
          readTab("Timeline!A1:F19"),
          readTab("Appointments!A1:E14"),
          readTab("To-Do List!A1:F23"),
          readTab("Shopping List!A1:F40"),
          readTab("Baby Names!A1:F16")
        ]);
        const apptRows = parseRows2(apptResult);
        const appointments = apptRows.slice(1).filter((r) => r[0]).map((r) => ({
          title: (r[1] || "").trim(),
          date: (r[0] || "").trim(),
          time: "",
          detail: (r[3] || "").trim(),
          status: (r[4] || "").trim()
        }));
        const taskRows = parseRows2(tasksResult);
        const tasks = taskRows.slice(1).filter((r) => r[0]).map((r) => {
          const status = (r[4] || "").trim();
          return { text: (r[0] || "").trim(), priority: "medium", week: parseInt(r[2]) || 0, done: status.includes("\u2705"), owner: (r[3] || "").trim(), category: (r[1] || "").trim() };
        });
        const shoppingRows = parseRows2(shoppingResult);
        const shoppingItems = shoppingRows.slice(1).filter((r) => r[1]);
        const shoppingDone = shoppingItems.filter((r) => (r[3] || "").includes("\u2705")).length;
        const tasksDone = tasks.filter((t) => t.done).length;
        const timelineRows = parseRows2(timelineResult);
        let currentWeekData = null;
        timelineRows.slice(1).forEach((r) => {
          const status = (r[5] || "").trim();
          if (status.includes("\u2705") && status.toLowerCase().includes("current")) {
            currentWeekData = { week: parseInt(r[0]) || 0, development: (r[3] || "").trim(), rickin: (r[4] || "").trim() };
          }
        });
        const nameRows = parseRows2(namesResult);
        const favNames = [], otherNames = [];
        nameRows.slice(1).filter((r) => r[0]).forEach((r) => {
          const n = (r[0] || "").trim();
          if (n === "\u2B50 FAVORITES" || n === "\u{1F4CB} SHORTLIST" || !n) return;
          const entry = { name: n, meaning: (r[1] || "").trim() };
          if ((r[3] || "").includes("\u2B50") || (r[3] || "").includes("\u{1F195}") || (r[4] || "").includes("\u2B50")) favNames.push(entry);
          else otherNames.push(entry);
        });
        const apptJson = JSON.stringify(appointments);
        const tasksJson = JSON.stringify(tasks);
        const checklistJson = JSON.stringify({ shoppingDone: `${shoppingDone}/${shoppingItems.length}`, tasksDone: `${tasksDone}/${tasks.length}` });
        html = html.replace(/<script id="appt-data"[^>]*>.*?<\/script>/s, `<script id="appt-data" type="application/json">${apptJson}</script>`);
        html = html.replace(/<script id="tasks-data"[^>]*>.*?<\/script>/s, `<script id="tasks-data" type="application/json">${tasksJson}</script>`);
        html = html.replace(/<script id="checklist-data"[^>]*>.*?<\/script>/s, `<script id="checklist-data" type="application/json">${checklistJson}</script>`);
        if (currentWeekData) {
          html = html.replace(/id="devNote">[^<]*</s, `id="devNote">${currentWeekData.development}<`);
          html = html.replace(/id="milestoneNote">[^<]*</s, `id="milestoneNote">${currentWeekData.milestone}<`);
        }
        if (favNames.length) {
          const favStr = favNames.map((n) => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${n.meaning.replace(/'/g, "\\'")}'}`).join(",");
          html = html.replace(/var defaultFavNames\s*=\s*\[.*?\];/s, `var defaultFavNames = [${favStr}];`);
        }
        if (otherNames.length) {
          const otherStr = otherNames.map((n) => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${n.meaning.replace(/'/g, "\\'")}'}`).join(",");
          html = html.replace(/var defaultOtherNames\s*=\s*\[.*?\];/s, `var defaultOtherNames = [${otherStr}];`);
        }
      } else {
        const apptJson = JSON.stringify((data.appointments || []).map((a) => ({
          title: a.type || a.title,
          date: a.date,
          time: a.time || "",
          detail: a.notes || a.detail || "",
          status: a.status || ""
        })));
        const tasksJson = JSON.stringify((data.tasks || []).map((t) => ({
          text: t.text,
          priority: "medium",
          week: parseInt(t.dueWeek) || 0,
          done: t.done,
          owner: t.owner || "",
          category: t.category || ""
        })));
        const checklistJson = JSON.stringify(data.counters || {});
        html = html.replace(/<script id="appt-data"[^>]*>.*?<\/script>/s, `<script id="appt-data" type="application/json">${apptJson}</script>`);
        html = html.replace(/<script id="tasks-data"[^>]*>.*?<\/script>/s, `<script id="tasks-data" type="application/json">${tasksJson}</script>`);
        html = html.replace(/<script id="checklist-data"[^>]*>.*?<\/script>/s, `<script id="checklist-data" type="application/json">${checklistJson}</script>`);
        if (data.timeline?.currentWeek) {
          html = html.replace(/id="devNote">[^<]*</s, `id="devNote">${data.timeline.currentWeek.development || ""}<`);
          html = html.replace(/id="milestoneNote">[^<]*</s, `id="milestoneNote">${data.timeline.currentWeek.milestone || ""}<`);
        }
        if (data.names?.fav?.length) {
          const favStr = data.names.fav.map((n) => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${(n.meaning || "").replace(/'/g, "\\'")}'}`).join(",");
          html = html.replace(/var defaultFavNames\s*=\s*\[.*?\];/s, `var defaultFavNames = [${favStr}];`);
        }
        if (data.names?.other?.length) {
          const otherStr = data.names.other.map((n) => `{name:'${n.name.replace(/'/g, "\\'")}',meaning:'${(n.meaning || "").replace(/'/g, "\\'")}'}`).join(",");
          html = html.replace(/var defaultOtherNames\s*=\s*\[.*?\];/s, `var defaultOtherNames = [${otherStr}];`);
        }
      }
      res.type("html").send(html);
      return;
    } catch (err) {
      console.error("[baby-dashboard] SSR error:", err);
    }
  }
  res.sendFile(filePath);
});
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
var cachedStaticTools = [
  ...buildGmailTools(),
  ...buildCalendarTools(),
  ...buildWeatherTools(),
  ...buildSearchTools(),
  ...buildWebFetchTools(),
  ...buildImageTools(),
  ...buildRenderPageTools(),
  ...buildTaskTools(),
  ...buildNewsTools(),
  ...buildTwitterTools(),
  ...buildStockTools(),
  ...buildMapsTools(),
  ...buildDriveTools(),
  ...buildSheetsTools(),
  ...buildDocsTools(),
  ...buildSlidesTools(),
  ...buildYouTubeTools(),
  ...buildRealEstateTools(),
  ...buildConversationTools(),
  ...buildWebPublishTools()
];
{
  const kbToolNames = buildKnowledgeBaseTools().map((t) => t.name);
  const staticToolNames = cachedStaticTools.map((t) => t.name);
  setRegisteredTools([...kbToolNames, ...staticToolNames]);
}
app.post("/api/session", async (req, res) => {
  try {
    const { resumeConversationId } = req.body || {};
    const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const authStorage = AuthStorage.create(path4.join(AGENT_DIR, "auth.json"));
    authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_KEY);
    const modelRegistry = new ModelRegistry(authStorage, path4.join(AGENT_DIR, "models.json"));
    const fullModel = modelRegistry.find("anthropic", FULL_MODEL_ID);
    if (!fullModel) throw new Error(`Model ${FULL_MODEL_ID} not found in registry`);
    const coreTools = [
      ...buildKnowledgeBaseTools(),
      ...cachedStaticTools,
      ...buildInterviewTool(sessionId)
    ];
    const allTools = [
      ...coreTools,
      ...buildAgentTools(() => coreTools, sessionId)
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
    let resumedMessages = [];
    if (resumeConversationId) {
      const oldConv = await load(resumeConversationId);
      if (oldConv && oldConv.messages.length > 0) {
        for (const msg of oldConv.messages) {
          addMessage(conv, msg.role, msg.text);
        }
        resumedMessages = oldConv.messages;
        conv.title = oldConv.title;
        console.log(`[session] Resuming conversation "${oldConv.title}" with ${oldConv.messages.length} messages`);
        await remove(resumeConversationId);
      }
    }
    const entry = {
      session,
      subscribers: /* @__PURE__ */ new Set(),
      createdAt: Date.now(),
      conversation: conv,
      currentAgentText: "",
      currentToolName: null,
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
      if (event.type === "tool_execution_start") {
        entry.currentToolName = event.toolName || null;
      } else if (event.type === "tool_execution_end") {
        entry.currentToolName = null;
      }
      if (event.type === "agent_end") {
        entry.isAgentRunning = false;
        entry.currentToolName = null;
        if (entry.currentAgentText) {
          addMessage(entry.conversation, "agent", entry.currentAgentText);
          entry.currentAgentText = "";
        }
        save(entry.conversation).catch((err) => console.error("[conversations] save error:", err));
        syncConversationToVault(entry.conversation);
        const nonSystem = entry.conversation.messages.filter((m) => m.role !== "system");
        if (nonSystem.length >= 2 && nonSystem.length <= 4) {
          generateTitle(entry.conversation).then((title) => {
            if (title) {
              save(entry.conversation).catch((err) => console.error("[conversations] title save error:", err));
            }
          }).catch((err) => console.warn("[conversations] title generation error:", err));
        }
        processNextPendingMessage(sessionId);
      }
    });
    let combinedContext;
    if (resumeConversationId && resumedMessages.length > 0) {
      const lastN = resumedMessages.slice(-20);
      const formatted = lastN.map((m) => {
        const role = m.role === "user" ? "RICKIN" : m.role === "agent" ? "YOU" : "SYSTEM";
        const text = m.text.length > 800 ? m.text.slice(0, 800) + "\u2026" : m.text;
        return `${role}: ${text}`;
      }).join("\n\n");
      const resumeContext = `[RESUMED CONVERSATION: "${conv.title}"]
Rickin is picking up exactly where you left off. This is a continuation \u2014 treat any references like "it", "that", "this" as referring to the topic below. Here are the last ${lastN.length} messages:

${formatted}

IMPORTANT: When Rickin says something brief like "test it", "try again", "do it", etc., it refers to whatever you were last discussing above. Do NOT start a new unrelated topic.`;
      const vaultIndex = await getVaultIndex();
      combinedContext = [resumeContext, vaultIndex].filter(Boolean).join("\n\n---\n\n");
    } else {
      const recentSummary = await getRecentSummary(5);
      const lastConvoContext = await getLastConversationContext(10);
      const vaultIndex = await getVaultIndex();
      combinedContext = [lastConvoContext, recentSummary, vaultIndex].filter(Boolean).join("\n\n---\n\n") || null;
    }
    entry.startupContext = combinedContext || void 0;
    res.json({ sessionId, recentContext: combinedContext, messages: resumedMessages });
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
    res.write(`data: ${JSON.stringify({ type: "ping" })}

`);
  }, 15e3);
  entry.subscribers.add(res);
  req.on("close", () => {
    clearInterval(heartbeat);
    entry.subscribers.delete(res);
    if (entry.subscribers.size === 0 && entry.isAgentRunning && entry.currentAgentText) {
      console.log(`[sse] All subscribers dropped while agent running \u2014 saving partial text (${entry.currentAgentText.length} chars)`);
      addMessage(entry.conversation, "agent", entry.currentAgentText + "\n\n\u26A0\uFE0F *Connection dropped \u2014 response may be incomplete. Ask me to continue if needed.*");
      entry.currentAgentText = "";
      save(entry.conversation).catch((err) => console.error("[conversations] partial save error:", err));
    }
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
    currentToolName: entry.currentToolName,
    messages: entry.conversation.messages,
    pendingCount: entry.pendingMessages.length,
    pendingInterview: entry.pendingInterviewForm || null
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
  await save(entry.conversation);
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
  const hasImages = images && images.length > 0;
  if (entry.modelMode === "max") {
    chosenModelId = MAX_MODEL_ID;
  } else if (hasImages) {
    chosenModelId = FULL_MODEL_ID;
  } else if (entry.modelMode === "fast") {
    chosenModelId = FAST_MODEL_ID;
  } else if (entry.modelMode === "auto") {
    const intent = classifyIntent(text);
    chosenModelId = intent === "fast" ? FAST_MODEL_ID : intent === "max" ? MAX_MODEL_ID : FULL_MODEL_ID;
  }
  if (chosenModelId !== entry.activeModelName) {
    try {
      const authStorage = AuthStorage.create(path4.join(AGENT_DIR, "auth.json"));
      authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_KEY);
      const modelRegistry = new ModelRegistry(authStorage, path4.join(AGENT_DIR, "models.json"));
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
  entry.currentAgentText = "";
  const startEvent = JSON.stringify({ type: "agent_start" });
  for (const sub of entry.subscribers) {
    try {
      sub.write(`data: ${startEvent}

`);
    } catch {
    }
  }
  if (hasImages) {
    const totalB64 = images.reduce((sum, i) => sum + i.data.length, 0);
    const mimeTypes = images.map((i) => i.mimeType).join(", ");
    console.log(`[prompt] ${images.length} image(s), ~${Math.round(totalB64 / 1024)}KB base64, types: ${mimeTypes}`);
  }
  const promptStart = Date.now();
  const sessionId = req.params["id"];
  const etNow = (/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
  let augmentedText = `[Current date/time in Rickin's timezone (Eastern): ${etNow}]

`;
  if (entry.startupContext) {
    augmentedText += `[Session Context]
${entry.startupContext}

`;
    entry.startupContext = void 0;
  }
  augmentedText += text;
  const promptImages = images?.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
  const PROMPT_TIMEOUT = 9e5;
  const actualPromise = entry.session.prompt(augmentedText, promptImages ? { images: promptImages } : void 0);
  const timeoutPromise = new Promise(
    (_, reject) => setTimeout(() => reject(new Error("Response timed out after 15 minutes")), PROMPT_TIMEOUT)
  );
  try {
    await Promise.race([actualPromise, timeoutPromise]);
    console.log(`[prompt] completed in ${((Date.now() - promptStart) / 1e3).toFixed(1)}s`);
    entry.isAgentRunning = false;
    entry.currentToolName = null;
    processNextPendingMessage(sessionId);
  } catch (err) {
    const elapsed = ((Date.now() - promptStart) / 1e3).toFixed(1);
    const isTimeout = String(err).includes("timed out");
    console.error(`[prompt] ${isTimeout ? "timeout" : "error"} after ${elapsed}s:`, err);
    const errEvent = JSON.stringify({ type: isTimeout ? "timeout" : "error", error: String(err) });
    for (const sub of entry.subscribers) {
      try {
        sub.write(`data: ${errEvent}

`);
      } catch {
      }
    }
    if (isTimeout) {
      console.log(`[prompt] agent still running in background \u2014 new messages will be queued`);
      actualPromise.then(() => {
        console.log(`[prompt] background prompt finally completed after ${((Date.now() - promptStart) / 1e3).toFixed(1)}s total`);
        entry.isAgentRunning = false;
        entry.currentToolName = null;
        processNextPendingMessage(sessionId);
      }).catch(() => {
        console.log(`[prompt] background prompt failed after ${((Date.now() - promptStart) / 1e3).toFixed(1)}s total`);
        entry.isAgentRunning = false;
        entry.currentToolName = null;
        processNextPendingMessage(sessionId);
      });
    } else {
      entry.isAgentRunning = false;
      entry.currentToolName = null;
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
  if (!mode || !["auto", "fast", "full", "max"].includes(mode)) {
    res.status(400).json({ error: "mode must be auto, fast, full, or max" });
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
    entry.pendingInterviewForm = void 0;
    console.log(`[interview] Received ${responses.length} responses for session ${req.params["id"]}`);
    res.json({ ok: true });
  } else {
    res.status(410).json({ error: "Form expired or already submitted" });
  }
});
app.delete("/api/session/:id", async (req, res) => {
  await saveAndCleanSession(req.params["id"]);
  res.json({ ok: true });
});
app.get("/api/conversations/search", async (req, res) => {
  const q = req.query["q"] || "";
  if (!q.trim()) {
    res.json([]);
    return;
  }
  const before = req.query["before"] ? Number(req.query["before"]) : void 0;
  const after = req.query["after"] ? Number(req.query["after"]) : void 0;
  const results = await search(q, { before, after });
  res.json(results);
});
app.get("/api/conversations", async (_req, res) => {
  res.json(await list());
});
app.get("/api/conversations/:id", async (req, res) => {
  const conv = await load(req.params["id"]);
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.json(conv);
});
app.delete("/api/conversations/:id", async (req, res) => {
  await remove(req.params["id"]);
  res.json({ ok: true });
});
app.get("/api/tasks", async (_req, res) => {
  try {
    const active = await getActiveTasks();
    res.json(active);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.post("/api/tasks", async (req, res) => {
  try {
    const { title, priority, dueDate } = req.body;
    if (!title || !title.trim()) {
      res.status(400).json({ error: "title required" });
      return;
    }
    await addTask(title.trim(), { priority, dueDate });
    glanceCache = null;
    const active = await getActiveTasks();
    const created = active.find((t) => t.title === title.trim());
    res.json({ ok: true, task: created || { title: title.trim(), priority: priority || "medium", dueDate } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.patch("/api/tasks/:id/complete", async (req, res) => {
  try {
    const result = await completeTask(req.params["id"]);
    glanceCache = null;
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.delete("/api/tasks/:id", async (req, res) => {
  try {
    const result = await deleteTask(req.params["id"]);
    glanceCache = null;
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.get("/api/tasks/completed", async (_req, res) => {
  try {
    const completed = await getCompletedTasks();
    res.json(completed);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.get("/api/agents/status", (_req, res) => {
  const runningJob = getRunningJob();
  const activeSessions = [];
  for (const [id, entry] of sessions.entries()) {
    if (entry.isAgentRunning) {
      activeSessions.push({ id, running: true, tool: entry.currentToolName || void 0 });
    }
  }
  res.json({
    job: runningJob,
    sessions: activeSessions,
    anyActive: runningJob.running || activeSessions.length > 0
  });
});
app.get("/api/scheduled-jobs", (_req, res) => {
  res.json(getJobs());
});
app.put("/api/scheduled-jobs", (req, res) => {
  try {
    const body = req.body;
    if (body.jobs) {
      updateConfig2({ jobs: body.jobs });
    }
    res.json({ ok: true, jobs: getJobs() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.put("/api/scheduled-jobs/:id", (req, res) => {
  try {
    const body = req.body;
    if (body.schedule) {
      const { hour, minute } = body.schedule;
      if (hour !== void 0 && (hour < 0 || hour > 23)) {
        res.status(400).json({ error: "hour must be 0-23" });
        return;
      }
      if (minute !== void 0 && (minute < 0 || minute > 59)) {
        res.status(400).json({ error: "minute must be 0-59" });
        return;
      }
    }
    if (body.name && body.name.length > 100) {
      res.status(400).json({ error: "name too long" });
      return;
    }
    if (body.prompt && body.prompt.length > 5e3) {
      res.status(400).json({ error: "prompt too long" });
      return;
    }
    const result = updateJob(req.params["id"], body);
    if (!result) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json({ ok: true, job: result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.post("/api/scheduled-jobs", (req, res) => {
  try {
    const { name, agentId, prompt, schedule, enabled } = req.body;
    if (!name || !agentId || !prompt) {
      res.status(400).json({ error: "name, agentId, and prompt required" });
      return;
    }
    if (name.length > 100) {
      res.status(400).json({ error: "name too long" });
      return;
    }
    if (prompt.length > 5e3) {
      res.status(400).json({ error: "prompt too long" });
      return;
    }
    const sched = schedule || { type: "daily", hour: 8, minute: 0 };
    if (sched.hour < 0 || sched.hour > 23 || sched.minute < 0 || sched.minute > 59) {
      res.status(400).json({ error: "invalid schedule time" });
      return;
    }
    const job = addJob({ name, agentId, prompt, schedule: sched, enabled: enabled || false });
    res.json({ ok: true, job });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.delete("/api/scheduled-jobs/:id", (req, res) => {
  try {
    const removed = removeJob(req.params["id"]);
    if (!removed) {
      res.status(404).json({ error: "Job not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.get("/api/scheduled-jobs/history", async (_req, res) => {
  try {
    const limit = Math.max(1, Math.min(parseInt(_req.query.limit) || 20, 100));
    const history = await getJobHistory(limit);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.post("/api/scheduled-jobs/:id/trigger", async (req, res) => {
  try {
    res.json({ ok: true, status: "started" });
    triggerJob(req.params["id"]).catch((err) => {
      console.error(`[scheduled-jobs] Manual trigger failed:`, err);
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});
app.patch("/api/tasks/:id/restore", async (req, res) => {
  try {
    const result = await restoreTask(req.params["id"]);
    glanceCache = null;
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
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
        const feelsMatch = raw.match(/Feels like:\s*([\d.-]+)°C/);
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
          const w = { tempC: Math.round(parseFloat(tempMatch[1])), condition, icon };
          if (feelsMatch) w.feelsLikeC = Math.round(parseFloat(feelsMatch[1]));
          const forecastLines = raw.match(/\d{4}-\d{2}-\d{2}:\s*.+/g);
          if (forecastLines) {
            w.forecast = forecastLines.map((line) => {
              const m = line.match(/(\d{4}-\d{2}-\d{2}):\s*(.+?),\s*([\d-]+)-([\d-]+)°C.*?Rain:\s*(\d+)%/);
              if (!m) return null;
              return { date: m[1], condition: m[2].trim(), lowC: parseInt(m[3]), highC: parseInt(m[4]), rainPct: parseInt(m[5]) };
            }).filter(Boolean);
          }
          result.weather = w;
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
        const active = await getActiveTasks();
        result.tasks = { active: active.length, items: active };
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
          const eodTomorrowInTz = new Date(Date.UTC(nowShifted.getUTCFullYear(), nowShifted.getUTCMonth(), nowShifted.getUTCDate() + 1, 23, 59, 59, 999));
          const endOfTomorrowUTC = new Date(eodTomorrowInTz.getTime() - tzOffsetMs);
          const events = await listEventsStructured({ maxResults: 5, timeMax: endOfTomorrowUTC.toISOString() });
          if (events.length > 0) {
            result.nextEvent = events[0];
            result.upcomingEvents = events.slice(0, 5);
          }
        } catch {
        }
      })());
    }
    promises.push((async () => {
      try {
        const headlines = await getTopHeadlines(3);
        if (headlines.length > 0) result.headlines = headlines;
      } catch {
      }
    })());
    await Promise.all(promises);
    const allJobs = getJobs();
    const enabledJobs = allJobs.filter((j) => j.enabled);
    const jobItems = enabledJobs.map((j) => ({
      name: j.name,
      id: j.id,
      status: j.lastStatus || null,
      lastRun: j.lastRun || null
    }));
    const okCount = jobItems.filter((j) => j.status === "success").length;
    const partialCount = jobItems.filter((j) => j.status === "partial").length;
    const failedCount = jobItems.filter((j) => j.status === "error").length;
    result.jobs = { total: enabledJobs.length, ok: okCount, partial: partialCount, failed: failedCount, items: jobItems };
    result.nextJob = getNextJob();
    glanceCache = { data: result, ts: Date.now() };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch glance data" });
  }
});
app.get("/api/kb-status", (_req, res) => {
  res.json({ online: useLocalVault || lastTunnelStatus, mode: useLocalVault ? "local" : "remote" });
});
var obSyncProcess = null;
function startObSync() {
  const vaultPath2 = path4.join(process.cwd(), "data", "vault");
  const logPath = "/tmp/obsidian-sync.log";
  if (obSyncProcess) {
    try {
      obSyncProcess.kill();
    } catch {
    }
    obSyncProcess = null;
  }
  try {
    execSync("pgrep -f 'ob sync' 2>/dev/null && pkill -f 'ob sync'", { encoding: "utf-8" });
  } catch {
  }
  const logFd = fs3.openSync(logPath, "a");
  const child = spawn("ob", ["sync", "--continuous", "--path", vaultPath2], {
    stdio: ["ignore", logFd, logFd],
    detached: false
  });
  child.on("error", (err) => {
    console.error("[sync] ob sync failed to start:", err.message);
    obSyncProcess = null;
  });
  child.on("exit", (code) => {
    console.warn(`[sync] ob sync exited with code ${code} \u2014 restarting in 10s`);
    obSyncProcess = null;
    setTimeout(() => {
      if (!obSyncProcess) startObSync();
    }, 1e4);
  });
  obSyncProcess = child;
  console.log(`[sync] ob sync started (pid ${child.pid})`);
}
function getSyncStatus() {
  const logPath = "/tmp/obsidian-sync.log";
  const lastChecked = (/* @__PURE__ */ new Date()).toISOString();
  try {
    const content = fs3.readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n").filter((l) => l.trim());
    if (lines.length === 0) return { running: false, status: "not_running", lastLine: "", lastChecked };
    const lastLine = lines[lines.length - 1].trim();
    let running = true;
    let status = "unknown";
    if (/fully synced/i.test(lastLine)) status = "synced";
    else if (/upload complete/i.test(lastLine)) status = "synced";
    else if (/uploading/i.test(lastLine)) status = "uploading";
    else if (/download complete/i.test(lastLine)) status = "synced";
    else if (/downloading/i.test(lastLine)) status = "downloading";
    else if (/connection successful/i.test(lastLine)) status = "connected";
    else if (/connecting/i.test(lastLine)) status = "connecting";
    else if (/error|failed|disconnect/i.test(lastLine)) {
      status = "error";
      running = false;
    }
    try {
      const { execSync: execSync2 } = __require("child_process");
      const ps = execSync2("pgrep -f 'ob sync' 2>/dev/null", { encoding: "utf-8" }).trim();
      running = ps.length > 0;
    } catch {
      running = false;
    }
    return { running, status, lastLine, lastChecked };
  } catch {
    return { running: false, status: "not_running", lastLine: "no log file", lastChecked };
  }
}
app.get("/api/sync-status", (_req, res) => {
  res.json(getSyncStatus());
});
var lastSyncLogStatus = "";
setInterval(() => {
  const sync = getSyncStatus();
  const key = `${sync.running}:${sync.status}`;
  if (key !== lastSyncLogStatus) {
    const icon = sync.running ? "\u25CF" : "\u25CB";
    console.log(`[sync] ${icon} ob sync ${sync.running ? "running" : "stopped"} \u2014 ${sync.status}${sync.status === "error" ? ": " + sync.lastLine : ""}`);
    lastSyncLogStatus = key;
  }
}, 6e4);
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
async function buildVaultTree(dir) {
  const entries = await fs3.promises.readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const children = await buildVaultTree(path4.join(dir, entry.name));
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
function formatVaultIndex(entries, indent = 0) {
  const lines = [];
  for (const entry of entries) {
    const prefix = "  ".repeat(indent);
    if (entry.type === "folder") {
      lines.push(`${prefix}${entry.name}/`);
      if (entry.children) {
        lines.push(formatVaultIndex(entry.children, indent + 1));
      }
    } else {
      lines.push(`${prefix}${entry.name}`);
    }
  }
  return lines.filter(Boolean).join("\n");
}
async function getVaultIndex() {
  try {
    const tree = await buildVaultTree(VAULT_DIR);
    return `## Vault Index (all folders and files)
${formatVaultIndex(tree)}`;
  } catch {
    return "";
  }
}
app.get("/api/vault-tree", async (_req, res) => {
  try {
    const tree = await buildVaultTree(VAULT_DIR);
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
async function gracefulShutdown(signal) {
  console.error(`Got ${signal} \u2014 closing server...`);
  if (obSyncProcess) {
    try {
      obSyncProcess.kill();
    } catch {
    }
    obSyncProcess = null;
  }
  stopJobSystem();
  const ids = [...sessions.keys()];
  if (ids.length > 0) {
    console.error(`[shutdown] Saving ${ids.length} active session(s)...`);
    const results = await Promise.allSettled(ids.map((id) => saveAndCleanSession(id)));
    const saved = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;
    console.error(`[shutdown] Sessions saved: ${saved}, failed: ${failed}`);
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(1);
  }, 5e3);
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
  await init2();
  await init3();
  await init4();
  await init5();
  await init6();
  await init7();
  console.log("[boot] PostgreSQL ready (shared pool, 4 tables)");
  checkConnectionStatus().then((status) => {
    if (status.connected) console.log(`[boot] Google connected: ${status.email} (Gmail, Calendar, Drive, Sheets)`);
    else console.warn(`[boot] Google not connected: ${status.error}`);
  }).catch(() => {
  });
  setInterval(async () => {
    try {
      const token = await getAccessToken();
      if (token) {
        console.log("[google-health] Token valid \u2014 auto-refreshed successfully");
      } else {
        console.warn("[google-health] Token refresh failed \u2014 Google auth needs reconnection at /api/gmail/auth");
      }
    } catch (err) {
      console.error("[google-health] Auth check failed:", err.message);
    }
  }, 6 * 60 * 60 * 1e3);
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
          startObSync();
          startAlertSystem(broadcastToAll, async (briefPath, content) => {
            try {
              await kbCreate(briefPath, content);
            } catch (err) {
              console.error(`[alerts] Vault save failed for ${briefPath}:`, err);
            }
          });
          startJobSystem(
            async (agentId, task, onProgress) => {
              const agentTools = [
                ...buildKnowledgeBaseTools(),
                ...cachedStaticTools
              ];
              const result = await runSubAgent({
                agentId,
                task,
                allTools: agentTools,
                apiKey: ANTHROPIC_KEY,
                onProgress
              });
              return { response: result.response, timedOut: result.timedOut };
            },
            broadcastToAll,
            async (path5, content) => {
              try {
                await kbCreate(path5, content);
              } catch (err) {
                console.error(`[scheduled-jobs] Vault save failed for ${path5}:`, err);
              }
            },
            async (path5) => kbList(path5),
            async (from, to) => kbMove(from, to),
            () => getPool()
          );
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
