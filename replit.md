# pi-replit

Mobile-friendly web UI for the pi coding agent with knowledge base integration, deployable on Replit. Acts as a personal AI companion — chat with an AI agent that remembers you across sessions, learns about you over time, and can search, read, create, and organize notes in your knowledge base.

## Architecture

- **server.ts** — Express server wrapping the pi coding agent SDK
  - Creates agent sessions with Anthropic API
  - Registers custom tools: knowledge base, email, calendar, weather, web search, tasks, news
  - Streams agent events via SSE (Server-Sent Events)
  - Tracks conversation messages and persists them to JSON files
  - Auto-saves conversations every 5 minutes; saves on session close/expiry/shutdown
  - Inline interview tool: AI sends structured question forms to user, waits for responses via Promise/SSE
  - Graceful shutdown on SIGHUP/SIGTERM/SIGINT (saves all conversations, releases port)
  - EADDRINUSE auto-recovery: detects port conflict, kills stale process, retries once
  - Periodic knowledge base health check (every 2 min) with connection status logging
  - Express error-handling middleware for clean JSON error responses
- **src/obsidian.ts** — Client for the knowledge base REST API (10s timeout, 2 retries on transient failures, health ping)
- **src/gmail.ts** — Gmail integration via custom Google OAuth (list/read/search emails)
- **src/calendar.ts** — Google Calendar integration (shares OAuth with Gmail)
- **src/weather.ts** — Weather via Open-Meteo (free, no API key)
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
- **tunnel-setup/** — macOS LaunchAgent for cloudflared tunnel (retry notifications with backoff, log rotation)

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
| `/api/session/:id/model-mode` | GET | Get current model mode |
| `/api/session/:id/model-mode` | PUT | Set model mode (auto/fast/full) |
| `/api/session/:id` | DELETE | Close session |
| `/api/conversations` | GET | List saved conversations |
| `/api/conversations/:id` | GET | Get full conversation with messages |
| `/api/conversations/:id` | DELETE | Delete a saved conversation |
| `/api/config/tunnel-url` | POST | Update tunnel URL at runtime |
| `/api/alerts/config` | GET | Get alert/brief configuration |
| `/api/alerts/config` | PUT | Update alert/brief configuration |
| `/api/alerts/trigger/:type` | POST | Manually trigger a brief (morning/afternoon/evening) |
| `/health` | GET | Health check |
| `/api/session/:id/interview-response` | POST | Submit interview form responses |

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

1 custom tool using Open-Meteo API (free, no API key):
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

## X (Twitter) Reader

3 custom tools using public APIs (free, no API key):
- `x_user_profile` — User profile info via fxtwitter API
- `x_read_tweet` — Read specific tweet by URL or ID via fxtwitter API
- `x_user_timeline` — User's recent tweets via Twitter syndication API

## Stock & Crypto Tracker

2 custom tools using free APIs (no API key):
- `stock_quote` — Real-time stock price via Yahoo Finance (price, change, volume, day range)
- `crypto_price` — Crypto price via CoinGecko (price, 24h/7d change, market cap, volume, ATH)

## Maps & Directions

2 custom tools using free APIs (no API key):
- `maps_directions` — Driving/walking/cycling directions via Nominatim geocoding + OSRM routing
- `maps_search_places` — Place/business search via Nominatim, optionally near a location

## Alert & Briefing System

Proactive background scheduler that pushes briefings and alerts via SSE to all connected clients.

- **src/alerts.ts** — Scheduler module with config persistence (`data/alerts-config.json`)
- **Scheduled Briefs** (3x daily, US Eastern timezone):
  - Morning (8:00 AM): Calendar, tasks, weather, news headlines, market watchlist, unread email
  - Afternoon (1:00 PM): Calendar, tasks, email, markets
  - Evening (7:00 PM): Tomorrow's calendar, tasks, markets, email
- **Real-time Alerts** (checked every 15 min):
  - Calendar reminders (configurable minutes before)
  - Stock/crypto price moves exceeding threshold % on watchlist
  - Task deadlines due today
  - Important unread emails (deduped by message ID)
- **Default Watchlist**: GC=F (Gold), SI=F (Silver), BTC (Bitcoin), MSTR
- **API Endpoints**:
  - `GET /api/alerts/config` — Read config
  - `PUT /api/alerts/config` — Update config (partial merge)
  - `POST /api/alerts/trigger/:type` — Manually trigger morning/afternoon/evening brief
- **Frontend**:
  - Briefs render as full-width styled messages with `// MORNING BRIEF — 8:00 AM` header
  - Alerts show dismissible banner (auto-dismiss 30s) + persistent chat line
  - Browser notifications + audio beep when tab is hidden
  - Settings panel (gear icon in header) for configuring briefs, watchlist, alert thresholds
  - Settings auto-save with 500ms debounce

## Image / Screenshot Support

- Users can paste images (Cmd+V), drag-and-drop, or use the upload button
- Images sent as base64 in the prompt request body alongside text
- Server validates: max 5 images, max 10MB each, allowed types (png/jpeg/gif/webp)
- Images forwarded to Anthropic via `session.prompt()` with `PromptOptions.images`
- Images stored in conversation messages as `images: [{mimeType, data}]`
- Image thumbnails displayed in chat bubbles and conversation history view
- Express JSON body limit set to 50MB to accommodate base64 payloads

## Conversation Persistence

- Conversations stored as JSON files in `data/conversations/`
- Each file: `{ id, title, messages: [{role, text, timestamp, images?}], createdAt, updatedAt }`
- Title auto-derived from first user message (truncated to 60 chars)
- Auto-save every 5 minutes for crash resilience
- Saved on session close, 2-hour expiry, and graceful shutdown
- History panel in UI for browsing/viewing/deleting past conversations

## Dependencies

- `@mariozechner/pi-coding-agent` — Pi coding agent SDK
- `@sinclair/typebox` — JSON schema for tool parameters
- `googleapis` — Google APIs client (Gmail, Calendar)
- `express`, `cors`, `cookie-parser`

## src/ Modules
- **src/twitter.ts** — X/Twitter reader (fxtwitter for profiles/tweets, syndication API for timelines)
- **src/stocks.ts** — Stock quotes (Yahoo Finance) and crypto prices (CoinGecko)
- **src/maps.ts** — Directions (Nominatim + OSRM) and place search (Nominatim)
- **src/alerts.ts** — Alert & briefing scheduler (background checks, brief generation, SSE broadcast)

## Interview / Clarification Forms

1 custom tool for structured user input:
- `interview` — Sends an interactive form (single-select, multi-select, text, info) inline in the chat
- Server holds a Promise that resolves when user POSTs responses to `/api/session/:id/interview-response`
- 5-minute timeout; form grays out after submission
- System prompt instructs the AI to use it for ambiguous requests, multi-option choices, and project setup

## Two-Tier Model System

Automatic model routing to optimize cost and speed:
- **Auto mode** (default): Classifies intent per message — routes simple requests to Haiku 4.5, complex ones to Sonnet 4.6
- **Fast mode**: Forces all requests through Claude Haiku 4.5 (cheap, fast)
- **Full mode**: Forces all requests through Claude Sonnet 4.6 (powerful, thorough)
- Model badge in header is clickable — cycles through Auto / Fast / Full
- Badge updates live to show which model is actually handling the current response
- Uses `ModelRegistry` from pi-coding-agent SDK, `session.setModel()` for runtime switching
- Intent classifier: regex-based pattern matching for greetings, simple lookups, task management → fast; everything else → full
- API: `GET/PUT /api/session/:id/model-mode`

## Environment Variables

- `ANTHROPIC_API_KEY` (secret) — Required for agent sessions
- `APP_PASSWORD` (secret) — Password for web UI access
- `SESSION_SECRET` (secret) — Cookie signing key
- `OBSIDIAN_API_URL` (env) — Cloudflare Tunnel URL to knowledge base REST API
- `OBSIDIAN_API_KEY` (secret) — API key from knowledge base REST API plugin
- `GMAIL_REDIRECT_URI` (env) — OAuth redirect URI for Gmail (overrides auto-detected Replit domain). Must match what's registered in Google Cloud Console.
- `PORT` — Server port (default: 3000)

## Deployment

- Target: VM (always running) — needed for in-memory sessions and SSE
- Build: `npm run build`
- Run: `node dist/server.js`
