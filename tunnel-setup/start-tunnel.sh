#!/bin/bash
LOG_FILE="$HOME/.obsidian-tunnel.log"
MAX_LOG_SIZE=1048576
RESTART_DELAY=5

echo "[tunnel] Starting named tunnel: obsidian-vault"
echo "[tunnel] Fixed URL: https://obsidian.rickin.live"

while true; do
  : > "$LOG_FILE"
  echo "[tunnel] Launching cloudflared tunnel run obsidian-vault..."

  /opt/homebrew/bin/cloudflared tunnel run obsidian-vault 2>&1 | while IFS= read -r line; do
    LOG_SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$LOG_SIZE" -gt "$MAX_LOG_SIZE" ]; then
      tail -100 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
    fi
    echo "$line" >> "$LOG_FILE"
    echo "$line"
  done

  echo "[tunnel] cloudflared exited — restarting in ${RESTART_DELAY}s..."
  sleep "$RESTART_DELAY"
done
