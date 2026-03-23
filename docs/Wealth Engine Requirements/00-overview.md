# Wealth Engines: System Overview

> **Updated:** March 23, 2026 — Wallet Decode + Autonomous API

## Mission

Build an autonomous copy trading system targeting $50,000 by December 31, 2026 from $10,000 virtual shadow capital through Polymarket whale tracking and position mirroring.

## First Principles

### 1. Follow Smart Money, Don't Compete
We don't run our own signal models. We track proven Polymarket whale wallets and mirror their high-conviction positions through an 8-signal scoring engine.

### 2. Deterministic Code, Minimal LLM Usage
Signal scoring (VPIN, z-score, whale consensus, niche match, NOAA weather) is deterministic code. LLMs are used only for oversight reviews and thesis synthesis. All automated jobs use Haiku for cost efficiency.

### 3. Zero Human Intervention
The system runs autonomously — 5-minute copy trade scanning, automatic position mirroring, whale exit tracking, market resolution auto-redemption, wallet health decay with auto-disable, and wallet decode on admission. DarkNode has full API access to manage its own controls, whale registry, and Telegram messaging.

### 4. Test Before You Trade
Shadow mode validates the system on paper before real capital is at risk. Every phase has acceptance criteria that must pass before advancing.

### 5. NY Compliant, No Exceptions
No Hyperliquid. No offshore platforms. BNKR (Polymarket execution on Base) is the single execution venue. Full tax tracking from day one.

### 6. Cost-Aware Compute
Agent-driven jobs (activity scan, BANKR execute) use Haiku with toolSubset filtering. High-frequency operations (copy-trade-scan, anomaly scanner, DarkNode summary) are code-only — no LLM calls. Intervals optimized: copy-trade-scan every 5min, activity scan 2h, BANKR execute 1h.

## Operating Parameters

| Parameter | Value |
|-----------|-------|
| Starting capital | $10,000 (virtual shadow) |
| Target | $50,000 by Dec 31, 2026 |
| Copy trade size | $50 (score≥8) / $25 (score 4-7) |
| Max concurrent copies | 3 |
| Wallet win rate minimum | 65% |
| Odds range | 15-85¢ |
| Min volume/liquidity | $10K each |
| Resolution buffer | >24h to resolution |
| Portfolio drawdown hard stop | $100 |
| Circuit breaker | -15% rolling 7-day OR -25% peak drawdown |
| Execution venue | BNKR (Polymarket on Base) |
| Compliance | NY state — no Hyperliquid, no offshore |

## System Components

| Component | Role | Status |
|-----------|------|--------|
| COPY TRADING ENGINE | 5-min whale snapshot diffing + 8-signal scoring | Built ✅ |
| POLYMARKET SCOUT | Whale discovery, anomaly scanning, thesis generation | Built ✅ |
| WALLET DECODE | One-time strategy classification on admission (scraper/MM detection, price ceilings, min trade size) | Built ✅ |
| BANKR | Execute trades, manage positions, track taxes | Built ✅ |
| OVERSIGHT AGENT | Health monitoring, performance review, shadow trading | Built ✅ |
| TELEGRAM | Command center + categorized notifications | Built ✅ |
| DASHBOARD | Web UI for portfolio visualization | Built ✅ |
| AUTONOMOUS API | DarkNode self-management: controls, whale registry CRUD, Telegram send | Built ✅ |

## Data Flow

```
Whale Wallets → Snapshot Diffing (5min) → Signal Engine (8 signals) → BANKR Execution → OVERSIGHT → Telegram
                                                                                          ↓
                                                                                   Wallet Health Decay
```

### Wallet Admission Flow

```
Candidate Wallet → decodeWallet() → Scraper Check → MM Check → Niche Classification
                                         ↓                ↓              ↓
                                    REJECT + blacklist  REJECT      Set maxCopyPrice + minTradeSize
                                                                         ↓
                                                                   Admit to Registry → Telegram Alert
```

### Autonomous Control Flow

```
DarkNode Agent → api_request → /api/controls      → Read/update system state
                             → /api/whale-registry → CRUD wallets (with decode gate)
                             → /api/telegram/send  → Send notifications
                             → /api/cost-summary   → Monitor API spend
                             → /api/scheduled-jobs  → Trigger jobs on demand
```

## Removed Components (Crypto Pivot — March 22, 2026)

The following were removed as DarkNode pivoted to prediction-markets-only copy trading:
- CRYPTO SCOUT (6-signal Nunchi voting ensemble)
- AUTORESEARCH (parameter evolution via backtesting)
- All crypto data sources (CoinGecko, DexScreener, Nansen)
- Backtesting engine
- Signal aggregator (Fear & Greed, Binance funding)

See `07-autoresearch.md` for archive notices. `03-crypto-scout.md` has been removed (crypto pivot complete).
