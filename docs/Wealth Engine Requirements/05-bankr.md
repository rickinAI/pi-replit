# BANKR: Unified Execution Engine

## Purpose

Execute trades based on validated theses from both CRYPTO SCOUT and POLYMARKET SCOUT. Manage positions, enforce risk rules, track taxes, and provide real-time position monitoring. BANKR is the only component that touches real capital.

## Execution Venues

| Venue | Asset Class | Type | Why |
|-------|-------------|------|-----|
| BNKR (Avantis on Base) | Crypto | Perpetual contracts | Leverage, short capability |
| BNKR (Avantis on Base) | Polymarket | Prediction markets | Polymarket execution layer |

**Single venue architecture:** All trade execution routes through BNKR. Coinbase is a manual funding-only rail (not used for trade execution).

**Excluded:** Hyperliquid (NY compliance), all offshore platforms, Kreo.

## Risk Rules

### Per-Trade Limits

| Rule | Value | Enforcement |
|------|-------|-------------|
| Max risk per trade | 5% of portfolio | Position size = risk amount / (entry - stop) |
| Max leverage | 5x | Enforced before order submission |
| Margin buffer | 20% above liquidation | Reject trade if buffer insufficient |
| Max concurrent positions | 3 | Concentrated high-conviction portfolio |

### Portfolio-Level Limits

| Rule | Value | Enforcement |
|------|-------|-------------|
| Drawdown circuit breaker | -15% rolling 7-day P&L | Auto-pause via `wealth_engines_paused` |
| Peak drawdown breaker | -25% from peak portfolio | Kill switch activation |
| Correlation limit | Max 1 position per exposure bucket | Pre-execution check |
| Total exposure | Max 60% of portfolio deployed | Reserve 40% as buffer |

### Exposure Buckets

Positions are tagged into exposure buckets to prevent correlated concentration:

```
ETH bucket: ETH spot, ETH perp, "ETH > $5000" prediction
BTC bucket: BTC spot, BTC perp, BTC prediction markets
SOL bucket: SOL spot, SOL perp, SOL predictions
General crypto: other crypto positions
Prediction-only: non-crypto prediction markets
```

## Execution Flow

```
1. Thesis arrives (from either scout)
2. Pre-execution checks:
   a. Kill switch not active
   b. System not paused
   c. Mode is LIVE (not SHADOW)
   d. Risk per trade within 2% limit
   e. Leverage within 2x limit
   f. Margin buffer sufficient
   g. Correlation check: exposure bucket not at limit
   h. Total exposure within 80% limit
   i. Liquidity check: venue has sufficient depth
3. Telegram approval request → wait for response (30-min timeout)
4. If approved:
   a. Submit order to venue
   b. Record expected vs actual fill (slippage tracking)
   c. Create position record
   d. Create tax lot (FIFO)
   e. Notify via Telegram
5. If skipped/timeout: log decision, no action
6. If hold: keep thesis active, re-evaluate next cycle
```

## Position Monitor

**Runs every 5 minutes as independent `setInterval` — NOT in the agent job queue.**

This is critical: position monitoring cannot be blocked by a slow agent job. It runs on a separate timer.

### Monitor Checks (Crypto)

1. Fetch current price for each open position
2. Update `peak_price` if current > peak (for trailing stop)
3. **Trailing stop:** If current price < peak - (5.5 * ATR) → close position
4. **RSI exit:** If RSI > 69 (overbought, close longs) or RSI < 31 (oversold, close shorts)
5. **Kill switch:** If active → close ALL positions immediately
6. Update unrealized P&L

### Monitor Checks (Polymarket)

1. Fetch current odds for each open position
2. **Odds threshold:** If odds moved against position by > exit threshold → close
3. **Whale consensus flip:** If tracked whales reversed direction → close
4. **Resolution proximity:** If market resolving within 1 hour → close (avoid settlement risk)

## Shadow Mode

When `wealth_engines_mode = "SHADOW"`:
- All execution flow runs identically EXCEPT step 4a (no order submitted)
- Records shadow trades with hypothetical entry at current market price
- Tracks shadow P&L using real market prices
- Reports shadow performance via `/shadow` command
- Used to validate system before deploying real capital

## Done Looks Like

- [x] BNKR API integration for perp orders (open, close, modify)
- [x] BNKR-only venue architecture (Coinbase removed from execution path)
- [ ] All pre-execution risk checks passing
- [ ] Telegram approval flow working end-to-end
- [ ] Position monitor running on 5-min interval (independent timer)
- [ ] Trailing stop, RSI exit, kill switch all functional
- [ ] Slippage tracking: expected vs actual fill logged
- [ ] Correlation/exposure bucket check preventing concentrated bets
- [ ] Shadow mode logging hypothetical trades
- [ ] Tax lot creation on every trade (see Tax & Audit doc)
- [ ] Trade history append-only log with full metadata
- [ ] `/portfolio` shows live positions with P&L
- [ ] `/trades` shows recent trade history
