import { createHash } from 'crypto';

/** Salt used by Yandex Music clients to sign direct download links. */
const SIGN_SALT = 'XGRlBW9FXlekgbPrRHuSiA';

export interface Artist {
  id: number | string;
  name: string;
}

export interface Album {
  id: number | string;
  title: string;
}

export interface Track {
  id: string;
  title: string;
  version?: string;
  durationMs?: number;
  artists: Artist[];
  albums: Album[];
  coverUri?: string;
  available?: boolean;
}

export interface Playlist {
  uid: number | string;
  kind: number | string;
  title: string;
  trackCount: number;
}

export interface Account {
  uid: number | string;
  login: string;
  displayName?: string;
  hasPlus: boolean;
}

interface DownloadInfo {
  codec: string;
  bitrateInKbps: number;
  downloadInfoUrl: string;
  direct?: boolean;
  preview?: boolean;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body?: unknown) {
    super(message);
  }
}

export type Fetch = typeof fetch;

export class YandexMusicClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  get authorized(): boolean {
    return !!this.token;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'X-Yandex-Music-Client': 'YandexMusicAndroid/24023621',
      'Accept-Language': 'ru',
    };
    if (this.token) {
      h['Authorization'] = `OAuth ${this.token}`;
    }
    return h;
  }

  private async request<T>(path: string, init: { method?: string; form?: Record<string, string> } = {}): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl.replace(/\/$/, '')}${path}`;
    const headers = this.headers();
    let body: string | undefined;
    if (init.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    }
    const res = await this.fetchImpl(url, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(`Некорректный ответ сервера (${res.status})`, res.status, text);
    }
    if (!res.ok || json?.error) {
      const err = json?.error;
      const msg = typeof err === 'string' ? err : err?.message || err?.name || res.statusText;
      throw new ApiError(explainError(res.status, msg), res.status, json);
    }
    return (json?.result ?? json) as T;
  }

  async accountStatus(): Promise<Account> {
    const r = await this.request<any>('/account/status');
    const acc = r.account ?? {};
    if (acc.uid === undefined) {
      throw new ApiError('Токен недействителен', 401, r);
    }
    return {
      uid: acc.uid,
      login: acc.login ?? String(acc.uid),
      displayName: acc.displayName ?? acc.fullName,
      hasPlus: !!r.plus?.hasPlus,
    };
  }

  async search(text: string, page = 0): Promise<Track[]> {
    const q = new URLSearchParams({ text, type: 'track', page: String(page), nocorrect: 'false' });
    const r = await this.request<any>(`/search?${q}`);
    return (r.tracks?.results ?? []).map(normalizeTrack);
  }

  async tracks(ids: string[]): Promise<Track[]> {
    if (ids.length === 0) {
      return [];
    }
    const out: Track[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const r = await this.request<any[]>('/tracks', { form: { 'track-ids': chunk.join(','), 'with-positions': 'false' } });
      out.push(...r.map(normalizeTrack));
    }
    return out;
  }

  async likedTrackIds(uid: Account['uid']): Promise<string[]> {
    const r = await this.request<any>(`/users/${uid}/likes/tracks`);
    return (r.library?.tracks ?? []).map((t: any) => (t.albumId ? `${t.id}:${t.albumId}` : String(t.id)));
  }

  async likedTracks(uid: Account['uid'], limit = 300): Promise<Track[]> {
    const ids = (await this.likedTrackIds(uid)).slice(0, limit);
    return this.tracks(ids);
  }

  async setLike(uid: Account['uid'], trackId: string, like: boolean): Promise<void> {
    const action = like ? 'add-multiple' : 'remove';
    await this.request(`/users/${uid}/likes/tracks/${action}`, { form: { 'track-ids': trackId } });
  }

  async playlists(uid: Account['uid']): Promise<Playlist[]> {
    const r = await this.request<any[]>(`/users/${uid}/playlists/list`);
    return r.map((p) => ({ uid: p.uid ?? p.owner?.uid ?? uid, kind: p.kind, title: p.title, trackCount: p.trackCount ?? 0 }));
  }

  async playlistTracks(uid: Playlist['uid'], kind: Playlist['kind']): Promise<Track[]> {
    const r = await this.request<any>(`/users/${uid}/playlists/${kind}`);
    const items: any[] = r.tracks ?? [];
    const full = items.filter((i) => i.track).map((i) => normalizeTrack(i.track));
    if (full.length === items.length) {
      return full;
    }
    return this.tracks(items.map((i) => (i.albumId ? `${i.id}:${i.albumId}` : String(i.id))));
  }

  /** «Моя волна» — персональный бесконечный поток. */
  async myWave(lastTrackId?: string): Promise<Track[]> {
    const q = new URLSearchParams({ 'settings2': 'true' });
    if (lastTrackId) {
      q.set('queue', lastTrackId.split(':')[0]);
    }
    const r = await this.request<any>(`/rotor/station/user:onyourwave/tracks?${q}`);
    return (r.sequence ?? []).map((s: any) => normalizeTrack(s.track));
  }

  /** Возвращает прямую ссылку на MP3-поток трека. */
  async streamUrl(trackId: string, quality: 'high' | 'low' = 'high'): Promise<{ url: string; preview: boolean }> {
    const id = trackId.split(':')[0];
    const infos = await this.request<DownloadInfo[] | { name?: string; message?: string }>(`/tracks/${id}/download-info`);
    if (!Array.isArray(infos)) {
      const reason = infos?.message === 'no-rights' ? 'нет прав на прослушивание (нужен вход в аккаунт или подписка Плюс)' : infos?.message ?? 'неизвестная ошибка';
      throw new ApiError(`Трек недоступен: ${reason}`, 403, infos);
    }
    const mp3 = infos.filter((i) => i.codec === 'mp3');
    const pool = mp3.length ? mp3 : infos;
    if (!pool.length) {
      throw new ApiError('Трек недоступен для прослушивания', 404);
    }
    pool.sort((a, b) => (quality === 'high' ? b.bitrateInKbps - a.bitrateInKbps : a.bitrateInKbps - b.bitrateInKbps));
    const info = pool[0];
    const sep = info.downloadInfoUrl.includes('?') ? '&' : '?';
    const res = await this.fetchImpl(`${info.downloadInfoUrl}${sep}format=json`, { headers: this.headers() });
    if (!res.ok) {
      throw new ApiError(explainError(res.status, res.statusText), res.status);
    }
    const d = (await res.json()) as { host: string; path: string; ts: string; s: string };
    return { url: buildDirectLink(d), preview: !!info.preview };
  }
}

export function buildDirectLink(d: { host: string; path: string; ts: string; s: string }): string {
  const sign = createHash('md5').update(SIGN_SALT + d.path.slice(1) + d.s).digest('hex');
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(d.host) ? 'http' : 'https';
  return `${scheme}://${d.host}/get-mp3/${sign}/${d.ts}${d.path}`;
}

