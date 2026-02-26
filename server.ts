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
  type AgentSessionEvent,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import * as obsidian from "./src/obsidian.js";

const PORT = parseInt(process.env.PORT || "3000", 10);
const INTERVIEW_PORT = parseInt(process.env.INTERVIEW_PORT || "19847", 10);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = __filename.includes("/dist/") ? path.resolve(__dirname, "..") : __dirname;
const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
const AGENT_DIR = path.join(process.env.HOME || "/tmp", ".pi/agent");

fs.mkdirSync(AGENT_DIR, { recursive: true });

if (!ANTHROPIC_KEY) console.warn("ANTHROPIC_API_KEY is not set.");
if (!obsidian.isConfigured()) console.warn("Obsidian integration not configured.");
if (!APP_PASSWORD) console.warn("APP_PASSWORD is not set — auth disabled.");

console.log(`[boot] PORT=${PORT} PUBLIC_DIR=${PUBLIC_DIR} AGENT_DIR=${AGENT_DIR}`);
console.log(`[boot] public/ exists: ${fs.existsSync(PUBLIC_DIR)}`);

function buildObsidianTools(): ToolDefinition[] {
  if (!obsidian.isConfigured()) return [];

  return [
    {
      name: "obsidian_list",
      label: "Obsidian List",
      description: "List files and folders in the user's Obsidian vault.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "Directory path inside the vault. Defaults to root." })),
      }),
      async execute(_toolCallId, params) {
        const result = await obsidian.listNotes(params.path ?? "/");
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "obsidian_read",
      label: "Obsidian Read",
      description: "Read the markdown content of a note in the user's Obsidian vault.",
      parameters: Type.Object({
        path: Type.String({ description: "Path to the note, e.g. 'Daily Notes/2025-01-15.md'" }),
      }),
      async execute(_toolCallId, params) {
        const result = await obsidian.readNote(params.path);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "obsidian_create",
      label: "Obsidian Create",
      description: "Create or overwrite a note in the user's Obsidian vault.",
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
      name: "obsidian_append",
      label: "Obsidian Append",
      description: "Append content to the end of an existing note in the user's Obsidian vault.",
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
      name: "obsidian_search",
      label: "Obsidian Search",
      description: "Search for text across all notes in the user's Obsidian vault. Returns matching notes and snippets.",
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

interface SessionEntry {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  subscribers: Set<Response>;
  createdAt: number;
}
const sessions = new Map<string, SessionEntry>();

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, entry] of sessions.entries()) {
    if (entry.createdAt < cutoff) {
      for (const sub of entry.subscribers) {
        try { sub.end(); } catch {}
      }
      entry.subscribers.clear();
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000);

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser(SESSION_SECRET));

const AUTH_PUBLIC_PATHS = new Set(["/login.html", "/login.css", "/api/login", "/health"]);

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!APP_PASSWORD) { next(); return; }
  if (AUTH_PUBLIC_PATHS.has(req.path)) { next(); return; }
  if (req.path === "/api/config/tunnel-url") { next(); return; }

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

app.post("/api/session", async (_req: Request, res: Response) => {
  try {
    const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const authStorage = AuthStorage.create(path.join(AGENT_DIR, "auth.json"));
    authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_KEY);

    const { session } = await createAgentSession({
      agentDir: AGENT_DIR,
      authStorage,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      customTools: buildObsidianTools(),
    });

    const entry: SessionEntry = { session, subscribers: new Set(), createdAt: Date.now() };
    sessions.set(sessionId, entry);

    session.subscribe((event: AgentSessionEvent) => {
      const data = JSON.stringify(event);
      for (const sub of entry.subscribers) {
        try { sub.write(`data: ${data}\n\n`); } catch {}
      }
    });

    res.json({ sessionId });
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

  const { message } = req.body as { message?: string };
  if (!message?.trim()) { res.status(400).json({ error: "message is required" }); return; }

  res.json({ ok: true });

  try {
    await entry.session.prompt(message);
  } catch (err) {
    console.error("Prompt error:", err);
    const errEvent = JSON.stringify({ type: "error", error: String(err) });
    for (const sub of entry.subscribers) {
      try { sub.write(`data: ${errEvent}\n\n`); } catch {}
    }
  }
});

app.delete("/api/session/:id", (req: Request, res: Response) => {
  const entry = sessions.get(req.params["id"] as string);
  if (entry) {
    for (const sub of entry.subscribers) { try { sub.end(); } catch {} }
    entry.subscribers.clear();
    sessions.delete(req.params["id"] as string);
  }
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
  server.close(() => { process.exit(0); });
  setTimeout(() => { process.exit(1); }, 3000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGHUP", () => gracefulShutdown("SIGHUP"));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[ready] pi-replit listening on http://localhost:${PORT}`);
});
