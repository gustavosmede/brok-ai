#!/bin/zsh
set -euo pipefail

LABEL="com.paperdesk.whisper"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
rm -f "$PLIST_PATH"
echo "Serviço de voz removido. O modelo local foi preservado em .paperdesk/whisper.cpp."
