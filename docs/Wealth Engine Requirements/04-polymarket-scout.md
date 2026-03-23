# POLYMARKET SCOUT: Prediction Market Intelligence

> **Updated:** March 23, 2026 — Wallet Decode + Auto-Discovery

## Purpose

Track high-performing wallets on Polymarket, score their historical accuracy, monitor their activity, and generate structured theses when high-conviction whales converge. The edge is information asymmetry — following the people who consistently win, not analyzing charts.

## Operating Frequencies

| Mode | Interval | Scope | Cost |
|------|----------|-------|------|
| Copy trade scan | 5 min | Snapshot diffing on tracked wallets | Low — API calls only, no LLM |
| Anomaly scanner | 30 min | Scan trade stream for unknown large wallets | Low — API calls only |
| Activity scan | 2 hours | Poll tracked wallets for new positions or changes | Low — LLM for context |
| Full analysis | 4 hours | Deep evaluation, score recalculation, thesis generation | Medium — LLM for context |
| Seed wallets | Weekly (Sunday 9am) | Mine trade stream for new high-volume wallets | Low |

## Whale Tracking System

### Wallet Scoring

Each tracked wallet is scored on a rolling basis:

| Metric | Weight | Description |
|--------|--------|-------------|
| Win rate | 30% | Percentage of resolved positions that were profitable |
| ROI | 20% | Return on invested capital across resolved positions |
| Category expertise | 20% | Accuracy within specific categories (politics, crypto, sports) |
| Volume consistency | 10% | Regular activity vs. one-time bets |
| Recency | 20% | Recent performance weighted higher than historical |

### Wallet Data (WhaleWallet Interface)

```
address, alias, win_rate, roi, total_volume, total_trades,
niche: "politics" | "sports" | "crypto" | "weather" | "esports" | "general",
category_scores: { politics: 0.72, crypto: 0.85, sports: 0.45 },
last_active, added_at, total_markets, resolved_markets,
enabled, observation_only, degraded_count, pending_eviction,
source: "auto-discovery" | "anomaly-scanner" | "manual" | "seed",
strategy: string,          // decoded strategy classification
maxCopyPrice: number,      // per-wallet price ceiling (set by decode)
minTradeSize: number,      // per-wallet minimum trade (set by decode)
decoded: boolean,          // whether decodeWallet() has run
decodeResult: object       // full decode output (niche, anti-patterns, thresholds)
```

## Wallet Decode on Admission

Every wallet must pass through `decodeWallet()` before joining the active registry. This is a one-time strategy classification that runs on admission (both auto-discovery and manual `POST /api/whale-registry`).

### Decode Process

1. Pull last 50 trades from Polymarket activity API
2. Classify dominant niche via `categorizeMarketTitle()` + `determineNiche()`
3. Run anti-pattern detection:
   - **Scraper detection**: avg entry price >$0.90 AND >50% of buys above $0.90 → REJECT
   - **Market maker detection**: 4-signal heuristic (need ≥3 of 4):
     - Both-sides trading in >30% of markets
     - Activities ≥50
     - Unique markets >20
     - Average trade <$500
4. Set per-wallet thresholds:
   - **maxCopyPrice** (price ceiling by niche): sports 0.80, politics 0.92, crypto 0.75, weather/general 0.85
   - **minTradeSize**: max(median trade size × 0.3, $25)
5. Results:
   - **REJECT**: Auto-blacklist + Telegram alert with reason
   - **ADMIT**: Add to registry + Telegram notification with strategy/thresholds

### Decode Gate

- `scoreAndPromoteCandidate()` (auto-discovery) → always runs decode
- `addWallet()` in copy-trading.ts → always runs decode
- `POST /api/whale-registry` → runs decode by default; `skipDecode: true` (strict boolean) bypasses for manual curation

### Copy Trade Enforcement

In `runCopyTradeScan()`, per-wallet thresholds are enforced:
- Trade price must be ≤ wallet's `maxCopyPrice`
- Trade size must be ≥ wallet's `minTradeSize`
- Trades failing either filter are skipped (not copied)

## Auto-Discovery Pipeline

### Seed Wallets (Weekly)

`seedWalletsFromTradeStream()` mines recent Polymarket trades for high-volume wallets:
1. Fetch recent large trades from trade stream
2. Build profiles from activity API
3. Score using 5-metric composite
4. Auto-add wallets scoring ≥0.6

### Anomaly Scanner (Every 30 Minutes)

`runAnomalyScanner()` scans a 30-minute trade window:
1. Identify unknown wallets making large trades (≥$2K)
2. Build full profile from activity API
3. Run `decodeWallet()` strategy gate
4. Promote quality candidates as `observation_only` (auto-cleared after 5min)

### Market Maker Detection

`detectAndBlacklistMarketMakers()` uses behavioral fingerprinting:
- mmScore ≥3 of 4 signals: tradeCount>100, buy/sell symmetry<0.15, markets>20, avgTrade<$500
- Auto-blacklisted + Telegram alert

### Boot Sequence

On startup: migrate old registries → initialize blacklist (11 protocol contracts) → auto-seed if registry has <3 wallets

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
- `getWalletPositions`: All positions for a given wallet address (via Data API)
- `getWalletHistory`: Historical trades + outcomes for scoring
- `fetchWalletActivity()`: Recent trades for decode + scoring
- `fetchRecentTrades()`: Trade stream for anomaly scanning
- Cache: markets 5-min, wallet history 15-min

### NOAA Weather Edge
- `checkNOAAEdge()`: 6 cities (NYC, Chicago, Seattle, Atlanta, Dallas, Miami)
- Provides weather signal for weather-category markets (0-3 points in signal engine)

## Done Looks Like

- [x] Polymarket API integration with rate limiting and caching
- [x] Whale watchlist in DB with per-wallet scoring
- [x] Activity scanner detects new positions within 30 minutes
- [x] Thesis generation when whale activity meets thresholds
- [x] Context validation via news/X cross-reference
- [x] Theses persisted to DB, auto-expired on market resolution
- [x] `/polymarket` Telegram command shows active theses
- [x] Category expertise tracking with domain-weighted scoring
- [x] Weekly wallet review: promote/demote based on rolling performance
- [x] Auto-discovery pipeline (seed wallets + anomaly scanner)
- [x] Wallet decode on admission (scraper/MM detection, price ceilings, min trade size)
- [x] Per-wallet maxCopyPrice and minTradeSize enforcement in copy trade scan
- [x] Autonomous whale registry CRUD via REST API
- [x] Market maker detection and auto-blacklisting
- [x] Boot sequence: migrate → blacklist init → auto-seed
- [ ] Audit trail saved to vault
