#!/bin/bash
LOG_FILE="$HOME/.obsidian-tunnel.log"
MAX_LOG_SIZE=1048576

: > "$LOG_FILE"

echo "Starting named tunnel: obsidian-vault"
echo "$(date): Tunnel starting" >> "$LOG_FILE"

cloudflared tunnel run obsidian-vault 2>&1 | while IFS= read -r line; do
  LOG_SIZE=$(stat -f%z "$LOG_FILE" 2>/dev/null || stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$LOG_SIZE" -gt "$MAX_LOG_SIZE" ]; then
    tail -100 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
  fi

  echo "$line" >> "$LOG_FILE"
done
