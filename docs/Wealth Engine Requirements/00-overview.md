# Wealth Engines: System Overview

## Mission

Build an autonomous trading system that generates $5,000/month in profit through AI-driven intelligence and disciplined execution across crypto and prediction markets.

## First Principles

### 1. Intelligence Over Speed
We don't compete on latency. We compete on *information synthesis* — combining technical signals, smart money flows, social sentiment, and prediction market whale consensus into higher-conviction trades than any single data source can produce.

### 2. Deterministic Code, LLM for Judgment
Quantitative signals (EMA, RSI, MACD, vote counting, backtesting) are deterministic code — fast, free, reproducible. LLMs are used only where human-like judgment is needed: thesis synthesis, adversarial review, improvement hypothesis generation.

### 3. Simplicity Over Sophistication
Every component does one thing well. Scouts generate theses. BANKR executes them. Oversight reviews outcomes. Autoresearch tunes parameters. No component crosses its boundary.

### 4. Test Before You Trade
Shadow mode validates the system on paper before real capital is at risk. Every phase has acceptance criteria that must pass before advancing.

### 5. NY Compliant, No Exceptions
No Hyperliquid. No offshore platforms. BNKR (Avantis perps on Base) + Coinbase Wallet only. Full tax tracking from day one.

### 6. Cost-Aware Compute
Batch analysis (oversight, autoresearch, backtesting) runs on local hardware (Mac Mini + OpenClaw + Ollama). Latency-sensitive operations (scouts, execution, monitoring) run on Replit. Cloud LLMs are used sparingly and only when local model quality is insufficient.

## Beta Constraints

| Parameter | Value |
|-----------|-------|
| Starting capital | $50 |
| Max leverage | 2x |
| Max risk per trade | 2% of portfolio ($1) |
| Execution venues | BNKR (Avantis perps on Base), Coinbase (spot) |
| Compliance | NY state — no Hyperliquid, no offshore |
| Drawdown breaker | -15% rolling 7-day P&L → auto-pause |
| Margin buffer | 20% above liquidation price |

## System Components

| Component | Role | Runs On |
|-----------|------|---------|
| CRYPTO SCOUT | Scan crypto markets, generate trading theses | Replit |
| POLYMARKET SCOUT | Track whale wallets, generate prediction market theses | Replit |
| BANKR | Execute trades, manage positions, track taxes | Replit |
| OVERSIGHT AGENT | Monitor system health, review performance, generate improvements | Phase 1: Replit, Phase 2: Mac Mini |
| AUTORESEARCH | Evolve signal parameters through backtesting | Phase 1: Replit, Phase 2: Mac Mini |
| TELEGRAM | Command center for monitoring and control | Replit |
| DASHBOARD | Web UI for portfolio and performance visualization | Replit |

## Data Flow

```
Data Sources → Intelligence (Scouts) → Theses → Execution (BANKR) → Results → Oversight → Autoresearch
                                                                                    ↓
                                                                              Parameter Updates → Scouts
```

## Key Design Decisions

1. **Vote-based entries, not score thresholds** — Binary 4/6 vote gate from Nunchi research (Sharpe 2.7 → 21.4 across 103 experiments)
2. **Unified thesis format** — Both scouts produce the same interface so BANKR consumes them identically
3. **Adversarial review via oversight, not debate agents** — One structured prompt, not multiple expensive LLM calls
4. **Oversight before autoresearch** — Hypotheses from real trade outcomes are smarter than random parameter mutation
5. **Shadow mode before live scaling** — Validate on paper, then deploy with real capital
