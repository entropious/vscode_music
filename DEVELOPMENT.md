# Development

```bash
npm install
npm test        # integration tests in a real VS Code against a mock Yandex Music API
npm run e2e     # end-to-end: drives VS Code like a user, two windows included
npm run package # build the .vsix
```

## End-to-end test with sound (Linux)

The e2e test can record what VS Code plays and check that there is a signal
while a track plays (RMS above 0.1, the 440 Hz tone of the test track) and
silence on pause:

```bash
pulseaudio -D --exit-idle-time=-1
pactl load-module module-null-sink sink_name=vsc && pactl set-default-sink vsc
YM_AUDIO_DEVICE=vsc.monitor xvfb-run -a npm run e2e
```

Without `YM_AUDIO_DEVICE` and `xvfb-run` it runs on a regular desktop: the VS
Code window opens on your screen and you hear the sound yourself.

To run it against the real service, pass your token. It only goes to the local
VS Code, and the test just starts My Vibe:

```bash
YM_TOKEN=<your OAuth token> YM_AUDIO_DEVICE=vsc.monitor xvfb-run -a npm run e2e
```

## Dev host stand

`.probe/devhost.sh` opens the extension in a VS Code window with a separate
profile and the mock API, and `.probe/devhost-check.js` drives it over the
Chrome DevTools Protocol: signs in, opens the player, resizes the sidebar,
takes screenshots and checks the layout and playback animation. Run
`bash .probe/devhost.sh` for the list of commands.

## Player service (macOS)

On macOS the music plays in a background process, `out/service.js`, built from
`src/service.ts`. A window starts it with VS Code's own Electron in Node mode
(`ELECTRON_RUN_AS_NODE=1`) the first time music is played, hands over its queue
and becomes a remote over a Unix socket; other windows connect to the same
socket. The service runs the same `PlayerCore` (`src/core.ts`) as a window, and
plays audio through AVPlayer in `helper/avplayer.js`, a JXA script under
`osascript` that takes JSON commands on stdin and reports status on stdout. The
service exits 8 seconds after the last window disconnects and writes its log to
`service.log` in the extension's global storage.

Checks that need no VS Code window:

```bash
npm run compile
node .probe/avplayer-check.js  # AVPlayer helper: file and HTTP playback, pause, seek, track end
node .probe/service-check.js   # service: two clients, playback survives one closing, exit when none are left
```

`osascript` is run through `node .probe/jxa.js <file>` where running it directly isn't allowed.

## Endpoint settings

These point the extension at a different API or OAuth server, such as a mock:

| Setting | Default |
|---|---|
| `yandexMusic.apiBaseUrl` | `https://api.music.yandex.net` |
| `yandexMusic.oauthBaseUrl` | `https://oauth.yandex.ru` |
| `yandexMusic.sloplessBaseUrl` | `https://slopless.art/api` |

The mock API also answers the slopless.art endpoints under `/slopless`, with Test Track 2 marked as AI.
