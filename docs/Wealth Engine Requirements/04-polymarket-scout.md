# POLYMARKET SCOUT: Prediction Market Intelligence

## Purpose

Track high-performing wallets on Polymarket, score their historical accuracy, monitor their activity, and generate structured theses when high-conviction whales converge. The edge is information asymmetry — following the people who consistently win, not analyzing charts.

## Operating Frequencies

| Mode | Interval | Scope | Cost |
|------|----------|-------|------|
| Activity scan | 30 min | Poll tracked wallets for new positions or changes | Low — API calls only |
| Full analysis | 4 hours | Deep evaluation, score recalculation, thesis generation | Medium — LLM for context |
| Wallet review | Weekly | Re-evaluate watchlist, promote/demote wallets | Low |

## Whale Tracking System

### Wallet Scoring

Each tracked wallet is scored on a rolling basis:

| Metric | Weight | Description |
|--------|--------|-------------|
| Win rate | 30% | Percentage of resolved positions that were profitable |
| ROI | 30% | Return on invested capital across resolved positions |
| Category expertise | 20% | Accuracy within specific categories (politics, crypto, sports) |
| Volume consistency | 10% | Regular activity vs. one-time bets |
| Recency | 10% | Recent performance weighted higher than historical |

### Wallet Data

```
address, alias, win_rate, roi, total_volume,
category_scores: { politics: 0.72, crypto: 0.85, sports: 0.45 },
last_active, added_date, total_markets, resolved_markets
```

### Activity Detection

Every 30 minutes, scan tracked wallets for:
- **New market entry** — wallet takes a position in a market they weren't in
- **Position increase** — wallet doubles down (high conviction signal)
- **Position exit** — wallet closes before resolution (information signal)
- **Consensus shift** — multiple tracked wallets moving to the same side

## Thesis Generation

A thesis is generated when activity meets these thresholds:

| Filter | Threshold | Rationale |
|--------|-----------|-----------|
| Wallet score | >= configurable (default 0.6) | Only follow proven winners |
| Whale consensus | >= 2 wallets on same side | Single whale could be wrong |
| Market liquidity | >= $50K volume | Need to be able to exit |
| Odds range | 15% - 85% | Avoid near-certainties (no edge) and long shots (high variance) |
| Time to resolution | >= 24 hours | Need time to enter and manage |

### Context Validation

For high-confidence theses, cross-reference with:
- News search: is there a catalyst for the whale bet?
- X sentiment: does public consensus agree or disagree? (Contrarian = potentially higher alpha)
- Market metadata: resolution criteria, market creator reputation

## Data Sources

### Polymarket API (CLOB)
- `getMarkets`: Active markets with metadata (question, odds, volume, resolution date)
- `getMarketDetails`: Current odds, order book depth, liquidity
- `getWalletPositions`: All positions for a given wallet address
- `getWalletHistory`: Historical trades + outcomes for scoring
- Cache: markets 5-min, wallet history 15-min

### Kreo (execution layer)
- Used by BANKR for trade execution, not by SCOUT
- SCOUT only generates theses; execution is BANKR's responsibility

## Done Looks Like

- [ ] Polymarket API integration with rate limiting and caching
- [ ] Whale watchlist in DB with per-wallet scoring
- [ ] Activity scanner detects new positions within 30 minutes
- [ ] Thesis generation when whale activity meets thresholds
- [ ] Context validation via news/X cross-reference
- [ ] Theses persisted to DB, auto-expired on market resolution
- [ ] `/polymarket` Telegram command shows active theses
- [ ] Category expertise tracking with domain-weighted scoring
- [ ] Weekly wallet review: promote/demote based on rolling performance
- [ ] Audit trail saved to vault
