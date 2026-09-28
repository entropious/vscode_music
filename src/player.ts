import * as vscode from 'vscode';
import { Account, Playlist, Track, YandexMusicClient, artistLine, coverUrl, fullTitle } from './api';
import { renderCard } from './card';

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

/** Методы плеера, которые окно-пульт выполняет в ведущем окне. */
export const REMOTE_METHODS = [
  'playSource',
  'playTracks',
  'playIndex',
  'playPause',
  'next',
  'previous',
  'toggleLike',
  'seek',
  'search',
  'loadPlaylists',
  'refreshAccount',
] as const;
export type RemoteMethod = (typeof REMOTE_METHODS)[number];

/** Связь окна-пульта с ведущим окном, в котором играет звук. */
export interface RemoteLink {
  call(method: RemoteMethod, args: unknown[]): Promise<any>;
}

/** Всё, что окно-пульт показывает вслед за ведущим, кроме статуса воспроизведения. */
export interface SharedState {
  queue: Track[];
  index: number;
  source?: Source;
  liked: string[];
  playlists: Playlist[];
  searchResults: Track[];
  account?: Account;
  lastError?: string;
  streamInfo?: string;
  /** В панели ведущего окна звук разрешён. */
  audioUnlocked: boolean;
}

const CARD_COMMANDS = [
  'yandexMusic.previous',
  'yandexMusic.playPause',
  'yandexMusic.next',
  'yandexMusic.like',
  'yandexMusic.playMyWave',
  'yandexMusic.signIn',
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
  /** Статус аккаунта уже известен: без этого панель мигала бы экраном входа при запуске. */
  private accountChecked = false;
  private status: PlaybackStatus = { playing: false, position: 0, duration: 0 };
  private loadingMore = false;
  private lastError?: string;
  private gestureHintShown = false;
  /** Кодек и битрейт текущего потока, например «MP3 320 кбит/с». */
  private streamInfo?: string;
  private lastTooltip?: string;
  /** Обложка текущего трека для карточки в статус-баре: data:-адрес, загружается один раз на трек. */
  private cardCover?: { url: string; data?: string };
  /** Трек, чей поток отдан в webview; у предзагруженной волны его ещё нет. */
  private loadedTrackId?: string;
  /** Задана, пока окно — пульт: команды уходят ведущему окну. */
  private remote?: RemoteLink;
  /**
   * Webview даёт играть звуку только после нажатия внутри панели этого окна;
   * клики по статус-бару или карточке не в счёт.
   */
  private unlocked = false;
  private leaderUnlocked = false;

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
    // Встроенный «Problems» стоит слева с приоритетом 50, поэтому элементы плеера
    // занимают узкий дробный диапазон чуть выше, чтобы между ними ничего не вставало.
    this.prevItem = item('prev', 50.04, 'yandexMusic.previous', '$(chevron-left)', 'Предыдущий трек');
    this.playItem = item('play', 50.03, 'yandexMusic.playPause', '$(play)', 'Play / Pause');
    this.nextItem = item('next', 50.02, 'yandexMusic.next', '$(chevron-right)', 'Следующий трек');
    this.statusItem = item('track', 50.01, 'yandexMusic.showCard', '$(music) Яндекс Музыка', 'Яндекс Музыка');
    this.updateStatusBar();
    this.statusItem.show();
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('yandexMusic.volume')) {
          this.post({ type: 'volume', value: vscode.workspace.getConfiguration('yandexMusic').get<number>('volume', 0.7) });
        }
      }),
      // Цвета карточки в статус-баре зашиты в SVG, поэтому при смене темы её надо перерисовать.
      vscode.window.onDidChangeActiveColorTheme(() => this.updateStatusBar()),
    );
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
        this.loadedTrackId = undefined;
        this.unlocked = false;
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
        case 'audioUnlocked':
          this.unlocked = true;
          this.changed.fire();
          break;
        case 'command':
          await vscode.commands.executeCommand(m.command, ...(m.args ?? []));
          break;
        case 'playIndex':
          await this.playIndex(m.index);
          break;
        case 'playSearchResult':
          await this.playTracks([...this.searchResults], m.index, { kind: 'search', query: m.query });
          break;
        case 'seekTo':
          await this.seek(m.value);
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
      signedOut: this.accountChecked && !this.account,
      account: this.account ? { login: this.account.login, name: this.account.displayName, hasPlus: this.account.hasPlus } : null,
      current: current ? this.viewTrack(current) : null,
      liked: current ? this.liked.has(baseId(current.id)) : false,
      queue: this.queue.map((t) => this.viewTrack(t)),
      index: this.index,
      source: this.sourceLabel(),
      sourceShort: this.shortSourceLabel(),
      playlists: this.playlists.map((p) => ({ id: `${p.uid}:${p.kind}`, title: p.title, count: p.trackCount })),
      searchResults: this.searchResults.map((t) => this.viewTrack(t)),
      error: this.lastError ?? null,
      remote: !!this.remote,
      status: this.status,
    });
    this.changed.fire();
  }

  // ---------------------------------------------------------------- sync between windows

  /** Переводит окно в режим пульта: команды уходят ведущему окну, звук здесь не играет. */
  setRemote(link: RemoteLink): void {
    this.remote = link;
    this.loadedTrackId = undefined;
    this.post({ type: 'pause' });
    this.pushState();
  }

  /**
   * Окно становится ведущим. С `resume` продолжает воспроизведение с того места,
   * где оно было; без него только принимает очередь и позицию.
   */
  async takeOver(resume = true): Promise<void> {
    if (!this.remote) {
      return;
    }
    this.remote = undefined;
    const { playing, position } = this.status;
    this.status = { ...this.status, playing: false, needsGesture: false };
    this.pushState();
    this.updateStatusBar();
    if (resume && playing && this.current()) {
      await this.playIndex(this.index, position);
    }
  }

  /** Останавливает звук в этом окне, когда роль ведущего переходит другому окну. */
  releaseAudio(): void {
    this.post({ type: 'pause' });
    this.loadedTrackId = undefined;
  }

  get playbackStatus(): PlaybackStatus {
    return this.status;
  }

  sharedState(): SharedState {
    return {
      queue: this.queue,
      index: this.index,
      source: this.source,
      liked: [...this.liked],
      playlists: this.playlists,
      searchResults: this.searchResults,
      account: this.account,
      lastError: this.lastError,
      streamInfo: this.streamInfo,
      audioUnlocked: this.unlocked,
    };
  }

  /**
   * Где запускать звук по команде из этого окна: здесь, если в панели этого окна звук
   * разрешён или если он не разрешён и в ведущем (тогда просьба нажать появится тут, на глазах).
   */
  get shouldPlayHere(): boolean {
    return this.unlocked || !this.leaderUnlocked;
  }

  applySharedState(s: SharedState): void {
    this.queue = s.queue;
    this.index = s.index;
    this.source = s.source;
    this.liked = new Set(s.liked);
    this.playlists = s.playlists;
    this.searchResults = s.searchResults;
    this.account = s.account;
    this.accountChecked = true;
    this.lastError = s.lastError;
    this.streamInfo = s.streamInfo;
    this.leaderUnlocked = s.audioUnlocked;
    this.pushState();
    this.updateStatusBar();
  }

  applyPlaybackStatus(status: PlaybackStatus): void {
    this.status = status;
    this.post({ type: 'progress', status });
    this.updateStatusBar();
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

  /** Подпись источника для узкой панели плеера. */
  private shortSourceLabel(): string {
    switch (this.source?.kind) {
      case 'wave':
        return 'Волна';
      case 'liked':
        return 'Лайки';
      case 'playlist':
        return this.source.playlist.title;
      case 'search':
        return this.source.query;
      default:
        return '';
    }
  }

  // ---------------------------------------------------------------- account

  async refreshAccount(): Promise<Account | undefined> {
    if (this.remote) {
      return this.remote.call('refreshAccount', []);
    }
    const client = await this.clientFactory();
    this.liked.clear();
    this.playlists = [];
    if (!client.authorized) {
      this.account = undefined;
      this.accountChecked = true;
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
    this.accountChecked = true;
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
    if (this.remote) {
      return this.remote.call('playSource', [source]);
    }
    const tracks = await this.fetchSource(source);
    this.source = source;
    this.queue = tracks;
    await this.playIndex(0);
  }

  /**
   * На старте ставит в очередь «Мою волну» без воспроизведения: первый трек
   * виден в статус-баре, звук загружается по первому нажатию play.
   */
  async preloadWave(): Promise<void> {
    if (this.remote || this.index >= 0 || !(await this.refreshAccount())) {
      return;
    }
    const source: Source = { kind: 'wave' };
    const tracks = await this.fetchSource(source);
    if (this.index >= 0) {
      return; // пока грузили, пользователь уже что-то включил
    }
    this.source = source;
    this.queue = tracks;
    this.index = 0;
    this.status = { playing: false, position: 0, duration: 0 };
    this.pushState();
    this.updateStatusBar();
  }

  private async fetchSource(source: Source): Promise<Track[]> {
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
    return tracks;
  }

  private sourceLabelFor(s: Source): string {
    const prev = this.source;
    this.source = s;
    const label = this.sourceLabel();
    this.source = prev;
    return label;
  }

  async search(query: string): Promise<Track[]> {
    if (this.remote) {
      return this.remote.call('search', [query]);
    }
    const client = await this.clientFactory();
    this.searchResults = await client.search(query);
    this.pushState();
    return this.searchResults;
  }

  async loadPlaylists(): Promise<Playlist[]> {
    if (this.remote) {
      return this.remote.call('loadPlaylists', []);
    }
    const acc = await this.requireAccount();
    const client = await this.clientFactory();
    this.playlists = await client.playlists(acc.uid);
    this.pushState();
    return this.playlists;
  }

  async playTracks(tracks: Track[], index: number, source: Source): Promise<void> {
    if (this.remote) {
      return this.remote.call('playTracks', [tracks, index, source]);
    }
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

  async playIndex(index: number, startAt = 0): Promise<void> {
    if (this.remote) {
      return this.remote.call('playIndex', [index, startAt]);
    }
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
    this.post({ type: 'load', url, trackId: track.id, autoplay: true, position: startAt });
    this.loadedTrackId = track.id;

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
    if (this.remote) {
      return this.remote.call('playPause', []);
    }
    if (this.index < 0) {
      await this.playSource(this.account ? { kind: 'wave' } : { kind: 'search', query: 'Хиты' });
      return;
    }
    if (this.loadedTrackId !== this.current()?.id) {
      await this.playIndex(this.index, this.status.position);
      return;
    }
    await this.ensureView();
    this.post({ type: 'toggle' });
  }

  async next(auto = false): Promise<void> {
    if (this.remote) {
      return this.remote.call('next', [auto]);
    }
    if (this.index + 1 < this.queue.length) {
      await this.playIndex(this.index + 1);
    } else if (this.source?.kind === 'wave') {
      await this.loadMoreWave();
      await this.playIndex(this.index + 1);
    } else if (!auto && this.queue.length) {
      await this.playIndex(0);
    }
  }

  async seek(seconds: number): Promise<void> {
    if (this.remote) {
      return this.remote.call('seek', [seconds]);
    }
    this.post({ type: 'seek', value: seconds });
  }

  async previous(): Promise<void> {
    if (this.remote) {
      return this.remote.call('previous', []);
    }
    const loaded = this.loadedTrackId === this.current()?.id;
    if (loaded && (this.status.position > 3 || this.index === 0)) {
      this.post({ type: 'seek', value: 0 });
      return;
    }
    await this.playIndex(Math.max(0, this.index - 1));
  }

  async toggleLike(): Promise<boolean | undefined> {
    if (this.remote) {
      return this.remote.call('toggleLike', []);
    }
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

  /** Обложка для карточки. Пока она грузится, карточка рисуется с заглушкой и потом обновляется. */
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

  /** Мини-плеер: карточка трека в статус-баре, показывается при наведении и по клику. */
  private hoverCard(t: Track | undefined): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: CARD_COMMANDS };
    md.supportHtml = true;
    if (t) {
      md.appendMarkdown(
        renderCard({
          title: fullTitle(t),
          artists: artistLine(t),
          cover: this.cardCoverFor(t),
          source: this.sourceLabel(),
          details: [fmtTime((t.durationMs ?? 0) / 1000), this.streamInfo].filter((x): x is string => !!x),
          playing: this.status.playing,
          liked: this.liked.has(baseId(t.id)),
        }),
      );
    } else {
      md.appendMarkdown('**Яндекс Музыка**\n\n');
      md.appendMarkdown(this.account ? `[$(pulse) Моя волна](command:yandexMusic.playMyWave)` : `[$(account) Войти](command:yandexMusic.signIn)`);
    }
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
