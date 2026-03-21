# OVERSIGHT AGENT: Operational Risk & Feedback Loop

## Purpose

Monitor the entire Wealth Engines system — both scout pipelines and BANKR execution. Identify bottlenecks, surface blind spots, and generate structured improvement requests that feed back into autoresearch and manual review. The oversight agent is the "risk manager" that watches the machine, not individual trades.

## Operating Frequencies

| Mode | Interval | Scope | Compute |
|------|----------|-------|---------|
| Health check | 4 hours | Operational metrics | Light — DB queries + simple analysis |
| Performance review | Daily | Trade outcomes, signal attribution | Medium — requires pattern analysis |
| Improvement capture | Weekly | Cross-trade patterns, adversarial review | Heavy — LLM reasoning |

## Phase 1: Replit (Initial Deployment)

Runs as a scheduled agent job inside DarkNode. Uses Claude Sonnet for analysis. Cost-managed by keeping prompts focused and using deterministic code for metrics computation.

## Phase 2: Mac Mini + OpenClaw (After Real Trade Data Exists)

Migrates to local compute once the system generates enough trade history to justify batch analysis. OpenClaw's heartbeat scheduler replaces DarkNode's job scheduler. Ollama (qwen3.5:27b) handles routine analysis; Claude fallback for complex financial reasoning.

### Migration checklist:
- [ ] Sufficient trade history (50+ closed trades)
- [ ] API endpoints for data sync working
- [ ] OpenClaw + Ollama installed and tested on Mac Mini
- [ ] Hybrid model quality validated against Claude baseline

## Layer 1: Operational Health (Every 4 Hours)

All computed via deterministic code — no LLM needed.

| Check | Threshold | Action |
|-------|-----------|--------|
| Scout thesis production | < 1 thesis in 24h when enabled | Telegram warning |
| API error rate | > 10% of calls failing in last 4h | Telegram alert + log |
| Data freshness | OHLCV cache > 2 hours stale | Telegram warning |
| Job execution time | > 2x moving average | Log anomaly |
| Dead man switch | Scout > 6h, BANKR monitor > 30min | Telegram critical alert |
| DB connection | Pool exhaustion or timeout | Telegram critical alert |

**Output:** Structured health report saved to `oversight_latest_health`.

## Layer 2: Performance Review (Daily)

Mix of deterministic computation (metrics) and LLM analysis (patterns).

### Metrics (computed, no LLM)

| Metric | Calculation |
|--------|-------------|
| Win rate | Winning trades / total closed trades |
| Average win | Mean P&L of winning trades |
| Average loss | Mean P&L of losing trades |
| Profit factor | Gross profit / gross loss |
| Sharpe ratio | Mean return / std deviation of returns (annualized) |
| Max drawdown | Largest peak-to-trough decline |
| Rolling 7-day P&L | Sum of realized P&L in last 7 days |
| Thesis conversion | Theses executed / theses generated |
| Average slippage | Mean of (actual fill - expected entry) / expected entry |

### Signal Attribution (computed, no LLM)

For each closed trade, record which of the 6 signals were bullish at entry. Then:
- Win rate per signal: "EMA was bullish on 8/10 winners but only 3/7 losers"
- Signal contribution: which signals most reliably predicted winning trades?

### Daily Summary (Telegram)

```
[BETA] Daily Performance Report

Trades closed: 3 (2W / 1L)
Win rate: 66.7% | Profit factor: 2.1
Day P&L: +$1.23 | Rolling 7d: +$4.56
Sharpe (30d): 1.8 | Max DD: -3.2%
Best signal: EMA (75% win rate)
Worst signal: BB Width (40% win rate)
Slippage: avg 0.12%
Drawdown status: OK (7.2% remaining to breaker)
```

## Layer 3: Improvement Capture (Weekly)

This is where LLM reasoning adds value. The agent reviews the week's trades and generates hypotheses.

### Bull/Bear Adversarial Review

For each active high-confidence thesis:
1. Construct the bear case: "Why would this trade fail?"
2. Surface opposing evidence from the thesis sources
3. Flag if bear case is stronger than bull case
4. Downgrade confidence if adversarial evidence is compelling

### Pattern Analysis

Review last N closed trades and look for:
- Signal patterns in losses (e.g., "BB width was the 4th vote in 3/4 losses")
- Source patterns (e.g., "Nansen confirmation was missing on all losing trades")
- Timing patterns (e.g., "All losses were entered during high-vol regime")
- Asset patterns (e.g., "Small-cap theses underperform large-cap consistently")

### Improvement Requests

```typescript
interface ImprovementRequest {
  id: string;
  domain: "crypto" | "polymarket" | "system";
  priority: "high" | "medium" | "low";
  pattern: string;        // what was observed
  recommendation: string; // what should change
  route: "autoresearch" | "manual" | "bankr-config";
  evidence: string;       // supporting data
  status: "open" | "accepted" | "resolved" | "dismissed";
  created_at: number;
}
```

Routed as:
- **autoresearch**: parameter changes (e.g., "increase Nansen weight")
- **manual**: structural changes (e.g., "add new data source")
- **bankr-config**: risk rule adjustments (e.g., "reduce max concurrent positions")

## Drawdown Circuit Breaker

**This runs on every performance check, not just daily.**

```
if rolling_7d_pnl_pct < -15%:
  set wealth_engines_paused = true
  send critical Telegram alert
  require manual /resume to restart
```

Also monitors per-asset cumulative loss — if a single asset has caused > 5% portfolio loss, flag for review.

## Done Looks Like

- [ ] Health checker runs every 4h, alerts on anomalies
- [ ] Daily performance summary to Telegram with all metrics
- [ ] Weekly improvement report saved to vault
- [ ] Bull/bear adversarial review on active high-confidence theses
- [ ] Structured improvement requests in DB with routing
- [ ] Drawdown circuit breaker auto-pauses at -15%
- [ ] Cross-domain exposure detection alerts
- [ ] Shadow trading mode tracks hypothetical P&L
- [ ] `/oversight` command shows health + improvements
- [ ] `/shadow` command shows paper trading results
- [ ] Data sync API endpoints for Mac Mini migration
