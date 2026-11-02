#!/bin/bash
# Builds Yandex Music Remote from this repository at a given tag or branch and installs it into
# ~/Applications. The extension runs it in a terminal: Open Fullscreen Remote, when the app isn't
# there. It installs Bun (https://bun.sh) if there is none. It builds in
# ~/Library/Caches/yandex-music-remote and removes that when done; what stays for the next update
# is the Electron zip in ~/Library/Caches/electron and the packages in Bun's own cache.
#
#   install.sh [ref] [arch]
#
# ref is a tag or a branch (default main), arch arm64 or x64 (default this Mac's). With
# YM_REMOTE_SOURCE set to a checkout, that is built instead of a download.
set -euo pipefail

REF=${1:-main}
ARCH=${2:-$(uname -m)}
[ "$ARCH" = x86_64 ] && ARCH=x64
REPO=entropious/vscode_music
APP_NAME="Yandex Music Remote.app"
DEST="$HOME/Applications/$APP_NAME"
CACHE="$HOME/Library/Caches/yandex-music-remote"
# VS Code starts its processes with this set; with it, the app's Electron would run as plain Node.
unset ELECTRON_RUN_AS_NODE

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

BUN=$(command -v bun || true)
if [ -z "$BUN" ] && [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
fi
if [ -z "$BUN" ]; then
  step "Installing Bun"
  curl -fsSL https://bun.sh/install | bash
  BUN="$HOME/.bun/bin/bun"
fi

rm -rf "$CACHE"
mkdir -p "$CACHE"
trap 'rm -rf "$CACHE"' EXIT
SRC="$CACHE/source"
if [ -n "${YM_REMOTE_SOURCE:-}" ]; then
  step "Taking the source from $YM_REMOTE_SOURCE"
  rm -rf "$SRC" && mkdir -p "$SRC"
  # The app's build takes media/ (the art shared with the extension) from next to remote/.
  (cd "$YM_REMOTE_SOURCE" && tar -c --exclude node_modules --exclude out --exclude dist remote media) | tar -x -C "$SRC"
else
  step "Downloading the source ($REF)"
  rm -rf "$SRC" && mkdir -p "$SRC"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" | tar -xz -C "$SRC" --strip-components=1 '*/remote' '*/media'
fi

step "Installing its dependencies"
cd "$SRC/remote"
# Without the electron package's own download of Electron: the packager takes Electron from its cache.
"$BUN" install --frozen-lockfile --ignore-scripts

step "Building the app for $ARCH"
# @electron/packager keeps the Electron zip in its own cache (~/Library/Caches/electron).
"$BUN" run package -- --arch="$ARCH"

step "Installing it into ~/Applications"
mkdir -p "$HOME/Applications"
rm -rf "$DEST"
ditto "dist/Yandex Music Remote-darwin-$ARCH/$APP_NAME" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

step "Done: $DEST"
open "$DEST"
