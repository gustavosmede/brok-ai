#!/bin/zsh
set -euo pipefail

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LABEL="com.paperdesk.collector"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$AGENT_DIR/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/.paperdesk/logs"
NPM_DIR=$(dirname -- "$(command -v npm)")
COLLECTOR_PATH="$NPM_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cd "$PROJECT_DIR"
npm run build
mkdir -p "$AGENT_DIR" "$LOG_DIR"
sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" -e "s|__PATH__|$COLLECTOR_PATH|g" -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$PROJECT_DIR/scripts/com.paperdesk.collector.plist.template" > "$PLIST_PATH"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "Brok.ai iniciado em segundo plano. Abra http://localhost:3000"
