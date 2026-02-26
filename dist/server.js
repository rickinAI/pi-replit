// server.ts
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { fileURLToPath } from "url";
import path from "path";
import { createProxyMiddleware } from "http-proxy-middleware";
import {
  createAgentSession,
  AuthStorage,
  SessionManager,
  SettingsManager
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// src/obsidian.ts
var OBSIDIAN_API_URL = process.env.OBSIDIAN_API_URL ?? "";
var OBSIDIAN_API_KEY = process.env.OBSIDIAN_API_KEY ?? "";
function headers() {
  return {
    Authorization: `Bearer ${OBSIDIAN_API_KEY}`,
    Accept: "application/json"
  };
}
function baseUrl() {
  return OBSIDIAN_API_URL.replace(/\/+$/, "");
}
function encodePath(p) {
  return p.replace(/^\//, "").split("/").map(encodeURIComponent).join("/");
}
function isConfigured() {
  return !!(OBSIDIAN_API_URL && OBSIDIAN_API_KEY);
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

// server.ts
import { execSync } from "child_process";
var PORT = parseInt(process.env.PORT ?? "5000", 10);
var INTERVIEW_PORT = parseInt(process.env.INTERVIEW_PORT ?? "19847", 10);
var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
var __dirname = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!ANTHROPIC_KEY) {
  console.warn("\u26A0\uFE0F  ANTHROPIC_API_KEY is not set \u2014 sessions will fail until you add it to Replit Secrets.");
}
if (!isConfigured()) {
  console.warn("\u26A0\uFE0F  Obsidian integration not configured \u2014 set OBSIDIAN_API_URL and OBSIDIAN_API_KEY in Secrets.");
}
function buildObsidianTools() {
  if (!isConfigured()) return [];
  const obsidianList = {
    name: "obsidian_list",
    label: "Obsidian List",
    description: "List files and folders in the user's Obsidian vault. Use this to browse the vault structure.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory path inside the vault. Defaults to root." }))
    }),
    async execute(_toolCallId, params) {
      const result = await listNotes(params.path ?? "/");
      return { content: [{ type: "text", text: result }], details: {} };
    }
  };
  const obsidianRead = {
    name: "obsidian_read",
    label: "Obsidian Read",
    description: "Read the markdown content of a note in the user's Obsidian vault.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the note, e.g. 'Daily Notes/2025-01-15.md'" })
    }),
    async execute(_toolCallId, params) {
      const result = await readNote(params.path);
      return { content: [{ type: "text", text: result }], details: {} };
    }
  };
  const obsidianCreate = {
    name: "obsidian_create",
    label: "Obsidian Create",
    description: "Create or overwrite a note in the user's Obsidian vault.",
    parameters: Type.Object({
      path: Type.String({ description: "Path for the new note, e.g. 'Ideas/new-idea.md'" }),
      content: Type.String({ description: "Markdown content for the note" })
    }),
    async execute(_toolCallId, params) {
      const result = await createNote(params.path, params.content);
      return { content: [{ type: "text", text: result }], details: {} };
    }
  };
  const obsidianAppend = {
    name: "obsidian_append",
    label: "Obsidian Append",
    description: "Append content to the end of an existing note in the user's Obsidian vault.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to the note to append to" }),
      content: Type.String({ description: "Markdown content to append" })
    }),
    async execute(_toolCallId, params) {
      const result = await appendToNote(params.path, params.content);
      return { content: [{ type: "text", text: result }], details: {} };
    }
  };
  const obsidianSearch = {
    name: "obsidian_search",
    label: "Obsidian Search",
    description: "Search for text across all notes in the user's Obsidian vault. Returns matching notes and snippets.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query string" })
    }),
    async execute(_toolCallId, params) {
      const result = await searchNotes(params.query);
      return { content: [{ type: "text", text: result }], details: {} };
    }
  };
  return [obsidianList, obsidianRead, obsidianCreate, obsidianAppend, obsidianSearch];
}
var sessions = /* @__PURE__ */ new Map();
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1e3;
  for (const [id, entry] of sessions.entries()) {
    if (entry.createdAt < cutoff) {
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1e3);
var app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/interview",
  createProxyMiddleware({
    target: `http://localhost:${INTERVIEW_PORT}`,
    changeOrigin: true,
    on: {
      error: (_err, _req, res) => {
        try {
          if ("writeHead" in res && typeof res.status === "function") {
            res.status(502).json({
              error: "Interview tool is not running. The agent must trigger it first."
            });
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
    const authStorage = AuthStorage.create(
      path.join(process.env.HOME ?? "/tmp", ".pi/agent/auth.json")
    );
    authStorage.setRuntimeApiKey("anthropic", ANTHROPIC_KEY);
    const obsidianTools = buildObsidianTools();
    const { session } = await createAgentSession({
      agentDir: path.join(process.env.HOME ?? "/tmp", ".pi/agent"),
      authStorage,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false }
      }),
      customTools: obsidianTools
    });
    const entry = {
      session,
      subscribers: /* @__PURE__ */ new Set(),
      createdAt: Date.now()
    };
    sessions.set(sessionId, entry);
    session.subscribe((event) => {
      const data = JSON.stringify(event);
      for (const sub of entry.subscribers) {
        sub.write(`data: ${data}

`);
      }
    });
    res.json({ sessionId });
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
  res.json({ ok: true });
  try {
    await entry.session.prompt(message);
  } catch (err) {
    const errEvent = JSON.stringify({ type: "error", error: String(err) });
    for (const sub of entry.subscribers) {
      sub.write(`data: ${errEvent}

`);
    }
  }
});
app.delete("/api/session/:id", (req, res) => {
  sessions.delete(req.params["id"]);
  res.json({ ok: true });
});
app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: sessions.size, ts: Date.now() });
});
process.on("uncaughtException", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error("Port already in use, exiting:", err.message);
    process.exit(1);
  }
  console.error("Uncaught exception (server still running):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (server still running):", reason);
});
process.on("SIGTERM", () => {
  console.error("Received SIGTERM \u2014 ignoring to keep server alive");
});
process.on("SIGINT", () => {
  console.error("Received SIGINT \u2014 ignoring to keep server alive");
});
process.on("exit", (code) => {
  console.error(`Process exit with code ${code}`, new Error().stack);
});
var _origExit = process.exit;
process.exit = ((code) => {
  if (code === 1 && new Error().stack?.includes("EADDRINUSE")) {
    return _origExit.call(process, code);
  }
  console.error(`process.exit(${code}) intercepted:`, new Error().stack);
});
function startServer(retried = false) {
  const server = createServer(app);
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !retried) {
      console.log("Port in use, killing old process and retrying...");
      try {
        execSync(`fuser -k ${PORT}/tcp`, { stdio: "ignore" });
      } catch {
      }
      setTimeout(() => startServer(true), 2e3);
    } else {
      console.error("Server error:", err.message);
      process.exit(1);
    }
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`
\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557
\u2551  pi-replit server running                        \u2551
\u2551  http://localhost:${PORT}                           \u2551
\u2551                                                  \u2551
\u2551  Interview proxy \u2192 localhost:${INTERVIEW_PORT}          \u2551
\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D
    `);
  });
}
startServer();
