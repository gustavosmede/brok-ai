#!/bin/zsh
set -euo pipefail

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
WHISPER_DIR="$PROJECT_DIR/.paperdesk/whisper.cpp"
BUILD_DIR="$WHISPER_DIR/build"
MODEL_PATH="$WHISPER_DIR/models/ggml-small.bin"
SERVER_PATH="$BUILD_DIR/bin/whisper-server"
SDK_PATH=$(xcrun --show-sdk-path)
LABEL="com.paperdesk.whisper"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$AGENT_DIR/$LABEL.plist"
LOG_DIR="$PROJECT_DIR/.paperdesk/logs"

if ! command -v brew >/dev/null 2>&1; then
  echo "Homebrew not found. Install Homebrew to compile local Whisper."
  exit 1
fi

if ! command -v cmake >/dev/null 2>&1; then
  brew install cmake
fi

mkdir -p "$PROJECT_DIR/.paperdesk" "$LOG_DIR" "$AGENT_DIR"
if [[ ! -d "$WHISPER_DIR/.git" ]]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR"
fi

# Some recent macOS/CLT combinations do not expose libc++'s headers through
# clang's implicit search path, although they are present inside the SDK.
cmake -S "$WHISPER_DIR" -B "$BUILD_DIR" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_SYSROOT="$SDK_PATH" \
  -DCMAKE_CXX_FLAGS="-isystem $SDK_PATH/usr/include/c++/v1" \
  -DGGML_METAL=ON
cmake --build "$BUILD_DIR" --config Release -j 4

if [[ ! -f "$MODEL_PATH" ]]; then
  bash "$WHISPER_DIR/models/download-ggml-model.sh" small
fi

if [[ ! -x "$SERVER_PATH" || ! -f "$MODEL_PATH" ]]; then
  echo "The Whisper installation did not produce the expected server or model."
  exit 1
fi

sed -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
  -e "s|__SERVER_PATH__|$SERVER_PATH|g" \
  -e "s|__MODEL_PATH__|$MODEL_PATH|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$PROJECT_DIR/scripts/com.paperdesk.whisper.plist.template" > "$PLIST_PATH"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl enable "gui/$(id -u)/$LABEL"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

for attempt in {1..120}; do
  if curl -sS --max-time 2 http://127.0.0.1:8080/health 2>/dev/null | grep -q '"status":"ok"'; then
    echo "Local Whisper is installed and active. The Brok.ai microphone is ready to use."
    exit 0
  fi
  sleep 1
done

echo "The service was installed, but has not responded yet. See $LOG_DIR/whisper.err.log"
exit 1
