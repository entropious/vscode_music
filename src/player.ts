import * as vscode from 'vscode';
import { type Account, type Playlist, type Track, YandexMusicClient, artistLine, coverUrl, fullTitle } from './api';
import { renderCard } from './card';
import {
  AUDIO_METHODS,
  type AudioOutput,
  type PlaybackStatus,
  PlayerCore,
  type RemoteLink,
  type RemoteMethod,
  type SharedState,
  type Source,
  baseId,
  errorText,
  shortSourceLabel,
  sourceLabel,
} from './core';

export type { PlaybackStatus, RemoteLink, RemoteMethod, SharedState, Source } from './core';

const CARD_COMMANDS = [
  'yandexMusic.previous',
  'yandexMusic.playPause',
  'yandexMusic.next',
  'yandexMusic.like',
  'yandexMusic.playMyWave',
  'yandexMusic.signIn',
  // The focus command VS Code creates for the player view: the card's top opens the panel.
  'yandexMusic.player.focus',
];

interface ViewTrack {
  id: string;
  title: string;
  artists: string;
  duration?: number;
  cover?: string;
  available: boolean;
}

/**
 * The player as a window sees it: the panel, the status bar and the mini player. The queue and
 * playback live in a PlayerCore. It runs here, with audio in the panel's webview, unless the
 * music plays elsewhere — in the macOS service or another window — and then this window is a
 * remote: commands go there and the core mirrors its state.
 */
