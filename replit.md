# pi-replit

Mobile-friendly web UI for the pi coding agent with Obsidian vault integration, deployable on Replit.

## Architecture

- **server.ts** — Express server that wraps the pi coding agent SDK
  - Creates agent sessions with Anthropic API
  - Registers Obsidian vault tools (search, read, create, append, list) as custom agent tools
  - Streams agent events via SSE (Server-Sent Events)
  - Proxies the pi-interview-tool at `/interview`
  - Handles runtime tunnel URL updates via `/api/config/tunnel-url`
  - Handles SIGHUP/SIGTERM/SIGINT signals to prevent unexpected shutdowns
- **src/obsidian.ts** — Client for the Obsidian Local REST API (supports runtime URL updates)
- **public/** — Static frontend files (HTML/CSS/JS chat UI)
- **dist/** — esbuild output (compiled server)
- **tunnel-setup/** — macOS LaunchAgent setup for running cloudflared as a background service

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/` | GET | Chat UI |
| `/api/session` | POST | Create new agent session |
| `/api/session/:id/stream` | GET | SSE event stream |
| `/api/session/:id/prompt` | POST | Send message to agent |
| `/api/session/:id` | DELETE | Close session |
| `/api/config/tunnel-url` | POST | Update Obsidian tunnel URL at runtime |
| `/health` | GET | Health check |
| `/interview/*` | GET | Proxy to pi-interview-tool |

## Obsidian Integration

The agent has 5 custom tools for interacting with the user's Obsidian vault:
- `obsidian_list` — Browse vault file/folder structure
- `obsidian_read` — Read a note's markdown content
- `obsidian_create` — Create or overwrite a note
- `obsidian_append` — Append content to an existing note
- `obsidian_search` — Full-text search across all notes

These tools are only registered when `OBSIDIAN_API_URL` and `OBSIDIAN_API_KEY` are configured.
Connection requires the Obsidian Local REST API plugin + a Cloudflare Tunnel.

### Tunnel Setup

The tunnel can be run as a macOS background service (see `tunnel-setup/README.md`).
The tunnel script auto-notifies the Replit server when the URL changes via `POST /api/config/tunnel-url`.

## Agent Configuration (.pi directory)

- `.pi/APPEND_SYSTEM.md` — Appended to the agent's system prompt; tells the agent about Obsidian vault access
- `.pi/skills/obsidian.md` — Skill file with detailed Obsidian tool usage instructions
- The pi SDK auto-loads these files at session creation time

## Running

- **Build**: `npm run build` (esbuild bundles server.ts + src/ → dist/server.js)
- **Start**: `npm start` (runs dist/server.js)
- **Dev**: `npm run dev` (tsx watch mode)
- Server listens on port 5000

## Key Stability Notes

- The server handles SIGHUP signals (sent by the Replit workflow system) to prevent unexpected process termination
- uncaughtException and unhandledRejection handlers prevent crashes from async errors
- The process.on("exit") handler logs exit codes for debugging

## Dependencies

- `@mariozechner/pi-coding-agent` — Pi coding agent SDK
- `@sinclair/typebox` — JSON schema for tool parameters (transitive via SDK)
- `express` — HTTP server
- `cors` — CORS middleware
- `http-proxy-middleware` — Proxy for interview tool

## Environment Variables

- `ANTHROPIC_API_KEY` (secret) — Required for agent sessions
- `OBSIDIAN_API_URL` (env) — Cloudflare Tunnel URL pointing to Obsidian Local REST API
- `OBSIDIAN_API_KEY` (secret) — API key from the Obsidian Local REST API plugin
- `PORT` — Server port (default: 5000)
- `INTERVIEW_PORT` — Interview tool proxy target port (default: 19847)

## Deployment

- Target: VM (always running) — needed for in-memory sessions and SSE streaming
- Build: `npm run build`
- Run: `npm start`
