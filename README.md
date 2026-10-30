# Yandex Music for VS Code

Listen to Yandex Music without leaving the editor: My Vibe, your liked tracks,
playlists and search.

<img src="https://raw.githubusercontent.com/entropious/vscode_music/main/docs/screenshot.png" alt="The player panel in the VS Code sidebar and the mini player above the status bar" width="380">

## Install

Install **Yandex Music Player** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=entro.vscode-yandex-music),
or search for it in the Extensions view, or run:

```bash
code --install-extension entro.vscode-yandex-music
```

Builds are also attached to [GitHub releases](https://github.com/entropious/vscode_music/releases)
as `.vsix` files: **Extensions → … → Install from VSIX…**

## Controls

- **Player panel** — the `{✷}` icon in the Activity Bar. Cover art, a waveform
  seek bar, volume, the queue, playlists and search. Search also finds genres:
  `rock`, `jazz` or `рок` puts up to three matching genre stations above the
  tracks, and clicking one starts endless radio of that genre, as My Vibe does.
  **Track radio** under the current track keeps it playing and fills the queue
  after it with endless music like it.
- **Status bar** — `‹ ▶ ›` buttons and the current track. Hover over the track
  or click it to open a mini player with previous, play/pause, next and like.
- **Keyboard shortcuts**

  | macOS | Windows / Linux | Action |
  |---|---|---|
  | `Cmd+Alt+P` | `Ctrl+Alt+P` | Play / pause |
  | `Cmd+Alt+→` | `Ctrl+Alt+→` | Next track |
  | `Cmd+Alt+←` | `Ctrl+Alt+←` | Previous track |

Every action is also available from the Command Palette under the
**Yandex Music** category.

## Signing in

Run **Yandex Music: Sign In** from the Command Palette.

- **In the browser.** The extension opens a separate Chrome, Yandex Browser,
  Edge or Brave window with the Yandex sign-in page, catches the redirect and
  exchanges the code for a token itself. That window keeps you signed in to
  Yandex, so the next sign-in is one click. Without a Chromium-based browser the
  page opens in your default browser; after signing in, paste the
  `music.yandex.ru/oauth?code=…` link from the browser history into VS Code.
- **With a token.** Paste an existing Yandex Music OAuth token.

The browser sign-in uses the same OAuth client as the Yandex Music desktop app
and asks only for music and basic account access. The token is kept in VS Code
SecretStorage, which is backed by the system keychain. On macOS the player
service also keeps a copy in the login keychain (item `vscode-yandex-music`), so
the fullscreen remote can start it without VS Code; signing out deletes it.

Full tracks need a Yandex Plus subscription; without it Yandex serves 30-second
previews. Tracks stream as MP3 at up to 320 kbps, and the mini player shows the
current codec and bitrate.

## Several VS Code windows

**macOS.** Music plays in a small background process, not in a window, so closing
or reloading a window doesn't interrupt it. Every window is a remote control
showing the same track, queue and progress. The process starts the first time you
play music and exits a few seconds after the last VS Code window closes.

**Windows and Linux.** Music plays in one window at a time; the others act as
remote controls. A command that starts playback moves the audio to the window it
came from once you have clicked inside that window's player panel — the webview
is only allowed to play sound after a click inside it. If the window that plays
music closes, another one picks up from the same track and position.

## Fullscreen remote (macOS)

**Yandex Music Remote** is a separate fullscreen app for a big screen: a large
cover with a spinning record, a background in the cover's colors, a progress bar
of bouncing bars and controls you can hit from across the room. It plays nothing
itself: it controls the player service that the extension runs on macOS, the
same way a VS Code window does, and starts that service itself when it isn't
running, so it works without VS Code open. The music keeps playing while the app
is open, even after VS Code is closed.

Once the app is installed, the player panel's title bar gets a `⛶` button that
opens it, and so does **Yandex Music: Open Fullscreen Remote**. The extension
has to be installed and signed in once. The app isn't signed, so build it yourself (see
[`remote/`](https://github.com/entropious/vscode_music/tree/main/remote) and
[DEVELOPMENT.md](https://github.com/entropious/vscode_music/blob/main/DEVELOPMENT.md#fullscreen-remote-macos))
and copy `Yandex Music Remote.app` to `/Applications`.

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Previous / next track |
| `↑` / `↓` | Volume |
| `L` / `M` | Like / mute |
| `Q` / `/` | Queue / search |
| `F` | Leave or enter full screen |

Media keys keep working through the player service's Now Playing.

## AI-generated music

Tracks that are likely AI-generated get an **AI** mark in the player panel, the
queue and search results, the status bar and the mini player. The extension
doesn't skip or dislike them; it only shows the mark. The verdict comes from [slopless.art](https://slopless.art),
a public database of AI music on Yandex Music that combines its own model with
Yandex's own AI labels: a track counts as AI if either flags it, or if at least
5% of one of its artists' tracks are AI. The playing track, the next ones in the
queue and search results are looked up there; turn this off with
`yandexMusic.aiLabels`.

## Settings

| Setting | Default | Description |
|---|---|---|
| `yandexMusic.quality` | `high` | `high` picks the highest MP3 bitrate available, `low` the lowest. |
| `yandexMusic.volume` | `0.7` | Volume, 0–1. |
| `yandexMusic.aiLabels` | `true` | Mark likely AI-generated tracks, looked up on slopless.art. |

Source code, issues and building instructions are on
[GitHub](https://github.com/entropious/vscode_music); see
[DEVELOPMENT.md](https://github.com/entropious/vscode_music/blob/main/DEVELOPMENT.md)
for building and testing.

## Disclaimer

This is an unofficial client and is not affiliated with Yandex. It uses the
same undocumented API as the official apps, which may change at any time.
