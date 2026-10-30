import type { Account, Playlist, Track, WaveBatch, WaveEvent, YandexMusicClient } from './api';
import { artistLine, fullTitle } from './api';
import type { SlopChecker } from './slop';

export type Source = { kind: 'wave' } | { kind: 'liked' } | { kind: 'playlist'; playlist: Playlist } | { kind: 'search'; query: string };

export interface PlaybackStatus {
  playing: boolean;
  position: number;
  duration: number;
  trackId?: string;
  error?: string;
  /** The webview needs a user click before it can start audio. */
  needsGesture?: boolean;
}

/** Player methods that a remote window runs where the music plays: the leader window or the service. */
export const REMOTE_METHODS = [
  'playSource',
  'playTracks',
  'playIndex',
  'playPause',
  'next',
  'previous',
  'toggleLike',
  'toggleDislike',
  'seek',
  'setVolume',
  'search',
  'loadPlaylists',
  'refreshAccount',
] as const;
export type RemoteMethod = (typeof REMOTE_METHODS)[number];

/** Methods that load or control audio; everything else only reads or changes the queue and account. */
/** How many tracks after the current one get AI marks ahead of time, so the queue shows them. */
const SLOP_LOOKAHEAD = 25;

export const AUDIO_METHODS =new Set<RemoteMethod>(['playSource', 'playTracks', 'playIndex', 'playPause', 'next', 'previous', 'seek']);

/**
 * What changed: `status` is only the playback status (position, playing, duration), which
 * updates several times a second; `state` is anything else — track, queue, account, likes.
 */
export type Change = 'state' | 'status';

/** Connection from a remote window to wherever the music plays. */
export interface RemoteLink {
  call(method: RemoteMethod, args: unknown[]): Promise<any>;
}

/** A My Vibe radio session in a form that survives JSON. */
export interface WaveSession {
  sessionId: string;
  /** Track ID → the batch it came from. */
  batches: [string, string | undefined][];
}

/** Everything a remote window mirrors from where the music plays, except playback status. */
export interface SharedState {
  queue: Track[];
  index: number;
  source?: Source;
  liked: string[];
  disliked: string[];
  playlists: Playlist[];
  searchResults: Track[];
  account?: Account;
  accountChecked: boolean;
  lastError?: string;
  streamInfo?: string;
  wave?: WaveSession;
  /** Track ID (without the album) → whether slopless.art considers the track AI-generated. */
  slop: Record<string, boolean>;
  /** Audio is unlocked in the leader window's panel. */
  audioUnlocked: boolean;
}

