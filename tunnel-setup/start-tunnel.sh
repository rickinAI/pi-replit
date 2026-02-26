#!/bin/bash
REPLIT_APP_URL="${REPLIT_APP_URL:-}"
OBSIDIAN_API_KEY="${OBSIDIAN_API_KEY:-}"
TUNNEL_URL_FILE="$HOME/.obsidian-tunnel-url"
LOG_FILE="$HOME/.obsidian-tunnel.log"

cloudflared tunnel --url https://localhost:27124 --no-tls-verify 2>&1 | while IFS= read -r line; do
  echo "$line" >> "$LOG_FILE"

  URL=$(echo "$line" | grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com')
  if [ -n "$URL" ]; then
    echo "$URL" > "$TUNNEL_URL_FILE"
    echo "Tunnel URL: $URL"

    if [ -n "$REPLIT_APP_URL" ] && [ -n "$OBSIDIAN_API_KEY" ]; then
      curl -s -X POST "${REPLIT_APP_URL}/api/config/tunnel-url" \
        -H "Authorization: Bearer ${OBSIDIAN_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "{\"url\": \"${URL}\"}" \
        && echo "Replit server notified of new tunnel URL" \
        || echo "Failed to notify Replit server (is it running?)"
    fi
  fi
done
