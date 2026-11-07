#!/bin/bash
# Builds Yandex Music Remote.app into dist/: the release build of the Swift package, its
# resources, the icon and an Info.plist with the extension's version, which the extension
# compares with its own to offer an update.
#   bash scripts/build-app.sh
set -euo pipefail
cd "$(dirname "$0")/.."

NAME="Yandex Music Remote"
EXE=YandexMusicRemote
VERSION=$(sed -nE 's/^  "version": "([^"]+)".*/\1/p' ../package.json)

swift build -c release --product "$EXE"
BIN=$(swift build -c release --show-bin-path)

APP="dist/$NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/$EXE" "$APP/Contents/MacOS/$EXE"
cp -R Sources/$EXE/Resources/. "$APP/Contents/Resources/"
cp build/icon.icns "$APP/Contents/Resources/icon.icns"
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>$NAME</string>
	<key>CFBundleDisplayName</key><string>$NAME</string>
	<key>CFBundleIdentifier</key><string>net.entro.yandex-music-remote</string>
	<key>CFBundleExecutable</key><string>$EXE</string>
	<key>CFBundleIconFile</key><string>icon</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>$VERSION</string>
	<key>CFBundleVersion</key><string>$VERSION</string>
	<key>LSMinimumSystemVersion</key><string>14.0</string>
	<key>LSApplicationCategoryType</key><string>public.app-category.music</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
EOF
codesign --force --sign - "$APP" >/dev/null
echo "built $APP ($VERSION)"
