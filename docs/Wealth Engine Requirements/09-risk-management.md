# Risk Management Framework

## Design Philosophy

Risk management operates at three levels: per-trade rules (enforced by BANKR), portfolio-level rules (enforced by oversight + BANKR), and system-level rules (enforced by infrastructure). Each level is independent — if one fails, the others still protect capital.

## Level 1: Per-Trade Risk (BANKR)

Applied before every trade execution. Binary pass/fail — trade is rejected if any check fails.

| Check | Rule | Enforcement |
|-------|------|-------------|
| Position sizing | Risk amount = 2% of portfolio. Size = risk / (entry - stop) | Calculated pre-trade |
| Leverage cap | Never exceed 2x | Rejected if requested leverage > 2x |
| Margin buffer | Liquidation price must be > 20% away from entry | Calculated from venue margin requirements |
| Liquidity | Venue must have sufficient depth for position size | Check order book / available liquidity |
| Slippage estimate | Expected slippage < 1% of entry price | Based on order book depth vs size |

## Level 2: Portfolio Risk (Oversight + BANKR)

Applied continuously and before new trades.

| Check | Rule | When |
|-------|------|------|
| Drawdown circuit breaker | Auto-pause if rolling 7-day P&L < -15% | Checked on every position monitor tick |
| Correlation/exposure | Max 2 positions in same exposure bucket | Checked pre-trade |
| Total deployment | Max 80% of portfolio in open positions | Checked pre-trade |
| Concurrent positions | Max 5 open positions | Checked pre-trade |
| Per-asset cumulative loss | Flag if single asset caused > 5% portfolio loss | Daily review |

## Level 3: System Risk (Infrastructure)

| Check | Rule | Enforcement |
|-------|------|-------------|
| Kill switch | Closes ALL positions immediately | Manual via Telegram, checked every 5 min |
| Dead man switch — SCOUT | Alert if no run in 6 hours | Automated Telegram alert |
| Dead man switch — BANKR monitor | Alert if no run in 30 minutes | Automated Telegram alert |
| API failure | Alert if > 10% error rate | Health check every 4 hours |
| Mode enforcement | SHADOW mode prevents real execution | Checked in BANKR execution flow |
| Pause enforcement | `wealth_engines_paused` stops all scheduled jobs | Checked before every job execution |

## Exit Strategies

### Crypto Positions

| Exit Type | Trigger | Priority |
|-----------|---------|----------|
| Kill switch | Manual activation | Highest — immediate |
| Circuit breaker | -15% rolling 7-day P&L | High — auto-pause + close |
| Trailing stop | Price < peak - 5.5x ATR | Standard |
| RSI exit | RSI > 69 (longs) or RSI < 31 (shorts) | Standard |
| Thesis expiry | 72h since thesis creation | Low — review, not auto-close |
| Manual | User decision via Telegram | Any time |

### Polymarket Positions

| Exit Type | Trigger | Priority |
|-----------|---------|----------|
| Kill switch | Manual activation | Highest — immediate |
| Odds threshold | Odds moved against by > exit threshold | Standard |
| Whale consensus flip | Tracked whales reversed direction | Standard |
| Resolution proximity | Market resolving within 1 hour | Standard |
| Stale timeout | Position held > stale timeout days | Low — review |

## Scenario Analysis

### Worst Case: Flash Crash

```
BTC drops 15% in 30 minutes.
- Position monitor checks every 5 min → catches within 5 min
- Trailing stop (peak - 5.5x ATR) triggers
- With $50 portfolio, 2x leverage, 2% risk: max loss = $1
- Even with 5% slippage on exit: max loss ≈ $1.05
- Portfolio impact: -2.1%
- System continues operating
```

### Worst Case: API Outage

```
CoinGecko goes down for 6 hours.
- Dead man switch alerts at 6h mark
- SCOUT micro-scans fail silently (cached data used)
- Position monitor uses cached price → stale but safe
- No new theses generated (correct behavior)
- Existing positions maintain trailing stops from last known ATR
- User notified via Telegram to monitor manually
```

### Worst Case: Consecutive Losses

```
5 consecutive losses at 2% risk each.
- Trade 1: -$1.00 (portfolio: $49)
- Trade 2: -$0.98 (portfolio: $48.02)
- Trade 3: -$0.96 (portfolio: $47.06)
- Trade 4: -$0.94 (portfolio: $46.12)
- Trade 5: -$0.92 (portfolio: $45.20)
- Total loss: -$4.80 (-9.6%)
- Circuit breaker at -15% NOT triggered
- Daily performance review flags pattern
- Oversight agent generates improvement hypothesis
```

## Telegram Risk Commands

| Command | Action |
|---------|--------|
| `/kill` | Activate kill switch — close ALL positions |
| `/pause` | Pause all Wealth Engine jobs |
| `/resume` | Resume after pause or circuit breaker |
| `/risk` | Show current risk metrics (exposure, drawdown, open risk) |
| `/oversight` | Show latest health report + improvement queue |
