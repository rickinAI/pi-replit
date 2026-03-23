# Data Layer: Storage, Schema & API Design

> **Updated:** March 23, 2026 — Wallet Decode Fields + Autonomous API Keys

## Storage Strategy

All persistent state lives in PostgreSQL via the `app_config` table (key-value JSONB). This keeps the system simple — no migrations for schema changes, easy to inspect, and naturally supports the evolving data structures of an early-stage system.

### app_config Keys

| Key | Type | Description | TTL |
|-----|------|-------------|-----|
| `polymarket_scout_active_theses` | TradeThesis[] | Active prediction market theses | Auto-expire on resolution |
| `polymarket_whale_watchlist` | WhaleWallet[] | Unified whale tracking registry | Managed by SCOUT + API |
| `polymarket_whale_blacklist` | string[] | Blacklisted addresses (protocol contracts, MMs, scrapers) | Permanent |
| `wealth_engines_positions` | Position[] | Open positions | Updated by BANKR |
| `wealth_engines_trade_history` | TradeRecord[] | Closed trade log with outcomes | Append-only |
| `wealth_engines_kill_switch` | boolean | Emergency stop — closes all positions | Manual or API |
| `wealth_engines_paused` | boolean | Pause all WE scheduled jobs | Manual, circuit breaker, or API |
| `wealth_engines_mode` | "BETA" \| "LIVE" \| "SHADOW" | Operating mode | Manual or API |
| `wealth_engines_public` | boolean | Dashboard public access toggle | Manual |
| `wealth_engine_config` | RiskConfig | Dynamic risk parameters | API or Control Panel |
| `oversight_latest_health` | HealthReport | Most recent 4h health check | Overwritten |
| `oversight_improvement_queue` | ImprovementRequest[] | Open improvement requests | Lifecycle managed |
| `oversight_shadow_trades` | ShadowTrade[] | Paper trading log | Append-only |
| `shadow_streak` | StreakData | Win/loss streak tracking for shadow trades | Weekly reset Monday |
| `wealth_goal` | number | EOY wealth target (default $50K) | Via /goal command |
| `signal_quality_scores` | SignalQualityMap | Per-source win/loss with time decay | Rolling |
| `copy_trade_snapshots` | SnapshotMap | Per-wallet position snapshots for diffing | Overwritten each scan |
| `market_price_stats` | PriceStatsMap | 72h rolling price windows for z-score | Rolling |

### Removed Keys (Crypto Pivot)

| Key | Status |
|-----|--------|
| `scout_active_theses` | Removed — crypto theses no longer generated |
| `scout_watchlist` | Removed — no CoinGecko micro-scan |
| `scout_latest_brief` | Removed — crypto brief no longer generated |
| `crypto_signal_parameters` | Removed — no crypto signals |
| `autoresearch_experiment_log` | Removed — no autoresearch |
| `autoresearch_parameter_history` | Removed — no autoresearch |

### Existing Tables

| Table | Used By |
|-------|---------|
| `app_config` | All WE components (key-value store) |
| `job_history` | Scheduled job execution log |
| `agent_activity` | Agent run tracking |
| `conversations` | Chat session persistence |
| `tasks` | Task manager |
| `oauth_tokens` | Google OAuth |
| `vault_inbox` | URL queue |
| `vault_embeddings` | Semantic search vectors |
| `email_pipeline` | Resend webhook events |

### WhaleWallet Interface

```typescript
interface WhaleWallet {
  address: string;
  alias: string;
  win_rate: number;
  roi: number;
  total_volume: number;
  total_trades: number;
  niche: "politics" | "sports" | "crypto" | "weather" | "esports" | "general";
  category_scores: Record<string, number>;
  last_active: string;
  added_at: string;
  total_markets: number;
  resolved_markets: number;
  enabled: boolean;
  observation_only: boolean;
  degraded_count: number;
  pending_eviction: boolean;
  source: "auto-discovery" | "anomaly-scanner" | "manual" | "seed";
  strategy: string;
  maxCopyPrice: number;
  minTradeSize: number;
  decoded: boolean;
  decodeResult: {
    niche: string;
    isScraper: boolean;
    isMarketMaker: boolean;
    maxCopyPrice: number;
    minTradeSize: number;
    tradeCount: number;
    avgEntryPrice: number;
    medianTradeSize: number;
  };
}
```

### RiskConfig Interface

```typescript
interface RiskConfig {
  max_leverage: number;          // default 5
  risk_per_trade_pct: number;    // default 5%
  max_positions: number;         // default 3
  exposure_cap_pct: number;      // default 60%
  correlation_limit: number;     // default 1 per bucket
  circuit_breaker_7d_pct: number;     // default -15%
  circuit_breaker_drawdown_pct: number; // default -25%
  notification_mode: string;
}
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/controls` | GET | Unified system state snapshot |
| `/api/controls` | PUT | Update system state (paused, killSwitch, mode) |
| `/api/whale-registry` | GET | Tracked wallets + blacklist |
| `/api/whale-registry` | POST | Add wallet (with decode gate) |
| `/api/whale-registry/:address` | PUT | Update wallet fields; `status: "blacklisted"` evicts + blacklists |
| `/api/whale-registry/:address` | DELETE | Remove wallet (optional blacklist) |
| `/api/telegram/send` | POST | Send arbitrary Telegram message |
| `/api/wealth-engine/config` | GET | Full WE config |
| `/api/wealth-engine/config` | POST | Update risk parameters |
| `/api/wealth-engines/data` | GET | Dashboard data (portfolio, P&L, positions, health) |
| `/api/wealth-engines/positions` | GET | Open positions with P&L |
| `/api/wealth-engines/trades` | GET | Trade history with filters |
| `/api/wealth-engines/pnl-data` | GET | P&L + equity curve data |
| `/api/wealth-engines/oversight` | GET | Latest health report + improvement queue |
| `/api/wealth-engines/polymarket/theses` | GET | Active theses |
| `/api/cost-summary` | GET | API cost breakdown |
| `/api/scheduled-jobs/:id/trigger` | POST | Force-run a job |

### Data Retention

| Data Type | Retention | Reason |
|-----------|-----------|--------|
| Trade history | Permanent | Tax compliance + performance analysis |
| Tax lots | Permanent | IRS requirement |
| Active theses | Auto-expire on resolution | Stale theses are dangerous |
| Health reports | 30 days | Trend analysis |
| Shadow trades | 90 days | Validation window |
| Whale blacklist | Permanent | Prevent re-admission of bad actors |
| Signal quality scores | Rolling with 30-day decay | Adaptive quality tracking |
