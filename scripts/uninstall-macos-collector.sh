#!/bin/zsh
set -euo pipefail

LABEL="com.paperdesk.collector"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"
echo "Coletor do Brok.ai removido. Os dados locais foram preservados."
