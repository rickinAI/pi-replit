# Telegram Command Reference

## Command Inventory

### System Control

| Command | Action | Status |
|---------|--------|--------|
| `/status` | System health: mode, kill switch, pause state, agent last-run times | Built |
| `/pause` | Halt all Wealth Engine scheduled jobs | Built |
| `/resume` | Resume after pause or circuit breaker trigger | Built |
| `/kill` | Emergency: activate kill switch, close ALL positions | To build (BANKR) |
| `/public on\|off` | Toggle dashboard public access | Built |

### Portfolio & Trading

| Command | Action | Status |
|---------|--------|--------|
| `/portfolio` | Open positions with live P&L | Built (shell) |
| `/trades [n]` | Last N closed trades (default 5, max 20) | Built (shell) |
| `/tax` | YTD tax summary with estimated liability | To build |

### Intelligence

| Command | Action | Status |
|---------|--------|--------|
| `/scout` | Active crypto theses with vote counts and confidence | Built (shell, needs enrichment) |
| `/intel` | Latest SCOUT full-cycle brief | Built (shell, needs enrichment) |
| `/polymarket` | Active prediction market theses with whale consensus | To build |
| `/watchlist` | Current SCOUT watchlist assets | To build |

### Oversight & Research

| Command | Action | Status |
|---------|--------|--------|
| `/oversight` | Latest health report + active improvement requests | To build |
| `/shadow` | Shadow portfolio performance (paper trading) | To build |
| `/risk` | Current risk metrics: exposure %, drawdown, open risk | To build |
| `/research` | Trigger autoresearch (both domains) | To build |
| `/research crypto` | Trigger crypto-only autoresearch | To build |
| `/research polymarket` | Trigger polymarket-only autoresearch | To build |
| `/research rollback crypto` | Revert to previous crypto parameters | To build |
| `/research rollback polymarket` | Revert to previous PM parameters | To build |

### Interactive

| Feature | Action | Status |
|---------|--------|--------|
| Trade approval buttons | Approve / Skip / Hold inline keyboard | Built |
| Callback handling | Process approval decisions, record to DB | Built |
| Approval timeout | Auto-skip after 30 minutes | Built |

### Alerts (Outbound, No Command)

| Alert | Trigger | Status |
|-------|---------|--------|
| Trade executed | BANKR completes a trade | Built (shell) |
| Trade stopped | Trailing stop or RSI exit triggered | Built (shell) |
| Emergency | Kill switch activated | Built (shell) |
| Dead man switch | Agent hasn't run within threshold | Built |
| Drawdown breaker | Rolling 7-day P&L < -15% | To build |
| Daily performance | Automated end-of-day summary | To build |
| Exposure warning | Correlation/concentration limit approached | To build |
| API failure | Error rate > 10% | To build |

## Message Format

All messages include mode prefix: `[BETA]` or `[LIVE]`

Markdown formatting with:
- Bold for headers and key values
- Italic for timestamps and notes
- Emoji indicators: green/red circles for P&L, warning triangles for alerts
