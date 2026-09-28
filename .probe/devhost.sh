#!/bin/bash
# Test the extension in an Extension Development Host with its own profile.
#
#   bash .probe/devhost.sh start           build, start the mock API and open the window (comes to the front once)
#   bash .probe/devhost.sh signin          sign in with the mock API token via the command palette
#   bash .probe/devhost.sh reload          reload webviews from disk without restarting the window
#   bash .probe/devhost.sh restart         close the window and start it again (comes to the front)
#   bash .probe/devhost.sh case            narrow panel: what gets clipped and where the like button is
#   bash .probe/devhost.sh case stock      same, against media/ from HEAD (negative run)
#   bash .probe/devhost.sh stock <check>   any check against media/ from HEAD, e.g. stock progress
#   bash .probe/devhost.sh stop            close the window and stop the mock API
#
# Any other subcommand is passed to devhost-check.js: targets, palette, type, panel,
# width, shot, measure, progress, throttle.
set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"
CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
PROFILE="$ROOT/.probe/vscode-user"
EXTENSIONS="$ROOT/.probe/vscode-ext"
WORKSPACE="$ROOT/.probe/ws"
export CDP_PORT="${CDP_PORT:-9231}"
CHECK=(node "$ROOT/.probe/devhost-check.js")

cdp_up() { curl -s --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null 2>&1; }
# Only processes of this profile, so regular VS Code windows are left alone.
host_pids() { ps ax -o pid,command | grep "user-data-dir=$PROFILE" | grep -v grep | awk '{print $1}'; }
main_pids() { ps ax -o pid,command | grep "user-data-dir=$PROFILE" | grep "Code.app/Contents/MacOS/Code " | grep -v grep | awk '{print $1}'; }
mock_pids() { ps ax -o pid,command | grep "$ROOT/.probe/mock.js" | grep -v grep | awk '{print $1}'; }

case "${1:-}" in
start)
	npm run compile 2>&1 | grep -E "error TS" && { echo "build failed"; exit 1; }
	if cdp_up; then echo "window already running (CDP on $CDP_PORT)"; exit 0; fi
	[ -z "$(mock_pids)" ] && { node "$ROOT/.probe/mock.js" > "$ROOT/.probe/mock.log" 2>&1 & }
	for _ in $(seq 1 20); do [ -s "$ROOT/.probe/mock.json" ] && break; sleep 0.5; done
	BASE="$(node -e 'console.log(require(process.argv[1]).base)' "$ROOT/.probe/mock.json")"
	mkdir -p "$PROFILE/User" "$WORKSPACE"
	rm -rf "$PROFILE/User/workspaceStorage" "$PROFILE/User/History"
	cat > "$PROFILE/User/settings.json" <<EOF
{
  "yandexMusic.apiBaseUrl": "$BASE",
  "yandexMusic.volume": 0,
  "workbench.startupEditor": "none",
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "chat.commandCenter.enabled": false,
  "chat.disableAIFeatures": true,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "update.mode": "none",
  "update.showReleaseNotes": false,
  "telemetry.telemetryLevel": "off",
  "extensions.autoUpdate": false,
  "security.workspace.trust.enabled": false
}
EOF
	# The test window usually sits behind other windows. Without these flags Chromium treats
	# it as hidden: timers fire once a second, and no frames or CSS animations run at all.
	"$CODE" --user-data-dir="$PROFILE" --extensions-dir="$EXTENSIONS" --remote-debugging-port="$CDP_PORT" \
		--extensionDevelopmentPath="$ROOT" --new-window "$WORKSPACE" \
		--disable-workspace-trust --skip-welcome --skip-release-notes --disable-updates \
		--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling \
		> "$ROOT/.probe/devhost.log" 2>&1 &
	for _ in $(seq 1 30); do sleep 2; cdp_up && { echo "window ready, CDP on $CDP_PORT"; exit 0; }; done
	echo "window did not come up within 60 s, see .probe/devhost.log"; exit 1
	;;

signin)
	TOKEN="$(node -e 'console.log(require(process.argv[1]).token)' "$ROOT/.probe/mock.json")"
	"${CHECK[@]}" palette "Yandex Music: Enter OAuth Token Manually" || exit 1
	"${CHECK[@]}" type "$TOKEN"
	;;

restart)
	bash "$0" stop || exit 1
	bash "$0" start
	;;

reload)
	"${CHECK[@]}" palette "Developer: Reload Webviews"
	;;

case)
	if [ "${2:-}" = "stock" ]; then
		bash "$0" stock measure
		exit $?
	fi
	bash "$0" reload > /dev/null
	"${CHECK[@]}" open || exit 1
	"${CHECK[@]}" width 258 || exit 1
	"${CHECK[@]}" shot work
	"${CHECK[@]}" measure
	;;

stock)
	# Negative run: the check runs against media/ from HEAD. The files are swapped in for
	# the run and restored afterwards; webviews are reloaded from disk.
	shift
	[ -z "${1:-}" ] && { echo "specify a check: stock measure | stock progress"; exit 2; }
	cp media/player.js .probe/player.js.work && cp media/player.css .probe/player.css.work
	restore() {
		[ -f .probe/player.js.work ] || return
		cp .probe/player.js.work media/player.js && cp .probe/player.css.work media/player.css && rm -f .probe/*.work
	}
	trap restore EXIT
	git show HEAD:media/player.js > media/player.js && git show HEAD:media/player.css > media/player.css
	bash "$0" reload > /dev/null
	"${CHECK[@]}" open > /dev/null || exit 1
	"${CHECK[@]}" width 258 > /dev/null || exit 1
	"${CHECK[@]}" "$@"
	STATUS=$?
	restore
	bash "$0" reload > /dev/null
	exit $STATUS
	;;

targets|palette|type|panel|width|shot|measure|progress|throttle|open|layout)
	"${CHECK[@]}" "$@"
	;;

stop)
	[ -n "$(mock_pids)" ] && mock_pids | xargs kill -TERM 2>/dev/null
	rm -f "$ROOT/.probe/mock.json"
	[ -z "$(host_pids)" ] && { echo "window not running"; exit 0; }
	# SIGTERM goes to the main process only, so Electron shuts down cleanly, as on Cmd+Q.
	# VS Code treats helpers killed one by one as a crash.
	MAIN="$(main_pids)"
	[ -z "$MAIN" ] && { echo "main process not found, remaining: $(host_pids)"; exit 1; }
	echo "$MAIN" | xargs kill -TERM 2>/dev/null
	for _ in $(seq 1 30); do sleep 1; [ -z "$(host_pids)" ] && { echo "window closed"; exit 0; }; done
	echo "window did not close within 30 s, processes: $(host_pids); not killing them forcibly"; exit 1
	;;

*)
	grep '^#' "$0" | sed -n '2,14p' | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
