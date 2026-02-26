/**
 * pi-replit — Express server wrapping pi coding agent SDK
 * Exposes a mobile-friendly web UI with SSE streaming + interview tool proxy
 */
import express from "express";
import type { Request, Response } from "express";
import cors from "cors";
import { createServer } from "http";
import { fileURLToPath } from "url";
import path from "path";
import { createProxyMiddleware } from "http-proxy-middleware";

// ── pi SDK imports ──────────────────────────────────────────────────────────
import {
  createAgentSession,
  AuthStorage,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const INTERVIEW_PORT = parseInt(process.env.INTERVIEW_PORT ?? "19847", 10);
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!ANTHROPIC_KEY) {
  console.error("❌  ANTHROPIC_API_KEY is not set. Exiting.");
  process.exit(1);
}

// ── Active sessions map ─────────────────────────────────────────────────────
interface SessionEntry {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  subscribers: Set<Response>;
  createdAt: number;
}
const sessions = new Map<string, SessionEntry>();

// Clean up sessions older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, entry] of sessions.entries()) {
    if (entry.createdAt < cutoff) {
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000);

// ── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── Proxy /interview/* → pi-interview-tool server ───────────────────────────
app.use(
  "/interview",
  createProxyMiddleware({
    target: `http://localhost:${INTERVIEW_PORT}`,
    changeOrigin: true,
    on: {
      error: (_err, _req, res) => {
        if (res instanceof Response || (res as any).writeHead) {
          (res as any).status?.(502)?.json?.({
            error: "Interview tool is not running. The agent must trigger it first.",
          });
        }
      },
    },
  })
);

// ── POST /api/session — create a new agent session ─────────────────────────
app.post("/api/session", async (_req: Request, res: Response) => {
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
        compaction: { enabled: false },
      }),
    });

    const entry: SessionEntry = {
      session,
      subscribers: new Set(),
      createdAt: Date.now(),
    };
    sessions.set(sessionId, entry);

    // Forward all agent events to SSE subscribers
    session.subscribe((event) => {
      const data = JSON.stringify(event);
      for (const sub of entry.subscribers) {
        sub.write(`data: ${data}\n\n`);
      }
    });

    res.json({ sessionId });
  } catch (err) {
    console.error("Failed to create session:", err);
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/session/:id/stream — SSE event stream ─────────────────────────
app.get("/api/session/:id/stream", (req: Request, res: Response) => {
  const entry = sessions.get(req.params["id"] as string);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering on Replit
  res.flushHeaders();

  // Send a heartbeat every 15s to keep the connection alive
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15_000);

  entry.subscribers.add(res);

  req.on("close", () => {
    clearInterval(heartbeat);
    entry.subscribers.delete(res);
  });
});

// ── POST /api/session/:id/prompt — send a message to the agent ─────────────
app.post("/api/session/:id/prompt", async (req: Request, res: Response) => {
  const entry = sessions.get(req.params["id"] as string);
  if (!entry) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const { message } = req.body as { message?: string };
  if (!message?.trim()) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  // Respond immediately; streaming goes via SSE
  res.json({ ok: true });

  try {
    await entry.session.prompt(message);
  } catch (err) {
    const errEvent = JSON.stringify({ type: "error", error: String(err) });
    for (const sub of entry.subscribers) {
      sub.write(`data: ${errEvent}\n\n`);
    }
  }
});

// ── DELETE /api/session/:id — close a session ───────────────────────────────
app.delete("/api/session/:id", (req: Request, res: Response) => {
  sessions.delete(req.params["id"] as string);
  res.json({ ok: true });
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", sessions: sessions.size, ts: Date.now() });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = createServer(app);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  pi-replit server running                        ║
║  http://localhost:${PORT}                           ║
║                                                  ║
║  Interview proxy → localhost:${INTERVIEW_PORT}          ║
╚══════════════════════════════════════════════════╝
  `);
});
