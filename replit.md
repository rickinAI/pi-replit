# pi-replit

Mobile-friendly web UI for the pi coding agent with knowledge base integration, deployable on Replit. Acts as a personal AI companion — chat with an AI agent that remembers you across sessions, learns about you over time, and can search, read, create, and organize notes in your knowledge base.

## Architecture

- **server.ts** — Express server wrapping the pi coding agent SDK
  - Creates agent sessions with Anthropic API
  - Registers custom tools (112 total): knowledge base (10), email (15: list, read, search, get_attachment, thread, send, reply, draft, archive, label, mark_read, trash, gmail_list_labels, gmail_create_label, gmail_delete_label), calendar (3: list events, create event with calendar targeting, list available calendars), weather, web search, web fetch (reads full page content from URLs), render_page (Browserbase cloud browser with anti-bot protection for JS-heavy/paywalled pages, falls back to Lightpanda if no API key), browse_page (interactive Browserbase sessions: click, type, scroll, extract — for cookie walls, pagination, login forms), describe_image (Claude vision), tasks (5), news (2), Google Drive (6), Google Sheets (13), Google Docs (12), Google Slides (12), YouTube (4), Zillow (3), Redfin (3), X/Twitter (4), maps (2: directions, search places), web pages (4: web_publish, web_save, web_list_pages, web_delete_page), interview, conversation_search
  - Multi-agent system with 10 specialist agents defined in `data/agents.json` (hot-reloaded on file change)
  - Dual-source research default: all research-oriented agents search both web AND X (Twitter) for maximum coverage. X tools added to deep-researcher, analyst, real-estate, and moodys agents
  - Streams agent events via SSE (Server-Sent Events)
  - Tracks conversation messages and persists them to PostgreSQL
  - Auto-saves conversations every 5 minutes; saves on session close/expiry/shutdown
  - Inline interview tool: AI sends structured question forms to user, waits for responses via Promise/SSE
  - Graceful shutdown on SIGHUP/SIGTERM/SIGINT (awaits all conversation saves via Promise.allSettled before exit, 5s timeout, releases port)
  - EADDRINUSE auto-recovery: pre-emptive port kill, probes port availability before listen, waits up to 15s with retries
  - Periodic knowledge base health check (every 15s) with connection status logging
  - Express error-handling middleware for clean JSON error responses
- **src/db.ts** — Shared PostgreSQL connection pool (single `pg.Pool`, max 10 connections). Creates 7 tables on init (`conversations`, `tasks`, `app_config`, `oauth_tokens`, `job_history`, `agent_activity`, `vault_inbox`). All other modules import `getPool()` from here
- **src/obsidian.ts** — Client for the knowledge base REST API (10s timeout, 2 retries on transient failures, health ping)
- **src/gmail.ts** — Full Gmail integration via custom Google OAuth (15 tools: list, read, search, get_attachment with PDF extraction, thread, send, reply with threading headers, draft, archive, label, mark_read, trash, gmail_list_labels, gmail_create_label, gmail_delete_label). Tokens stored in PostgreSQL (oauth_tokens table). OAuth scopes: gmail.modify, calendar, drive, spreadsheets, documents, presentations, youtube.readonly. Also exports `getAccessToken()` for gws CLI and YouTube API
- **src/calendar.ts** — Google Calendar integration (shares OAuth tokens with Gmail via PostgreSQL). Queries all selected calendars (not just primary). `listEventsStructured()` returns events with calendar source names for family calendar awareness (Rickin, Pooja, Reya). `listCalendars()` exposes available calendars. `createEvent()` accepts optional `calendarName` for fuzzy-matching target calendar (e.g. "Reya" matches "Reya's Schedule")
- **src/weather.ts** — Weather via Open-Meteo (free, no API key)
- **src/websearch.ts** — Web search via DuckDuckGo HTML (free, no API key)
- **src/webfetch.ts** — Fetches web pages and converts HTML to clean readable text. Extracts title, meta description, and page content. Strips scripts/styles/nav/footer, converts headings to markdown, preserves links/images/tables/code blocks, decodes HTML entities. Handles HTML, JSON, and plain text responses. 80KB default content limit with smart truncation. 15s timeout. Used by `web_fetch` tool — available to all 9 agents
- **src/tasks.ts** — Task manager with PostgreSQL storage (tasks table)
- **src/scheduled-jobs.ts** — Scheduled agent jobs system. Runs agents autonomously on configurable schedules. 21 jobs (19 enabled). Config stored in `app_config` key='scheduled_jobs'. 60s check loop with run-key dedup (interval jobs use timestamp-based dedup). Schedule types: `daily`, `weekly`, `interval` (with `intervalMinutes`). Status tracking: `success`, `partial` (timedOut or "PARTIAL" in response), `error`. Writes `Scheduled Reports/job-status.json` to vault after each job. API: GET/POST/PUT/DELETE `/api/scheduled-jobs`, POST `/api/scheduled-jobs/:id/trigger`, GET `/api/scheduled-jobs/history`, GET `/api/kb/read?path=...`
  - **Agent Management UI** (Agents panel in app.js): Dashboard tab with health ring (SVG), total runs, estimated cost (per-model pricing), token usage stats, and per-agent cost breakdown with model badges (Haiku/Sonnet/Opus color-coded). History tab shows recent runs with status dots, model badges, per-run cost, token counts, summaries, and View Report buttons. Schedule tab with per-job toggle, time picker, Run Now, collapsible prompt editor (view/edit/save), and delete button with confirmation. Report overlay is full-screen fixed position with back/close buttons. Custom tab for creating new jobs. `job_history` table includes `agent_id`, `model_used`, `tokens_input`, `tokens_output` columns for tracking
