# pi-replit

Mobile-friendly web UI for the [pi coding agent](https://github.com/badlogic/pi-mono), deployable on Replit.

## What it does

- Wraps the `pi` coding agent SDK in an Express server with SSE streaming
- Serves a mobile-first chat UI at `/`
- Proxies the [pi-interview-tool](https://github.com/nicobailon/pi-interview-tool) form UI at `/interview`
- Single port (3000) for everything — works on Replit's single-port constraint

## Architecture

```
Browser (mobile)
   │
   ├── GET  /              → chat UI (public/)
   ├── POST /api/session   → create pi agent session
   ├── GET  /api/session/:id/stream → SSE event stream
   ├── POST /api/session/:id/prompt → send message to agent
   └── GET  /interview/*   → proxy → pi-interview-tool (port 19847)
```

## Local dev

```bash
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env

npm install
npm run dev
# → http://localhost:3000
```

## Replit deploy

1. Fork/import this repo into Replit
2. Add `ANTHROPIC_API_KEY` in **Secrets**
3. Click **Run** — Replit auto-detects `.replit` config
4. Open the Replit URL on mobile

## Prerequisites

- Node.js >= 20
- `pi` coding agent >= 0.35.0 (from [pi-mono](https://github.com/badlogic/pi-mono))
- [pi-interview-tool](https://github.com/nicobailon/pi-interview-tool) installed as a pi extension
