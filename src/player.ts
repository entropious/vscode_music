import * as vscode from 'vscode';
import { Account, Playlist, Track, YandexMusicClient, artistLine, coverUrl, fullTitle } from './api';

export type Source = { kind: 'wave' } | { kind: 'liked' } | { kind: 'playlist'; playlist: Playlist } | { kind: 'search'; query: string };

export interface PlaybackStatus {
  playing: boolean;
  position: number;
  duration: number;
  trackId?: string;
  error?: string;
  /** Webview ждёт первого клика пользователя, чтобы начать звук. */
  needsGesture?: boolean;
}

const CARD_COMMANDS = [
  'yandexMusic.previous',
  'yandexMusic.playPause',
  'yandexMusic.next',
  'yandexMusic.like',
  'yandexMusic.playMyWave',
  'yandexMusic.playLiked',
  'yandexMusic.playPlaylist',
  'yandexMusic.search',
  'yandexMusic.signIn',
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
 * Управляет очередью, общается с API и webview, в котором живёт <audio>.
 */
export class Player implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'yandexMusic.player';

  private view?: vscode.WebviewView;
  private viewReady?: Promise<void>;
  private resolveReady?: () => void;

  private queue: Track[] = [];
  private index = -1;
  private source?: Source;
  private liked = new Set<string>();
  private playlists: Playlist[] = [];
  private searchResults: Track[] = [];
  private account?: Account;
  private status: PlaybackStatus = { playing: false, position: 0, duration: 0 };
  private loadingMore = false;
  private lastError?: string;
  private gestureHintShown = false;
  /** Кодек и битрейт текущего потока, например «MP3 320 кбит/с». */
  private streamInfo?: string;
  private lastTooltip?: string;

  private readonly prevItem: vscode.StatusBarItem;
  private readonly playItem: vscode.StatusBarItem;
  private readonly nextItem: vscode.StatusBarItem;
  private readonly statusItem: vscode.StatusBarItem;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Срабатывает при смене трека, очереди, лайка или статуса воспроизведения. */
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly clientFactory: () => Promise<YandexMusicClient>,
  ) {
    const item = (id: string, priority: number, command: string, text: string, tooltip: string) => {
      const i = vscode.window.createStatusBarItem(`yandexMusic.${id}`, vscode.StatusBarAlignment.Left, priority);
      i.name = `Яндекс Музыка: ${tooltip}`;
      i.command = command;
      i.text = text;
      i.tooltip = tooltip;
      return i;
    };
    this.prevItem = item('prev', 53, 'yandexMusic.previous', '$(chevron-left)', 'Предыдущий трек');
    this.playItem = item('play', 52, 'yandexMusic.playPause', '$(play)', 'Play / Pause');
    this.nextItem = item('next', 51, 'yandexMusic.next', '$(chevron-right)', 'Следующий трек');
    this.statusItem = item('track', 50, 'yandexMusic.showCard', '$(music) Яндекс Музыка', 'Яндекс Музыка');
    this.updateStatusBar();
    this.statusItem.show();
  }

  dispose(): void {
    [this.prevItem, this.playItem, this.nextItem, this.statusItem, this.changed].forEach((d) => d.dispose());
    this.disposables.forEach((d) => d.dispose());
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
        this.status = { ...this.status, playing: false };
        this.updateStatusBar();
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
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Яндекс Музыка</title>
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
          this.post({ type: 'volume', value: vscode.workspace.getConfiguration('yandexMusic').get<number>('volume', 0.7) });
          this.pushState();
          if (this.account === undefined) {
            void this.refreshAccount();
          }
          break;
        case 'status':
          this.status = { playing: !!m.playing, position: m.position ?? 0, duration: m.duration ?? 0, trackId: m.trackId, needsGesture: !!m.needsGesture };
          this.updateStatusBar();
          break;
        case 'ended':
          await this.next(true);
          break;
        case 'mediaError':
          this.showError(`Не удалось воспроизвести трек: ${m.message}`);
          this.status = { ...this.status, playing: false, error: m.message };
          this.updateStatusBar();
          break;
        case 'needsGesture':
          this.status = { ...this.status, playing: false, needsGesture: true };
          this.updateStatusBar();
          this.view?.show(false);
          if (!this.gestureHintShown) {
            this.gestureHintShown = true;
            vscode.window.setStatusBarMessage('Яндекс Музыка: нажмите «▶ Включить звук» в панели плеера (нужно один раз за сессию)', 8000);
          }
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
          this.source = { kind: 'search', query: m.query };
          this.queue = [...this.searchResults];
          await this.playIndex(m.index);
          break;
        case 'search':
          await this.search(m.query);
          break;
        case 'openPlaylist': {
          const p = this.playlists.find((x) => `${x.uid}:${x.kind}` === m.id);
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

  private pushState(): void {
    const current = this.current();
    this.post({
      type: 'state',
      account: this.account ? { login: this.account.login, name: this.account.displayName, hasPlus: this.account.hasPlus } : null,
      current: current ? this.viewTrack(current) : null,
      liked: current ? this.liked.has(baseId(current.id)) : false,
      queue: this.queue.map((t) => this.viewTrack(t)),
      index: this.index,
      source: this.sourceLabel(),
      playlists: this.playlists.map((p) => ({ id: `${p.uid}:${p.kind}`, title: p.title, count: p.trackCount })),
      searchResults: this.searchResults.map((t) => this.viewTrack(t)),
      error: this.lastError ?? null,
    });
  }

  private viewTrack(t: Track): ViewTrack {
    return { id: t.id, title: fullTitle(t), artists: artistLine(t), duration: t.durationMs, cover: coverUrl(t.coverUri, 200), available: t.available !== false };
  }

  private sourceLabel(): string {
    switch (this.source?.kind) {
      case 'wave':
        return 'Моя волна';
      case 'liked':
        return 'Мне нравится';
      case 'playlist':
        return `Плейлист «${this.source.playlist.title}»`;
      case 'search':
        return `Поиск: ${this.source.query}`;
      default:
        return '';
    }
  }

  // ---------------------------------------------------------------- account

  async refreshAccount(): Promise<Account | undefined> {
    const client = await this.clientFactory();
    this.liked.clear();
    this.playlists = [];
    if (!client.authorized) {
      this.account = undefined;
      this.pushState();
      this.updateStatusBar();
      return undefined;
    }
    try {
      this.account = await client.accountStatus();
      this.lastError = undefined;
      const likedIds = await client.likedTrackIds(this.account.uid).catch(() => []);
      likedIds.forEach((id) => this.liked.add(baseId(id)));
    } catch (e) {
      this.account = undefined;
      this.lastError = errorText(e);
    }
    this.pushState();
    this.updateStatusBar();
    return this.account;
  }

  private async requireAccount(): Promise<Account> {
    if (!this.account) {
      await this.refreshAccount();
    }
    if (!this.account) {
      throw new Error(this.lastError ?? 'Сначала войдите в аккаунт Яндекса (команда «Яндекс Музыка: Войти в аккаунт»)');
    }
    return this.account;
  }

  // ---------------------------------------------------------------- sources

  async playSource(source: Source): Promise<void> {
    const client = await this.clientFactory();
    let tracks: Track[];
    switch (source.kind) {
      case 'wave':
        await this.requireAccount();
        tracks = await client.myWave();
        break;
      case 'liked': {
        const acc = await this.requireAccount();
        tracks = await client.likedTracks(acc.uid);
        break;
      }
      case 'playlist':
        tracks = await client.playlistTracks(source.playlist.uid, source.playlist.kind);
        break;
      case 'search':
        tracks = await client.search(source.query);
        break;
    }
    tracks = tracks.filter((t) => t.available !== false);
    if (!tracks.length) {
      throw new Error(`Нет доступных треков: ${this.sourceLabelFor(source)}`);
    }
    this.source = source;
    this.queue = tracks;
    await this.playIndex(0);
  }

  private sourceLabelFor(s: Source): string {
    const prev = this.source;
    this.source = s;
    const label = this.sourceLabel();
    this.source = prev;
    return label;
  }

  async search(query: string): Promise<Track[]> {
    const client = await this.clientFactory();
    this.searchResults = await client.search(query);
    this.pushState();
    return this.searchResults;
  }

  async loadPlaylists(): Promise<Playlist[]> {
    const acc = await this.requireAccount();
    const client = await this.clientFactory();
    this.playlists = await client.playlists(acc.uid);
    this.pushState();
    return this.playlists;
  }

  async playTracks(tracks: Track[], index: number, source: Source): Promise<void> {
    this.source = source;
    this.queue = tracks;
    await this.playIndex(index);
  }

  // ---------------------------------------------------------------- playback

  current(): Track | undefined {
    return this.queue[this.index];
  }

  getStatus(): PlaybackStatus & { title?: string; queueLength: number; index: number; source: string } {
    const t = this.current();
    return { ...this.status, title: t ? `${artistLine(t)} — ${fullTitle(t)}` : undefined, queueLength: this.queue.length, index: this.index, source: this.sourceLabel() };
  }

  async playIndex(index: number): Promise<void> {
    const track = this.queue[index];
    if (!track) {
      return;
    }
    await this.ensureView();
    this.index = index;
    this.lastError = undefined;
    this.streamInfo = undefined;
    this.status = { playing: false, position: 0, duration: 0, trackId: track.id };
    this.pushState();
    this.updateStatusBar('$(loading~spin)');

    const client = await this.clientFactory();
    const quality = vscode.workspace.getConfiguration('yandexMusic').get<'high' | 'low'>('quality', 'high');
    const { url, preview, codec, bitrate } = await client.streamUrl(track.id, quality);
    if (this.current() !== track) {
      return; // пользователь уже переключил трек
    }
    this.streamInfo = `${codec.toUpperCase()} ${bitrate} кбит/с${preview ? ', фрагмент 30 с' : ''}`;
    if (preview) {
      vscode.window.setStatusBarMessage('Яндекс Музыка: без Плюса доступен только 30-секундный фрагмент', 5000);
    }
    this.post({ type: 'load', url, trackId: track.id, autoplay: true });

    if (this.source?.kind === 'wave' && this.queue.length - index <= 2) {
      void this.loadMoreWave();
    }
  }

  private async loadMoreWave(): Promise<void> {
    if (this.loadingMore) {
      return;
    }
    this.loadingMore = true;
    try {
      const client = await this.clientFactory();
      const known = new Set(this.queue.map((t) => baseId(t.id)));
      const more = (await client.myWave(this.current()?.id)).filter((t) => !known.has(baseId(t.id)) && t.available !== false);
      this.queue.push(...more);
      this.pushState();
    } catch {
      // not critical: попробуем ещё раз на следующем треке
    } finally {
      this.loadingMore = false;
    }
  }

  async playPause(): Promise<void> {
    if (this.index < 0) {
      await this.playSource(this.account ? { kind: 'wave' } : { kind: 'search', query: 'Хиты' });
      return;
    }
    await this.ensureView();
    this.post({ type: 'toggle' });
  }

  async next(auto = false): Promise<void> {
    if (this.index + 1 < this.queue.length) {
      await this.playIndex(this.index + 1);
    } else if (this.source?.kind === 'wave') {
      await this.loadMoreWave();
      await this.playIndex(this.index + 1);
    } else if (!auto && this.queue.length) {
      await this.playIndex(0);
    }
  }

  async previous(): Promise<void> {
    if (this.status.position > 3 || this.index === 0) {
      this.post({ type: 'seek', value: 0 });
      return;
    }
    await this.playIndex(Math.max(0, this.index - 1));
  }

  async toggleLike(): Promise<boolean | undefined> {
    const track = this.current();
    if (!track) {
      return undefined;
    }
    const acc = await this.requireAccount();
    const id = baseId(track.id);
    const like = !this.liked.has(id);
    const client = await this.clientFactory();
    await client.setLike(acc.uid, track.id, like);
    like ? this.liked.add(id) : this.liked.delete(id);
    this.pushState();
    this.updateStatusBar();
    vscode.window.setStatusBarMessage(like ? `♥ Добавлено в «Мне нравится»` : 'Удалено из «Мне нравится»', 3000);
    return like;
  }

  private updateStatusBar(icon?: string): void {
    const t = this.current();
    let text = '$(music) Яндекс Музыка';
    if (!t) {
      [this.prevItem, this.playItem, this.nextItem].forEach((i) => i.hide());
    } else {
      this.playItem.text = icon ?? (this.status.playing ? '$(debug-pause)' : '$(play)');
      this.playItem.tooltip = this.status.playing ? 'Пауза' : 'Играть';
      const label = `${artistLine(t)} — ${fullTitle(t)}`;
      const liked = this.liked.has(baseId(t.id));
      text = `${liked ? '$(heart-filled)' : '$(music)'} ${label.length > 45 ? label.slice(0, 44) + '…' : label}`;
      [this.prevItem, this.playItem, this.nextItem].forEach((i) => i.show());
    }
    // Любое присваивание свойству элемента отправляет в VS Code и markdown-tooltip,
    // а он при этом пересоздаёт открытую карточку. Поэтому элемент трека
    // обновляется только когда его текст или карточка действительно изменились.
    const card = this.hoverCard(t);
    if (text !== this.statusItem.text) {
      this.statusItem.text = text;
    }
    if (card.value !== this.lastTooltip) {
      this.lastTooltip = card.value;
      this.statusItem.tooltip = card;
    }
    this.changed.fire();
  }

  /** Мини-плеер: карточка трека в статус-баре, показывается при наведении и по клику. */
  private hoverCard(t: Track | undefined): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: CARD_COMMANDS };
    md.supportHtml = true;
    if (t) {
      const liked = this.liked.has(baseId(t.id));
      const cover = coverUrl(t.coverUri, 100);
      if (cover) {
        md.appendMarkdown(`<img src="${cover}" width="64" height="64"/>\n\n`);
      }
      md.appendMarkdown(`**${escapeMd(fullTitle(t))}**  \n${escapeMd(artistLine(t))}  \n`);
      const details = [this.sourceLabel(), fmtTime((t.durationMs ?? 0) / 1000), this.streamInfo].filter(Boolean).map((s) => escapeMd(s!));
      md.appendMarkdown(`*${details.join(' · ')}*\n\n`);
      // В заголовке ссылки и иконки крупнее: инлайн-стили размера hover не пропускает.
      md.appendMarkdown(
        '# ' +
        [
          `[$(chevron-left)](command:yandexMusic.previous "Предыдущий")`,
          this.status.playing ? `[$(debug-pause)](command:yandexMusic.playPause "Пауза")` : `[$(play)](command:yandexMusic.playPause "Играть")`,
          `[$(chevron-right)](command:yandexMusic.next "Следующий")`,
          liked ? `[$(heart-filled)](command:yandexMusic.like "Убрать из «Мне нравится»")` : `[$(heart)](command:yandexMusic.like "Нравится")`,
        ].join('&nbsp;&nbsp;&nbsp;') + '\n\n',
      );
    } else {
      md.appendMarkdown('**Яндекс Музыка**\n\n');
    }
    md.appendMarkdown('---\n\n');
    const links = this.account
      ? [
          `[$(pulse) Моя волна](command:yandexMusic.playMyWave)`,
          `[$(heart-filled) Мне нравится](command:yandexMusic.playLiked)`,
          `[$(list-unordered) Плейлист…](command:yandexMusic.playPlaylist)`,
        ]
      : [`[$(account) Войти](command:yandexMusic.signIn)`];
    links.push(`[$(search) Поиск…](command:yandexMusic.search)`, `[$(layout-sidebar-left) Панель](command:yandexMusic.player.focus "Очередь, плейлисты, громкость")`);
    md.appendMarkdown(links.join('&nbsp;&nbsp;·&nbsp;&nbsp;'));
    return md;
  }

  showError(e: unknown): void {
    this.lastError = errorText(e);
    this.pushState();
    void vscode.window.showErrorMessage(`Яндекс Музыка: ${this.lastError}`);
  }
}

export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) {
    return '0:00';
  }
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}

export function baseId(id: string): string {
  return id.split(':')[0];
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
