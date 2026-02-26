// server.ts
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { fileURLToPath } from "url";
import path2 from "path";
import fs2 from "fs";
import { createProxyMiddleware } from "http-proxy-middleware";
import cookieParser from "cookie-parser";
import crypto from "crypto";
import {
  createAgentSession,
  AuthStorage,
  SessionManager,
  SettingsManager
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
var connectionSettings;
async function getAccessToken() {
  if (connectionSettings?.settings?.access_token && connectionSettings.settings.expires_at) {
    const expiresAt = new Date(connectionSettings.settings.expires_at).getTime();
    if (expiresAt > Date.now() + 6e4) {
      return connectionSettings.settings.access_token;
    }
  }
  connectionSettings = null;
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY ? "repl " + process.env.REPL_IDENTITY : process.env.WEB_REPL_RENEWAL ? "depl " + process.env.WEB_REPL_RENEWAL : null;
  if (!xReplitToken) {
    throw new Error("X-Replit-Token not found for repl/depl");
  }
  connectionSettings = await fetch(
    "https://" + hostname + "/api/v2/connection?include_secrets=true&connector_names=google-mail",
    {
      headers: {
        Accept: "application/json",
        "X-Replit-Token": xReplitToken
      }
    }
  ).then((res) => res.json()).then((data) => data.items?.[0]);
  const accessToken = connectionSettings?.settings?.access_token || connectionSettings.settings?.oauth?.credentials?.access_token;
  if (!connectionSettings || !accessToken) {
    throw new Error("Gmail not connected");
  }
  return accessToken;
}
async function getGmailClient() {
  const accessToken = await getAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.gmail({ version: "v1", auth: oauth2Client });
}
function isConfigured2() {
  return !!(process.env.REPLIT_CONNECTORS_HOSTNAME && (process.env.REPL_IDENTITY || process.env.WEB_REPL_RENEWAL));
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
    if (msg.includes("not connected") || msg.includes("X-Replit-Token")) {
      return "Gmail is not connected. Please reconnect your Gmail account.";
    }
    return "Unable to check emails right now. Please try again shortly.";
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
    if (msg.includes("not connected") || msg.includes("X-Replit-Token")) {
      return "Gmail is not connected. Please reconnect your Gmail account.";
    }
    if (msg.includes("404") || msg.includes("Not Found")) {
      return "That email could not be found. It may have been deleted.";
    }
    return "Unable to read this email right now. Please try again shortly.";
  }
}
async function searchEmails(query) {
  return listEmails(query, 10);
}

// server.ts
var PORT = parseInt(process.env.PORT || "3000", 10);
var INTERVIEW_PORT = parseInt(process.env.INTERVIEW_PORT || "19847", 10);
var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
var APP_PASSWORD = process.env.APP_PASSWORD || "";
var SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
var __filename = fileURLToPath(import.meta.url);
var __dirname = path2.dirname(__filename);
var PROJECT_ROOT = __filename.includes("/dist/") ? path2.resolve(__dirname, "..") : __dirname;
var PUBLIC_DIR = path2.join(PROJECT_ROOT, "public");
var AGENT_DIR = path2.join(process.env.HOME || "/tmp", ".pi/agent");
var DATA_DIR = path2.join(PROJECT_ROOT, "data", "conversations");
fs2.mkdirSync(AGENT_DIR, { recursive: true });
init(DATA_DIR);
if (!ANTHROPIC_KEY) console.warn("ANTHROPIC_API_KEY is not set.");
if (!isConfigured()) console.warn("Knowledge base integration not configured.");
if (!isConfigured2()) console.warn("Gmail integration not configured.");
if (!APP_PASSWORD) console.warn("APP_PASSWORD is not set \u2014 auth disabled.");
console.log(`[boot] PORT=${PORT} PUBLIC_DIR=${PUBLIC_DIR} AGENT_DIR=${AGENT_DIR}`);
console.log(`[boot] public/ exists: ${fs2.existsSync(PUBLIC_DIR)}`);
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
app.post("/api/session", async (_req, res) => {
  try {
    const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const authStorage = AuthStorage.create(path2.join(AGENT_DIR, "auth.json"));
    authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_KEY);
    const { session } = await createAgentSession({
      agentDir: AGENT_DIR,
      authStorage,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      customTools: [...buildKnowledgeBaseTools(), ...buildGmailTools()]
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
