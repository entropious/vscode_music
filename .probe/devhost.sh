#!/bin/bash
# Проверка расширения в Extension Development Host с отдельным профилем.
#
#   bash .probe/devhost.sh start           сборка, mock-API и окно (выходит вперёд один раз)
#   bash .probe/devhost.sh signin          вход по токену mock-API через палитру
#   bash .probe/devhost.sh reload          перечитать вебвью с диска, не перезапуская окно
#   bash .probe/devhost.sh restart         закрыть окно и поднять заново (выходит вперёд)
#   bash .probe/devhost.sh case            узкая панель: что обрезается и где лайк
#   bash .probe/devhost.sh case stock      то же на media/ из HEAD (отрицательный прогон)
#   bash .probe/devhost.sh stock <проверка> любая проверка на media/ из HEAD, например stock progress
#   bash .probe/devhost.sh stop            закрыть окно и mock-API
#
# Прочие подкоманды передаются в devhost-check.js: targets, palette, type, panel,
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
# Только процессы этого профиля: рабочие окна VS Code не трогаются.
host_pids() { ps ax -o pid,command | grep "user-data-dir=$PROFILE" | grep -v grep | awk '{print $1}'; }
main_pids() { ps ax -o pid,command | grep "user-data-dir=$PROFILE" | grep "Code.app/Contents/MacOS/Code " | grep -v grep | awk '{print $1}'; }
mock_pids() { ps ax -o pid,command | grep "$ROOT/.probe/mock.js" | grep -v grep | awk '{print $1}'; }

case "${1:-}" in
start)
	npm run compile 2>&1 | grep -E "error TS" && { echo "сборка упала"; exit 1; }
	if cdp_up; then echo "окно уже запущено (CDP на $CDP_PORT)"; exit 0; fi
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
	# Окно стенда обычно лежит под рабочими окнами. Без флагов Chromium считает его
	# скрытым: таймеры срабатывают раз в секунду, кадров и CSS-анимаций нет вовсе.
	"$CODE" --user-data-dir="$PROFILE" --extensions-dir="$EXTENSIONS" --remote-debugging-port="$CDP_PORT" \
		--extensionDevelopmentPath="$ROOT" --new-window "$WORKSPACE" \
		--disable-workspace-trust --skip-welcome --skip-release-notes --disable-updates \
		--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling \
		> "$ROOT/.probe/devhost.log" 2>&1 &
	for _ in $(seq 1 30); do sleep 2; cdp_up && { echo "окно готово, CDP на $CDP_PORT"; exit 0; }; done
	echo "окно не поднялось за 60с, см. .probe/devhost.log"; exit 1
	;;

signin)
	TOKEN="$(node -e 'console.log(require(process.argv[1]).token)' "$ROOT/.probe/mock.json")"
	"${CHECK[@]}" palette "Яндекс Музыка: Ввести OAuth-токен вручную" || exit 1
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
	# Отрицательный прогон: проверка на media/ из HEAD. Файлы подменяются на время
	# прогона и возвращаются, вебвью перечитывается с диска.
	shift
	[ -z "${1:-}" ] && { echo "нужна проверка: stock measure | stock progress"; exit 2; }
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
	[ -z "$(host_pids)" ] && { echo "окно не запущено"; exit 0; }
	# SIGTERM только главному процессу: Electron выходит штатно, как по Cmd+Q.
	# Убитые по отдельности хелперы VS Code считает падением.
	MAIN="$(main_pids)"
	[ -z "$MAIN" ] && { echo "главный процесс не найден, остались: $(host_pids)"; exit 1; }
	echo "$MAIN" | xargs kill -TERM 2>/dev/null
	for _ in $(seq 1 30); do sleep 1; [ -z "$(host_pids)" ] && { echo "окно закрыто"; exit 0; }; done
	echo "окно не закрылось за 30 с, процессы: $(host_pids) — принудительно не добиваю"; exit 1
	;;

*)
	grep '^#' "$0" | sed -n '2,13p' | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
