# pi-replit

Mobile-friendly web UI for the pi coding agent with knowledge base integration, deployable on Replit. Acts as a personal AI companion — chat with an AI agent that remembers you across sessions, learns about you over time, and can search, read, create, and organize notes in your knowledge base.

## Architecture

- **server.ts** — Express server wrapping the pi coding agent SDK
  - Creates agent sessions with Anthropic API
  - Registers custom tools (112 total): knowledge base (10), email (15: list, read, search, get_attachment, thread, send, reply, draft, archive, label, mark_read, trash, gmail_list_labels, gmail_create_label, gmail_delete_label), calendar (3: list events, create event with calendar targeting, list available calendars), weather, web search, web fetch (reads full page content from URLs), render_page (Browserbase cloud browser with anti-bot protection for JS-heavy/paywalled pages, falls back to Lightpanda if no API key), browse_page (interactive Browserbase sessions: click, type, scroll, extract — for cookie walls, pagination, login forms), describe_image (Claude vision), tasks (5), news (2), Google Drive (6), Google Sheets (13), Google Docs (12), Google Slides (12), YouTube (4), Zillow (3), Redfin (3), X/Twitter (4), maps (2: directions, search places), web pages (4: web_publish, web_save, web_list_pages, web_delete_page), interview, conversation_search
  - Multi-agent system with 13 specialist agents defined in `data/agents.json` (hot-reloaded on file change)
  - Dual-source research default: all research-oriented agents search both web AND X (Twitter) for maximum coverage. X tools added to deep-researcher, analyst, real-estate, and moodys agents
  - Streams agent events via SSE (Server-Sent Events)
  - Tracks conversation messages and persists them to PostgreSQL
  - Auto-saves conversations every 5 minutes; saves on session close/expiry/shutdown
  - Inline interview tool: AI sends structured question forms to user, waits for responses via Promise/SSE
  - Graceful shutdown on SIGHUP/SIGTERM/SIGINT (awaits all conversation saves via Promise.allSettled before exit, 5s timeout, releases port)
  - EADDRINUSE auto-recovery: pre-emptive port kill, probes port availability before listen, waits up to 15s with retries
  - Periodic knowledge base health check (every 15s) with connection status logging
  - Express error-handling middleware for clean JSON error responses
- **src/db.ts** — Shared PostgreSQL connection pool (single `pg.Pool`, max 10 connections). Creates 7 tables on init (`conversations`, `tasks`, `app_config`, `oauth_tokens`, `job_history`, `agent_activity`, `vault_inbox`) + enables pgvector extension. `vault_embeddings` table created by vault-embeddings module. `email_pipeline` table created by pipeline-store module at boot. All other modules import `getPool()` from here
- **src/obsidian.ts** — Client for the knowledge base REST API (10s timeout, 2 retries on transient failures, health ping)
- **src/gmail.ts** — Full Gmail integration via custom Google OAuth (15 tools: list, read, search, get_attachment with PDF extraction, thread, send, reply with threading headers, draft, archive, label, mark_read, trash, gmail_list_labels, gmail_create_label, gmail_delete_label). Tokens stored in PostgreSQL (oauth_tokens table). OAuth scopes: gmail.modify, calendar, drive, spreadsheets, documents, presentations, youtube.readonly. Also exports `getAccessToken()` for gws CLI and YouTube API
- **src/calendar.ts** — Google Calendar integration (shares OAuth tokens with Gmail via PostgreSQL). Queries all selected calendars (not just primary). `listEventsStructured()` returns events with calendar source names for family calendar awareness (Rickin, Pooja, Reya). `listCalendars()` exposes available calendars. `createEvent()` accepts optional `calendarName` for fuzzy-matching target calendar (e.g. "Reya" matches "Reya's Schedule")
- **src/weather.ts** — Weather via Open-Meteo (free, no API key)
- **src/websearch.ts** — Web search via DuckDuckGo HTML (free, no API key)
- **src/webfetch.ts** — Fetches web pages and converts HTML to clean readable text. Extracts title, meta description, and page content. Strips scripts/styles/nav/footer, converts headings to markdown, preserves links/images/tables/code blocks, decodes HTML entities. Handles HTML, JSON, and plain text responses. 80KB default content limit with smart truncation. 15s timeout. Used by `web_fetch` tool — available to all 9 agents
- **src/tasks.ts** — Task manager with PostgreSQL storage (tasks table)
- **src/scheduled-jobs.ts** — Scheduled agent jobs system. Runs agents autonomously on configurable schedules. 31 jobs (16 enabled). WE jobs: polymarket-activity-scan (2h), polymarket-full-cycle (4h), bankr-execute (1h), oversight-weekly-review (weekly), shadow-price-refresh (2h). Config stored in `app_config` key='scheduled_jobs'. 60s check loop with run-key dedup (interval jobs use timestamp-based dedup). Schedule types: `daily`, `weekly`, `interval` (with `intervalMinutes`). Status tracking: `success`, `partial` (timedOut or "PARTIAL" in response), `error`. Writes `Ops/Scheduled/job-status.json` to vault after each job. Per-job `toolSubset` field restricts tools sent to Anthropic API (reduces input tokens for lightweight scans). API: GET/POST/PUT/DELETE `/api/scheduled-jobs`, POST `/api/scheduled-jobs/:id/trigger`, GET `/api/scheduled-jobs/history`, GET `/api/kb/read?path=...`
  - **Cost Optimization**: All automated jobs forced to Haiku via modelOverride. Automated jobs use max_tokens=4096 (vs 16384 for interactive). Lightweight scan jobs (micro-scan, activity-scan, BANKR execute, shadow-refresh) have toolSubset filtering — only needed tools sent to API, cutting input token costs. Trimmed prompts for high-frequency jobs. Intervals widened: micro-scan 60m, BANKR 60m, activity-scan 120m, shadow-refresh 120m. DarkNode summaries reduced from 5/day to 3/day (9am, 3pm, 9pm). DB migration auto-applies on startup
  - **Agent Management UI** (Agents panel in app.js): Dashboard tab with health ring (SVG), total runs, estimated cost (per-model pricing), token usage stats, and per-agent cost breakdown with model badges (Haiku/Sonnet/Opus color-coded). History tab shows recent runs with status dots, model badges, per-run cost, token counts, summaries, and View Report buttons. Schedule tab with per-job toggle, time picker, Run Now, collapsible prompt editor (view/edit/save), and delete button with confirmation. Report overlay is full-screen fixed position with back/close buttons. Custom tab for creating new jobs. `job_history` table includes `agent_id`, `model_used`, `tokens_input`, `tokens_output` columns for tracking
