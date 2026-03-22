# Data Layer: Storage, Schema & API Design

> **PARTIALLY OUTDATED — March 22, 2026**
> Some keys below (crypto_signal_parameters, autoresearch_*) are no longer used after the crypto pivot.
> New keys added: `polymarket_whale_watchlist`, `shadow_streak`, `wealth_goal`, `signal_quality_scores`.
> See `Wealth Engines Status.md` in vault for the current key inventory.

## Storage Strategy

All persistent state lives in PostgreSQL via the `app_config` table (key-value JSONB). This keeps the system simple — no migrations for schema changes, easy to inspect, and naturally supports the evolving data structures of an early-stage system.

### app_config Keys

| Key | Type | Description | TTL |
|-----|------|-------------|-----|
| `scout_active_theses` | TradeThesis[] | Active crypto trading theses | 72h auto-expire |
| `polymarket_scout_active_theses` | TradeThesis[] | Active prediction market theses | Auto-expire on resolution |
| `scout_watchlist` | string[] | CoinGecko IDs for micro-scan | Updated by full cycle |
| `scout_latest_brief` | string | Most recent SCOUT analysis text | Overwritten each cycle |
| `crypto_signal_parameters` | SignalConfig | Current best signal parameters | Updated by autoresearch |
| `polymarket_scout_parameters` | PolymarketConfig | Current best PM parameters | Updated by autoresearch |
| `wealth_engines_positions` | Position[] | Open positions (crypto + PM) | Updated by BANKR |
| `wealth_engines_trade_history` | TradeRecord[] | Closed trade log with outcomes | Append-only |
| `wealth_engines_kill_switch` | boolean | Emergency stop — closes all positions | Manual |
| `wealth_engines_paused` | boolean | Pause all WE scheduled jobs | Manual or circuit breaker |
| `wealth_engines_mode` | "BETA" \| "LIVE" \| "SHADOW" | Operating mode | Manual |
| `wealth_engines_public` | boolean | Dashboard public access toggle | Manual |
| `oversight_latest_health` | HealthReport | Most recent 4h health check | Overwritten |
| `oversight_improvement_queue` | ImprovementRequest[] | Open improvement requests | Lifecycle managed |
| `oversight_shadow_trades` | ShadowTrade[] | Paper trading log | Append-only |
| `autoresearch_experiment_log` | Experiment[] | Full experiment history | Append-only |
| `autoresearch_parameter_history` | ParameterSnapshot[] | Previous N parameter sets | Rolling 5 |

### Existing Tables (No Changes Needed)

| Table | Used By |
|-------|---------|
| `app_config` | All WE components (key-value store) |
| `job_history` | Scheduled job execution log |
| `agent_activity` | Agent run tracking |

### Data Interfaces

```typescript
interface TradeThesis {
  id: string;                    // unique thesis ID
  asset: string;                 // "bitcoin", "ETH > $5000 by June"
  asset_class: "crypto" | "polymarket";
  direction: "LONG" | "SHORT" | "YES" | "NO";
  confidence: "HIGH" | "MEDIUM" | "LOW";
  technical_score: number;       // 0.0-1.0 weighted ensemble
  vote_count: string;            // "5/6" for crypto, null for PM
  market_regime: string;         // "TRENDING" | "RANGING" | "VOLATILE"
  entry_price: number;
  exit_price: number;            // target
  stop_price: number;            // ATR-based for crypto, odds-based for PM
  atr_value: number;
  time_horizon: string;          // "24h", "7d", etc.
  sources: string[];             // ["coingecko", "nansen", "x_sentiment"]
  backtest_score: number | null;
  nansen_flow_direction: string | null;  // "inflow" | "outflow" | null
  whale_consensus: number | null;        // for polymarket
  created_at: number;
  expires_at: number;
  status: "active" | "executed" | "expired" | "retired";
}

interface TradeRecord {
  id: string;
  thesis_id: string;            // links back to thesis
  asset: string;
  asset_class: "crypto" | "polymarket";
  direction: string;
  leverage: string;
  entry_price: number;
  exit_price: number;
  expected_entry_price: number;  // from thesis — for slippage tracking
  pnl: number;
  pnl_pct: number;
  fees: number;
  opened_at: string;
  closed_at: string;
  close_reason: string;         // "stop_loss" | "take_profit" | "rsi_exit" | "manual" | "kill_switch"
  signals_at_entry: SignalSnapshot;  // for attribution analysis
  tax_lot: TaxLot;              // FIFO tracking
}

interface Position {
  id: string;
  thesis_id: string;
  asset: string;
  asset_class: "crypto" | "polymarket";
  direction: string;
  leverage: string;
  entry_price: number;
  current_price: number;
  unrealized_pnl: number;
  peak_price: number;           // for trailing stop
  atr_stop_price: number;
  opened_at: string;
  venue: "bnkr";
}
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/wealth-engines/theses` | GET | Active theses (crypto + polymarket) |
| `/api/wealth-engines/positions` | GET | Open positions with P&L |
| `/api/wealth-engines/trades` | GET | Trade history with filters |
| `/api/wealth-engines/oversight` | GET | Latest health report + improvement queue |
| `/api/wealth-engines/export` | GET | Full state dump for Mac Mini sync |
| `/api/wealth-engines/oversight-report` | POST | Receive oversight results from Mac Mini |
| `/api/wealth-engines/parameters` | GET | Current signal parameters (both domains) |
| `/api/wealth-engines/tax/summary` | GET | Tax summary (YTD, quarterly) |
| `/api/wealth-engines/tax/8949` | GET | Form 8949 CSV export |

### Data Retention

| Data Type | Retention | Reason |
|-----------|-----------|--------|
| Trade history | Permanent | Tax compliance + performance analysis |
| Tax lots | Permanent | IRS requirement |
| Active theses | 72h auto-expire | Stale theses are dangerous |
| Health reports | 30 days | Trend analysis |
| Experiment log | Permanent | Autoresearch needs full history |
| Parameter snapshots | Last 5 per domain | Rollback capability |
| Shadow trades | 90 days | Validation window |