export function normalizeTrack(t: any): Track {
  const albums: Album[] = (t.albums ?? []).map((a: any) => ({ id: a.id, title: a.title }));
  const id = albums.length && !String(t.id).includes(':') ? `${t.id}:${albums[0].id}` : String(t.id);
  return {
    id,
    title: t.title ?? 'Без названия',
    version: t.version,
    durationMs: t.durationMs,
    artists: (t.artists ?? []).map((a: any) => ({ id: a.id, name: a.name })),
    albums,
    coverUri: t.coverUri ?? t.ogImage,
    available: t.available !== false,
  };
}

export function coverUrl(uri: string | undefined, size = 200): string | undefined {
  if (!uri) {
    return undefined;
  }
  const u = uri.replace('%%', `${size}x${size}`);
  return /^https?:\/\//.test(u) ? u : `https://${u}`;
}

export function artistLine(t: Track): string {
  return t.artists.map((a) => a.name).join(', ');
}

export function fullTitle(t: Track): string {
  return t.version ? `${t.title} (${t.version})` : t.title;
}

function explainError(status: number, msg: string): string {
  if (status === 401 || status === 403) {
    return 'Нужна авторизация: войдите в аккаунт Яндекса (команда «Яндекс Музыка: Войти в аккаунт»)';
  }
  if (status === 451 || /legal reasons/i.test(msg)) {
    return 'Яндекс Музыка недоступна в вашем регионе (451 Unavailable For Legal Reasons)';
  }
  return `Ошибка API Яндекс Музыки (${status}): ${msg}`;
}