export class Player implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'yandexMusic.player';

  private view?: vscode.WebviewView;
  private viewReady?: Promise<void>;
  private resolveReady?: () => void;

  readonly core: PlayerCore;
  /** Set while this window is a remote; commands are forwarded to where the music plays. */
  private remote?: RemoteLink;
  /** Starts the macOS player service and connects to it; unset where there is no service. */
  private startService?: () => Promise<void>;
  /**
   * The webview only allows audio after a click inside this window's panel;
   * clicks on the status bar or the card don't count.
   */
  private unlocked = false;
  private gestureHintShown = false;
  private lastTooltip?: string;
  /** Cover of the current track for the status bar card, as a data: URI fetched once per track. */
  private cardCover?: { url: string; data?: string };

  private readonly prevItem: vscode.StatusBarItem;
  private readonly playItem: vscode.StatusBarItem;
  private readonly nextItem: vscode.StatusBarItem;
  private readonly statusItem: vscode.StatusBarItem;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the track, queue, like or playback status changes. */
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];
  /** The "Yandex Music" channel in the Output panel. */
  readonly log = vscode.window.createOutputChannel('Yandex Music', { log: true });
  private readonly extensionUri: vscode.Uri;

  constructor(extensionUri: vscode.Uri, clientFactory: () => Promise<YandexMusicClient>) {
    this.extensionUri = extensionUri;
    const webviewAudio: AudioOutput = {
      load: async (url, trackId, position) => {
        await this.ensureView();
        this.post({ type: 'load', url, trackId, autoplay: true, position });
      },
      toggle: () => void this.ensureView().then(() => this.post({ type: 'toggle' })),
      seek: (seconds) => this.post({ type: 'seek', value: seconds }),
      setVolume: (value) => this.post({ type: 'volume', value }),
    };
    this.core = new PlayerCore(
      {
        client: clientFactory,
        quality: () => vscode.workspace.getConfiguration('yandexMusic').get<'high' | 'low'>('quality', 'high'),
        log: this.log,
        notice: (text) => vscode.window.setStatusBarMessage(text, 4000),
      },
      webviewAudio,
    );
    this.disposables.push({ dispose: this.core.onDidChange(() => this.render()) });

    const item = (id: string, priority: number, command: string, text: string, tooltip: string) => {
      const i = vscode.window.createStatusBarItem(`yandexMusic.${id}`, vscode.StatusBarAlignment.Left, priority);
      i.name = `Yandex Music: ${tooltip}`;
      i.command = command;
      i.text = text;
      i.tooltip = tooltip;
      return i;
    };
    // The built-in Problems item sits on the left at priority 50, so the player items use
    // a narrow fractional range just above it to keep anything from landing between them.
    this.prevItem = item('prev', 50.04, 'yandexMusic.previous', '$(chevron-left)', 'Previous track');
    this.playItem = item('play', 50.03, 'yandexMusic.playPause', '$(play)', 'Play / Pause');
    this.nextItem = item('next', 50.02, 'yandexMusic.next', '$(chevron-right)', 'Next track');
    this.statusItem = item('track', 50.01, 'yandexMusic.showCard', '$(music) Yandex Music', 'Yandex Music');
    this.updateStatusBar();
    this.statusItem.show();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('yandexMusic.volume')) {
          void this.setVolume(this.volume()).catch(() => undefined);
          this.post({ type: 'volume', value: this.volume() });
        }
      }),
      // The status bar card has its colors baked into SVG, so it must be redrawn on theme change.
      vscode.window.onDidChangeActiveColorTheme(() => this.updateStatusBar()),
    );
  }

  dispose(): void {
    [this.prevItem, this.playItem, this.nextItem, this.statusItem, this.changed, this.log].forEach((d) => d.dispose());
    this.disposables.forEach((d) => d.dispose());
  }

  private volume(): number {
    return vscode.workspace.getConfiguration('yandexMusic').get<number>('volume', 0.7);
  }

  /** On macOS: commands that need audio first start the player service and then go to it. */
  useService(start: () => Promise<void>): void {
    this.startService = start;
  }

  // ---------------------------------------------------------------- commands

  /** Runs a player command where the music plays: in the service, in the leader window or here. */
  private async run(method: RemoteMethod, args: unknown[]): Promise<any> {
    if (!this.remote && this.startService && AUDIO_METHODS.has(method)) {
      try {
        await this.startService();
      } catch (e) {
        this.log.warn(`Service: couldn't start, playing in this window: ${errorText(e)}`);
      }
    }
    if (this.remote) {
      return this.remote.call(method, args);
    }
    const local = this.core[method] as (...a: unknown[]) => Promise<unknown>;
    return local.apply(this.core, args);
  }

  playSource(source: Source): Promise<void> {
    return this.run('playSource', [source]);
  }
  playTracks(tracks: Track[], index: number, source: Source): Promise<void> {
    return this.run('playTracks', [tracks, index, source]);
  }
  playIndex(index: number, startAt = 0): Promise<void> {
    return this.run('playIndex', [index, startAt]);
  }
  playPause(): Promise<void> {
    return this.run('playPause', []);
  }
  next(auto = false): Promise<void> {
    return this.run('next', [auto]);
  }
  previous(): Promise<void> {
    return this.run('previous', []);
  }
  seek(seconds: number): Promise<void> {
    return this.run('seek', [seconds]);
  }
  setVolume(value: number): Promise<void> {
    return this.run('setVolume', [value]);
  }
  toggleLike(): Promise<boolean | undefined> {
    return this.run('toggleLike', []);
  }
  search(query: string): Promise<Track[]> {
    return this.run('search', [query]);
  }
  loadPlaylists(): Promise<Playlist[]> {
    return this.run('loadPlaylists', []);
  }
  refreshAccount(): Promise<Account | undefined> {
    return this.run('refreshAccount', []);
  }

  /** Queues My Vibe on startup without playing it, unless the music already plays elsewhere. */
  async preloadWave(): Promise<void> {
    if (!this.remote) {
      await this.core.preloadWave();
    }
  }

  getStatus() {
    return this.core.getStatus();
  }

  // ---------------------------------------------------------------- remote mode

  get isRemote(): boolean {
    return !!this.remote;
  }

  /** Makes this window a remote of `link`, or a standalone player again with `undefined`. */
  setRemote(link: RemoteLink | undefined): void {
    this.remote = link;
    if (link) {
      this.core.loadedTrackId = undefined;
      this.post({ type: 'pause' });
    } else {
      this.core.audioUnlocked = this.unlocked;
      this.core.applyPlaybackStatus({ ...this.core.status, playing: false, needsGesture: false });
    }
    this.render();
  }

  /**
   * Makes this window the leader. With `resume`, playback continues from where it
   * left off; without it, the window only takes over the queue and position.
   */
  async takeOver(resume = true): Promise<void> {
    if (!this.remote) {
      return;
    }
    const { playing, position } = this.core.status;
    this.setRemote(undefined);
    if (resume && playing && this.core.current()) {
      await this.core.playIndex(this.core.index, position);
    }
  }

  /** Stops audio in this window when another window becomes the leader. */
  releaseAudio(): void {
    this.post({ type: 'pause' });
    this.core.releaseAudio();
  }

  get playbackStatus(): PlaybackStatus {
    return this.core.status;
  }

  sharedState(): SharedState {
    return this.core.sharedState();
  }

  applySharedState(s: SharedState): void {
    this.core.applySharedState(s);
  }

  applyPlaybackStatus(status: PlaybackStatus): void {
    this.core.applyPlaybackStatus(status);
    this.post({ type: 'progress', status });
  }

  /**
   * Whether a command from this window should start audio here: yes if audio is unlocked
   * in this window's panel, or if it isn't unlocked in the leader either (then the prompt
   * to click shows up here, where the user can see it).
   */
  get shouldPlayHere(): boolean {
    return this.unlocked || !this.core.audioUnlocked;
  }

  // ---------------------------------------------------------------- webview

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.viewReady = new Promise((r) => (this.resolveReady = r));
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    this.disposables.push(
      view.webview.onDidReceiveMessage((m) => this.onMessage(m)),
      view.onDidDispose(() => {
        this.view = undefined;
        this.viewReady = undefined;
        this.unlocked = false;
        if (!this.remote) {
          this.core.audioUnlocked = false;
          this.core.releaseAudio();
        }
      }),
    );
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'player.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'player.js'));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `media-src https: http://127.0.0.1:* http://localhost:* blob:`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Yandex Music</title>
</head>
<body>
<div id="app"></div>
<audio id="audio" preload="auto"></audio>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  private async ensureView(): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand(`${Player.viewId}.focus`, { preserveFocus: true });
    }
    for (let i = 0; i < 50 && !this.viewReady; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.viewReady;
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private async onMessage(m: any): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          this.resolveReady?.();
          this.post({ type: 'volume', value: this.volume() });
          this.pushState();
          if (!this.core.accountChecked) {
            void this.refreshAccount();
          }
          break;
        // Events from this window's <audio>; it only plays while the window isn't a remote.
        case 'status':
          if (!this.remote) {
            this.core.audioStatus({ playing: !!m.playing, position: m.position ?? 0, duration: m.duration ?? 0, needsGesture: !!m.needsGesture });
          }
          break;
        case 'ended':
          if (!this.remote) {
            await this.core.audioEnded();
          }
          break;
        case 'mediaError':
          if (!this.remote) {
            this.core.audioError(m.message);
            this.showError(this.core.lastError);
          }
          break;
        case 'needsGesture':
          if (!this.remote) {
            this.core.audioNeedsGesture();
            this.view?.show(false);
            if (!this.gestureHintShown) {
              this.gestureHintShown = true;
              vscode.window.setStatusBarMessage('Yandex Music: click "▶ Enable sound" in the player panel (needed once per session)', 8000);
            }
          }
          break;
        case 'audioUnlocked':
          this.unlocked = true;
          if (!this.remote) {
            this.core.audioUnlocked = true;
          }
          this.changed.fire();
          break;
        case 'volume':
          await vscode.workspace.getConfiguration('yandexMusic').update('volume', m.value, vscode.ConfigurationTarget.Global);
          break;
        case 'command':
          await vscode.commands.executeCommand(m.command, ...(m.args ?? []));
          break;
        case 'playIndex':
          await this.playIndex(m.index);
          break;
        case 'playSearchResult':
          await this.playTracks([...this.core.searchResults], m.index, { kind: 'search', query: m.query });
          break;
        case 'seekTo':
          await this.seek(m.value);
          break;
        case 'search':
          await this.search(m.query);
          break;
        case 'openPlaylist': {
          const p = this.core.playlists.find((x) => `${x.uid}:${x.kind}` === m.id);
          if (p) {
            await this.playSource({ kind: 'playlist', playlist: p });
          }
          break;
        }
        case 'loadPlaylists':
          await this.loadPlaylists();
          break;
      }
    } catch (e) {
      this.showError(e);
    }
  }

  private render(): void {
    this.pushState();
    this.updateStatusBar();
  }

  private pushState(): void {
    const c = this.core;
    const current = c.current();
    this.post({
      type: 'state',
      signedOut: c.accountChecked && !c.account,
      account: c.account ? { login: c.account.login, name: c.account.displayName, hasPlus: c.account.hasPlus } : null,
      current: current ? this.viewTrack(current) : null,
      liked: current ? c.liked.has(baseId(current.id)) : false,
      queue: c.queue.map((t) => this.viewTrack(t)),
      index: c.index,
      source: sourceLabel(c.source),
      sourceShort: shortSourceLabel(c.source),
      playlists: c.playlists.map((p) => ({ id: `${p.uid}:${p.kind}`, title: p.title, count: p.trackCount })),
      searchResults: c.searchResults.map((t) => this.viewTrack(t)),
      error: c.lastError ?? null,
      remote: !!this.remote,
      status: c.status,
    });
    this.changed.fire();
  }

  private viewTrack(t: Track): ViewTrack {
    return { id: t.id, title: fullTitle(t), artists: artistLine(t), duration: t.durationMs, cover: coverUrl(t.coverUri, 200), available: t.available !== false };
  }

  // ---------------------------------------------------------------- status bar

  private updateStatusBar(): void {
    const c = this.core;
    const t = c.current();
    let text = '$(music) Yandex Music';
    if (!t) {
      [this.prevItem, this.playItem, this.nextItem].forEach((i) => i.hide());
    } else {
      // Picked but not playing yet and its length still unknown: the stream is loading.
      const loading = c.status.trackId === t.id && !c.status.playing && !c.status.duration;
      this.playItem.text = loading ? '$(loading~spin)' : c.status.playing ? '$(debug-pause)' : '$(play)';
      this.playItem.tooltip = c.status.playing ? 'Pause' : 'Play';
      const label = `${artistLine(t)} — ${fullTitle(t)}`;
      const liked = c.liked.has(baseId(t.id));
      text = `${liked ? '$(heart-filled)' : '$(music)'} ${label.length > 45 ? label.slice(0, 44) + '…' : label}`;
      [this.prevItem, this.playItem, this.nextItem].forEach((i) => i.show());
    }
    // Setting any property on a status bar item also resends its markdown tooltip to VS Code,
    // which rebuilds the card if it's open. So the track item is only updated
    // when its text or card has actually changed.
    const card = this.hoverCard(t);
    if (text !== this.statusItem.text) {
      this.statusItem.text = text;
    }
    if (card.value !== this.lastTooltip) {
      this.lastTooltip = card.value;
      this.statusItem.tooltip = card;
    }
  }

  /** Cover for the card. While it loads, the card renders with a placeholder and is redrawn afterwards. */
  private cardCoverFor(t: Track): string | undefined {
    const url = coverUrl(t.coverUri, 200);
    if (!url) {
      return undefined;
    }
    if (this.cardCover?.url !== url) {
      const entry: { url: string; data?: string } = { url };
      this.cardCover = entry;
      fetch(url)
        .then(async (r) => {
          if (!r.ok) {
            return;
          }
          const type = r.headers.get('content-type') ?? 'image/jpeg';
          entry.data = `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
          if (this.cardCover === entry) {
            this.updateStatusBar();
          }
        })
        .catch(() => undefined);
    }
    return this.cardCover.data;
  }

  /** Mini player: the track card in the status bar, shown on hover and on click. */
  private hoverCard(t: Track | undefined): vscode.MarkdownString {
    const c = this.core;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: CARD_COMMANDS };
    md.supportHtml = true;
    if (t) {
      md.appendMarkdown(
        renderCard({
          title: fullTitle(t),
          artists: artistLine(t),
          cover: this.cardCoverFor(t),
          source: sourceLabel(c.source),
          details: [fmtTime((t.durationMs ?? 0) / 1000), c.streamInfo].filter((x): x is string => !!x),
          playing: c.status.playing,
          liked: c.liked.has(baseId(t.id)),
        }),
      );
    } else {
      md.appendMarkdown('**Yandex Music**\n\n');
      md.appendMarkdown(c.account ? `[$(pulse) My Vibe](command:yandexMusic.playMyWave)` : `[$(account) Sign in](command:yandexMusic.signIn)`);
    }
    return md;
  }

  showError(e: unknown): void {
    this.core.lastError = errorText(e);
    this.pushState();
    void vscode.window.showErrorMessage(`Yandex Music: ${this.core.lastError}`);
  }
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) {
    return '0:00';
  }
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}
