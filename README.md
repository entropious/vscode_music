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
  seek bar, volume, the queue, playlists and search.
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
SecretStorage, which is backed by the system keychain.

Full tracks need a Yandex Plus subscription; without it Yandex serves 30-second
previews. Tracks stream as MP3 at up to 320 kbps, and the mini player shows the
current codec and bitrate.

## Several VS Code windows

Music plays in one window at a time; the others act as remote controls and show
the same track, queue and progress. A command that starts playback moves the
audio to the window it came from once you have clicked inside that window's
player panel — the webview is only allowed to play sound after a click inside
it. If the window that plays music closes, another one picks up from the same
track and position.

## Settings

| Setting | Default | Description |
|---|---|---|
| `yandexMusic.quality` | `high` | `high` picks the highest MP3 bitrate available, `low` the lowest. |
| `yandexMusic.volume` | `0.7` | Volume, 0–1. |

Source code, issues and building instructions are on
[GitHub](https://github.com/entropious/vscode_music); see
[DEVELOPMENT.md](https://github.com/entropious/vscode_music/blob/main/DEVELOPMENT.md)
for building and testing.

## Disclaimer

This is an unofficial client and is not affiliated with Yandex. It uses the
same undocumented API as the official apps, which may change at any time.
