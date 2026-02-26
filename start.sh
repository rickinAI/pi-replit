#!/bin/bash
# Resolve to the project root regardless of where this script is called from
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "📦 Installing dependencies..."
npm install --prefer-offline 2>/dev/null || npm install

echo "🔑 API key set: ${ANTHROPIC_API_KEY:+yes (${#ANTHROPIC_API_KEY} chars)}"
echo "🔑 API key set: ${ANTHROPIC_API_KEY:-NO - add ANTHROPIC_API_KEY to Replit Secrets!}"

echo "🔨 Building..."
npm run build

echo "🚀 Starting pi-replit server..."
export NODE_PATH="$SCRIPT_DIR/node_modules"
exec node dist/server.js