- **src/copy-trading.ts** — Autonomous Polymarket copy trading engine with 8-signal scoring. Tracks 5-10 whale wallets via unified registry (`polymarket_whale_watchlist` in DB). Detects new positions via snapshot diffing (5-min polling). **Signal Engine** (`runSignalEngine()`): gates (wallet score≥0.6, odds 15-85%, >24h to resolution) + 5 scored signals: VPIN (0-3pts), whale consensus (0-3pts), niche match (0-2pts), z-score (0-2pts), NOAA weather edge (0-3pts). Tiered sizing: score≥8 → $50 full, 4-7 → $25 half, <4 → skip. buyOnly mode (only copies new entries, not exits). Observation_only wallets auto-cleared after 5min. Copy trade evaluation filters: wallet win rate ≥65%, odds 15-85¢, volume >$10k, liquidity >$10k, >24h to resolution, max 3 concurrent, $100 portfolio drawdown hard stop. Auto-redeem resolved markets. Whale exit mirroring. Telegram alerts with full signal breakdown. Registry uses `getWhaleWatchlist()`/`saveWhaleWatchlist()` from polymarket.ts. Scheduled job: `copy-trade-scan` every 5min
- **REMOVED MODULES** (crypto pivot complete): signal-sources.ts, coingecko.ts, dexscreener.ts, technical-signals.ts, autoresearch.ts, crypto-scout.ts, backtest.ts, nansen.ts, coinbase-wallet.ts, stocks.ts — all deleted as part of the prediction-markets-only pivot. DarkNode now operates exclusively through Polymarket copy trading
- **src/polymarket.ts** — Polymarket CLOB API client + unified wallet data layer. Market search/trending/details via Gamma API (gamma-api.polymarket.com, no auth). Direct position fetching via Polymarket Data API (`data-api.polymarket.com`). **Unified Wallet Registry** (`polymarket_whale_watchlist` DB key): WhaleWallet interface with niche, total_trades, last_checked, added_at, source, enabled, observation_only, degraded_count, pending_eviction fields. Whale scoring: 5-metric composite (win rate 30%, ROI 20%, category expertise 20%, volume 10%, recency 20%). **Data utilities**: `fetchWalletPositionsDirect()`, `fetchRecentTrades()`, `fetchWalletActivity()`, `buildWalletFromActivity()`, `categorizeMarketTitle()` (weather/politics/sports/crypto/esports/general), `determineNiche()`. **Signal data**: `calculateVPIN()`, `updateMarketPriceStats()`, `getMarketPriceStats()` (72h rolling window), `checkNOAAEdge()` (6 cities: NYC/Chicago/Seattle/Atlanta/Dallas/Miami). **Blacklist**: `initBlacklist()` seeds 11 protocol contracts (BNKR wallet, CTF Exchange, Neg Risk, Gnosis Safe, UMA, Uniswap v3, USDC.e). Generic `getAppConfig()`/`setAppConfig()` helpers
- **src/polymarket-scout.ts** — Polymarket SCOUT intelligence + wallet discovery. Thesis generation from whale consensus. **Auto-discovery**: `seedWalletsFromTradeStream()` mines recent trades for high-volume wallets, builds profiles, scores, auto-adds ≥0.6. `runAnomalyScanner()` scans 30-min trade window for unknown large wallets (≥$2K), promotes quality candidates as observation_only. `scoreAndPromoteCandidate()` builds full profile from activity API. `detectAndBlacklistMarketMakers()` behavioral fingerprint (mmScore≥3/4: tradeCount>100, buy/sell symmetry<0.15, markets>20, avgTrade<$500). `migrateWalletRegistries()` one-time migration from old `copy_trading_wallets` → unified registry. Thresholds: score≥0.6, ≥1 whale (tiered: HIGH/MEDIUM/LOW/SPECULATIVE), ≥$50K volume, 15-85% odds, ≥24h to resolution. Scheduled jobs: `anomaly-scanner` (30min), `seed-wallets` (weekly Sunday 9am). Boot sequence: migrate → init blacklist → auto-seed if registry<3
- **src/bnkr.ts** — BNKR API wrapper for Polymarket execution on Base. Polymarket: openPolymarketPosition, closePolymarketPosition, getPolymarketPositions, getPolymarketPositionPnL. Prompt-based execution via bnkrAnalyze(). Auth: BNKR_API_KEY + BNKR_WALLET_ADDRESS. Shadow mode when unconfigured (logs but doesn't execute). 15s timeout per request
- **src/bankr.ts** — BANKR execution engine (Polymarket only via BNKR). $10,000 starting capital. **DB-backed risk config** (`wealth_engine_config` key): all risk parameters are dynamic and editable via Control Panel or API. RiskConfig interface: max_leverage, risk_per_trade_pct, max_positions, exposure_cap_pct, correlation_limit, circuit_breaker_7d_pct, circuit_breaker_drawdown_pct, notification_mode. Defaults: 5x leverage, 5% risk/trade, 3 max positions, 60% exposure cap, 1/bucket correlation, -15% 7d breaker, -25% drawdown breaker. Tiered risk framework: autonomous (≤20% capital, confidence ≥3.5), dead_zone (20-30%, flag in Telegram), human_required (>30%, 3+ consecutive losses, drawdown, first trade on asset). Shadow mode support. FIFO tax lots with dynamic holding period. Source tracking (polymarket_scout/manual/copy_trade) on Position and TradeRecord. Copy trade support: `is_copy_trade` flag, `source_wallet` field, `copy_trade_size_usd` param; SHADOW mode uses fixed $50 sizing for copy trades; position monitor skips percentage stop-loss when `is_copy_trade === true`. **Signal Quality Feedback Loop** (`signal_quality_scores` DB key): tracks per-source win/loss counts, rolling win rate with 30-day time decay, avg P&L, profit factor. `getSignalQualityModifier()` returns modifier/winRate/sampleSize/profitFactor for a given source. `generateForm8949CSV()` exports tax lots as CSV. Independent position monitor (2-min setInterval): polymarket odds target, 10-point stop loss, whale consensus flip, 30d underwater exit, resolution proximity (<4h), kill switch check. Tools: bankr_risk_check, bankr_open_position, bankr_close_position, bankr_positions, bankr_trade_history, bankr_tax_summary, signal_quality
- **data/pages/wealth-engines.html** — DarkNode Command Center main dashboard at rickin.live/pages/wealth-engines. Prediction markets focused: KPIs (portfolio value, P&L, win rate, drawdown, copy trades active), EOY $50K target progress bar, positions display with odds (entry/current in cents), YES/NO direction, COPY/SHADOW badges, source wallet. Sections: P&L & Tax summary, Risk & Circuit Breakers, Open Positions (PM format), Active Theses (Polymarket), Whale Intelligence (tracked wallet registry with win rates, P&L, niche, W/L records), Trade History, Agent Activity, Autoresearch, System Health, Oversight. Crypto sections fully removed (no crypto theses, no Fear & Greed gauge, no crypto regime). API: GET /api/wealth-engines/data (30s cache) includes `whale_intelligence` field with tracked wallets and per-wallet copy trade performance
- **data/pages/wealth-engines-pnl.html** — P&L & Tax Dashboard at rickin.live/pages/wealth-engines-pnl. Equity curve chart (canvas-based, no CDN), drawdown visualization, trade markers, tabbed layout (Equity Curve / Tax Summary / Tax Lots). Tax summary: YTD realized P&L, short-term vs long-term gains, quarterly breakdown, wash sale flags, estimated federal (24% ST, 15% LT) and NY State (6.85%) taxes. Trade history shows source attribution (copy_trade, shadow, etc.) instead of leverage. SSR data injection for fast load. 60-second auto-refresh. API: GET /api/wealth-engines/pnl-data (30s cache)
- **data/pages/wealth-engine-controls.html** — DarkNode Control Panel at rickin.live/pages/wealth-engine-controls. Password-protected, dark-themed, mobile-first. Sections: Risk Parameters (risk/trade %, max positions, exposure cap, correlation limit, circuit breakers — leverage slider removed), Copy Trading (read-only display: $50/trade size, max 3 concurrent, odds range 15-85¢, min volume/liquidity $10K, min wallet WR 65%, $100 drawdown hard stop, tracked wallet count), Execution Controls (mode SHADOW/BETA/LIVE, pause/resume, kill switch, BNKR status), Agent Schedules, Portfolio, Notifications, System Health. Auto-refreshes every 30s. API: GET/POST /api/wealth-engine/config (includes `copy_trading` config object)
- **src/oversight.ts** — Wealth Engines Oversight Agent core logic. Operational risk monitoring, performance review, exposure detection, improvement capture, and shadow trading. Health checker evaluates subsystems (BANKR/PM Scout freshness, monitor heartbeat, kill switch, pause state, circuit breaker, job failures). Performance review: win rate, Sharpe ratio, avg P&L, slippage, source attribution (polymarket_scout), thesis conversion rate. Exposure detector: flags correlated Polymarket positions in same bucket, combined exposure alerts. Improvement request lifecycle: open→accepted→resolved/dismissed with dedup (24h window), routes: manual/bankr-config. Shadow trading: hypothetical trades tracked in parallel with P&L calculation. Auto-prunes data >30 days. DB keys: oversight_health_reports, oversight_improvement_queue, oversight_shadow_trades, oversight_last_health_check. Tools: oversight_health_check, oversight_performance_review, oversight_cross_domain_exposure, oversight_improvement_queue, oversight_capture_improvement, oversight_update_improvement, oversight_shadow_open, oversight_shadow_close, oversight_shadow_trades, oversight_shadow_performance, oversight_summary
- **src/pipeline-store.ts** — DB-first email pipeline event store. `email_pipeline` table (id, inbox, category, sender, subject, status, metadata JSONB, created_at) with indexes on inbox and created_at. Enforced JSONB envelope: `{inbox, category, sender_domain, classification_confidence, vault_written, vault_path, reject_reason, body_length, parsed_signals}`. Functions: `logPipelineEvent()`, `updatePipelineEvent()`, `queryPipelineEvents(filters)`, `getPipelineStats()` (by_inbox, by_category, total_24h, last_event_at), `pruneOldEvents(30)`. Auto-prune runs daily (30-day retention). Query API: GET `/api/pipeline/events` (inbox/category/since/limit params), GET `/api/pipeline/stats`
- **src/resend.ts** — Resend email webhook handler for agent inboxes (node@, intel@, engine@, vault@, access@ on agents.rickin.live). DB-first architecture: (1) classify email, (2) write structured event to `email_pipeline` table, (3) conditional vault write based on inbox rules, (4) Telegram notification. Vault write rules: intel@/vault@/node@ always, engine@ only if body >500 chars, access@ never. Verifies webhook signatures via svix, fetches full email from Resend API. Webhook endpoint: POST /api/resend/webhook (auth-bypassed)
- **src/email-classifier.ts** — Deterministic email routing engine for Resend inboxes. Sender-domain rules + subject keyword matching. Trust hierarchy: node@ strict allowlist (Rickin only, rejects + alerts on unknown), intel@ allowlist (crypto/polymarket/weather sources), engine@ allowlist (BNKR/trade sources), vault@ Rickin-only with content-based subfolder routing, access@ accepts all. Unroutable emails fall to System/Email-Unrouted/. vault@ fallback: Library/Inbox/ when classifier can't confidently route. `shouldWriteToVault(inbox, bodyLength)` implements conditional vault write rules
- **src/telegram-format.ts** — Shared formatting utilities for Telegram notifications. Category badge constants (WHALE INTEL, COPY TRADE, SHADOW BOOK, SCOUT, OVERSIGHT, DISCOVERY, DAILY BRIEF, AUTO-REDEEM, DEAD MAN, CIRCUIT BREAK), niche emoji map, market category badges, confidence bar visualization (SPECULATIVE/LOW/MEDIUM/HIGH), performance mood indicator, progress bar builder, streak text, HTML escaping (`escapeHtml`, `escapeAndPreserveHtmlTags`), 4096-char Telegram limit truncation, address truncation, confidence-based one-liners, P&L/percentage formatting, ET time formatting. Mission Control additions: section header emojis, family member emojis (Rickin/Pooja/Reya), priority circles, email category icons (Travel/Financial/Shopping/Documents/Calendar/Updates), `resolveFamilyEmoji()` for calendar events, brief header formatting, email batch grouping by category, Telegram-specific AI synthesis prompt builder, `formatTelegramAlert()` for alert messages, `formatDarkNodeSection()` for DarkNode section headers
- **src/telegram.ts** — Telegram Command Center for Wealth Engines mobile control. Direct Bot API via fetch (no library). Webhook mode with long-polling fallback. Two bots: DarkNode (@Darknode_trading_bot) for trading events + Mission Control (@MissionControl_alerts_bot) for personal alerts + status digests. All alert/brief messages use HTML parse_mode (not Markdown) for reliability with user-generated content. HTML entity escaping on all dynamic content. Commands: /status (enhanced: F&G, shadow P&L, PM scout timestamp, notify mode), /portfolio, /intel, /pause, /resume, /scout, /polymarket, /trades [n], /kill, /risk, /oversight, /shadow, /notify [smart|immediate], /research [polymarket|rollback|status], /tax, /reset [capital], /public on|off, /alerts, /wallets, /copytrades, /walletstatus, /seedwallets, /goal [amount], /help. **Notification Overhaul**: All WE notifications use category header badges via telegram-format.ts. Copy trade signals show niche emoji, market badge, confidence bar, whale one-liner. Shadow trade open/close has dramatic flair with streak tracking. DarkNode Summary with goal progress bar, mood indicator, today P&L, Fear & Greed, active theses breakdown. Mission Control alerts use separate formatting path: `formatTelegramBrief()` for briefs (with family emojis, section headers, priority circles), `formatTelegramAlert()` for alerts with category-specific icons. Separate web vs Telegram brief synthesis: AI generates two versions (web: 800 tokens plain, telegram: 1400 tokens emoji-rich). `BriefEvent.telegramContent` carries Telegram-specific content stripped before SSE broadcast. Calendar alerts enriched with family emojis, time context, and location. Env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_ALERTS_BOT_TOKEN, TELEGRAM_ALERTS_CHAT_ID
- **src/news.ts** — News headlines via Google News RSS feeds
- **src/conversations.ts** — Conversation persistence module (save/load/list/delete via PostgreSQL, AI summaries via Haiku, last-conversation context for session start). Uses Replit's built-in PostgreSQL database (DATABASE_URL) so conversations persist across deployments
- **src/vault-embeddings.ts** — Vault semantic layer using pgvector. Indexes all vault .md files into vector embeddings (chunked by heading, SHA-256 content hashing for incremental updates). Embedding providers: Cloudflare Workers AI bge-base-en-v1.5 (primary, via CF_ACCOUNT_ID + CF_API_TOKEN) or OpenAI text-embedding-3-small (fallback, via OPENAI_API_KEY). 768-dim vectors with HNSW index. Excludes noisy folders (Ops, Archive). Functions: `indexVault()` (incremental/full), `semanticSearch()` (cosine similarity with optional folder filter), `getSemanticNeighbors()` (find similar notes to a given note), `getOrphanedNotes()`, `getTopClusters()`, `getIndexStats()`. Scheduled 6-hour re-index. Agent tools: vault_semantic_search, vault_reindex, vault_contradictions (Claude Haiku analysis), vault_insights (cluster/orphan/theme report). REST API: GET /api/vault/smart-connections. Session context enrichment: auto-surfaces top 5 relevant vault notes at session start based on recent conversation topics
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
  - Pass 1: Daily Intelligence Brief at 6:00 AM ET — 5 categories: Corporate News, Banking Segment, Competitor Watch (12 competitors), Enterprise AI Trends, Analyst Coverage (Celent, Chartis, Forrester, Gartner, IDC). Dual-source: searches both web AND X for each category. Includes 🐦 X/Twitter Signals section. Saves to `Ops/Intelligence/Daily/YYYY-MM-DD-Brief.md`. Research only — does NOT update profiles.
  - Pass 2: Profile Updates at 6:15 AM ET — reads today's brief, appends date-stamped findings to competitor/analyst profiles in `Projects/Moody's/Competitive Intelligence/`
  - Weekly Strategic Digest on Sundays at 7:00 AM ET — reads from `Daily/`, synthesises into strategic analysis. Saves to `Ops/Intelligence/Weekly/YYYY-MM-DD-Digest.md`
  - Auto-archive: reports older than 30 days move to corresponding `Archive/` subfolders
  - Moody's agent pre-read optimized: uses notes_list for folder awareness, only reads file content when directly needed for the current task. Timeout: 600s
- **Real Estate Property Scout** — Daily property scan using the real-estate agent:
  - Daily Property Scan at 7:30 AM ET — searches 6 areas (Upper Saddle River NJ, Montclair NJ, Princeton NJ, Long Island NY, Hudson Valley NY, Stamford-Westport CT) via Zillow AND Redfin APIs
  - Criteria: $1.3M–$1.8M, 4+ bed / 3+ bath, modern, garage, good schools, walkable. Commute to Brookfield Place (Battery Park City)
  - 6 RapidAPI tools: Zillow via `private-zillow.p.rapidapi.com` (`property_search`, `property_details`, `neighborhood_search`) + Redfin (`redfin_search`, `redfin_details`, `redfin_autocomplete`) + `x_search` for local market intel
  - Dual-platform search: cross-references Zillow and Redfin results, flags platform exclusives (🔵 Redfin-only, 🟡 Zillow-only)
  - 7-step daily scan: Zillow → Redfin → cross-reference → deep dive → X/social signals → commute research → Market Overview update
  - Saves to `Ops/Real Estate/YYYY-MM-DD-Property-Scan.md`, appends to `Real Estate/Areas/`, saves ⭐ gems to `Real Estate/Favorites/`
  - Auto-archive >30 days to `Archive/Real Estate/`. Agent pre-reads Search Criteria + area files. Timeout: 600s
- **Wealth Engines Dashboard** (`data/pages/wealth-engines.html`) — Live portfolio dashboard at `/pages/wealth-engines`:
  - Dark theme matching Daily Brief design system. Mobile-first (480px max-width), Inter font
  - **Portfolio Overview**: 4-card hero grid — portfolio value + ATH, total P&L (realized + unrealized), drawdown % with color coding, exposure + position count
  - **Open Positions**: asset, direction badge, entry/current price, leverage, ATR stop, P&L %, source tag
  - **Recent Trades**: last 20 closed trades with P&L, close reason, leverage, source, time ago
  - **SCOUT Intelligence**: crypto SCOUT summary + regime, polymarket thesis count + top thesis
  - **System Health**: 6-indicator grid — kill switch, system status, mode, SCOUT health (6h threshold), monitor health (30min), BNKR connection
  - Kill switch banner (red) and pause banner (amber) shown when active
  - Mode badge: BETA (amber), LIVE (green), SHADOW (purple)
  - API: `GET /api/wealth-engines/data` returns all dashboard data as JSON. 30s server cache; `?force=1` bypasses
  - SSR data injection on page load (no loading spinner on first paint)
  - Auto-refresh: polls API every 60 seconds
  - Public access toggle: DB config key `wealth_engines_public` (default: false). When true, page + API bypass auth middleware. Togglable via Telegram `/public on|off` command
  - Share snapshot support via `/api/pages/wealth-engines/share` (here.now, 24h expiry)
  - Collapsible sections with localStorage persistence (`we_collapsed`)
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
  - Results saved to `Ops/Inbox Monitor/` with timestamps
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
- **Daily Digests**: Scheduled briefs (morning/afternoon/evening) are AI-synthesized by Claude Haiku into conversational summaries and saved to `Ops/Daily Digests/` in the vault

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
