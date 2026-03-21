# CRYPTO SCOUT: Intelligence Agent

## Purpose

Scan crypto markets and generate structured trading theses by synthesizing five data layers: price/market data (CoinGecko), technical signals (Nunchi 6-signal ensemble), smart money flows (Nansen), social sentiment (X/Twitter), and news context.

## Operating Frequencies

| Mode | Interval | Scope | Cost |
|------|----------|-------|------|
| Micro-scan | 30 min | Re-run technical analysis on watchlist assets, update scores | Low — deterministic code only, CoinGecko API calls |
| Full cycle | 4 hours | Complete multi-source scan: trending/movers → filter → analyze → validate → thesis | Medium — LLM synthesis for thesis generation |

## Technical Signals: Nunchi 6-Signal Voting Ensemble

Based on Nunchi autoresearch (103 experiments, Sharpe 2.7 → 21.4).

### The 6 Signals

| # | Signal | Parameters | Vote Logic |
|---|--------|------------|------------|
| 1 | EMA Crossover | Fast: 7, Slow: 26 | Bull: fast > slow, Bear: fast < slow |
| 2 | RSI | Period: 8, OB: 69, OS: 31 | Bull: RSI < 45 (room to run), Bear: RSI > 55 |
| 3 | Momentum | 12-bar lookback | Bull: positive return > threshold, Bear: negative |
| 4 | Very-Short Momentum | 6-bar lookback | Bull: positive, Bear: negative |
| 5 | MACD | Fast: 14, Slow: 23, Signal: 9 | Bull: histogram > 0 or crossing up, Bear: < 0 |
| 6 | BB Width | Period: 7, Percentile: 90 | Bull: compressed (breakout imminent), Bear: expanded |

### Entry/Exit Rules

- **Entry:** Minimum 4/6 bull votes required
- **BTC Filter:** Alt trades require BTC momentum not opposing direction
- **Cooldown:** 2-bar minimum between signals on same asset
- **Vol-Adjusted Threshold:** Entry threshold adjusts based on realized volatility
- **Exit — Stop Loss:** Peak price minus 5.5x ATR (trailing)
- **Exit — RSI:** Overbought > 69 (close longs), Oversold < 31 (close shorts)
- **Auto-expire:** Theses expire after 72 hours if not executed

### Dual Scoring

1. **Vote count** (binary decision): "5/6 bull" — used for entry/exit gates
2. **Weighted ensemble** (continuous confidence): 0.0-1.0 — used for thesis confidence and position sizing

Signal weights: EMA 40%, RSI 25%, Momentum 20%, MACD 10%, BB 3%, Vol Regime 2%

## Data Sources

### CoinGecko (existing)
- Trending coins, market movers, category rotations
- Historical OHLCV (hourly, up to 90 days)
- Global market overview (BTC dominance, total cap)
- Rate limit: 10 req/min (free tier)

### Nansen (new)
- `nansen_smart_money`: Net wallet flows for a token (are whales buying or selling?)
- `nansen_token_holders`: Holder concentration, whale activity
- `nansen_hot_contracts`: Trending smart contract interactions
- Cache TTL: smart_money 30 min, token_holders 1 hour, hot_contracts 15 min

### X/Twitter (existing)
- Ticker sentiment search
- Trader consensus signals
- Breaking news detection

### News/Web (existing)
- Context validation for thesis generation
- Macro event detection

## Full Cycle Flow

```
1. CoinGecko trending + movers → candidate list (20-30 assets)
2. Filter: min 24h volume > $1M, available on execution venue
3. Technical analysis on each candidate (6-signal ensemble)
4. Filter: only assets with vote_count >= 3/6 proceed
5. Backtest top 5 candidates on recent 30-day data
6. Nansen smart money check on top candidates
7. X sentiment scan for confirmation/contradiction
8. LLM synthesis: generate thesis package with confidence, adversarial notes
9. Save theses to DB, retire stale theses
10. Telegram summary to user
```

## Watchlist Management

- `scout_watchlist` in DB — list of CoinGecko IDs
- Full cycle updates watchlist: promotes trending/thesis assets, demotes inactive
- Micro-scan reads watchlist and re-runs technical analysis only
- Default watchlist: BTC, ETH, SOL, BNKR (always included)

## Backtesting

- Bar-by-bar replay of 6-signal ensemble against OHLCV history
- Simulates entries (4/6 votes) and exits (ATR stop, RSI exit)
- Metrics: Sharpe ratio, max drawdown, trade count, win rate
- Nunchi composite score: `Sharpe * sqrt(trade_count_factor) - drawdown_penalty - turnover_penalty`
- Used by SCOUT to validate signal quality before thesis generation
- Used by autoresearch for parameter optimization

## Done Looks Like

- [ ] All 6 signals active with Nunchi-proven parameters
- [ ] Vote counting (bull/bear out of 6) exposed in analysis output
- [ ] BTC confirmation filter working for alt assets
- [ ] 2-bar cooldown tracking prevents signal spam
- [ ] Micro-scan runs every 30 min on watchlist, updates scores
- [ ] Full cycle runs every 4 hours, generates/retires theses
- [ ] Nansen tools registered and integrated into full cycle
- [ ] Backtester validates top candidates before thesis generation
- [ ] Theses persisted to DB with 72h auto-expiry
- [ ] `/scout` shows live theses with vote counts
- [ ] `/intel` shows latest full-cycle brief
- [ ] Audit trail saved to vault
