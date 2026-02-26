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
var PORT = parseInt(process.env.PORT ?? "3000", 10);
var INTERVIEW_PORT = parseInt(process.env.INTERVIEW_PORT ?? "19847", 10);
var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
var __dirname = path.dirname(fileURLToPath(import.meta.url));
if (!ANTHROPIC_KEY) {
  console.error("\u274C  ANTHROPIC_API_KEY is not set. Exiting.");
  process.exit(1);
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
        if (res instanceof Response || res.writeHead) {
          res.status?.(502)?.json?.({
            error: "Interview tool is not running. The agent must trigger it first."
          });
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
    const { session } = await createAgentSession({
      agentDir: path.join(process.env.HOME ?? "/tmp", ".pi/agent"),
      authStorage,
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false }
      })
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
var server = createServer(app);
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
