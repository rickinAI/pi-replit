# Architecture: System Infrastructure

> **Updated:** March 23, 2026 — Replit-Only, Polymarket Copy Trading

## Single-Environment Architecture

The system runs entirely on Replit. The Mac Mini local compute migration (Phase 6) is deferred.

### Replit (Cloud, Always-On)

| Component | Why Replit |
|-----------|-----------|
| POLYMARKET SCOUT | Frequent API polling (5-min copy scan, 30-min anomaly scan) needs reliable uptime |
| COPY TRADING ENGINE | 5-min snapshot diffing requires consistent scheduling |
| BANKR | Trade execution must be reliable; can't depend on home internet |
| Telegram Bot (2 bots) | DarkNode + Mission Control must be always-reachable |
| Dashboard (3 pages) | Web UI needs public URL |
| PostgreSQL | Primary data store (app_config key-value, 9 tables + pgvector) |
| Autonomous API | DarkNode self-management endpoints must be always-available |

**Replit Constraints:**
- PORT 5000 (dev), 3000 (production)
- Express/TypeScript runtime (esbuild bundle)
- Workflows manage long-running processes
- Environment secrets for API keys (BNKR_API_KEY, TELEGRAM_BOT_TOKEN, etc.)
- Shared PostgreSQL via `DATABASE_URL`

### Compute Optimization

| Job Category | Model | Interval | Cost Strategy |
|-------------|-------|----------|---------------|
| Copy trade scan | Code-only (no LLM) | 5 min | Zero LLM cost |
| Anomaly scanner | Code-only | 30 min | Zero LLM cost |
| DarkNode summaries | Code-only | 3x/day (9am, 3pm, 9pm) | Zero LLM cost |
| Position monitor | Code-only | 2 min | Zero LLM cost |
| Activity scan | Haiku + toolSubset | 2 hours | Minimal — filtered tools |
| BANKR execute | Haiku + toolSubset | 1 hour | Minimal — filtered tools |
| Full analysis cycle | Haiku | 4 hours | Medium |
| Oversight review | Haiku (modelOverride) | Weekly | Minimal — all scheduled jobs forced to Haiku |
| Shadow price refresh | Code-only | 2 hours | Zero LLM cost |

### Data Flow

```
                    ┌─────────────────────────────────────────────┐
                    │              REPLIT (Always-On)              │
                    │                                             │
                    │  Polymarket APIs ──► SCOUT ──► Whale        │
                    │       │              │         Registry     │
                    │       ▼              ▼           │          │
                    │  Anomaly Scanner  Thesis Gen     ▼          │
                    │       │              │      Copy Trade      │
                    │       ▼              ▼      Engine (5min)   │
                    │  Wallet Decode ──► Admission     │          │
                    │                      Gate        ▼          │
                    │                              Signal Engine  │
                    │                              (8 signals)    │
                    │                                  │          │
                    │                                  ▼          │
                    │                              BANKR ──► BNKR │
                    │                                  │          │
                    │                                  ▼          │
                    │  PostgreSQL ◄── Position Monitor (2min)     │
                    │       │              │                      │
                    │       ▼              ▼                      │
                    │  Dashboard      Telegram (2 bots)           │
                    │  (3 pages)      Autonomous API              │
                    └─────────────────────────────────────────────┘
```

### Autonomous API Layer

DarkNode can manage itself via REST API without human intervention:

| Endpoint Group | Purpose |
|---------------|---------|
| `/api/controls` | Read/update system state (paused, killSwitch, mode) |
| `/api/whale-registry` | Full CRUD on tracked wallets with decode gate |
| `/api/telegram/send` | Send arbitrary notifications |
| `/api/wealth-engine/config` | Read/update risk parameters |
| `/api/cost-summary` | Monitor API spend |
| `/api/scheduled-jobs/:id/trigger` | Force-run jobs on demand |

All mutating endpoints are WE_CONTROL_USERS gated (rickin, darknode).

### Future-Proofing

The architecture supports these extensions without restructuring:
- **Additional signal sources** (e.g., Kreo alerts) — plug into signal engine
- **Multiple execution venues** — BANKR's execution layer is abstracted behind a venue interface
- **Real-time price feeds** — websocket connection alongside existing polling (additive)
- **Mac Mini migration** — oversight + batch analysis can move to local compute when justified
- **Team access** — dashboard already supports public/private toggle; role-based access is an extension of existing auth
