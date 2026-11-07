#!/bin/bash
# Replaces the remote in ~/Applications with the one in dist/ and opens it again if it was running.
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="Yandex Music Remote"
SOURCE="dist/$NAME.app"
TARGET="$HOME/Applications/$NAME.app"
BINARY="$TARGET/Contents/MacOS/YandexMusicRemote"

[ -d "$SOURCE" ] || { echo "no $SOURCE, run scripts/build-app.sh first" >&2; exit 1; }

running=false
if pgrep -f "$BINARY" >/dev/null; then
    running=true
    osascript -e "quit app \"$NAME\"" || true
    for _ in {1..50}; do
        pgrep -f "$BINARY" >/dev/null || break
        sleep 0.1
    done
    pkill -f "$BINARY" || true
fi

mkdir -p "$HOME/Applications"
rm -rf "$TARGET"
ditto "$SOURCE" "$TARGET"
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

if $running; then
    open "$TARGET"
fi
echo "installed $TARGET"