- **src/coingecko.ts** — Expanded CoinGecko intelligence suite: trending coins/categories, top gainers/losers, category analysis, global market overview, and historical OHLCV data fetching (hourly candles up to 90 days). Local file cache at ~/.cache/coingecko/ (max 1 refresh per hour per asset). Shared rate limiter (token bucket, 10 req/min for free tier). Supports COINGECKO_API_KEY env var for demo API key. Tools: crypto_trending, crypto_movers, crypto_categories, crypto_market_overview, crypto_historical
- **src/technical-signals.ts** — Technical analysis signals module for Wealth Engines. Returns continuous confidence scores (0.0-1.0), not booleans. 3 active signals (beta): EMA crossover (7/26), RSI (period 8, thresholds 69/31), multi-timeframe momentum (12h/24h). 3 stubbed signals (disabled, post-beta): MACD, BB width compression, realized volatility regime. Ensemble scoring (weighted average of active signals). Market regime classifier (TRENDING/RANGING/VOLATILE). ATR calculation with configurable stop multiplier (default 5.5x). All parameters marked as UNVALIDATED starting points from Nunchi autoresearch. Tool: technical_analysis
- **src/polymarket.ts** — Polymarket CLOB API client. Market search/trending/details via Gamma API (gamma-api.polymarket.com, no auth). Whale scoring system: 5-metric composite (win rate, ROI, category expertise, volume, recency). Caching: markets 5min, wallet history 15min. Rate limiting with graceful error handling
- **src/polymarket-scout.ts** — Polymarket SCOUT intelligence agent. Thesis generation from whale consensus. Whale watchlist persistence (DB), activity detection, consensus tracking. Thresholds: score≥0.6, ≥2 whales, ≥$50K volume, 15-85% odds, ≥24h to resolution. Auto-expire theses on resolution. Tools: polymarket_search, polymarket_trending, polymarket_details, polymarket_whale_watchlist, polymarket_whale_activity, polymarket_consensus, polymarket_theses, save_pm_thesis, retire_pm_thesis
- **src/bnkr.ts** — BNKR API wrapper for Avantis on-chain perps on Base. Crypto: openCryptoPosition, closeCryptoPosition, getCryptoPositions, getCryptoPositionPnL. Polymarket: openPolymarketPosition, closePolymarketPosition, getPolymarketPositions, getPolymarketPositionPnL. Auth: BANKR_API_KEY + BANKR_WALLET_ADDRESS. Shadow mode when unconfigured (logs but doesn't execute). 15s timeout per request
- **src/coinbase-wallet.ts** — Coinbase Wallet API for spot operations. HMAC-SHA256 signed requests. buySpot, sellSpot, getBalances. Auth: COINBASE_API_KEY + COINBASE_API_SECRET. Shadow mode when unconfigured. Account lookup by currency
- **src/bankr.ts** — BANKR unified execution engine. Tiered risk framework: autonomous (≤20% capital, confidence ≥3.5), dead_zone (20-30%, flag in Telegram), human_required (>30%, 3+ consecutive losses, -25% drawdown, first trade on asset). Pre-trade risk checks (kill switch, pause, leverage, margin, exposure buckets, correlation, consecutive losses, peak drawdown). Position sizing: 2% max risk/trade. Shadow mode support. FIFO tax lots with dynamic holding period + wash sale detection. Source tracking (crypto_scout/polymarket_scout/manual) on Position and TradeRecord. Execution routing: BNKR API for crypto perps + polymarket, Coinbase Wallet for spot. Circuit breaker: -15% rolling 7-day drawdown OR -25% peak drawdown. Peak portfolio value tracked automatically. Consecutive loss counter resets on win. Independent position monitor (5-min setInterval, NOT in agent job queue): trailing stop 5.5x ATR, RSI exit 69/31, 72h crypto time exit, polymarket odds target, 10-point stop loss, whale consensus flip, 30d underwater exit, resolution proximity (<4h), kill switch check. Monitor heartbeat stored in `bankr_monitor_last_tick` DB key. Tools: bankr_risk_check, bankr_open_position, bankr_close_position, bankr_positions, bankr_trade_history, bankr_tax_summary
- **src/telegram.ts** — Telegram Command Center for Wealth Engines mobile control. Direct Bot API via fetch (no library). Long-polling for commands + callback queries. Commands: /status, /portfolio, /intel, /pause, /resume, /scout, /polymarket, /trades [n], /kill, /risk, /tax, /public on|off, /help. Inline keyboard trade approval flow (approve/skip/hold with 30m timeout). Dead man's switches: SCOUT no run >6h, BANKR agent no run >8h, BANKR monitor no tick >30min → auto-alert. Trade alerts (executed/stopped/emergency/closed). Brief forwarding from alert system. Mode indicator [BETA] on every message. Graceful degradation if TELEGRAM_BOT_TOKEN missing. Env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
- **src/news.ts** — News headlines via Google News RSS feeds
- **src/conversations.ts** — Conversation persistence module (save/load/list/delete via PostgreSQL, AI summaries via Haiku, last-conversation context for session start). Uses Replit's built-in PostgreSQL database (DATABASE_URL) so conversations persist across deployments
- **src/hindsight.ts** — Vectorize.io Hindsight knowledge graph memory client. Semantic memory with retain/recall/reflect operations. Auth via VECTORIZE_API_KEY + VECTORIZE_ORG_ID + VECTORIZE_KB_ID. Rate limit retries (429/5xx), 15s timeout, 2 retries. `retain()` stores memories with metadata, `recall()` retrieves ranked matches by query, `reflect()` analyzes patterns across stored memories. Graceful fallback: returns empty results if unconfigured or API down
- **src/memory-extractor.ts** — Post-conversation fact extraction (profile updates, action items) via Claude Haiku. Dual-write: appends to vault markdown AND retains to Hindsight knowledge graph. Hindsight writes are non-blocking and non-fatal — vault is always the primary store
- **.pi/SYSTEM.md** — Agent personality, greeting template, vault structure map, auto-categorization rules, dual-source research default (web + X), and auto-catalog shared links behavior (auto-loaded by SDK from `.pi/SYSTEM.md`)
- **Vault index injection** — At session creation, a full vault tree (all folders/files) is generated via `buildVaultTree()` / `formatVaultIndex()` and injected into the agent's first prompt via `startupContext`. This gives the agent immediate awareness of all vault contents without needing to call notes_list first
- **.pi/agent/system-prompt.md** — Synced copy of SYSTEM.md for reference
- **.pi/agent/models.json** — Custom model registry entries (`claude-sonnet-4-6`, `claude-haiku-4-5-20251001`, `claude-opus-4-6`) so the Pi SDK's ModelRegistry can resolve them. These must match exact Anthropic API model IDs (no `-latest` aliases — Anthropic doesn't support them)
  - Three-tier model system with 4 modes: Auto (routes fast/full/max by intent), Fast (Haiku), Full (Sonnet), Max (Opus)
  - Auto mode uses MAX_PATTERNS to detect work/project keywords and route to Opus
  - Three-tier agent models: research agents (deep-researcher, analyst, moodys, project-planner, mindmap-generator) use Sonnet; utility agents (email-drafter, real-estate, nutritionist, family-planner, knowledge-organizer) use Haiku for cost efficiency. Orchestrator fallback uses Sonnet
  - All sub-agents use the custom `web_search` tool (DuckDuckGo-based) — Anthropic native server tools removed to avoid container_id API issues
  - Orchestrator: container_id tracking (future-proofing), graceful API error handling (400/429/529 with retry), soft timeout at 80% of budget (nudges agent to save partial results), hard timeout at 100%, fallback summary if no response. `SubAgentResult.timedOut` and `.error` flags propagated to job system
  - Agent loader validates tool names against registered tools at startup — logs warnings for unknown tools
