# Phased Build Plan

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

**Acceptance:** All commands respond correctly. Pause/resume toggles work. Dead man switches fire on threshold.

---

## Phase 1: CRYPTO SCOUT Intelligence — Task #33

**What gets built:**
1. Upgrade technical signals to 6-signal Nunchi voting ensemble (all 6 active)
2. Vote counting (bull/bear out of 6) with 4/6 entry gate
3. BTC confirmation filter for alt trades
4. 2-bar cooldown tracking
5. Very-short momentum signal (6-bar)
6. Dynamic vol-adjusted entry threshold
7. Backtesting module (bar-by-bar OHLCV replay, Nunchi scoring)
8. Nansen API integration (smart money, token holders, hot contracts)
9. Thesis data model and persistence (72h auto-expire)
10. SCOUT agent definition with full system prompt
11. Two scheduled jobs: micro-scan (30min) + full cycle (4h)
12. Watchlist management in DB
13. Enriched `/scout` and `/intel` commands

**Testing criteria:**
- [ ] Run `analyzeAsset()` on BTC — returns 6 active signals with vote count
- [ ] Run backtest on BTC 30-day data — returns Sharpe, drawdown, trade count
- [ ] Nansen API calls return cached data (or graceful degradation if no API key)
- [ ] SCOUT micro-scan executes on schedule, updates watchlist scores
- [ ] SCOUT full cycle generates at least 1 thesis from real market data
- [ ] Thesis saved to DB, visible via `/scout` command
- [ ] Thesis auto-expires after 72 hours
- [ ] BTC filter prevents alt entry when BTC momentum opposes

**Done when:** SCOUT is generating real theses from real market data on a schedule, visible via Telegram.

---

## Phase 2: POLYMARKET SCOUT — Task #38

**What gets built:**
1. Polymarket API integration (markets, wallet positions, wallet history)
2. Whale watchlist with scoring (win rate, ROI, category expertise)
3. Activity scanner (30-min interval)
4. Thesis generation when whale activity meets thresholds
5. Context validation (news/X cross-reference)
6. Agent definition + scheduled jobs
7. `/polymarket` Telegram command
8. Weekly wallet review job

**Testing criteria:**
- [ ] Polymarket API returns market data and wallet positions
- [ ] Whale scoring produces sensible scores from historical data
- [ ] Activity scanner detects mock whale position changes
- [ ] Thesis generated when consensus + wallet score thresholds met
- [ ] `/polymarket` shows formatted thesis data
- [ ] Theses use same unified format as crypto theses

**Done when:** POLYMARKET SCOUT generates theses from real whale activity, visible via Telegram.

---

## Phase 3: BANKR Execution Engine — Task #34

**What gets built:**
1. BNKR API integration (open/close perp positions) — BNKR-only venue
2. ~~Coinbase Wallet integration~~ (removed — Coinbase is manual funding-only rail)
3. Pre-execution risk checks (all per-trade + portfolio-level)
4. Telegram approval flow integration
5. Position monitor (5-min independent interval)
6. Trailing stop, RSI exit, kill switch enforcement
7. Slippage tracking (expected vs actual fill)
8. Correlation/exposure bucket check
9. Shadow mode (log hypothetical trades without execution)
10. Tax lot creation (FIFO)
11. Wash sale detection
12. Form 8949 CSV export
13. `/portfolio`, `/trades`, `/tax` command enrichment
14. `/kill` command for emergency stop

**Testing criteria (SHADOW MODE FIRST):**
- [ ] BANKR receives thesis, runs all pre-execution checks
- [ ] Telegram approval flow: approve → shadow trade logged
- [ ] Shadow trade tracks hypothetical P&L using real prices
- [ ] Position monitor runs every 5 min, updates shadow positions
- [ ] Trailing stop triggers correctly on shadow positions
- [ ] Tax lot created for each shadow trade
- [ ] Wash sale flagged when re-entry within 30 days of shadow loss
- [ ] Form 8949 CSV generates valid output
- [ ] Correlation check prevents concentrated exposure
- [ ] `/shadow` shows paper trading performance

**Testing criteria (LIVE MODE — only after shadow validation):**
- [ ] BNKR order submission works on testnet/small amount
- [ ] Actual fill price recorded, slippage calculated
- [ ] Real position monitor updates from venue
- [ ] Kill switch closes real position on BNKR
- [ ] Tax lot with real transaction hash recorded

**Done when:** System runs in shadow mode for 2+ weeks with positive hypothetical P&L before switching to live.

