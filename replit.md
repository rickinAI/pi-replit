# pi-replit

Mobile-friendly web UI for the pi coding agent with knowledge base integration, deployable on Replit. Acts as a personal AI companion — chat with an AI agent that remembers you across sessions, learns about you over time, and can search, read, create, and organize notes in your knowledge base.

## Architecture

- **server.ts** — Express server wrapping the pi coding agent SDK
  - Creates agent sessions with Anthropic API
  - Registers custom tools (86 total): knowledge base, email, calendar, weather, web search, tasks, news, Google Drive, Google Sheets (13 tools), Google Docs (12 tools), Google Slides (12 tools), YouTube, Zillow (3 tools), Redfin (3 tools), X/Twitter (4 tools)
  - Multi-agent system with 9 specialist agents defined in `data/agents.json` (hot-reloaded on file change)
  - Dual-source research default: all research-oriented agents search both web AND X (Twitter) for maximum coverage. X tools added to deep-researcher, analyst, real-estate, and moodys agents
  - Streams agent events via SSE (Server-Sent Events)
  - Tracks conversation messages and persists them to PostgreSQL
  - Auto-saves conversations every 5 minutes; saves on session close/expiry/shutdown
  - Inline interview tool: AI sends structured question forms to user, waits for responses via Promise/SSE
  - Graceful shutdown on SIGHUP/SIGTERM/SIGINT (awaits all conversation saves via Promise.allSettled before exit, 5s timeout, releases port)
  - EADDRINUSE auto-recovery: pre-emptive port kill, probes port availability before listen, waits up to 15s with retries
  - Periodic knowledge base health check (every 15s) with connection status logging
  - Express error-handling middleware for clean JSON error responses
