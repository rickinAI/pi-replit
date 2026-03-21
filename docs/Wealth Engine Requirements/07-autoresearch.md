# AUTORESEARCH: Self-Improving Parameter Evolution

## Purpose

Autonomously evolve signal parameters for both CRYPTO SCOUT and POLYMARKET SCOUT through controlled experimentation. Instead of hardcoding parameters, the system runs backtests with parameter variations, keeps improvements, and reverts failures. Parameters get better over time based on actual market conditions.

## Core Principle: Mutation, Not Reinvention

Autoresearch changes 1-3 parameters at a time from the current best set. It doesn't redesign the strategy — it tunes the dials. Structural changes come from the oversight agent's manual improvement requests.

## Two Domains, One Engine

### Crypto Parameter Space

| Parameter | Current Value | Range | Step |
|-----------|--------------|-------|------|
| RSI period | 8 | 5-20 | 1 |
| EMA fast | 7 | 3-15 | 1 |
| EMA slow | 26 | 15-50 | 1 |
| ATR stop multiplier | 5.5 | 2.0-8.0 | 0.5 |
| MACD fast | 14 | 8-20 | 1 |
| MACD slow | 23 | 15-35 | 1 |
| MACD signal | 9 | 5-15 | 1 |
| BB period | 7 | 5-20 | 1 |
| Momentum lookback | 12 | 6-24 | 2 |
| Very-short momentum | 6 | 3-12 | 1 |
| Vote threshold | 4 | 3-6 | 1 |
| Cooldown bars | 2 | 1-5 | 1 |
| RSI overbought | 69 | 60-80 | 1 |
| RSI oversold | 31 | 20-40 | 1 |

**Backtest method:** Fetch CoinGecko OHLCV (30-90 days), replay 6-signal ensemble bar-by-bar, simulate entries/exits, compute metrics.

**Scoring:** Nunchi formula: `Sharpe * sqrt(trade_count_factor) - drawdown_penalty - turnover_penalty`

### Polymarket Parameter Space

| Parameter | Current Value | Range | Step |
|-----------|--------------|-------|------|
| Min wallet score | 0.6 | 0.3-0.9 | 0.05 |
| Min whale consensus | 2 | 1-5 | 1 |
| Min entry odds | 0.15 | 0.05-0.40 | 0.05 |
| Max entry odds | 0.85 | 0.60-0.95 | 0.05 |
| Position sizing by tier | varies | 2%-15% | 1% |
| Conviction multiplier | 1.0 | 0.5-2.0 | 0.1 |
| Category weight boost | 1.5 | 1.0-3.0 | 0.25 |
| Exit odds threshold | -0.20 | -0.10 to -0.40 | 0.05 |
| Stale position timeout | 30 days | 7-60 | 7 |

**Backtest method:** Query historical resolved markets, simulate copy-trading with candidate parameters, compute which whale trades would have been copied and their outcomes.

**Scoring:** `ROI * win_rate_factor - drawdown_penalty`

## Experiment Flow

```
1. Load current best parameters from DB
2. Generate candidate: mutate 1-3 parameters within valid ranges
3. Run domain-specific backtest with candidate parameters
4. Score the result
5. Compare to current best:
   - If improvement > 0.5%: ADOPT (save new parameters to DB)
   - If improvement <= 0.5%: REVERT (keep current parameters)
6. Log experiment with full metadata
7. Repeat N times per research run (default: 10-20 per domain)
```

## Safety Guardrails

| Rule | Value | Why |
|------|-------|-----|
| Min improvement to adopt | 0.5% | Prevents noise-driven parameter drift |
| Max parameter drift per run | 30% | Prevents dramatic strategy shifts |
| Valid range enforcement | Hard caps on all parameters | Prevents degenerate configurations |
| Rollback history | Last 5 parameter sets per domain | One-command revert if needed |
| Max experiments per run | 50 | Cost control |

## Oversight Integration

Autoresearch consumes improvement hypotheses from the oversight agent:

```
OVERSIGHT: "BB width was the marginal vote in 3/4 recent losses"
→ AUTORESEARCH: prioritize experiments that adjust BB period or weight
```

Instead of purely random mutations, the experiment generator can seed candidates from oversight insights, making the search more targeted.

## Compute Strategy

| Phase | Where | Model | Cost |
|-------|-------|-------|------|
| Phase 1 | Replit | Deterministic code (backtests) + Claude for hypothesis | Per-experiment API cost |
| Phase 2 | Mac Mini | Deterministic code + Ollama for hypothesis | Free (local compute) |

Note: The actual backtest is pure computation — no LLM needed. The LLM is only used to generate mutation hypotheses and interpret results. This makes Phase 2 migration straightforward.

## Triggers

| Trigger | Scope |
|---------|-------|
| `/research` | Both domains |
| `/research crypto` | Crypto only |
| `/research polymarket` | Polymarket only |
| `/research rollback crypto` | Revert to previous crypto parameters |
| `/research rollback polymarket` | Revert to previous PM parameters |
| Weekly scheduled job | Both domains, 10-20 experiments each |

## Done Looks Like

- [ ] Crypto parameter space defined with valid ranges
- [ ] Polymarket parameter space defined with valid ranges
- [ ] Mutation generator producing valid candidates
- [ ] Crypto backtest engine (bar-by-bar OHLCV replay)
- [ ] Polymarket backtest engine (historical outcome replay)
- [ ] Experiment logging with full metadata
- [ ] Parameter adoption/reversion with 0.5% threshold
- [ ] Rollback history (5 per domain) with Telegram commands
- [ ] Oversight hypothesis integration
- [ ] Weekly scheduled job running both domains
- [ ] Telegram: `/research` commands working
- [ ] Parameters automatically loaded by scouts at runtime