- **src/obsidian-skills.ts** — Fetches and caches kepano's official Obsidian skills from GitHub (obsidian-markdown, json-canvas, obsidian-bases, defuddle). 24h TTL with disk + memory cache in `data/skills/`. Skills auto-injected into agent system prompts when agents have vault tools (via orchestrator). Ensures agents write proper Obsidian-flavored markdown (wikilinks, callouts, frontmatter, Canvas, Bases)
- **src/defuddle.ts** — HTML-to-markdown cleaning utility. Strips scripts, styles, nav, footer, ads, cookie banners. Converts headings, links, images, lists to markdown. Auto-applied in `notes_create` tool when content looks like HTML. Reduces token waste from web saves
- **Mind Map Generator** — `mindmap-generator` agent (Sonnet) creates `#mindmap`-formatted files compatible with openMindMap Obsidian plugin. Searches vault for related notes, synthesizes into hierarchical structure, saves to project folder. Auto-triggered when user says "map out X" or "visualize X". Config note at `Preferences/openMindMap-config.md`
- **src/vault-graph.ts** — Vault graph traversal and bidirectional linking engine:
  - `extractWikilinks(markdown)` — parses `[[wikilinks]]` from markdown, handles aliases (`[[path|alias]]`), ignores code blocks and escaped brackets
  - `graphContext(startPath, depth, tokenBudget)` — BFS traversal following wikilinks up to N hops deep. Resolves paths (with/without `.md`, basename matching). Token budget stops traversal early if content exceeds limit (default 30K tokens)
  - `findRelatedNotes(path, content)` — keyword extraction from filename + headings, scores vault files by title/folder overlap, returns top 5 related notes
  - `addBidirectionalLinks(newPath, content)` — post-creation hook: finds related notes, appends `## Related Notes` section with wikilinks to new note, appends `## Backlinks` entries in each related note
  - `notes_graph_context` tool registered in `buildKnowledgeBaseTools()` — available to deep-researcher, analyst, knowledge-organizer, mindmap-generator agents
  - Bidirectional linking runs automatically on every `notes_create` call (local vault only, non-fatal on error)
