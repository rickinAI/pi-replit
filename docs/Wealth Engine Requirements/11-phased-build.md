# Phased Build Plan

> **Updated:** March 23, 2026 — All Core Phases Complete

## Design Principle: Each Phase is Self-Contained

Every phase produces a working, testable system. You can stop after any phase and have something useful. Later phases add capability without breaking earlier ones.

---

## Phase 0: Foundation (COMPLETE)

**What was built:**
- CoinGecko integration: price, trending, movers, categories, OHLCV history
- Technical signals module: EMA, RSI, momentum (3 active), MACD, BB, vol regime (3 stubbed)
- Telegram command center: /status, /portfolio, /scout, /intel, /trades, /pause, /resume
- Trade approval flow with inline buttons
- Dead man switches
- Webhook auth + polling command parsing
- Pause enforcement in scheduled jobs

**Tasks:** #31 (CoinGecko), #32 (Telegram) — both MERGED

---

## Phase 1: CRYPTO SCOUT Intelligence (COMPLETE → REMOVED)

**Status:** Built and merged (Task #33), then fully removed in the March 22, 2026 crypto pivot. All crypto scout modules deleted.

---

## Phase 2: POLYMARKET SCOUT (COMPLETE)

**What was built:**
- Polymarket API integration (CLOB + Data API + Gamma API)
- Whale watchlist with 5-metric composite scoring
- Activity scanner (30-min interval → 2h optimized)
- Thesis generation when whale consensus meets thresholds
- Agent definition + scheduled jobs
- `/polymarket` Telegram command
- Market categorization: weather/politics/sports/crypto/esports/general
- NOAA weather edge signal (6 cities)

**Tasks:** #38 — MERGED

---

## Phase 3: BANKR Execution Engine (COMPLETE)

**What was built:**
- BNKR API integration for Polymarket execution on Base
- Pre-execution risk checks (all per-trade + portfolio-level)
- Position monitor (2-min independent interval)
- Odds target, stop loss, whale flip, underwater exit, resolution proximity
- Kill switch enforcement
- Shadow mode with streak tracking
- Tax lot creation (FIFO) + Form 8949 CSV export
- Signal quality feedback loop with 30-day time decay
- Copy trade support: is_copy_trade flag, source_wallet, fixed sizing
- `/portfolio`, `/trades`, `/tax`, `/shadow` commands

**Tasks:** #34 — MERGED

---

## Phase 4: OVERSIGHT AGENT (COMPLETE)

**What was built:**
- Health checker (every 4h) — subsystem freshness, dead man switches
- Performance review — win rate, Sharpe, slippage, source attribution
- Improvement capture — pattern analysis, structured requests with routing
- Drawdown circuit breaker (-15% auto-pause, -25% kill switch)
- Cross-domain exposure detection
- Shadow trading mode integration
- `/oversight` and `/risk` commands

**Tasks:** #39 — MERGED

---

## Phase 5: AUTORESEARCH (REMOVED)

**Status:** Removed in the March 22, 2026 crypto pivot. Parameter evolution via backtesting is not applicable to the copy trading strategy.

---

## Phase 6: Mac Mini Migration (DEFERRED)

**Status:** Deferred. Current system runs entirely on Replit. Will revisit when compute needs justify local infrastructure.

---

## Phase 7: DASHBOARD (COMPLETE)

**What was built:**
- DarkNode Command Center (wealth-engines.html)
- P&L & Tax Dashboard (wealth-engines-pnl.html)
- Control Panel (wealth-engine-controls.html)
- Portfolio view with live P&L, equity curve, drawdown visualization
- Whale Intelligence section with per-wallet performance
- Public/private access control

**Tasks:** #36 — MERGED

---

## Phase 8: COPY TRADING ENGINE (COMPLETE)

**What was built:**
- 5-minute whale snapshot diffing
- 8-signal scoring engine: VPIN, whale consensus, niche match, z-score, NOAA weather
- Tiered copy sizing: $50 (score≥8), $25 (score 4-7), skip (<4)
- buyOnly mode (only copies new entries, not exits)
- Observation_only wallet auto-clear (5min)
- Whale exit mirroring
- Auto-redeem resolved markets
- Telegram alerts with full signal breakdown

**Tasks:** #67 (Copy Trading), #68 (Wallet Management), #69 (Telegram Overhaul) — MERGED

---

## Phase 9: WALLET DECODE ON ADMISSION (COMPLETE)

**What was built:**
- `decodeWallet()` — one-time strategy classification on admission
- Scraper detection: avg entry >$0.90 AND >50% buys above $0.90
- Market maker detection: 4-signal heuristic (≥3 of 4)
- Per-wallet `maxCopyPrice` (niche-based: sports 0.80, politics 0.92, crypto 0.75, weather/general 0.85)
- Per-wallet `minTradeSize` (median × 0.3, min $25)
- Decode gate on `scoreAndPromoteCandidate()` and `addWallet()`
- Rejected wallets auto-blacklisted + Telegram alert
- Admitted wallets get Telegram notification with strategy/thresholds

**Completed:** March 23, 2026

---

## Phase 10: AUTONOMOUS WE CONTROL API (COMPLETE)

**What was built:**
- `GET/PUT /api/controls` — unified system state with Telegram alerts on change
- `POST /api/telegram/send` — arbitrary Telegram messaging
- `GET/POST/PUT/DELETE /api/whale-registry` — full whale registry CRUD with decode gate
- `PUT /api/whale-registry/:address` with `status: "blacklisted"` — evict + blacklist
- `GET /api/cost-summary` — API spend monitoring
- `POST /api/scheduled-jobs/:id/trigger` — force-run jobs
- All endpoints WE_CONTROL_USERS gated (rickin, darknode)
- DarkNode system prompt updated with full endpoint reference

**Tasks:** #74-76, #79 — MERGED. Completed: March 23, 2026

---

## Pending Work

| Item | Status | Blocker |
|------|--------|---------|
| Go-live (SHADOW → LIVE) | Pending | Need shadow win rate >55% over 50+ trades |
| Kill switch stress test | Pending | Need 50+ shadow trades first |
| Agent Autopilot (Task #77) | Proposed | Parked |
| Kreo Signal Ingestion (Task #78) | Proposed | User gathering sample alert messages |

---

## Summary Timeline

| Phase | What | Status | Key Milestone |
|-------|------|--------|---------------|
| 0 | Foundation | ✅ Complete | CoinGecko + Telegram working |
| 1 | CRYPTO SCOUT | ❌ Removed | Crypto pivot |
| 2 | POLYMARKET SCOUT | ✅ Complete | Whale-based theses on schedule |
| 3 | BANKR | ✅ Complete | Shadow trading with paper P&L |
| 4 | OVERSIGHT | ✅ Complete | Daily performance reports |
| 5 | AUTORESEARCH | ❌ Removed | Crypto pivot |
| 6 | Mac Mini | ⏸️ Deferred | Local compute for batch work |
| 7 | DASHBOARD | ✅ Complete | Full web visibility |
| 8 | COPY TRADING | ✅ Complete | 5-min snapshot diffing + 8-signal scoring |
| 9 | WALLET DECODE | ✅ Complete | Scraper/MM gate + per-wallet thresholds |
| 10 | AUTONOMOUS API | ✅ Complete | DarkNode self-management |
