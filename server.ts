import express from "express";
import type { Request, Response, NextFunction } from "express";
import cors from "cors";
import { createServer } from "http";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import { createProxyMiddleware } from "http-proxy-middleware";
import cookieParser from "cookie-parser";
import crypto from "crypto";

import {
  createAgentSession,
  AuthStorage,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  type AgentSessionEvent,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import * as obsidian from "./src/obsidian.js";
import * as conversations from "./src/conversations.js";
import * as gmail from "./src/gmail.js";
import * as calendar from "./src/calendar.js";
import * as weather from "./src/weather.js";
import * as websearch from "./src/websearch.js";
import * as tasks from "./src/tasks.js";
import * as news from "./src/news.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const INTERVIEW_PORT = parseInt(process.env.INTERVIEW_PORT || "19847", 10);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = __filename.includes("/dist/") ? path.resolve(__dirname, "..") : __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const AGENT_DIR = path.join(PROJECT_ROOT, ".pi/agent");
const DATA_DIR = path.join(PROJECT_ROOT, "data", "conversations");

fs.mkdirSync(AGENT_DIR, { recursive: true });
conversations.init(DATA_DIR);
gmail.init(PROJECT_ROOT);
calendar.init(PROJECT_ROOT);
tasks.init(PROJECT_ROOT);

if (!ANTHROPIC_KEY) console.warn("ANTHROPIC_API_KEY is not set.");
if (!obsidian.isConfigured()) console.warn("Knowledge base integration not configured.");
if (!gmail.isConfigured()) console.warn("Gmail integration not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing).");
else if (!gmail.isConnected()) console.warn("Gmail configured but not yet authorized. Visit /api/gmail/auth to connect.");
if (!APP_PASSWORD) console.warn("APP_PASSWORD is not set — auth disabled.");

console.log(`[boot] PORT=${PORT} PUBLIC_DIR=${PUBLIC_DIR} AGENT_DIR=${AGENT_DIR}`);
console.log(`[boot] public/ exists: ${fs.existsSync(PUBLIC_DIR)}`);

function buildKnowledgeBaseTools(): ToolDefinition[] {
  if (!obsidian.isConfigured()) return [];

  return [
    {
      name: "notes_list",
      label: "Notes List",
      description: "List files and folders in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Directory path inside the knowledge base. Defaults to root." })),
      }),
      async execute(_toolCallId, params) {
        const result = await obsidian.listNotes(params.path ?? "/");
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "notes_read",
      label: "Notes Read",
      description: "Read the markdown content of a note in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the note, e.g. 'Daily Notes/2025-01-15.md'" }),
      }),
      async execute(_toolCallId, params) {
        const result = await obsidian.readNote(params.path);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "notes_create",
      label: "Notes Create",
      description: "Create or overwrite a note in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.String({ description: "Path for the new note, e.g. 'Ideas/new-idea.md'" }),
        content: Type.String({ description: "Markdown content for the note" }),
      }),
      async execute(_toolCallId, params) {
        const result = await obsidian.createNote(params.path, params.content);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "notes_append",
      label: "Notes Append",
      description: "Append content to the end of an existing note in the user's knowledge base.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the note to append to" }),
        content: Type.String({ description: "Markdown content to append" }),
      }),
      async execute(_toolCallId, params) {
        const result = await obsidian.appendToNote(params.path, params.content);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "notes_search",
      label: "Notes Search",
      description: "Search for text across all notes in the user's knowledge base. Returns matching notes and snippets.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query string" }),
      }),
      async execute(_toolCallId, params) {
        const result = await obsidian.searchNotes(params.query);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildGmailTools(): ToolDefinition[] {
  if (!gmail.isConfigured()) return [];

  return [
    {
      name: "email_list",
      label: "Email List",
      description: "List recent emails from the user's inbox. Optionally filter with a Gmail search query (e.g. 'is:unread', 'from:someone@example.com', 'subject:meeting').",
      parameters: Type.Object({
        query: Type.Optional(Type.String({ description: "Gmail search query to filter emails. Uses Gmail search syntax." })),
        maxResults: Type.Optional(Type.Number({ description: "Maximum number of emails to return (default 10, max 20)." })),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.listEmails(params.query, params.maxResults ?? 10);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "email_read",
      label: "Email Read",
      description: "Read the full content of a specific email by its message ID. Use email_list first to find the ID.",
      parameters: Type.Object({
        messageId: Type.String({ description: "The Gmail message ID to read (from email_list results)." }),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.readEmail(params.messageId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "email_search",
      label: "Email Search",
      description: "Search emails using Gmail search syntax. Supports queries like 'from:name subject:topic after:2025/01/01 has:attachment'.",
      parameters: Type.Object({
        query: Type.String({ description: "Gmail search query string." }),
      }),
      async execute(_toolCallId, params) {
        const result = await gmail.searchEmails(params.query);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildWeatherTools(): ToolDefinition[] {
  return [
    {
      name: "weather_get",
      label: "Weather",
      description: "Get current weather conditions and 3-day forecast for a location. Use city names, zip codes, or landmarks.",
      parameters: Type.Object({
        location: Type.String({ description: "Location to get weather for (e.g. 'New York', '90210', 'Tokyo')" }),
      }),
      async execute(_toolCallId, params) {
        const result = await weather.getWeather(params.location);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildSearchTools(): ToolDefinition[] {
  return [
    {
      name: "web_search",
      label: "Web Search",
      description: "Search the web for real-time information. Returns top results with titles, snippets, and URLs.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
      }),
      async execute(_toolCallId, params) {
        const result = await websearch.search(params.query);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildCalendarTools(): ToolDefinition[] {
  if (!calendar.isConfigured()) return [];

  return [
    {
      name: "calendar_list",
      label: "Calendar Events",
      description: "List upcoming calendar events. Can filter by date range.",
      parameters: Type.Object({
        maxResults: Type.Optional(Type.Number({ description: "Maximum number of events to return (default 10)" })),
        timeMin: Type.Optional(Type.String({ description: "Start of date range in ISO 8601 format (defaults to now)" })),
        timeMax: Type.Optional(Type.String({ description: "End of date range in ISO 8601 format" })),
      }),
      async execute(_toolCallId, params) {
        const result = await calendar.listEvents(params);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
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
        allDay: Type.Optional(Type.Boolean({ description: "Whether this is an all-day event" })),
      }),
      async execute(_toolCallId, params) {
        const { summary, ...options } = params;
        const result = await calendar.createEvent(summary, options);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildTaskTools(): ToolDefinition[] {
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
        tags: Type.Optional(Type.Array(Type.String(), { description: "Tags for categorization" })),
      }),
      async execute(_toolCallId, params) {
        const { title, ...options } = params;
        const result = tasks.addTask(title, options);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "task_list",
      label: "List Tasks",
      description: "List tasks and to-do items. Shows open tasks by default.",
      parameters: Type.Object({
        showCompleted: Type.Optional(Type.Boolean({ description: "Include completed tasks (default: false)" })),
        tag: Type.Optional(Type.String({ description: "Filter by tag" })),
        priority: Type.Optional(Type.String({ description: "Filter by priority: 'low', 'medium', 'high'" })),
      }),
      async execute(_toolCallId, params) {
        const result = tasks.listTasks(params);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "task_complete",
      label: "Complete Task",
      description: "Mark a task as completed.",
      parameters: Type.Object({
        taskId: Type.String({ description: "The task ID to complete" }),
      }),
      async execute(_toolCallId, params) {
        const result = tasks.completeTask(params.taskId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "task_delete",
      label: "Delete Task",
      description: "Delete a task permanently.",
      parameters: Type.Object({
        taskId: Type.String({ description: "The task ID to delete" }),
      }),
      async execute(_toolCallId, params) {
        const result = tasks.deleteTask(params.taskId);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
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
        tags: Type.Optional(Type.Array(Type.String(), { description: "New tags" })),
      }),
      async execute(_toolCallId, params) {
        const { taskId, ...updates } = params;
        const result = tasks.updateTask(taskId, updates);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

function buildNewsTools(): ToolDefinition[] {
  return [
    {
      name: "news_headlines",
      label: "News Headlines",
      description: "Get latest news headlines by category. Categories: top, world, business, technology, science, health, sports, entertainment.",
      parameters: Type.Object({
        category: Type.Optional(Type.String({ description: "News category (default: 'top'). Options: top, world, business, technology, science, health, sports, entertainment" })),
      }),
      async execute(_toolCallId, params) {
        const result = await news.getNews(params.category);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "news_search",
      label: "Search News",
      description: "Search for news articles about a specific topic.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query for news articles" }),
      }),
      async execute(_toolCallId, params) {
        const result = await news.searchNews(params.query);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

interface SessionEntry {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  subscribers: Set<Response>;
  createdAt: number;
  conversation: conversations.Conversation;
  currentAgentText: string;
}
const sessions = new Map<string, SessionEntry>();

function saveAndCleanSession(id: string) {
  const entry = sessions.get(id);
  if (!entry) return;
  if (entry.currentAgentText) {
    conversations.addMessage(entry.conversation, "agent", entry.currentAgentText);
    entry.currentAgentText = "";
  }
  if (entry.conversation.messages.length > 0) {
    conversations.save(entry.conversation);
  }
  for (const sub of entry.subscribers) { try { sub.end(); } catch {} }
  entry.subscribers.clear();
  sessions.delete(id);
}

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, entry] of sessions.entries()) {
    if (entry.createdAt < cutoff) {
      saveAndCleanSession(id);
    }
  }
}, 10 * 60 * 1000);

setInterval(() => {
  for (const entry of sessions.values()) {
    if (entry.currentAgentText) {
      conversations.addMessage(entry.conversation, "agent", entry.currentAgentText);
      entry.currentAgentText = "";
    }
    if (entry.conversation.messages.length > 0) {
      conversations.save(entry.conversation);
    }
  }
}, 5 * 60 * 1000);

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(cookieParser(SESSION_SECRET));

const AUTH_PUBLIC_PATHS = new Set(["/login.html", "/login.css", "/api/login", "/health"]);

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!APP_PASSWORD) { next(); return; }
  if (AUTH_PUBLIC_PATHS.has(req.path)) { next(); return; }
  if (req.path === "/api/config/tunnel-url") { next(); return; }
  if (req.path === "/api/gmail/callback") { next(); return; }
  if (req.path === "/api/gmail/auth") { next(); return; }

  const token = req.signedCookies?.auth;
  if (token === "authenticated") { next(); return; }

  if (req.headers.accept?.includes("text/html") || req.path === "/") {
    res.redirect("/login.html");
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
}

app.use(authMiddleware);

app.post("/api/login", (req: Request, res: Response) => {
  const { password } = req.body as { password?: string };
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
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

app.get("/api/logout", (_req: Request, res: Response) => {
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
          if ("writeHead" in res && typeof (res as any).status === "function") {
            (res as any).status(502).json({ error: "Interview tool is not running." });
          }
        } catch {}
      },
    },
  })
);

app.get("/api/gmail/auth", (_req: Request, res: Response) => {
  if (!gmail.isConfigured()) {
    res.status(500).json({ error: "Gmail not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET." });
    return;
  }
  const url = gmail.getAuthUrl();
  res.redirect(url);
});

app.get("/api/gmail/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).send("Missing authorization code.");
    return;
  }
  try {
    await gmail.handleCallback(code);
    res.send(`<html><body style="background:#000;color:#0f0;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><div style="text-align:center"><h2>[GMAIL CONNECTED]</h2><p>Authorization successful. You can close this tab.</p><script>setTimeout(()=>window.close(),2000)</script></div></body></html>`);
  } catch (err) {
    console.error("Gmail callback error:", err);
    res.status(500).send("Gmail authorization failed. Please try again.");
  }
});

app.get("/api/gmail/status", (_req: Request, res: Response) => {
  res.json({
    configured: gmail.isConfigured(),
    connected: gmail.isConnected(),
  });
});

app.post("/api/session", async (_req: Request, res: Response) => {
  try {
    const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const authStorage = AuthStorage.create(path.join(AGENT_DIR, "auth.json"));
    authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_KEY);

    const allTools = [
      ...buildKnowledgeBaseTools(),
      ...buildGmailTools(),
      ...buildCalendarTools(),
      ...buildWeatherTools(),
      ...buildSearchTools(),
      ...buildTaskTools(),
      ...buildNewsTools(),
    ];
    console.log(`[session] ${allTools.length} tools registered`);
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });

    const resourceLoader = new DefaultResourceLoader({
      cwd: PROJECT_ROOT,
      agentDir: AGENT_DIR,
      settingsManager,
      noSkills: true,
      noExtensions: true,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      agentDir: AGENT_DIR,
      authStorage,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      resourceLoader,
      tools: [],
      customTools: allTools,
    });

    const conv = conversations.createConversation(sessionId);
    const entry: SessionEntry = {
      session,
      subscribers: new Set(),
      createdAt: Date.now(),
      conversation: conv,
      currentAgentText: "",
    };
    sessions.set(sessionId, entry);

    session.subscribe((event: AgentSessionEvent) => {
      const data = JSON.stringify(event);
      for (const sub of entry.subscribers) {
        try { sub.write(`data: ${data}\n\n`); } catch {}
      }

      if (event.type === "message_update") {
        const ae = (event as any).assistantMessageEvent;
        if (ae?.type === "text_delta" && ae.delta) {
          entry.currentAgentText += ae.delta;
        }
      }

      if (event.type === "agent_end") {
        if (entry.currentAgentText) {
          conversations.addMessage(entry.conversation, "agent", entry.currentAgentText);
          entry.currentAgentText = "";
        }
      }
    });

    const recentSummary = conversations.getRecentSummary(5);

    res.json({ sessionId, recentContext: recentSummary || null });
  } catch (err) {
    console.error("Failed to create session:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/session/:id/stream", (req: Request, res: Response) => {
  const entry = sessions.get(req.params["id"] as string);
  if (!entry) { res.status(404).json({ error: "Session not found" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => { res.write(": heartbeat\n\n"); }, 15_000);
  entry.subscribers.add(res);

  req.on("close", () => {
    clearInterval(heartbeat);
    entry.subscribers.delete(res);
  });
});

app.post("/api/session/:id/prompt", async (req: Request, res: Response) => {
  const entry = sessions.get(req.params["id"] as string);
  if (!entry) { res.status(404).json({ error: "Session not found" }); return; }

  const { message, images } = req.body as { message?: string; images?: Array<{ mimeType: string; data: string }> };
  if (!message?.trim() && (!images || images.length === 0)) { res.status(400).json({ error: "message or images required" }); return; }

  const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const MAX_IMAGES = 5;
  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

  if (images && images.length > MAX_IMAGES) {
    res.status(400).json({ error: `Maximum ${MAX_IMAGES} images allowed` }); return;
  }
  if (images) {
    for (const img of images) {
      if (!ALLOWED_MIME.has(img.mimeType)) {
        res.status(400).json({ error: `Unsupported image type: ${img.mimeType}` }); return;
      }
      const sizeBytes = Math.ceil((img.data.length * 3) / 4);
      if (sizeBytes > MAX_IMAGE_BYTES) {
        res.status(400).json({ error: "Image too large (max 10MB)" }); return;
      }
    }
  }

  const text = message?.trim() || "(image attached)";
  const imgAttachments = images?.map(i => ({ mimeType: i.mimeType, data: i.data }));
  conversations.addMessage(entry.conversation, "user", text, imgAttachments);

  res.json({ ok: true });

  try {
    const promptImages = images?.map(i => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));
    await entry.session.prompt(text, promptImages ? { images: promptImages } : undefined);
  } catch (err) {
    console.error("Prompt error:", err);
    const errEvent = JSON.stringify({ type: "error", error: String(err) });
    for (const sub of entry.subscribers) {
      try { sub.write(`data: ${errEvent}\n\n`); } catch {}
    }
  }
});

app.delete("/api/session/:id", (req: Request, res: Response) => {
  saveAndCleanSession(req.params["id"] as string);
  res.json({ ok: true });
});

app.get("/api/conversations", (_req: Request, res: Response) => {
  res.json(conversations.list());
});

app.get("/api/conversations/:id", (req: Request, res: Response) => {
  const conv = conversations.load(req.params["id"] as string);
  if (!conv) { res.status(404).json({ error: "Conversation not found" }); return; }
  res.json(conv);
});

app.delete("/api/conversations/:id", (req: Request, res: Response) => {
  conversations.remove(req.params["id"] as string);
  res.json({ ok: true });
});

app.post("/api/config/tunnel-url", (req: Request, res: Response) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.OBSIDIAN_API_KEY}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { url } = req.body as { url?: string };
  if (!url?.startsWith("https://")) {
    res.status(400).json({ error: "url must be an https:// URL" });
    return;
  }
  obsidian.setApiUrl(url);
  console.log(`Tunnel URL updated to: ${url}`);
  res.json({ ok: true, url });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: sessions.size, ts: Date.now() });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Express error:", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

process.on("uncaughtException", (err) => console.error("Uncaught exception:", err));
process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));

const server = createServer(app);

function gracefulShutdown(signal: string) {
  console.error(`Got ${signal} — closing server...`);
  for (const [id] of sessions.entries()) {
    saveAndCleanSession(id);
  }
  server.close(() => { process.exit(0); });
  setTimeout(() => { process.exit(1); }, 3000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[ready] pi-replit listening on http://localhost:${PORT}`);
});