- **Vault Inbox (Link Drop Box)** — Paste any URL on Mission Control and the system auto-extracts, categorizes, and files it to the vault:
  - `POST /api/vault-inbox` — accepts `{ url, tag?, source? }`, returns immediately with `{ status: "processing", id }`. Agent processes async
  - `GET /api/vault-inbox/history` — last 10 filed items from `vault_inbox` DB table
  - `GET /api/vault-inbox/:id` — poll individual item status (processing/filed/error)
  - Link type auto-detection: YouTube (`youtube_video`), X/Twitter (`x_read_tweet`), GitHub/article (`web_fetch` → `render_page` fallback for blocked/JS-heavy pages)
  - Delegates to `knowledge-organizer` agent (Haiku) with structured prompt for extraction + auto-catalog filing. Agent has access to render_page (Browserbase cloud browser) and browse_page for interactive extraction
  - Vault folder routing by content topic (Moody's, health, AI, real estate, finance, etc.)
  - Structured notes with frontmatter (source, type, author, date_filed, tags), summary, key takeaways, wikilinks
  - Duplicate URL detection (checks DB before processing)
  - Activity logged to `Resources/Vault-Inbox-Log.md` and `agent_activity` table
  - Landing page UI: input field + submit button, processing spinner, confirmation card, history of last 5 filed items
  - Supports `source` field for future iOS Shortcut / email / MCP integration
- **Moody's Intelligence Pipeline** — Three scheduled jobs using the moodys agent:
  - Pass 1: Daily Intelligence Brief at 6:00 AM ET — 5 categories: Corporate News, Banking Segment, Competitor Watch (12 competitors), Enterprise AI Trends, Analyst Coverage (Celent, Chartis, Forrester, Gartner, IDC). Dual-source: searches both web AND X for each category. Includes 🐦 X/Twitter Signals section. Saves to `Scheduled Reports/Moody's Intelligence/Daily/YYYY-MM-DD-Brief.md`. Research only — does NOT update profiles.
  - Pass 2: Profile Updates at 6:15 AM ET — reads today's brief, appends date-stamped findings to competitor/analyst profiles in `Projects/Moody's/Competitive Intelligence/`
  - Weekly Strategic Digest on Sundays at 7:00 AM ET — reads from `Daily/`, synthesises into strategic analysis. Saves to `Scheduled Reports/Moody's Intelligence/Weekly/YYYY-MM-DD-Digest.md`
  - Auto-archive: reports older than 30 days move to corresponding `Archive/` subfolders
  - Moody's agent pre-read optimized: uses notes_list for folder awareness, only reads file content when directly needed for the current task. Timeout: 600s
- **Real Estate Property Scout** — Daily property scan using the real-estate agent:
  - Daily Property Scan at 7:30 AM ET — searches 6 areas (Upper Saddle River NJ, Montclair NJ, Princeton NJ, Long Island NY, Hudson Valley NY, Stamford-Westport CT) via Zillow AND Redfin APIs
  - Criteria: $1.3M–$1.8M, 4+ bed / 3+ bath, modern, garage, good schools, walkable. Commute to Brookfield Place (Battery Park City)
  - 6 RapidAPI tools: Zillow via `private-zillow.p.rapidapi.com` (`property_search`, `property_details`, `neighborhood_search`) + Redfin (`redfin_search`, `redfin_details`, `redfin_autocomplete`) + `x_search` for local market intel
  - Dual-platform search: cross-references Zillow and Redfin results, flags platform exclusives (🔵 Redfin-only, 🟡 Zillow-only)
  - 7-step daily scan: Zillow → Redfin → cross-reference → deep dive → X/social signals → commute research → Market Overview update
  - Saves to `Scheduled Reports/Real Estate/YYYY-MM-DD-Property-Scan.md`, appends to `Real Estate/Areas/`, saves ⭐ gems to `Real Estate/Favorites/`
  - Auto-archive >30 days to `Archive/Real Estate/`. Agent pre-reads Search Criteria + area files. Timeout: 600s
- **Daily Brief Dashboard** (`data/pages/daily-brief.html`) — Personal daily briefing at `/pages/daily-brief`:
  - Dark, sleek design with blue/navy aesthetic. Single-scroll layout (no tabs). Hero greeting adapts to time of day
  - **Family Cards**: Three horizontal cards — 👨‍💻 Rickin (tasks + emails count), 🤰 Pooja (pregnancy week + days to go), 👧 Reya (school info on weekdays, "No school today!" on weekends, GenAI fallback otherwise). Smart content varies by morning/afternoon/evening
  - **Markets**: 6-card grid (BTC, MSTR, SPX, Gold, Silver, Oil) with live prices + % change
  - **X Intelligence**: 5 sections (Breaking, Macro, Global, Tech/AI, Bitcoin) with curated handle lists from KB (`data/vault/Research/x-intelligence-dashboard-accounts.md`). Each section shows Visionaries + Headlines sub-feeds. 5 random handles per sub-feed, 2 tweets each. Batched API calls (6 concurrent). Sections collapsed by default except Breaking
  - **Other Sections**: Calendar (today + tomorrow), Real Estate (standalone), Moody's Intel, Tasks, Weather (Celsius), System status (job health)
  - **Collapsible Sections**: All sections collapsible with chevron toggles. State persisted in localStorage (`brief_collapsed_sections`). Listeners bound once (not re-attached on re-render)
  - API: `GET /api/daily-brief/data` aggregates all data. 2-min server cache; `?force=1` bypasses cache for manual refresh. `familyCards` and `xIntel` added to response
  - Client polls every 5 min. Manual refresh button (with cache bypass) in footer
  - **Share Snapshot**: Share button in footer generates a self-contained HTML snapshot via `POST /api/pages/daily-brief/share`. Injects current data inline (no API calls needed), strips share/refresh buttons, publishes to `here.now` (24h expiry). Returns shareable URL shown in modal with Copy Link + Open buttons
- **X Intelligence Page** (`data/pages/x-intelligence.html`) — Standalone X/Twitter feed at `/pages/x-intelligence`:
  - Two-tab view: **"X Followers"** (visionaries/analysts) and **"Mainstream"** (institutional news outlets)
  - Prominent segmented control tab bar — active tab filled with accent blue, inactive clearly visible
  - 5 collapsible sections per tab: Breaking 🔥, Global 🌍, Macro 📊, Tech/AI 🤖, Bitcoin ₿
  - Each tweet card shows @handle, text, likes, retweets, time ago
  - API: `GET /api/x-intelligence/data` — lightweight endpoint that only fetches xIntel data (uses `fetchXIntelData()` helper). 2-min cache, falls back to daily brief cache. `?force=1` bypasses cache
  - Collapse state persisted in localStorage (`xintel_collapsed`)
  - **Share Snapshot**: Works with tabs — tab switching is pure client-side, so shared links allow full tab interaction. Data baked inline
- **Baby Dashboard** (`data/pages/baby-dashboard.html`) — Pregnancy tracker at `/pages/baby-dashboard`:
  - Due date July 7, 2026; OB: Dr. Boester; Google Sheet ID: `1fhtMkDSTUlRCFqY4hQiSdZg7cOe4FYNkmOIIHWo4KSU`
  - 5 Sheet tabs: Appointments (OB schedule), To-Do (21 tasks), Shopping List (37 items), Hospital Bag (50 items), Names (with meanings + fav status)
  - Real-time API: `GET /api/baby-dashboard/data` reads all 5 tabs via `gws.sheetsRead()`, returns structured JSON with 60s server cache
  - Sync metadata: response includes `sync.source` ("live"), `sync.partial` (boolean), `sync.errors` (failed tabs) — drives client badge (Live/Partial/Offline/Error)
  - `GET /api/baby-dashboard/status` returns Google auth health (`tokenValid`, `cacheAge`, `reconnectUrl`)
  - Client: fetches API on load + polls every 5 min; hardcoded fallback data in HTML for offline resilience
  - Scheduled job: `baby-dashboard-weekly-update` (Monday 7 AM ET) — reads all tabs and injects updated JSON blocks into the HTML file
  - Google auth health check: server proactively refreshes token every 6 hours, logs warnings if refresh fails
  - **Share Snapshot**: Share button in footer generates a self-contained HTML snapshot via `POST /api/pages/baby-dashboard/share`. Injects current Google Sheets data via SSR, strips share/interactive elements, publishes to `here.now` (24h expiry). Same modal UI as Daily Brief
- **@darknode Inbox Monitor** — Automated email-to-task pipeline:
  - Polls Gmail every 30 minutes for unread emails containing `@darknode` + instruction
  - Uses `getDarkNodeEmails()` from `src/gmail.ts` to search `is:unread @darknode`, extract instruction text after the `@darknode` tag
  - Tracks processed email IDs in `app_config` key `darknode_processed_emails` (keeps last 200 IDs) — avoids reprocessing without needing `gmail.modify` scope
  - For each email, constructs a prompt with the full email content + instruction, runs via `deep-researcher` agent
  - Common instructions: "add to KB" (save to vault), "summarize", "add to calendar", "action items", "tasks"
  - Results saved to `Scheduled Reports/Inbox Monitor/` with timestamps
  - Usage: forward any email to `rickin.patel@gmail.com` and reply/add `@darknode [instruction]` in the body
- **public/** — Static frontend (terminal/hacker aesthetic, branded as "RICKIN")
  - Swipe navigation: swipe right from chat → Mission Control (iOS-style slide), swipe left from Mission Control → resume chat. Mid-stream safe (SSE stays open if agent is running). Excludes interactive areas (inputs, code blocks, tables). Uses `lastKnownConversations` for resume target; falls back to active session if one exists
  - Planning mode toggle: lightning bolt / checkmark icon button in `.input-row` before prompt prefix. Cycles plan/execute on tap, syncs to server via `PUT /api/session/:id/planning-mode`. Amber "PLAN MODE" banner appears above input when active. Persists preference in localStorage across sessions. Server injects system prompt prefix instructing AI to plan-then-confirm before tool use (applies to both `/prompt` and queued messages)
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
- **data/agents.json** — Agent definitions (9 agents: deep-researcher, project-planner, email-drafter, analyst, real-estate, nutritionist, moodys, family-planner, knowledge-organizer). Hot-reloaded on file change via `src/agents/loader.ts`. 103 of 110 tools assigned across agents
- **data/vault/Replit Agent/** — Self-referencing system documentation in the vault (Architecture, Memory System, Alerts & Briefs, Agent Team, Tools Reference, Rules & Behavior, UI & Frontend, Changelog). Updated on major changes so all DarkNode agents understand the system
- **data/vault/Agents/** — Per-agent documentation (all 9 agents: Agents Overview, Deep Researcher, Project Planner, Email Drafter, Market Analyst, Real Estate Agent, Nutritionist, Moodys Researcher, Family Planner, Knowledge Organizer)

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
| `/api/daily-brief/data` | GET | Daily brief dashboard data (weather, markets, tasks, events, news, jobs) — 2min cache |
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
  - Settings panel (gear icon in header) with sections: Appearance (theme toggle), Alert Settings (calendar reminders, stock moves, task deadlines, important emails), Scheduled Agents (job cards with enable/disable toggles, hour/minute pickers, Run button, custom job form, health summary banner), Watchlist (stock/crypto tickers), Logout
  - Settings auto-save with 500ms debounce
  - Ambient ticker on Mission Control landing page: replaces static glance strip with cycling ticker that rotates through 2-3 groups of info every 5s with fade transitions. Cycle 1: weather, emails, tasks. Cycle 2: upcoming calendar events (from all family calendars with person labels — Pooja, Reya) + next scheduled job. Cycle 3 (if needed): failed/partial jobs. Managed by `startLandingTicker()`/`stopLandingTicker()`, built by `buildLandingTickerCycles()`. Cleaned up on session teardown

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

### Current Agents (9)
| ID | Name | Model | Tools | Key Capabilities |
|----|------|-------|-------|-----------------|
| `deep-researcher` | Deep Researcher | Opus | 26 | Web + X + YouTube research, image analysis, page rendering, vault, weather, tasks, publishing |
| `project-planner` | Project Planner | Sonnet | 17 | Full task CRUD, calendar scheduling, interview forms, vault search |
| `email-drafter` | Email Drafter | Opus | 25 | Full Gmail management, web_fetch for linked pages, describe_image for attachments, calendar |
| `analyst` | Market Analyst | Opus | 20 | Stocks, crypto, news, full X access, YouTube, chart analysis, vault persistence |
| `real-estate` | Real Estate Agent | Opus | 21 | Zillow + Redfin, Maps commutes/nearby, photo analysis, YouTube neighborhood tours, X |
| `nutritionist` | Nutritionist | Sonnet | 10 | Recipes, YouTube tutorials, food photo analysis, vault |
| `moodys` | Moody's Researcher | Opus | 75 | Full Google Workspace, news, X, YouTube, image/page analysis, tasks, interview |
| `family-planner` | Family Planner | Sonnet | 13 | Financial/legal planning, YouTube, spreadsheets, calendar, tasks |
| `knowledge-organizer` | Knowledge Organizer | Sonnet | 12 | Full vault management (10 tools), web search/fetch for enrichment |

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

## Knowledge Base Sync Reminder

After making significant changes (new tools, agent config updates, bug fixes, feature additions), update the relevant folders in the knowledge base vault:
- **`Agents/`** — Agent definitions, capabilities, tool lists
- **`Replit Agent/`** — Fix requests, changelogs, architecture notes
- **`Replit Agent/Fix Requests/`** — Mark completed fix requests as Done

## Deployment

- Target: VM (always running) — needed for in-memory sessions and SSE
- Build: `npm run build`
- Run: `node dist/server.js`
