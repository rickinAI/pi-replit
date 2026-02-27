#!/bin/bash
REPLIT_APP_URLS="${REPLIT_APP_URLS:-}"
OBSIDIAN_API_KEY="${OBSIDIAN_API_KEY:-}"
TUNNEL_URL_FILE="$HOME/.obsidian-tunnel-url"
LOG_FILE="$HOME/.obsidian-tunnel.log"
MAX_LOG_SIZE=1048576

: > "$LOG_FILE"

notify_server() {
  local APP_URL="$1"
  local TUNNEL_URL="$2"
  local attempt=0
  local max_attempts=3

  while [ $attempt -lt $max_attempts ]; do
    if curl -s --connect-timeout 5 --max-time 10 -X POST "${APP_URL}/api/config/tunnel-url" \
      -H "Authorization: Bearer ${OBSIDIAN_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "{\"url\": \"${TUNNEL_URL}\"}" > /dev/null 2>&1; then
      echo " -> Notified ${APP_URL} (attempt $((attempt+1)))"
      return 0
    fi
    attempt=$((attempt+1))
    [ $attempt -lt $max_attempts ] && sleep $((attempt * 2))
  done
  echo " -> Failed to notify ${APP_URL} after ${max_attempts} attempts"
  return 1
}

/opt/homebrew/bin/cloudflared tunnel --url https://localhost:27124 --no-tls-verify 2>&1 | while IFS= read -r line; do
  LOG_SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$LOG_SIZE" -gt "$MAX_LOG_SIZE" ]; then
    tail -100 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
  fi

  echo "$line" >> "$LOG_FILE"

  URL=$(echo "$line" | grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com')
  if [ -n "$URL" ]; then
    echo "$URL" > "$TUNNEL_URL_FILE"
    echo "Tunnel URL: $URL"

    if [ -n "$REPLIT_APP_URLS" ] && [ -n "$OBSIDIAN_API_KEY" ]; then
      IFS=',' read -ra URLS <<< "$REPLIT_APP_URLS"
      for APP_URL in "${URLS[@]}"; do
        APP_URL=$(echo "$APP_URL" | xargs)
        notify_server "$APP_URL" "$URL" &
      done
      wait
    fi
  fi
done
