# pi-replit

Mobile-friendly web UI for the pi coding agent with knowledge base integration, deployable on Replit. Acts as a "second brain" interface — chat with an AI agent that can search, read, create, and organize notes in your knowledge base.

## Architecture

- **server.ts** — Express server wrapping the pi coding agent SDK
  - Creates agent sessions with Anthropic API
  - Registers knowledge base tools (search, read, create, append, list)
  - Streams agent events via SSE (Server-Sent Events)
  - Proxies the pi-interview-tool at `/interview`
  - Graceful shutdown on SIGHUP/SIGTERM/SIGINT (releases port cleanly)
  - Express error-handling middleware for clean JSON error responses
- **src/obsidian.ts** — Client for the knowledge base REST API (internal module)
- **public/** — Static frontend (terminal/hacker aesthetic, branded as "RICKIN")
- **dist/** — esbuild output (compiled server)
- **tunnel-setup/** — macOS LaunchAgent for running cloudflared tunnel

## Port Configuration

- **Default port**: 3000 (matches deployment port forwarding)
- **Local dev**: workflow sets `PORT=5000` inline (webview requires port 5000)
- **Deployment**: uses `PORT=3000` from `.replit` `[env]`, forwarded to external port 80
- Server reads `process.env.PORT` with `||` (not `??`) to handle empty strings

## Authentication

- Password-protected via `APP_PASSWORD` secret
- Signed cookie sessions using `cookie-parser` with `SESSION_SECRET`
- 7-day cookie expiry, httpOnly, secure flag detects HTTPS via `x-forwarded-proto`
- Login page: `public/login.html` — terminal boot sequence aesthetic

## UI Theme

- Branding: [RICKIN] header, "MISSION CONTROL" login ASCII art
- Terminal/hacker aesthetic: green (#0f0) monospace text on black, CRT scanlines, glow effects
- Font: Fira Code from Google Fonts
- Login page: ASCII art header, simulated boot sequence, blinking cursor
- Chat: terminal-style prompts, amber agent text
- Mobile-friendly: visualViewport keyboard handling, 16px input fonts, 44px touch targets, smart auto-scroll

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/` | GET | Chat UI (requires auth) |
| `/login.html` | GET | Terminal-style login page |
| `/api/login` | POST | Authenticate with password |
| `/api/logout` | GET | Clear session and redirect |
| `/api/session` | POST | Create new agent session |
| `/api/session/:id/stream` | GET | SSE event stream |
| `/api/session/:id/prompt` | POST | Send message to agent |
| `/api/session/:id` | DELETE | Close session |
| `/api/config/tunnel-url` | POST | Update tunnel URL at runtime |
| `/health` | GET | Health check |
| `/interview/*` | GET | Proxy to pi-interview-tool |

## Knowledge Base Integration

5 custom tools for the agent to interact with your knowledge base (never references Obsidian to end users):
- `notes_list` — Browse file/folder structure
- `notes_read` — Read a note's markdown content
- `notes_create` — Create or overwrite a note
- `notes_append` — Append content to an existing note
- `notes_search` — Full-text search across all notes

Requires Local REST API plugin + Cloudflare Tunnel (see `tunnel-setup/`).

## Dependencies

- `@mariozechner/pi-coding-agent` — Pi coding agent SDK
- `@sinclair/typebox` — JSON schema for tool parameters
- `express`, `cors`, `cookie-parser`, `http-proxy-middleware`

## Environment Variables

- `ANTHROPIC_API_KEY` (secret) — Required for agent sessions
- `APP_PASSWORD` (secret) — Password for web UI access
- `SESSION_SECRET` (secret) — Cookie signing key
- `OBSIDIAN_API_URL` (env) — Cloudflare Tunnel URL to knowledge base REST API
- `OBSIDIAN_API_KEY` (secret) — API key from knowledge base REST API plugin
- `PORT` — Server port (default: 3000)
- `INTERVIEW_PORT` — Interview tool port (default: 19847)

## Deployment

- Target: VM (always running) — needed for in-memory sessions and SSE
- Build: `npm run build`
- Run: `node dist/server.js`
