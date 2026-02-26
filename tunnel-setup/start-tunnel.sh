#!/bin/bash
REPLIT_APP_URLS="${REPLIT_APP_URLS:-}"
OBSIDIAN_API_KEY="${OBSIDIAN_API_KEY:-}"
TUNNEL_URL_FILE="$HOME/.obsidian-tunnel-url"
LOG_FILE="$HOME/.obsidian-tunnel.log"

cloudflared tunnel --url https://localhost:27124 --no-tls-verify 2>&1 | while IFS= read -r line; do
  echo "$line" >> "$LOG_FILE"

  URL=$(echo "$line" | grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com')
  if [ -n "$URL" ]; then
    echo "$URL" > "$TUNNEL_URL_FILE"
    echo "Tunnel URL: $URL"

    if [ -n "$REPLIT_APP_URLS" ] && [ -n "$OBSIDIAN_API_KEY" ]; then
      IFS=',' read -ra URLS <<< "$REPLIT_APP_URLS"
      for APP_URL in "${URLS[@]}"; do
        APP_URL=$(echo "$APP_URL" | xargs)
        curl -s -X POST "${APP_URL}/api/config/tunnel-url" \
          -H "Authorization: Bearer ${OBSIDIAN_API_KEY}" \
          -H "Content-Type: application/json" \
          -d "{\"url\": \"${URL}\"}" \
          && echo " -> Notified ${APP_URL}" \
          || echo " -> Failed to notify ${APP_URL}"
      done
    fi
  fi
done
