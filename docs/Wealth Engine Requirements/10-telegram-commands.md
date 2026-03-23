# Telegram Command Reference

> **Updated:** March 23, 2026 — Post Notification Overhaul + Autonomous API

## Two-Bot Architecture

| Bot | Purpose |
|-----|---------|
| **DarkNode** (@Darknode_trading_bot) | Trading events, WE commands, copy trade signals |
| **Mission Control** (@MissionControl_alerts_bot) | Personal alerts, calendar, status digests |

## Command Inventory

### System Control

| Command | Action | Status |
|---------|--------|--------|
| `/status` | System health: mode, kill switch, pause, shadow P&L, notify mode | Built ✅ |
| `/pause` | Halt all Wealth Engine scheduled jobs | Built ✅ |
| `/resume` | Resume after pause or circuit breaker trigger | Built ✅ |
| `/kill` | Emergency: activate kill switch, close ALL positions | Built ✅ |
| `/public on\|off` | Toggle dashboard public access | Built ✅ |
| `/notify [smart\|immediate\|digest]` | Set notification mode | Built ✅ |
| `/reset [capital]` | Full portfolio reset (default $10K) | Built ✅ |

### Portfolio & Trading

| Command | Action | Status |
|---------|--------|--------|
| `/portfolio` | Open positions with live P&L | Built ✅ |
| `/trades [n]` | Last N closed trades (default 5, max 20) | Built ✅ |
| `/tax` | YTD tax summary with estimated liability | Built ✅ |
| `/risk` | Current risk metrics: exposure %, drawdown, open risk | Built ✅ |
| `/shadow` | Shadow portfolio performance (paper trading) | Built ✅ |

### Intelligence & Whales

| Command | Action | Status |
|---------|--------|--------|
| `/intel` | Latest SCOUT brief with active theses | Built ✅ |
| `/polymarket` | Active prediction market theses with whale consensus | Built ✅ |
| `/wallets` | Tracked whale registry with top performers + niche breakdown | Built ✅ |
| `/walletstatus` | Wallet health dashboard (aggregate counts) | Built ✅ |
| `/copytrades` | Active copy positions with unrealized P&L | Built ✅ |
| `/seedwallets` | Manual wallet seed from trade stream | Built ✅ |
| `/goal [amount]` | View/set wealth target (default $50K) | Built ✅ |

### Wallet Management

| Command | Action | Status |
|---------|--------|--------|
| `/add-wallet <addr> [alias] [niche]` | Add wallet to tracking registry | Built ✅ |
| `/remove-wallet <addr\|alias>` | Remove wallet from registry | Built ✅ |
| `/blacklist-wallet <addr\|alias>` | Permanently blacklist a wallet | Built ✅ |

### Oversight & Research

| Command | Action | Status |
|---------|--------|--------|
| `/oversight` | Latest health report + active improvement requests | Built ✅ |
| `/alerts` | Bot connection status | Built ✅ |
| `/help` | Command list | Built ✅ |

## Notification Categories (HTML Parse Mode)

All WE notifications use category header badges via `telegram-format.ts`:

| Badge | Category | Used For |
|-------|----------|----------|
| 🐋 WHALE INTEL | Whale intelligence | Wallet events, auto-disable alerts |
| ⚡ COPY TRADE | Copy trading | New copy signals, position mirrors |
| 👻 SHADOW BOOK | Shadow trading | Shadow open/close with streak tracking |
| 🔍 SCOUT | Scout intelligence | Scout briefs, scan results |
| 🛡️ OVERSIGHT | System oversight | Health checks, daily performance |
| 🌱 DISCOVERY | Wallet discovery | Anomaly scanner, new whale candidates |
| 📊 DAILY BRIEF | Summaries | DarkNode Summary with goal progress |
| 🎉 AUTO-REDEEM | Redemptions | Resolved market auto-redemptions |
| ⚠️ DEAD MAN | Dead man switch | Silent agent/monitor alerts |
| 🔴 CIRCUIT BREAK | Circuit breaker | Risk limit triggers |

## Notification Features

- **Copy trade signals**: Niche emoji, market badge, confidence bar, whale one-liner
- **Shadow trades**: Win/loss streak persistence (`shadow_streak` DB key), weekly reset Monday
- **DarkNode Summary**: $50K goal progress bar, mood indicator, today's P&L
- **Streak tracking**: currentStreak, streakType, longestStreak, weeklyWins/Losses/Pnl
- **Wealth goal**: Configurable via `/goal`, defaults to $50K, stored in `wealth_goal` DB key

## Autonomous Telegram API

DarkNode can send Telegram messages programmatically without going through the bot command flow:

| Endpoint | Method | Body | Purpose |
|----------|--------|------|---------|
| `/api/telegram/send` | POST | `{ message, parseMode? }` | Send arbitrary message (max 4000 chars) |

Supports `"Markdown"` and `"HTML"` parse modes. WE_CONTROL_USERS gated (rickin, darknode).

## Message Format

- Direct notifications: HTML parse mode with `escapeHtml()` for special characters
- Command responses: Markdown (shared dispatch — no HTML tags in return strings)
- Direct notifications truncated to 4096-char Telegram limit via `truncateToTelegramLimit()`
- API messages (`/api/telegram/send`): support both Markdown and HTML parse modes
