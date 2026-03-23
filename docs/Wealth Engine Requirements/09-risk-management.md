# Risk Management Framework

> **Updated:** March 23, 2026 — Polymarket-Only + Dynamic Risk Config

## Design Philosophy

Risk management operates at three levels: per-trade rules (enforced by BANKR), portfolio-level rules (enforced by oversight + BANKR), and system-level rules (enforced by infrastructure). Each level is independent — if one fails, the others still protect capital.

## Level 1: Per-Trade Risk (BANKR)

Applied before every trade execution. Binary pass/fail — trade is rejected if any check fails.

| Check | Rule | Enforcement |
|-------|------|-------------|
| Position sizing | Copy trade: $50 (score≥8) / $25 (score 4-7) | Fixed sizing in SHADOW mode |
| Wallet price ceiling | Trade price ≤ wallet's maxCopyPrice | Per-wallet decode filter |
| Wallet min trade | Trade size ≥ wallet's minTradeSize | Per-wallet decode filter |
| Wallet win rate | ≥ 65% | Checked pre-trade |
| Odds range | 15-85¢ | Checked pre-trade |
| Volume/liquidity | ≥ $10K each | Checked pre-trade |
| Resolution buffer | > 24 hours | Checked pre-trade |

## Level 2: Portfolio Risk (Oversight + BANKR)

Applied continuously and before new trades. All thresholds are dynamic — stored in `wealth_engine_config` DB key and editable via Control Panel or `POST /api/wealth-engine/config`.

| Check | Default | When |
|-------|---------|------|
| Drawdown circuit breaker | -15% rolling 7-day P&L | Checked on every position monitor tick |
| Peak drawdown breaker | -25% from portfolio peak | Checked on every position monitor tick |
| Correlation/exposure | Max 1 position per exposure bucket | Checked pre-trade |
| Total deployment | Max 60% of portfolio in open positions | Checked pre-trade |
| Concurrent positions | Max 3 open positions | Checked pre-trade |
| Portfolio hard stop | $100 remaining | Copy trade evaluation filter |

## Level 3: System Risk (Infrastructure)

| Check | Rule | Enforcement |
|-------|------|-------------|
| Kill switch | Closes ALL positions immediately | Manual via Telegram/API, checked every 2 min |
| Dead man switch — SCOUT | Alert if no run in 6 hours | Automated Telegram alert |
| Dead man switch — BANKR monitor | Alert if no run in 30 minutes | Automated Telegram alert |
| API failure | Alert if > 10% error rate | Health check every 4 hours |
| Mode enforcement | SHADOW mode prevents real execution | Checked in BANKR execution flow |
| Pause enforcement | `wealth_engines_paused` stops all scheduled jobs | Checked before every job execution |
| Autonomous controls | DarkNode can pause/kill via `/api/controls` | WE_CONTROL_USERS gated |

## Exit Strategies (Polymarket Only)

| Exit Type | Trigger | Priority |
|-----------|---------|----------|
| Kill switch | Manual activation or API | Highest — immediate |
| Circuit breaker | -15% rolling 7-day P&L | High — auto-pause + close |
| Odds target | Position hit target odds | Standard |
| 10-point stop loss | Odds moved against by >10 points | Standard |
| Whale consensus flip | Tracked whales reversed direction | Standard |
| 30-day underwater | Position held >30 days with negative P&L | Standard |
| Resolution proximity | Market resolving within 4 hours | Standard |
| Copy trade exception | Copy trades bypass stop-loss AND 30-day underwater (only whale flip, resolution proximity, kill switch apply) | Rule modifier |

## Scenario Analysis

### Worst Case: Market Resolution Against Position

```
Polymarket market resolves against our YES position.
- Position monitor checks every 2 min
- Resolution proximity exit triggers at <4h
- If missed: position resolves to $0
- With $50 max copy trade: max loss = $50
- Portfolio impact: -0.5% on $10K capital
- System continues operating
```

### Worst Case: API Outage

```
Polymarket API goes down for 6 hours.
- Dead man switch alerts at 6h mark
- Copy trade scan fails silently (no new trades copied)
- Position monitor uses cached odds → stale but safe
- No new positions opened (correct behavior)
- User notified via Telegram to monitor manually
```

### Worst Case: Consecutive Losses

```
5 consecutive copy trade losses at $50 each.
- Trade 1: -$50 (portfolio: $9,950)
- Trade 2: -$50 (portfolio: $9,900)
- Trade 3: -$50 (portfolio: $9,850)
- Trade 4: -$50 (portfolio: $9,800)
- Trade 5: -$50 (portfolio: $9,750)
- Total loss: -$250 (-2.5%)
- Circuit breaker at -15% NOT triggered
- Daily performance review flags pattern
- Signal quality feedback loop degrades source scores
```

## Telegram Risk Commands

| Command | Action |
|---------|--------|
| `/kill` | Activate kill switch — close ALL positions |
| `/pause` | Pause all Wealth Engine jobs |
| `/resume` | Resume after pause or circuit breaker |
| `/risk` | Show current risk metrics (exposure, drawdown, open risk) |
| `/oversight` | Show latest health report + improvement queue |

## API Risk Controls

| Endpoint | Method | Action |
|----------|--------|--------|
| `/api/controls` | GET | Read system state (paused, killSwitch, mode, circuitBreaker) |
| `/api/controls` | PUT | Update system state with Telegram alerts |
| `/api/wealth-engine/config` | POST | Update risk parameters |
| `/api/wealth-engines/kill` | POST | Activate kill switch |
| `/api/wealth-engines/pause` | POST | Pause all execution |
| `/api/wealth-engines/resume` | POST | Resume execution |
