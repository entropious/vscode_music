/**
 * What the player service sends and takes over its socket. These types mirror `src/core.ts`,
 * `src/api.ts` and `src/protocol.ts` of the extension; the app only reads the fields below,
 * and fields that older services don't send are optional.
 */

/** Version of the messages between remotes and the service, `PROTOCOL` in `src/protocol.ts`. */
export const PROTOCOL = 2;

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

export interface Station {
  id: string;
  tag: string;
  name: string;
  altName?: string;
  parent?: string;
  icon?: string;
  color?: string;
}

export type Source =
  | { kind: 'wave' }
  | { kind: 'station'; id: string; name: string }
  | { kind: 'liked' }
  | { kind: 'playlist'; playlist: Playlist }
  | { kind: 'search'; query: string };

export interface PlaybackStatus {
  playing: boolean;
  position: number;
  duration: number;
  trackId?: string;
  error?: string;
}

export interface SharedState {
  queue: Track[];
  index: number;
  source?: Source;
  liked: string[];
  disliked?: string[];
  playlists: Playlist[];
  searchResults: Track[];
  searchStations?: Station[];
  account?: Account;
  accountChecked: boolean;
  lastError?: string;
  streamInfo?: string;
  slop?: Record<string, boolean>;
  volume?: number;
}

/** Player methods a remote can run, `REMOTE_METHODS` in `src/core.ts`, with their arguments. */
export interface RemoteMethods {
  playSource: [source: Source];
  playTracks: [tracks: Track[], index: number, source: Source];
  playIndex: [index: number];
  playPause: [];
  next: [];
  previous: [];
  toggleLike: [];
  toggleDislike: [];
  seek: [seconds: number];
  setVolume: [value: number];
  search: [query: string];
  loadPlaylists: [];
  refreshAccount: [];
  startTrackRadio: [];
}
export type RemoteMethod = keyof RemoteMethods;

export type Message =
  | { type: 'call'; id: number; method: RemoteMethod; args: unknown[] }
  | { type: 'result'; id: number; value?: unknown; error?: string }
  | { type: 'state'; state: SharedState }
  | { type: 'status'; status: PlaybackStatus }
  | { type: 'attach'; protocol: number }
  | { type: 'welcome' }
  | { type: 'outdated' }
  | { type: 'notice'; text: string };

/** The track ID without the album, as likes, dislikes and AI marks are keyed. */
export function baseId(id: string): string {
  return id.split(':')[0] ?? id;
}

export function coverUrl(uri: string | undefined, size: number): string | undefined {
  if (!uri) {
    return undefined;
  }
  if (uri.startsWith('data:')) {
    return uri;
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