/** Where the audio actually plays: a webview's <audio> element or the macOS service's AVPlayer. */
export interface AudioOutput {
  /** Loads the stream and starts playing it from `position`. */
  load(url: string, trackId: string, position: number): Promise<void>;
  toggle(): void;
  seek(seconds: number): void;
  setVolume(value: number): void;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

export interface CoreHost {
  client(): Promise<YandexMusicClient>;
  quality(): 'high' | 'low';
  log: Logger;
  /** A short message for the user, e.g. that a track was liked. */
  notice(text: string): void;
  /** Marks AI-generated tracks; undefined while the yandexMusic.aiLabels setting is off. */
  slop(): SlopChecker | undefined;
}

export function sourceLabel(source: Source | undefined): string {
  switch (source?.kind) {
    case 'wave':
      return 'My Vibe';
    case 'liked':
      return 'Liked';
    case 'playlist':
      return `Playlist "${source.playlist.title}"`;
    case 'search':
      return `Search: ${source.query}`;
    default:
      return '';
  }
}

/** Source label for the narrow player panel. */
export function shortSourceLabel(source: Source | undefined): string {
  switch (source?.kind) {
    case 'wave':
      return 'Vibe';
    case 'liked':
      return 'Liked';
    case 'playlist':
      return source.playlist.title;
    case 'search':
      return source.query;
    default:
      return '';
  }
}

export function baseId(id: string): string {
  return id.split(':')[0];
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The player without any UI: the queue, the Yandex Music API, My Vibe sessions and playback
 * state. A window runs it with a webview for audio; the macOS service runs it with AVPlayer.
 */
export class PlayerCore {
  queue: Track[] = [];
  index = -1;
  source?: Source;
  liked = new Set<string>();
  disliked = new Set<string>();
  playlists: Playlist[] = [];
  searchResults: Track[] = [];
  account?: Account;
  /** Account status is known; without this the panel would flash the sign-in screen on startup. */
  accountChecked = false;
  status: PlaybackStatus = { playing: false, position: 0, duration: 0 };
  lastError?: string;
  /** Codec and bitrate of the current stream, e.g. MP3 at 320 kbps. */
  streamInfo?: string;
  audioUnlocked = false;
  slop: Record<string, boolean> = {};
  /** Tracks being looked up on slopless.art right now. */
  private readonly slopPending = new Set<string>();
  /** Track whose stream has been handed to the audio output; unset while My Vibe is only preloaded. */
  loadedTrackId?: string;

  private wave?: { sessionId: string; batches: Map<string, string | undefined> };
  /** Track that played to the end, so switching away from it isn't reported as a skip. */
  private finishedTrackId?: string;
  private loadingMore = false;
  private readonly listeners = new Set<(change: Change) => void>();
  private readonly host: CoreHost;
  audio: AudioOutput;

  constructor(host: CoreHost, audio: AudioOutput) {
    this.host = host;
    this.audio = audio;
  }

  /** Subscribes to changes of the queue, account or playback status; returns the unsubscribe function. */
  onDidChange(listener: (change: Change) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(change: Change = 'state'): void {
    this.listeners.forEach((l) => l(change));
  }

  current(): Track | undefined {
    return this.queue[this.index];
  }

  sharedState(): SharedState {
    return {
      queue: this.queue,
      index: this.index,
      source: this.source,
      liked: [...this.liked],
      disliked: [...this.disliked],
      playlists: this.playlists,
      searchResults: this.searchResults,
      account: this.account,
      accountChecked: this.accountChecked,
      lastError: this.lastError,
      streamInfo: this.streamInfo,
      wave: this.wave && { sessionId: this.wave.sessionId, batches: [...this.wave.batches] },
      slop: this.slop,
      audioUnlocked: this.audioUnlocked,
    };
  }

  applySharedState(s: SharedState): void {
    this.queue = s.queue;
    this.index = s.index;
    this.source = s.source;
    this.liked = new Set(s.liked);
    this.disliked = new Set(s.disliked ?? []);
    this.playlists = s.playlists;
    this.searchResults = s.searchResults;
    this.account = s.account;
    this.accountChecked = s.accountChecked;
    this.lastError = s.lastError;
    this.streamInfo = s.streamInfo;
    this.wave = s.wave && { sessionId: s.wave.sessionId, batches: new Map(s.wave.batches) };
    this.slop = s.slop ?? {};
    this.audioUnlocked = s.audioUnlocked;
    this.changed();
  }

  applyPlaybackStatus(status: PlaybackStatus): void {
    this.status = status;
    this.changed('status');
  }

  /** The audio output stopped playing this window's stream, e.g. its webview was closed. */
  releaseAudio(): void {
    this.loadedTrackId = undefined;
    this.status = { ...this.status, playing: false };
    this.changed('status');
  }

  getStatus(): PlaybackStatus & { title?: string; queueLength: number; index: number; source: string } {
    const t = this.current();
    return { ...this.status, title: t ? `${artistLine(t)} — ${fullTitle(t)}` : undefined, queueLength: this.queue.length, index: this.index, source: sourceLabel(this.source) };
  }

  // ---------------------------------------------------------------- events from the audio output

  audioStatus(s: { playing: boolean; position: number; duration: number; needsGesture?: boolean }): void {
    this.status = { ...this.status, playing: s.playing, position: s.position, duration: s.duration, needsGesture: s.needsGesture };
    this.changed('status');
  }

  async audioEnded(): Promise<void> {
    const track = this.current();
    if (track) {
      this.finishedTrackId = track.id;
      this.waveFeedback({ type: 'trackFinished', trackId: track.id, totalPlayedSeconds: this.status.duration, trackLengthSeconds: this.status.duration });
    }
    await this.next(true);
  }

  audioError(message: string): void {
    this.lastError = `Couldn't play the track: ${message}`;
    this.status = { ...this.status, playing: false, error: message };
    this.changed();
  }

  audioNeedsGesture(): void {
    this.status = { ...this.status, playing: false, needsGesture: true };
    this.changed('status');
  }

  // ---------------------------------------------------------------- account

  async refreshAccount(): Promise<Account | undefined> {
    const client = await this.host.client();
    this.liked.clear();
    this.disliked.clear();
    this.playlists = [];
    if (!client.authorized) {
      this.account = undefined;
      this.accountChecked = true;
      this.changed();
      return undefined;
    }
    try {
      this.account = await client.accountStatus();
      this.lastError = undefined;
      const [likedIds, dislikedIds] = await Promise.all([
        client.likedTrackIds(this.account.uid).catch(() => []),
        client.dislikedTrackIds(this.account.uid).catch(() => []),
      ]);
      likedIds.forEach((id) => this.liked.add(baseId(id)));
      dislikedIds.forEach((id) => this.disliked.add(baseId(id)));
    } catch (e) {
      this.account = undefined;
      this.lastError = errorText(e);
    }
    this.accountChecked = true;
    this.changed();
    return this.account;
  }

  private async requireAccount(): Promise<Account> {
    if (!this.account) {
      await this.refreshAccount();
    }
    if (!this.account) {
      throw new Error(this.lastError ?? 'Sign in to your Yandex account first with "Yandex Music: Sign In"');
    }
    return this.account;
  }

  // ---------------------------------------------------------------- sources

  async playSource(source: Source): Promise<void> {
    const tracks = await this.fetchSource(source);
    this.source = source;
    this.queue = tracks;
    await this.playIndex(0);
  }

  /**
   * Queues My Vibe without playing it: the first track shows in the status bar
   * and its audio loads on the first play.
   */
  async preloadWave(): Promise<void> {
    if (this.index >= 0 || !(await this.refreshAccount())) {
      return;
    }
    const source: Source = { kind: 'wave' };
    const tracks = await this.fetchSource(source);
    if (this.index >= 0) {
      return; // the user started something else while this was loading
    }
    this.source = source;
    this.queue = tracks;
    this.index = 0;
    this.status = { playing: false, position: 0, duration: 0 };
    this.changed();
    this.checkSlopAround(0);
  }

  /**
   * Asks slopless.art about the tracks in the background and marks them all at once when the
   * answers come, so a list of them redraws once rather than once per track.
   */
  private checkSlop(tracks: Track[]): void {
    const checker = this.host.slop();
    const unknown = tracks.filter((t) => !(baseId(t.id) in this.slop) && !this.slopPending.has(baseId(t.id)));
    if (!checker || !unknown.length) {
      return;
    }
    unknown.forEach((t) => this.slopPending.add(baseId(t.id)));
    void Promise.all(unknown.map((t) => checker.isAi(t).catch(() => undefined))).then((answers) => {
      unknown.forEach((t) => this.slopPending.delete(baseId(t.id)));
      const found = Object.fromEntries(unknown.map((t, i) => [baseId(t.id), answers[i]]).filter(([, ai]) => ai !== undefined));
      if (Object.keys(found).length) {
        this.slop = { ...this.slop, ...found };
        this.changed();
      }
    });
  }

  /** The current track first, on its own, so its mark doesn't wait for the rest of the batch. */
  private checkSlopAround(index: number): void {
    const track = this.queue[index];
    if (track) {
      this.checkSlop([track]);
    }
    this.checkSlop(this.queue.slice(index + 1, index + 1 + SLOP_LOOKAHEAD));
  }

  private async fetchSource(source: Source): Promise<Track[]> {
    const client = await this.host.client();
    let tracks: Track[];
    switch (source.kind) {
      case 'wave':
        await this.requireAccount();
        tracks = await this.startWave(client);
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
      throw new Error(`No playable tracks (${sourceLabel(source)})`);
    }
    return tracks;
  }

  /** Starts a new My Vibe session; if that fails, falls back to the station endpoint. */
  private async startWave(client: YandexMusicClient): Promise<Track[]> {
    const log = this.host.log;
    try {
      const batch = await client.waveStart();
      this.wave = { sessionId: batch.sessionId, batches: new Map() };
      this.rememberBatch(batch);
      log.info(`My Vibe: session ${batch.sessionId}, batch ${batch.batchId}: ${batch.tracks.map(fullTitle).join(', ')}`);
      void client.waveFeedback(batch.sessionId, batch.batchId, { type: 'radioStarted' }).catch((e) => log.warn(`My Vibe: radioStarted wasn't accepted: ${errorText(e)}`));
      return batch.tracks;
    } catch (e) {
      this.wave = undefined;
      log.warn(`My Vibe: couldn't start a radio session, using the station endpoint: ${errorText(e)}`);
      const tracks = await client.myWave();
      log.info(`My Vibe from the station endpoint: ${tracks.map(fullTitle).join(', ')}`);
      return tracks;
    }
  }

  private async moreWave(client: YandexMusicClient): Promise<Track[]> {
    if (this.wave) {
      try {
        const batch = await client.waveMore(this.wave.sessionId, this.queue.map((t) => t.id));
        this.rememberBatch(batch);
        return batch.tracks;
      } catch (e) {
        // the session may have expired; the station endpoint still serves My Vibe
        this.host.log.warn(`My Vibe: couldn't get more tracks from session ${this.wave.sessionId}: ${errorText(e)}`);
      }
    }
    return client.myWave(this.current()?.id);
  }

  private rememberBatch(batch: WaveBatch): void {
    batch.tracks.forEach((t) => this.wave?.batches.set(t.id, batch.batchId));
  }

  /** Reports playback to the My Vibe session, which shapes the next batches. Failures are only logged. */
  private waveFeedback(event: WaveEvent): void {
    const wave = this.wave;
    if (this.source?.kind !== 'wave' || !wave) {
      return;
    }
    const log = this.host.log;
    const batchId = 'trackId' in event ? wave.batches.get(event.trackId) : undefined;
    void this.host
      .client()
      .then((client) => client.waveFeedback(wave.sessionId, batchId, event))
      .then(() => log.debug(`My Vibe: ${event.type} ${'trackId' in event ? event.trackId : ''}`))
      .catch((e) => log.warn(`My Vibe: ${event.type} wasn't accepted: ${errorText(e)}`));
  }

  async search(query: string): Promise<Track[]> {
    const client = await this.host.client();
    this.searchResults = await client.search(query);
    this.changed();
    this.checkSlop(this.searchResults);
    return this.searchResults;
  }

  async loadPlaylists(): Promise<Playlist[]> {
    const acc = await this.requireAccount();
    const client = await this.host.client();
    this.playlists = await client.playlists(acc.uid);
    this.changed();
    return this.playlists;
  }

  async playTracks(tracks: Track[], index: number, source: Source): Promise<void> {
    this.source = source;
    this.queue = tracks;
    await this.playIndex(index);
  }

  // ---------------------------------------------------------------- playback

  async playIndex(index: number, startAt = 0): Promise<void> {
    const track = this.queue[index];
    if (!track) {
      return;
    }
    const prev = this.current();
    if (prev && prev !== track && this.loadedTrackId === prev.id && this.finishedTrackId !== prev.id) {
      this.waveFeedback({ type: 'skip', trackId: prev.id, totalPlayedSeconds: this.status.position });
    }
    this.index = index;
    this.lastError = undefined;
    this.streamInfo = undefined;
    this.status = { playing: false, position: 0, duration: 0, trackId: track.id };
    this.changed();
    this.checkSlopAround(index);

    const client = await this.host.client();
    const { url, preview, codec, bitrate } = await client.streamUrl(track.id, this.host.quality());
    if (this.current() !== track) {
      return; // the user has already switched tracks
    }
    this.streamInfo = `${codec.toUpperCase()} ${bitrate} kbps${preview ? ', 30-second preview' : ''}`;
    if (preview) {
      this.host.notice('Yandex Music: without Yandex Plus, only a 30-second preview is available');
    }
    await this.audio.load(url, track.id, startAt);
    this.loadedTrackId = track.id;
    this.finishedTrackId = undefined;
    this.waveFeedback({ type: 'trackStarted', trackId: track.id });
    this.changed();

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
      const client = await this.host.client();
      const known = new Set(this.queue.map((t) => baseId(t.id)));
      const more = (await this.moreWave(client)).filter((t) => !known.has(baseId(t.id)) && t.available !== false);
      this.queue.push(...more);
      this.changed();
    } catch {
      // not critical: we'll try again on the next track
    } finally {
      this.loadingMore = false;
    }
  }

  async playPause(): Promise<void> {
    if (this.index < 0) {
      await this.playSource(this.account ? { kind: 'wave' } : { kind: 'search', query: 'Hits' });
      return;
    }
    if (this.loadedTrackId !== this.current()?.id) {
      await this.playIndex(this.index, this.status.position);
      return;
    }
    this.audio.toggle();
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

  async seek(seconds: number): Promise<void> {
    this.audio.seek(seconds);
  }

  async setVolume(value: number): Promise<void> {
    this.audio.setVolume(value);
  }

  async previous(): Promise<void> {
    const loaded = this.loadedTrackId === this.current()?.id;
    if (loaded && (this.status.position > 3 || this.index === 0)) {
      this.audio.seek(0);
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
    const client = await this.host.client();
    await client.setLike(acc.uid, track.id, like);
    if (like) {
      this.liked.add(id);
      this.disliked.delete(id); // Yandex drops the dislike of a track that gets liked
    } else {
      this.liked.delete(id);
    }
    this.changed();
    this.host.notice(like ? '♥ Added to Liked' : 'Removed from Liked');
    return like;
  }

  /**
   * Dislikes the current track and moves on to the next one, as Yandex Music does; on a
   * track that is already disliked, takes the dislike back and keeps playing.
   */
  async toggleDislike(): Promise<boolean | undefined> {
    const track = this.current();
    if (!track) {
      return undefined;
    }
    const acc = await this.requireAccount();
    const id = baseId(track.id);
    const dislike = !this.disliked.has(id);
    const client = await this.host.client();
    await client.setDislike(acc.uid, track.id, dislike);
    if (dislike) {
      this.disliked.add(id);
      this.liked.delete(id);
      this.waveFeedback({ type: 'dislike', trackId: track.id, totalPlayedSeconds: this.status.position });
      // Reported as a dislike already, so the switch to the next track isn't reported as a skip too.
      this.finishedTrackId = track.id;
    } else {
      this.disliked.delete(id);
      this.waveFeedback({ type: 'undislike', trackId: track.id });
    }
    this.changed();
    this.host.notice(dislike ? 'Disliked: this track will not be recommended' : 'Dislike removed');
    if (dislike) {
      await this.next();
    }
    return dislike;
  }
}
