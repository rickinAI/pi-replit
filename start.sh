#!/bin/bash
# Resolve to the project root regardless of where this script is called from
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "📦 Installing dependencies..."
npm install

echo "🚀 Starting pi-replit server..."
export NODE_PATH="$SCRIPT_DIR/node_modules"
exec node dist/server.js
