# pi-replit

Mobile-friendly web UI for the pi coding agent with knowledge base integration, deployable on Replit. Acts as a personal AI companion — chat with an AI agent that remembers you across sessions, learns about you over time, and can search, read, create, and organize notes in your knowledge base.

## Architecture

- **server.ts** — Express server wrapping the pi coding agent SDK
  - Creates agent sessions with Anthropic API
  - Registers custom tools: knowledge base, email, calendar, weather, web search, tasks, news
  - Streams agent events via SSE (Server-Sent Events)
  - Tracks conversation messages and persists them to JSON files
  - Auto-saves conversations every 5 minutes; saves on session close/expiry/shutdown
  - Proxies the pi-interview-tool at `/interview`
  - Graceful shutdown on SIGHUP/SIGTERM/SIGINT (saves all conversations, releases port)
  - Express error-handling middleware for clean JSON error responses
- **src/obsidian.ts** — Client for the knowledge base REST API (internal module)
- **src/gmail.ts** — Gmail integration via custom Google OAuth (list/read/search emails)
- **src/calendar.ts** — Google Calendar integration (shares OAuth with Gmail)
- **src/weather.ts** — Weather via wttr.in (free, no API key)
- **src/websearch.ts** — Web search via DuckDuckGo HTML (free, no API key)
- **src/tasks.ts** — Local task manager with JSON storage
- **src/news.ts** — News headlines via Google News RSS feeds
- **src/conversations.ts** — Conversation persistence module (save/load/list/delete JSON files)
- **.pi/SYSTEM.md** — Agent personality, greeting template, vault structure map, and auto-categorization rules (auto-loaded by SDK from `.pi/SYSTEM.md`)
- **.pi/agent/system-prompt.md** — Synced copy of SYSTEM.md for reference
- **public/** — Static frontend (terminal/hacker aesthetic, branded as "RICKIN")
  - History panel (slide-out, lists past conversations, view/delete)
  - Confirmation modal before starting new session
- **dist/** — esbuild output (compiled server)
- **data/conversations/** — Persisted conversation JSON files
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
| `/api/conversations` | GET | List saved conversations |
| `/api/conversations/:id` | GET | Get full conversation with messages |
| `/api/conversations/:id` | DELETE | Delete a saved conversation |
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

## Gmail Integration

3 custom tools for the agent to check email (custom Google OAuth):
- `email_list` — List recent emails, optionally filter with Gmail search query
- `email_read` — Read full email content by message ID
- `email_search` — Search emails using Gmail search syntax

Auth via custom OAuth flow using `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`. Tokens stored in `data/gmail-tokens.json`.

## Calendar Integration

2 custom tools using Google Calendar API (shares OAuth tokens with Gmail):
- `calendar_list` — List upcoming events with date range filtering
- `calendar_create` — Create new events with time, description, location

## Weather

1 custom tool using wttr.in (free, no API key):
- `weather_get` — Current conditions and 3-day forecast for any location

## Web Search

1 custom tool using DuckDuckGo HTML search (free, no API key):
- `web_search` — Search the web for real-time information

## Task Manager

5 custom tools with local JSON storage (`data/tasks.json`):
- `task_add` — Add task with due date, priority, tags
- `task_list` — List tasks sorted by priority/due date
- `task_complete` — Mark task as done
- `task_delete` — Remove task
- `task_update` — Modify task details

## News Headlines

2 custom tools using Google News RSS feeds (free, no API key):
- `news_headlines` — Headlines by category (top, world, business, tech, science, health, sports, entertainment)
- `news_search` — Search news by topic

## Conversation Persistence

- Conversations stored as JSON files in `data/conversations/`
- Each file: `{ id, title, messages: [{role, text, timestamp}], createdAt, updatedAt }`
- Title auto-derived from first user message (truncated to 60 chars)
- Auto-save every 5 minutes for crash resilience
- Saved on session close, 2-hour expiry, and graceful shutdown
- History panel in UI for browsing/viewing/deleting past conversations

## Dependencies

- `@mariozechner/pi-coding-agent` — Pi coding agent SDK
- `@sinclair/typebox` — JSON schema for tool parameters
- `googleapis` — Google APIs client (Gmail)
- `express`, `cors`, `cookie-parser`, `http-proxy-middleware`

## Environment Variables

- `ANTHROPIC_API_KEY` (secret) — Required for agent sessions
- `APP_PASSWORD` (secret) — Password for web UI access
- `SESSION_SECRET` (secret) — Cookie signing key
- `OBSIDIAN_API_URL` (env) — Cloudflare Tunnel URL to knowledge base REST API
- `OBSIDIAN_API_KEY` (secret) — API key from knowledge base REST API plugin
- `GMAIL_REDIRECT_URI` (env) — OAuth redirect URI for Gmail (overrides auto-detected Replit domain). Must match what's registered in Google Cloud Console.
- `PORT` — Server port (default: 3000)
- `INTERVIEW_PORT` — Interview tool port (default: 19847)

## Deployment

- Target: VM (always running) — needed for in-memory sessions and SSE
- Build: `npm run build`
- Run: `node dist/server.js`
