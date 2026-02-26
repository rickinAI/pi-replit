# pi-replit

Mobile-friendly web UI for the pi coding agent, deployable on Replit.

## Architecture

- **server.ts** — Express server that wraps the pi coding agent SDK
  - Creates agent sessions with Anthropic API
  - Streams agent events via SSE (Server-Sent Events)
  - Proxies the pi-interview-tool at `/interview`
- **public/** — Static frontend files (HTML/CSS/JS chat UI)
- **dist/** — esbuild output (compiled server)

## API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/` | GET | Chat UI |
| `/api/session` | POST | Create new agent session |
| `/api/session/:id/stream` | GET | SSE event stream |
| `/api/session/:id/prompt` | POST | Send message to agent |
| `/api/session/:id` | DELETE | Close session |
| `/health` | GET | Health check |
| `/interview/*` | GET | Proxy to pi-interview-tool |

## Running

- **Build**: `npm run build` (esbuild bundles server.ts → dist/server.js)
- **Start**: `npm start` (runs dist/server.js)
- **Dev**: `npm run dev` (tsx watch mode)
- Server listens on port 5000

## Dependencies

- `@mariozechner/pi-coding-agent` — Pi coding agent SDK
- `express` — HTTP server
- `cors` — CORS middleware
- `http-proxy-middleware` — Proxy for interview tool

## Environment Variables

- `ANTHROPIC_API_KEY` (secret) — Required for agent sessions
- `PORT` — Server port (default: 5000)
- `INTERVIEW_PORT` — Interview tool proxy target port (default: 19847)

## Deployment

- Target: VM (always running) — needed for in-memory sessions and SSE streaming
- Build: `npm run build`
- Run: `npm start`
