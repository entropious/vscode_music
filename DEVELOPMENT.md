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

## Fullscreen remote (macOS)

`remote/` is Yandex Music Remote, a native macOS app in SwiftUI: a Swift package
(`remote/Package.swift`, macOS 14+) with no dependencies. It finds the player
service's socket in the temp directory (`vscode-yandex-music-service-*.sock`),
joins it with an `attach` message (a remote without settings: the token stays as
the windows set it) and runs the same calls as a window (`ServiceLink.swift`); the
messages' types are in `Wire.swift`. A connected app keeps the service running.
Tracks the app sends back (`playTracks`) go as the service sent them, raw JSON,
with the fields the app doesn't read. The now-playing art follows the player
panel's (`media/nowArt.js`): the palette and the progress bars' heights are worked
out the same way (`Art.swift`), with the same 32-bit hashing, so a track looks the
same in both.

It is kept small in memory, some 60 MB with a video playing: the window is the app
delegate's own and isn't restored (restoration keeps a picture of the whole
window); images reach SwiftUI as `CGImage`s, decoded once by ImageIO (from an
`NSImage` SwiftUI may render a new bitmap the size it shows it at); the background
is blurred with vImage, since Core Image brings Metal and its caches.
`YM_SNAPSHOT=<file.png>` makes the app save a picture of its window every few
seconds, for checking its look without screen recording rights (it doesn't
catch the video, which AVPlayer draws in its own layer).

When no service answers, the app starts one itself (`Launch.swift`): it finds the
newest copy of the extension in `~/.vscode/extensions` (or Insiders, Cursor,
VSCodium, Windsurf), computes the socket the windows of that editor look at from
its global storage folder, and runs the extension's `out/service.js` with that
editor's own Electron in Node mode. Such a service has no window to say hello,
so on every hello the service saves the window's settings to
`service-settings.json` in the global storage and the token to the login
keychain (`security`, item `vscode-yandex-music`, account `token-<socket id>`:
one per VS Code profile, so the tests' service, with a profile of its own, never
overwrites the user's token), and reads both when it starts. `YM_EXTENSION_DIR`,
`YM_STORAGE_DIR` and `YM_NODE` (the Electron to run it with) point the app at
another copy, e.g. this repository after `npm run compile`.

The service looks up the visuals of the current and the next track
(`src/visuals.ts`) while a remote app asks for them, and passes them in the shared
state (`visuals`). The app asks with a `visuals` message while its window is
visible and stops when it is minimized or hidden; attaching alone asks for nothing:
- from Yandex Music: the video shot (`backgroundVideoUri`) in the track itself;
  the album's genre with `/genres`; the artist's
  `backgroundVideoUrl` in `/artists/{id}/brief-info`. Its music videos (`/clips`,
  `/tracks/{id}/supplement`) are left out: few tracks have one, and what `/clips`
  gives is a 4-second preview;
- from the iTunes Search API, the music video's 30-second preview, by artist and
  title; from Wikidata and Genius, the music video's YouTube ID, checked with
  YouTube's oEmbed;
- from Apple Music, the motion cover: the album on the iTunes Search API, then
  the HLS playlists linked on its music.apple.com page, of which the square one;
  and the artist's video for artists Yandex Music has none of: the artist's page,
  of which the wide one.

The remote plays one of them with AVPlayer (`Video.swift`), which plays the MP4
files and HLS streams as they are. A music video on YouTube is played from its
video stream, which yt-dlp finds (`--get-url`, H.264 or HEVC up to 720p; a link
is kept for an hour), and kept at the track's position; AVPlayer's buffer is held
to 10 seconds, or it keeps all of such a plain MP4 in memory. Without yt-dlp those
videos are left out. A full music video from Yandex isn't reached yet: the Yandex
Music API gives only a preview and a `playerId` for Yandex's video hosting.
**Yandex Music: Save Video Info of the Current Track** saves the API's answers
about the current track's videos to a JSON file in the global storage, to see
what there is to play.

```bash
cd remote
swift run                    # build and open it; add --fullscreen to open it in full screen
bash scripts/build-app.sh    # dist/Yandex Music Remote.app, for Apple silicon
```

`npm run package` builds the app first and puts it into the extension's package
(`remote/dist/`). The extension's **Install Fullscreen Remote** (and **Open
Fullscreen Remote**, without asking, when the app isn't installed or came with an
older version) copies it into `~/Applications` with `ditto`, takes it out of quarantine (it is
signed only ad hoc), and installs yt-dlp with Homebrew when it isn't there.
**Open Fullscreen Remote** looks for the app in `~/Applications` only, so a build
in a checkout doesn't count, and compares the version in the app's `Info.plist`
(the extension's version it came with) with its own.

## Endpoint settings

These point the extension at a different API or OAuth server, such as a mock:

| Setting | Default |
|---|---|
| `yandexMusic.apiBaseUrl` | `https://api.music.yandex.net` |
| `yandexMusic.oauthBaseUrl` | `https://oauth.yandex.ru` |

Yandex Music's AI label is the "AI use" (`Использование ИИ`) entry of
`/tracks/{id}/credits`; `src/aiMarks.ts` tells "fully", "partly" and "possibly"
apart by its wording, and takes a wording it doesn't know for "possibly". The mock
API labels Test Track 2 there.
