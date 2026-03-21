# Architecture: Compute Split & Infrastructure

## Two-Environment Architecture

The system is split across two compute environments based on workload characteristics.

### Replit (Cloud, Always-On)

**What runs here:** Latency-sensitive, always-available operations.

| Component | Why Replit |
|-----------|-----------|
| CRYPTO SCOUT | 30-min polling cycles need reliable uptime and API access |
| POLYMARKET SCOUT | Same — frequent API polling |
| BANKR | Trade execution must be reliable; can't depend on home internet |
| Telegram Bot | Command center must be always-reachable |
| Dashboard | Web UI needs public URL |
| PostgreSQL | Primary data store for theses, trades, config, job history |

**Replit Constraints:**
- PORT 5000 (dev), 3000 (production)
- Express/TypeScript runtime
- Workflows manage long-running processes
- Environment secrets for API keys
- Shared PostgreSQL via `DATABASE_URL`

### Mac Mini (Local, Batch Processing) — Phase 2

**What runs here:** Compute-heavy, cost-sensitive batch workloads.

| Component | Why Local |
|-----------|-----------|
| OVERSIGHT AGENT | Batch analysis every 4h/daily/weekly — not latency-sensitive |
| AUTORESEARCH | 10-20 experiments per domain — expensive on cloud LLMs |
| BACKTESTING ENGINE | CPU-bound computation, no LLM needed for the actual backtest |

**Local Stack:**
- OpenClaw framework (agent orchestration, Telegram integration, heartbeat scheduler)
- Ollama (qwen3.5:27b or similar local model)
- Hybrid mode: local for routine analysis, cloud fallback for complex financial reasoning
- Data sync: pulls from Replit via `/api/wealth-engines/export` endpoint, pushes results via `/api/wealth-engines/oversight-report`

### Data Synchronization

```
Mac Mini                              Replit
┌─────────────┐  GET /api/export     ┌──────────────┐
│ Oversight   │ ◄──── every 4h ──── │ PostgreSQL   │
│ Autoresearch│                      │              │
│             │ ──── POST results ──►│ app_config   │
└─────────────┘  /api/oversight-report└──────────────┘
```

**Export payload:** trade history, active theses, signal parameters, job history, position state
**Import payload:** health report, improvement requests, optimized parameters, shadow trade log

### Future-Proofing

The architecture supports these extensions without restructuring:
- **Additional scouts** (e.g., on-chain DEX flow scanner) — same thesis interface, plug into BANKR
- **Multiple execution venues** — BANKR's execution layer is abstracted behind a venue interface
- **Real-time price feeds** — websocket connection alongside existing polling (additive, not replacement)
- **Multi-asset expansion** — thesis format supports any asset class via `asset_class` field
- **Team access** — dashboard already supports public/private toggle; role-based access is an extension of existing auth
