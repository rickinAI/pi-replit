# BANKR: Unified Execution Engine

> **Updated:** March 23, 2026 — Polymarket-Only Copy Trading

## Purpose

Execute copy trades mirrored from tracked Polymarket whale wallets. Manage positions, enforce risk rules, track taxes, and provide real-time position monitoring. BANKR is the only component that touches real capital.

## Execution Venue

| Venue | Asset Class | Type | Why |
|-------|-------------|------|-----|
| BNKR (Polymarket on Base) | Prediction markets | Polymarket execution | NY-compliant on-chain execution |

**Single venue architecture:** All trade execution routes through BNKR.

**Excluded:** Hyperliquid (NY compliance), all offshore platforms.

## Risk Rules

### Per-Trade Limits (Dynamic via DB)

All risk parameters are stored in `wealth_engine_config` DB key and editable via Control Panel or `POST /api/wealth-engine/config`.

| Rule | Default Value | Enforcement |
|------|---------------|-------------|
| Max risk per trade | 5% of portfolio | Position size = risk amount / (entry - stop) |
| Max leverage | 5x | Enforced before order submission |
| Max concurrent positions | 3 | Checked pre-trade |
| Copy trade size (score ≥8) | $50 | Fixed sizing in SHADOW mode |
| Copy trade size (score 4-7) | $25 | Fixed sizing in SHADOW mode |

### Portfolio-Level Limits

| Rule | Value | Enforcement |
|------|-------|-------------|
| Drawdown circuit breaker | -15% rolling 7-day P&L | Auto-pause via `wealth_engines_paused` |
| Peak drawdown breaker | -25% from peak portfolio | Kill switch activation |
| Correlation limit | Max 1 position per exposure bucket | Pre-execution check |
| Total exposure | Max 60% of portfolio deployed | Reserve 40% as buffer |
| Portfolio drawdown hard stop | $100 | Copy trade evaluation filter |

### Per-Wallet Filters (Set by Wallet Decode)

| Filter | Source | Enforcement |
|--------|--------|-------------|
| maxCopyPrice | `decodeWallet()` — niche-based ceiling | Trade price must be ≤ ceiling |
| minTradeSize | `decodeWallet()` — median × 0.3, min $25 | Trade size must be ≥ threshold |

### Copy Trade Evaluation Filters

| Filter | Threshold |
|--------|-----------|
| Wallet win rate | ≥ 65% |
| Odds range | 15-85¢ |
| Market volume | > $10K |
| Market liquidity | > $10K |
| Time to resolution | > 24 hours |
| Max concurrent copies | 3 |

## Execution Flow (Copy Trade)

```
1. Copy trade scan detects new whale position (5-min snapshot diff)
2. Per-wallet filters:
   a. Trade price ≤ wallet's maxCopyPrice
   b. Trade size ≥ wallet's minTradeSize
3. Signal engine scoring (8 signals):
   a. Gates: wallet score ≥0.6, odds 15-85%, >24h to resolution
   b. VPIN (0-3pts), whale consensus (0-3pts), niche match (0-2pts),
      z-score (0-2pts), NOAA weather edge (0-3pts)
4. Sizing: score ≥8 → $50, score 4-7 → $25, <4 → skip
5. Pre-execution checks:
   a. Kill switch not active
   b. System not paused
   c. Mode is LIVE (not SHADOW)
   d. Max positions not exceeded
   e. Exposure cap not exceeded
6. Execute via BNKR (or log shadow trade in SHADOW mode)
7. Create position record + tax lot (FIFO)
8. Telegram alert with full signal breakdown
```

## Position Monitor

**Runs every 2 minutes as independent `setInterval` — NOT in the agent job queue.**

This is critical: position monitoring cannot be blocked by a slow agent job. It runs on a separate timer.

### Monitor Checks (Polymarket)

1. Fetch current odds for each open position
2. **Odds target:** If position hit odds target → close
3. **10-point stop loss:** If odds moved against by >10 points → close
4. **Whale consensus flip:** If tracked whales reversed direction → close
5. **30-day underwater exit:** If position held >30 days underwater → close
6. **Resolution proximity:** If market resolving within 4 hours → close
7. **Kill switch:** If active → close ALL positions immediately
8. **Copy trade exception:** Copy trades bypass both percentage stop-loss AND 30-day underwater exit (only whale flip, resolution proximity, and kill switch apply)

## Shadow Mode

When `wealth_engines_mode = "SHADOW"`:
- All execution flow runs identically EXCEPT the BNKR order submission
- Records shadow trades with hypothetical entry at current market price
- Uses fixed $50 sizing for copy trades (not percentage-based)
- Tracks shadow P&L using real market prices
- Win/loss streak tracking (`shadow_streak` DB key, weekly reset Monday)
- Reports shadow performance via `/shadow` command
- Used to validate system before deploying real capital

### Go-Live Criteria
- Shadow win rate >55% over 50+ trades
- Kill switch stress test passed
- Circuit breaker tested and confirmed working

## Source Tracking

Every position and trade record includes:
- `source`: "polymarket_scout" | "manual" | "copy_trade"
- `source_wallet`: whale address (for copy trades)
- `is_copy_trade`: boolean flag
- `copy_trade_size_usd`: fixed dollar amount used

## Signal Quality Feedback Loop

`signal_quality_scores` DB key tracks per-source performance:
- Win/loss counts with 30-day time decay
- Rolling win rate, avg P&L, profit factor
- `getSignalQualityModifier()` returns modifier for a given source

## Tax Tracking

- FIFO tax lots with dynamic holding period
- `generateForm8949CSV()` exports as CSV
- Short-term vs long-term gain classification
- Quarterly breakdown with estimated federal (24% ST, 15% LT) and NY State (6.85%) taxes

## Done Looks Like

- [x] BNKR API integration for Polymarket execution
- [x] All pre-execution risk checks passing
- [x] Position monitor running on 2-min interval (independent timer)
- [x] Odds target, stop loss, whale flip, underwater exit, resolution proximity
- [x] Kill switch enforcement
- [x] Shadow mode logging hypothetical trades with streak tracking
- [x] Tax lot creation on every trade (FIFO)
- [x] Form 8949 CSV export
- [x] Signal quality feedback loop with time decay
- [x] Copy trade source tracking (wallet, size, flag)
- [x] Per-wallet decode filters enforced (maxCopyPrice, minTradeSize)
- [x] `/portfolio`, `/trades`, `/tax`, `/shadow` commands
- [ ] Go-live criteria met (shadow win rate >55% over 50+ trades)
- [ ] Kill switch stress test