- **src/db.ts** — Shared PostgreSQL connection pool (single `pg.Pool`, max 10 connections). Creates all 4 tables on init (`conversations`, `tasks`, `app_config`, `oauth_tokens`). All other modules import `getPool()` from here
- **src/obsidian.ts** — Client for the knowledge base REST API (10s timeout, 2 retries on transient failures, health ping)
- **src/gmail.ts** — Gmail integration via custom Google OAuth (list/read/search emails). Tokens stored in PostgreSQL (oauth_tokens table). OAuth scopes: gmail.readonly, calendar, drive, spreadsheets, documents, presentations, youtube.readonly. Also exports `getAccessToken()` for gws CLI and YouTube API
- **src/calendar.ts** — Google Calendar integration (shares OAuth tokens with Gmail via PostgreSQL)
- **src/weather.ts** — Weather via Open-Meteo (free, no API key)
- **src/websearch.ts** — Web search via DuckDuckGo HTML (free, no API key)
- **src/tasks.ts** — Task manager with PostgreSQL storage (tasks table)
- **src/scheduled-jobs.ts** — Scheduled agent jobs system. Runs agents autonomously on configurable schedules. 7 jobs (5 enabled): KB Audit 2AM (disabled), Daily News 6:30AM (disabled), Market Summary 7:30AM (disabled), Moody's Intel Brief 6:00AM, Moody's Profile Updates 6:15AM, Moody's Weekly Digest Sun 7:00AM, Real Estate Scan 7:30AM. Config stored in `app_config` key='scheduled_jobs'. 60s check loop with run-key dedup. Status tracking: `success`, `partial` (timedOut or "PARTIAL" in response), `error`. Writes `Scheduled Reports/job-status.json` to vault after each job. API: GET/PUT/DELETE `/api/scheduled-jobs`, PUT `/api/scheduled-jobs/:id`, POST `/api/scheduled-jobs/:id/trigger`
- **src/news.ts** — News headlines via Google News RSS feeds
- **src/conversations.ts** — Conversation persistence module (save/load/list/delete via PostgreSQL, AI summaries via Haiku, last-conversation context for session start). Uses Replit's built-in PostgreSQL database (DATABASE_URL) so conversations persist across deployments
- **src/memory-extractor.ts** — Post-conversation fact extraction (profile updates, action items) via Claude Haiku
- **.pi/SYSTEM.md** — Agent personality, greeting template, vault structure map, auto-categorization rules, dual-source research default (web + X), and auto-catalog shared links behavior (auto-loaded by SDK from `.pi/SYSTEM.md`)
- **Vault index injection** — At session creation, a full vault tree (all folders/files) is generated via `buildVaultTree()` / `formatVaultIndex()` and injected into the agent's first prompt via `startupContext`. This gives the agent immediate awareness of all vault contents without needing to call notes_list first
- **.pi/agent/system-prompt.md** — Synced copy of SYSTEM.md for reference
- **.pi/agent/models.json** — Custom model registry entries (`claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `claude-opus-4-6`) so the Pi SDK's ModelRegistry can resolve them. These must match exact Anthropic API model IDs (no `-latest` aliases — Anthropic doesn't support them)
  - Three-tier model system with 4 modes: Auto (routes fast/full/max by intent), Fast (Haiku), Full (Sonnet), Max (Opus)
  - Auto mode uses MAX_PATTERNS to detect work/project keywords and route to Opus
  - All sub-agents default to Opus (`data/agents.json` model field + orchestrator fallback)
  - All sub-agents get Anthropic native `web_search_20260209` and `web_fetch_20260209` server tools automatically (no DuckDuckGo scraping)
  - Orchestrator: soft timeout at 80% of budget (nudges agent to save partial results), hard timeout at 100%, fallback summary if no response. `SubAgentResult.timedOut` flag propagated to job system
- **Moody's Intelligence Pipeline** — Three scheduled jobs using the moodys agent:
  - Pass 1: Daily Intelligence Brief at 6:00 AM ET — 5 categories: Corporate News, Banking Segment, Competitor Watch (12 competitors), Enterprise AI Trends, Analyst Coverage (Celent, Chartis, Forrester, Gartner, IDC). Dual-source: searches both web AND X for each category. Includes 🐦 X/Twitter Signals section. Saves to `Scheduled Reports/Moody's Intelligence/Daily/YYYY-MM-DD-Brief.md`. Research only — does NOT update profiles.
  - Pass 2: Profile Updates at 6:15 AM ET — reads today's brief, appends date-stamped findings to competitor/analyst profiles in `Projects/Moody's/Competitive Intelligence/`
  - Weekly Strategic Digest on Sundays at 7:00 AM ET — reads from `Daily/`, synthesises into strategic analysis. Saves to `Scheduled Reports/Moody's Intelligence/Weekly/YYYY-MM-DD-Digest.md`
  - Auto-archive: reports older than 30 days move to corresponding `Archive/` subfolders
  - Moody's agent pre-read optimized: uses notes_list for folder awareness, only reads file content when directly needed for the current task. Timeout: 600s
- **Real Estate Property Scout** — Daily property scan using the real-estate agent:
  - Daily Property Scan at 7:30 AM ET — searches 6 areas (Upper Saddle River NJ, Montclair NJ, Princeton NJ, Long Island NY, Hudson Valley NY, Stamford-Westport CT) via Zillow AND Redfin APIs
  - Criteria: $1.5M–$2M, 5+ bed / 3+ bath, modern, garage, good schools, walkable. Commute to Brookfield Place (Battery Park City)
  - 6 RapidAPI tools: Zillow via `private-zillow.p.rapidapi.com` (`property_search`, `property_details`, `neighborhood_search`) + Redfin (`redfin_search`, `redfin_details`, `redfin_autocomplete`) + `x_search` for local market intel
  - Dual-platform search: cross-references Zillow and Redfin results, flags platform exclusives (🔵 Redfin-only, 🟡 Zillow-only)
  - 5-step daily scan: Zillow → Redfin → cross-reference → deep dive → X/social signals per area
  - Saves to `Scheduled Reports/Real Estate/YYYY-MM-DD-Property-Scan.md`, appends to `Real Estate/Areas/`, saves ⭐ gems to `Real Estate/Favorites/`
  - Auto-archive >30 days to `Archive/Real Estate/`. Agent pre-reads Search Criteria + area files. Timeout: 600s
- **public/** — Static frontend (terminal/hacker aesthetic, branded as "RICKIN")
  - Landing screen: "Mission Control" full-screen overlay on fresh load (no active session). Shows date, glance strip (weather/email/tasks/calendar from `/api/glance`), interactive task section (checklist with checkboxes, priority dots, "Go" quick-launch, inline add-task form), last conversation card with preview + RESUME button, NEW MISSION button, recent conversation cards with delete, VIEW ALL to expand full history inline
  - Conversation search: search input on landing screen filters conversations by title in real-time
  - Date-grouped conversations: Recent list grouped into Today/Yesterday/This Week/Earlier headers
  - Pull-to-refresh: touch pull-down on landing screen refreshes glance strip and conversation list
  - Smoother reconnection: catchUpSession appends only new messages instead of full DOM rebuild (preserves scroll position)
  - 4 header buttons: Home (house icon, returns to landing), New (+, starts fresh session directly), Brief, Settings
  - Resume conversation from landing cards (creates new session with old messages + context)
  - Scroll-to-bottom floating button (appears when scrolled up)
  - Retry button on errors (resends last message without retyping)
  - Emoji-labeled tool indicator (🔍🧠📝📅📧 etc.) with elapsed timer after 5s
- **src/gws.ts** — Google Workspace CLI wrapper. Calls the `gws` binary with the current OAuth access token via `GOOGLE_WORKSPACE_CLI_TOKEN`. Provides Drive (6 tools), Sheets (13 tools: CRUD + formatting, sorting, merging, tabs, auto-resize, batch), Docs (12 tools: CRUD + insert text/heading/table/image, format, find-replace, delete content, batch), Slides (12 tools: CRUD + insert table/image/shape, format text, duplicate/delete slide, find-replace, batch)
- **bin/gws** — Google Workspace CLI binary (v0.8.0, x86_64 Linux). Not an officially supported Google product. Pre-v1.0
- **dist/** — esbuild output (compiled server)
- **public/manifest.json** — PWA web app manifest (name, icons, display mode)
- **public/icons/** — App icons (180x180 apple-touch-icon, 192x192, 512x512)
- **tunnel-setup/** — macOS cloudflared named tunnel startup script with auto-restart loop
- **data/agents.json** — Agent definitions (9 agents: deep-researcher, project-planner, email-drafter, analyst, real-estate, nutritionist, moodys, family-planner, knowledge-organizer). Hot-reloaded on file change via `src/agents/loader.ts`
- **data/vault/Replit Agent/** — Self-referencing system documentation in the vault (Architecture, Memory System, Alerts & Briefs, Agent Team, Tools Reference, Rules & Behavior, UI & Frontend, Changelog). Updated on major changes so all DarkNode agents understand the system

## PostgreSQL Storage

All runtime state persists in Replit's built-in PostgreSQL (shared between dev and production via `DATABASE_URL`):

| Table | Module | Purpose |
|-------|--------|---------|
| `conversations` | `src/conversations.ts` | Chat history, messages, titles |
| `tasks` | `src/tasks.ts` | To-do items with priority, due dates, tags |
| `app_config` | `src/alerts.ts`, `src/scheduled-jobs.ts` | Brief schedules, watchlist, last prices, theme (key='alerts'); Scheduled agent job configs (key='scheduled_jobs') |
| `oauth_tokens` | `src/gmail.ts` + `src/calendar.ts` | Google OAuth access/refresh tokens (service='google') |

Connection pooling: Single shared `pg.Pool` in `src/db.ts` (max 10 connections), imported by all modules via `getPool()`.

## Port Configuration

- **Default port**: 3000 (matches deployment port forwarding)
- **Local dev**: workflow sets `PORT=5000` inline (webview requires port 5000)
- **Deployment**: VM (always-on) target — required for SSE streaming and in-memory sessions. Uses `PORT=3000` from `.replit` `[env]`, forwarded to external port 80
- Server reads `process.env.PORT` with `||` (not `??`) to handle empty strings

## Authentication

- Password-protected via `APP_PASSWORD` secret
- Signed cookie sessions using `cookie-parser` with `SESSION_SECRET`
- 7-day cookie expiry, httpOnly, secure flag detects HTTPS via `x-forwarded-proto`
- Login page: `public/login.html` — terminal boot sequence aesthetic

## UI Theme

- Branding: [RICKIN] header, "MISSION CONTROL" login ASCII art
- **Dark mode** (default): Terminal/hacker aesthetic — green (#0f0) monospace text on black, CRT scanlines, glow effects
- **Light mode**: Calm, modern palette — warm off-white (#f7f5f2) bg, sage (#5a8a7a) accents, clay (#9a6d4e) agent text, no scanlines/glows
  - Toggle in settings panel (// APPEARANCE section)
  - Persisted to `localStorage` key `theme` (values: `dark` | `light`) and to alerts config in PostgreSQL (`theme` field)
  - Applied via `body.light-theme` CSS class; CSS variable overrides in both `style.css` and `login.css`
  - Early `<script>` in `<head>` of index.html/login.html sets `document.documentElement.style.background` to prevent flash
- Font: Fira Code (dark mode), Inter sans-serif (light mode) — both from Google Fonts. Code blocks, tool pills, and prompt prefix stay in Fira Code in both modes
- Login page: ASCII art header, simulated boot sequence, blinking cursor
- Chat: terminal-style prompts, amber agent text
- Mobile-friendly: visualViewport keyboard handling, 16px input fonts, 44px touch targets, smart auto-scroll
- **Glance bar**: Slim strip pinned below header showing day-at-a-glance (weather, unread emails, task count, next calendar event, job health). Tap to expand detail card with per-job status rows (auto-collapses after 8s). Fetches from `/api/glance` every 5 min. `/api/glance` includes `jobs` field with enabled job count, ok/partial/failed counts, and per-job items. Both dark/light mode styled. Graceful degradation when data sources unavailable.
- **Suggestion chips**: After each AI response, 2-3 contextual follow-up prompts appear as tappable pill buttons below the message. AI generates them via `[suggestions: "...", "..."]` tag (stripped from display). Tapping a chip sends it as the next prompt. Chips cleared on new message or new AI response.
- **Dynamic profile learning**: AI maintains a structured profile in the vault (`About Me/My Profile.md`) with sections for preferences, routines, active projects, goals, key people, interests, decision patterns, and frequent requests. Also updates `About Me/About Me.md` and `About Me/My Style Guide.md` directly when learning relevant info. All three loaded at session start.
- **PWA standalone mode**: `manifest.json` with icons, `display: standalone`, iOS safe area insets for notch/Dynamic Island/home indicator, `@media (display-mode: standalone)` CSS block, `viewport-fit=cover`
- Auth-public paths: `/manifest.json`, `/icons/*` bypassed for PWA install

## Session Resilience

Client-side session resume and background agent support:
- **Session persistence**: `sessionId` saved to `localStorage` — closing the app and reopening resumes the active session via `GET /api/session/:id/status`
- **SSE auto-reconnect**: On connection drop, exponential backoff reconnect (1s→2s→4s→...→30s cap, max 30 retries). Shows "[RECONNECTING...]" status during retries
- **Catch-up on reconnect**: `catchUpSession()` calls the status endpoint to fetch missed messages and render them. In-progress agent responses shown with partial text. Uses `textOffsetAfterCatchUp` to skip already-rendered SSE deltas and prevent duplicate text
- **Visibility API**: `visibilitychange` listener triggers immediate reconnect + catch-up when user returns to the tab/app (500ms debounce for iOS PWA gestures)
- **Network recovery**: `online` event triggers SSE reconnect after wifi→cellular or network outage
- **Server-side tracking**: `isAgentRunning` flag on `SessionEntry` tracks whether agent is mid-response; status endpoint returns full conversation + in-progress text + pending queue count
- **Image compression**: Client-side canvas resize (max 1600px longest side, JPEG 0.85 quality) in `compressImage()` before upload — reduces iPhone photos from 10MB+ to ~200-400KB
- **Prompt timeout**: `session.prompt()` wrapped in `Promise.race` with 120s timeout in both direct and queued prompt handlers. On timeout, `isAgentRunning` resets and SSE error sent to client
- **Agent start event**: `agent_start` SSE event emitted immediately when prompt is received (before calling `session.prompt()`), ensuring typing indicator shows instantly
- **Prompt diagnostics**: Image count, base64 size, MIME types logged on receipt; prompt completion time logged on success/failure
- **Agent background work**: The `/prompt` endpoint returns immediately; agent runs asynchronously on the server regardless of client connection state
- **Message queue**: Users can send messages while the agent is processing. Messages are queued server-side (`pendingMessages` on `SessionEntry`) and auto-processed in order after each `agent_end`. Queue protected by `processingQueue` lock to prevent concurrent `session.prompt` calls. Client shows "Queued — will process next" system message. Send button stays enabled at all times
- **Port resilience**: `killPort()` uses both `fuser` and `lsof` fallbacks. Workflow command includes pre-start `fuser -k` to clear stale processes

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
| `/api/tasks` | GET | List active tasks (id, title, priority, dueDate) |
| `/api/tasks` | POST | Create a new task (body: title, priority?, dueDate?) — returns created task object |
| `/api/tasks/:id/complete` | PATCH | Mark task as completed |
| `/api/tasks/:id` | DELETE | Delete a task |
| `/api/tasks/completed` | GET | List completed tasks (id, title, priority, completedAt) sorted by most recent |
| `/api/tasks/:id/restore` | PATCH | Restore a completed task back to active |
| `/api/glance` | GET | Day-at-a-glance summary (weather, emails, tasks, calendar) — 5min server cache |
| `/health` | GET | Health check |
| `/api/session/:id/interview-response` | POST | Submit interview form responses |
| `/api/agents` | GET | List all agent configs (id, name, tools, enabled) |
| `/api/vault-tree` | GET | Vault folder/file structure as JSON |
| `/api/session/:id/status` | GET | Session state for resume (alive, agentRunning, messages, currentAgentText) |

## Knowledge Base Integration

5 custom tools for the agent to interact with your knowledge base (never references Obsidian to end users):
- `notes_list` — Browse file/folder structure
- `notes_read` — Read a note's markdown content
- `notes_create` — Create or overwrite a note
- `notes_append` — Append content to an existing note
- `notes_search` — Full-text search across all notes
- `notes_delete` — Permanently delete a note (auto-cleans empty parent folders)
- `notes_move` — Move or rename a note to a new path
- `notes_rename_folder` — Rename or move an entire folder at once
- `notes_list_recursive` — List all files/subfolders recursively within a folder
- `notes_file_info` — Get file metadata (size, created, modified dates)

**Primary: Local vault via Obsidian Headless Sync** (`obsidian-headless` npm package, v1.0.0). Vault files synced to `data/vault/` using `ob sync --continuous` spawned by `startObSync()` in `server.ts` on server startup (works in both dev and production). Auto-restarts on crash (10s delay). Reads files directly from disk via `src/vault-local.ts` — no network dependency. Requires Node.js 22+ (for native WebSocket). Obsidian Sync credentials stored in `~/.config/obsidian-headless/` on the Replit instance.

**Fallback: Cloudflare Named Tunnel** to Local REST API plugin on Mac. Permanent URL: `https://obsidian.rickin.live` via named tunnel `obsidian-vault`. Env var `OBSIDIAN_API_URL` is the URL source; falls back to persisted `data/tunnel-url.txt`. Dynamic URL push endpoint (`/api/config/tunnel-url`) still available.

## Gmail Integration

3 custom tools for the agent to check email (custom Google OAuth):
- `email_list` — List recent emails, optionally filter with Gmail search query
- `email_read` — Read full email content by message ID
- `email_search` — Search emails using Gmail search syntax

Auth via custom OAuth flow using `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`. Tokens stored in PostgreSQL (`oauth_tokens` table, service='google').

## Calendar Integration

2 custom tools using Google Calendar API (shares OAuth tokens with Gmail via PostgreSQL):
- `calendar_list` — List upcoming events with date range filtering (queries all visible calendars, not just primary)
- `calendar_create` — Create new events with time, description, location
- All date range calculations use proper timezone-aware UTC conversion (handles DST transitions)
- Connected Google account logged at boot and visible via `/api/gmail/status` (includes email address)

## Google Drive Integration

6 custom tools using the `gws` CLI binary (shares OAuth tokens with Gmail):
- `drive_list` — List/search files in Drive (supports Drive API query syntax)
- `drive_get` — Get file metadata by ID
- `drive_create_folder` — Create folders (optionally nested)
- `drive_move` — Move files/folders between folders
- `drive_rename` — Rename files/folders
- `drive_delete` — Move files/folders to trash

## Google Sheets Integration

13 custom tools using the `gws` CLI binary (shares OAuth tokens with Gmail):
- `sheets_list` — List all spreadsheets in Drive
- `sheets_read` — Read cell ranges from a spreadsheet
- `sheets_append` — Append rows to a spreadsheet
- `sheets_update` — Update specific cells in a spreadsheet
- `sheets_create` — Create a new spreadsheet
- `sheets_add_sheet` — Add a new sheet tab
- `sheets_delete_sheet` — Delete a sheet tab by ID
- `sheets_clear` — Clear values from a cell range
- `sheets_format_cells` — Format cells (bold, colors, font size)
- `sheets_auto_resize` — Auto-resize columns to fit content
- `sheets_merge_cells` — Merge a range of cells
- `sheets_sort` — Sort sheet data by column
- `sheets_batch_update` — Raw batchUpdate passthrough for complex operations

## Google Docs

12 custom tools using the `gws` CLI binary (shares OAuth tokens with Gmail):
- `docs_list` — List all Google Docs in Drive
- `docs_get` — Read a document's full content by ID
- `docs_create` — Create a new blank document
- `docs_append` — Append text to an existing document
- `docs_insert_text` — Insert text at a specific position
- `docs_delete_content` — Delete a range of content by index
- `docs_insert_table` — Insert an empty table (rows × cols)
- `docs_format_text` — Format text (bold, italic, font size, color)
- `docs_insert_image` — Insert an inline image from URL
- `docs_replace_text` — Find and replace text across the document
- `docs_insert_heading` — Insert a heading (H1–H6) with text
- `docs_batch_update` — Raw batchUpdate passthrough for complex operations

## Google Slides

12 custom tools using the `gws` CLI binary (shares OAuth tokens with Gmail):
- `slides_list` — List all presentations in Drive
- `slides_get` — Read a presentation's content and slide text by ID
- `slides_create` — Create a new blank presentation
- `slides_append` — Add a new slide with title and body text to an existing presentation
- `slides_insert_table` — Insert a table with data on a slide
- `slides_insert_image` — Insert an image from URL on a slide
- `slides_insert_shape` — Add a shape with text (rectangle, circle, arrow, etc.)
- `slides_format_text` — Format text on a slide (bold, italic, font size, color)
- `slides_delete_slide` — Delete a slide by ID
- `slides_duplicate_slide` — Duplicate an existing slide
- `slides_replace_text` — Find and replace text across all slides
- `slides_batch_update` — Raw batchUpdate passthrough for complex operations

## YouTube

4 custom tools using YouTube Data API v3 (shares OAuth tokens with Gmail):
- `youtube_search` — Search for YouTube videos by query
- `youtube_video` — Get video details (title, views, likes, duration, description)
- `youtube_channel` — Get channel info (subscribers, video count, description)
- `youtube_trending` — Get trending/popular videos by region

## Weather

1 custom tool using Open-Meteo API (free, no API key):
- `weather_get` — Current conditions and 3-day forecast for any location

## Web Search

1 custom tool using DuckDuckGo HTML search (free, no API key):
- `web_search` — Search the web for real-time information

## Task Manager

5 custom tools with PostgreSQL storage (`tasks` table):
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

4 tools using Twitter241 API via RapidAPI (same `RAPIDAPI_KEY`):
- `x_user_profile` — User profile info (bio, followers, verified status, join date)
- `x_read_tweet` — Read specific tweet by URL or ID (full text, engagement, views, media, quotes)
- `x_user_timeline` — User's recent tweets with view counts and engagement stats
- `x_search` — Search tweets by query (keywords, @mentions, #hashtags, from:user). Supports "Latest" and "Top" modes

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

- **src/alerts.ts** — Scheduler module with config persistence (PostgreSQL `app_config` table, key='alerts')
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
  - Settings panel (gear icon in header) with sections: Appearance (theme toggle), Alert Settings (calendar reminders, stock moves, task deadlines, important emails), Scheduled Agents (job cards with enable/disable toggles, hour/minute pickers, Run button, custom job form), Watchlist (stock/crypto tickers), Logout
  - Settings auto-save with 500ms debounce

## Image / Screenshot Support

- Users can paste images (Cmd+V), drag-and-drop, or use the upload button
- Images sent as base64 in the prompt request body alongside text
- Server validates: max 5 images, max 10MB each, allowed types (png/jpeg/gif/webp)
- Images forwarded to Anthropic via `session.prompt()` with `PromptOptions.images`
- Images stored in conversation messages as `images: [{mimeType, data}]`
- Image thumbnails displayed in chat bubbles and conversation history view
- Express JSON body limit set to 50MB to accommodate base64 payloads

## Conversation Persistence & Memory Search

- Conversations stored in PostgreSQL (`conversations` table)
- Each row: `{ id, title, messages: [{role, text, timestamp, images?}], createdAt, updatedAt, syncedAt? }`
- Title auto-derived from first user message (truncated to 60 chars)
- Auto-save every 5 minutes for crash resilience
- Saved on session close, 2-hour expiry, and graceful shutdown
- History panel in UI for browsing/viewing/deleting past conversations
- **Conversation search**: `GET /api/conversations/search?q=...&before=...&after=...` — full-text keyword search across all past conversations with date filtering
- **AI tool**: `conversation_search` — AI can search past conversations when user asks about previous discussions
- **Auto-sync to vault**: All conversations (1+ user messages) are automatically synced to `Conversations/` folder:
  - Short conversations (<3 user msgs): snippet-based summary (fast, no API call)
  - Longer conversations (3+ user msgs): AI-generated summary via Claude Haiku (overview, decisions, action items, follow-ups)
  - Prevents duplicates via `syncedAt` marker in conversation record
- **Post-conversation memory extraction**: After syncing longer conversations, `extractAndFileInsights()` runs to:
  - Extract new profile facts → appended to `About Me/My Profile.md`
  - Extract action items → filed to `Tasks & TODOs/Extracted Tasks.md`
  - Skips if nothing new was learned (AI-determined)
- **Richer session start**: New sessions receive the last conversation's final 10 exchanges (not just title) plus recent conversation titles, enabling natural continuity
- **Daily Digests**: Scheduled briefs (morning/afternoon/evening) are AI-synthesized by Claude Haiku into conversational summaries and saved to `Daily Digests/` in the vault

## Multi-Agent System

Config-driven specialist agents that RICKIN can delegate complex tasks to. Each agent runs as an independent Claude API call with a focused system prompt and filtered tool subset.

- **data/agents.json** — Agent definitions (id, name, systemPrompt, tools, enabled, timeout, model). Hot-reloads on file change — no restart needed to add/remove/modify agents
- **src/agents/loader.ts** — Reads and validates agent configs, watches for file changes, exports `getAgents()`, `getEnabledAgents()`, `getAgent(id)`
- **src/agents/orchestrator.ts** — Runs sub-agents via direct Anthropic SDK calls. Handles tool-use loops (max 15 iterations), timeout enforcement, and token tracking
- **Agent tools** registered on the main session:
  - `delegate` — Route a task to a specialist agent by ID
  - `list_agents` — Show available agents and descriptions
- **API**: `GET /api/agents` — Returns all agent configs (behind auth)
- **Vault docs**: `data/vault/Agents/` folder with overview and per-agent documentation

### Current Agents
| ID | Name | Tools |
|----|------|-------|
| `deep-researcher` | Deep Researcher | web_search, notes_create |
| `project-planner` | Project Planner | task_add, notes_create, notes_read, notes_list, web_search |
| `email-drafter` | Email Drafter | email_list, email_search, notes_read |
| `analyst` | Market Analyst | stock_quote, crypto_price, news_headlines, news_search, web_search |
| `knowledge-organizer` | Knowledge Organizer | notes_list, notes_read, notes_create, notes_append, notes_search |

## Dependencies

- `@mariozechner/pi-coding-agent` — Pi coding agent SDK
- `@anthropic-ai/sdk` — Direct Anthropic API calls for sub-agents (transitive dep from pi-coding-agent)
- `@sinclair/typebox` — JSON schema for tool parameters
- `googleapis` — Google APIs client (Gmail, Calendar)
- `pg` — PostgreSQL client (shared pool via src/db.ts)
- `express`, `cors`, `cookie-parser`

## src/ Modules
- **src/db.ts** — Shared PostgreSQL pool and table initialization
- **src/twitter.ts** — X/Twitter reader via Twitter241 RapidAPI (profiles, tweets, timelines, search)
- **src/stocks.ts** — Stock quotes (Yahoo Finance) and crypto prices (CoinGecko)
- **src/maps.ts** — Directions (Nominatim + OSRM) and place search (Nominatim)
- **src/youtube.ts** — YouTube Data API v3 integration (search, video details, channel info, trending)
- **src/alerts.ts** — Alert & briefing scheduler (background checks, brief generation, SSE broadcast)
- **src/agents/loader.ts** — Agent config loader with hot-reload
- **src/agents/orchestrator.ts** — Sub-agent execution engine

## Interview / Clarification Forms

1 custom tool for structured user input:
- `interview` — Sends an interactive form (single-select, multi-select, text, info) inline in the chat
- Server holds a Promise that resolves when user POSTs responses to `/api/session/:id/interview-response`
- 15-minute timeout; form grays out after submission
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
- `DATABASE_URL` (env) — Replit's built-in PostgreSQL connection string
- `OBSIDIAN_API_URL` (env) — Cloudflare Tunnel URL to knowledge base REST API
- `OBSIDIAN_API_KEY` (secret) — API key from knowledge base REST API plugin
- `GMAIL_REDIRECT_URI` (env) — OAuth redirect URI for Gmail (overrides auto-detected Replit domain). Must match what's registered in Google Cloud Console.
- `PORT` — Server port (default: 3000)

## Deployment

- Target: VM (always running) — needed for in-memory sessions and SSE
- Build: `npm run build`
- Run: `node dist/server.js`