---

## Phase 4: OVERSIGHT AGENT — Task #39

**What gets built:**
1. Health checker (every 4h) — agent uptime, API errors, data freshness
2. Performance review (daily) — win rate, Sharpe, signal attribution, slippage
3. Improvement capture (weekly) — pattern analysis, bull/bear review, fix requests
4. Drawdown circuit breaker (-15% auto-pause)
5. Cross-domain exposure detection
6. Shadow trading mode integration
7. Improvement request data model and persistence
8. Agent definition + scheduled jobs
9. `/oversight` and `/risk` Telegram commands
10. Daily performance summary to Telegram
11. Data export API for Mac Mini migration

**Testing criteria:**
- [ ] Health check runs, produces structured report
- [ ] Daily summary calculates correct metrics from trade history
- [ ] Signal attribution correctly identifies per-signal win rates
- [ ] Drawdown circuit breaker triggers at -15% (test with mock data)
- [ ] Improvement requests generated and stored in DB
- [ ] `/oversight` shows health + improvements
- [ ] Export API returns full state dump

**Done when:** Oversight agent produces daily summaries and weekly improvement reports from real (or shadow) trade data.

---

## Phase 5: AUTORESEARCH — Task #37

**What gets built:**
1. Shared autoresearch engine (pluggable backtest interface)
2. Crypto parameter space and mutation generator
3. Polymarket parameter space and mutation generator
4. Crypto backtest (OHLCV replay with Nunchi scoring)
5. Polymarket backtest (historical outcome replay)
6. Experiment logging with full metadata
7. Parameter adoption/reversion with safety guardrails
8. Rollback history (5 per domain)
9. Oversight hypothesis integration
10. Weekly scheduled job + `/research` Telegram commands

**Testing criteria:**
- [ ] Candidate generation produces valid parameter sets within ranges
- [ ] Crypto backtest produces consistent scores for same parameters
- [ ] Improvement > 0.5% results in parameter adoption
- [ ] Improvement < 0.5% results in reversion
- [ ] Parameter drift cap prevents > 30% change per run
- [ ] Rollback restores previous parameter set
- [ ] Scouts load updated parameters at runtime
- [ ] Experiment log persists all attempts

**Done when:** Autoresearch can run a 10-experiment crypto cycle and produce measurable parameter improvements (or confirm current parameters are optimal).

---

## Phase 6: Mac Mini Migration

**What gets migrated:**
1. Install OpenClaw + Ollama on Mac Mini
2. Configure heartbeat scheduler for oversight + autoresearch
3. Set up Telegram integration via OpenClaw
4. Configure hybrid model (local Ollama + Claude fallback)
5. Test data sync: Mac Mini pulls export, pushes reports
6. Validate local model quality against Claude baseline
7. Cut over oversight + autoresearch from Replit to Mac Mini

**Testing criteria:**
- [ ] OpenClaw runs 24/7 on Mac Mini without intervention
- [ ] Ollama generates acceptable quality analysis (manual review)
- [ ] Data sync endpoint pulls/pushes correctly
- [ ] Telegram alerts work from both Replit and Mac Mini
- [ ] Autoresearch produces similar-quality experiments locally vs cloud

**Done when:** Oversight and autoresearch run locally for 1 week with no issues.

---

## Phase 7: DASHBOARD — Task #36

**What gets built:**
1. Portfolio view with live P&L
2. Thesis list (both domains)
3. Trade history with filters
4. Oversight reports
5. Performance charts
6. Tax summary view
7. Shadow portfolio view
8. Public/private access control

**Done when:** Dashboard provides full visibility into all Wealth Engines data without needing Telegram.

---

## Summary Timeline

| Phase | Task | Depends On | Key Milestone |
|-------|------|------------|---------------|
| 0 | Foundation | — | CoinGecko + Telegram working |
| 1 | CRYPTO SCOUT | Phase 0 | Real crypto theses on schedule |
| 2 | POLYMARKET SCOUT | Phase 0 | Real whale-based theses on schedule |
| 3 | BANKR | Phase 1 + 2 | Shadow trading with paper P&L |
| 4 | OVERSIGHT | Phase 1 + 2 + 3 | Daily performance reports |
| 5 | AUTORESEARCH | Phase 1 + 2 + 4 | Self-improving parameters |
| 6 | Mac Mini | Phase 4 + 5 | Local compute for batch work |
| 7 | DASHBOARD | Phase 3 | Full web visibility |

Phases 1 and 2 can run in parallel. Everything else is sequential.
