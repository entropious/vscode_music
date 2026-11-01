import type { Genre, Track, YandexMusicClient } from './api';
import type { Logger } from './core';

/**
 * What the fullscreen remote shows besides the cover: videos of a track and its genres. The
 * remote picks one video by its own order (a music video, the track's video shot, the artist's
 * video, Apple Music's motion cover); the rest is there for it to fall back on.
 */
export interface TrackVisuals {
  /** The album's genre, with its names and color from `/genres`. */
  genre?: { id: string; title: string; titleRu?: string; color?: string };
  /** Finer genres from MusicBrainz, found by the track's ISRC, most voted first. */
  tags?: string[];
  /** A music video on Yandex Music: its short preview. */
  clip?: { title: string; previewUrl: string; thumbnail?: string };
  /** A music video on YouTube, as Yandex Music links it. */
  youtubeId?: string;
  /** The track's video shot: a short looping vertical video, MP4. */
  video?: string;
  /** The artist's background video, MP4. */
  artistVideo?: string;
  /** Apple Music's motion cover of the album: a square looping video, HLS. */
  motionCover?: string;
}

/** Which lookups outside Yandex Music the user allows. */
export interface VisualsOptions {
  motionCovers: boolean;
  detailedGenres: boolean;
}

const TIMEOUT_MS = 15000;
const USER_AGENT = 'vscode-yandex-music (https://github.com/entropious/vscode_music)';
/** MusicBrainz allows one request a second per client. */
const MUSICBRAINZ_GAP_MS = 1100;
const MUSICBRAINZ = 'https://musicbrainz.org/ws/2';

async function getText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`${new URL(url).host} answered ${res.status}`);
  }
  return res.text();
}

async function getJson(url: string): Promise<any> {
  return JSON.parse(await getText(url, { Accept: 'application/json' }));
}

/** A name to compare: lower case, without what's in brackets, editions and punctuation. */
function plain(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[([][^)\]]*[)\]]/g, ' ')
    .replace(/\b(deluxe|expanded|remaster(ed)?|edition|version|single|ep)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Remembers each lookup's promise, so that a key is looked up once however often it's asked for. */
class Cache<T> {
  private readonly items = new Map<string, Promise<T>>();
  private readonly limit: number;

  constructor(limit = 300) {
    this.limit = limit;
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    let item = this.items.get(key);
    if (!item) {
      item = load();
      this.items.set(key, item);
      if (this.items.size > this.limit) {
        this.items.delete(this.items.keys().next().value as string);
      }
    }
    return item;
  }
}

/** MusicBrainz's genres of a recording, by ISRC; requests go one at a time, a second apart. */
class MusicBrainz {
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;
  private readonly cache = new Cache<string[]>();

  private get(path: string): Promise<any> {
    const run = this.queue.then(async () => {
      const wait = this.last + MUSICBRAINZ_GAP_MS - Date.now();
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
      this.last = Date.now();
      return getJson(`${MUSICBRAINZ}/${path}`);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  genres(isrc: string): Promise<string[]> {
    return this.cache.get(isrc, async () => {
      const found = await this.get(`isrc/${encodeURIComponent(isrc)}?fmt=json`);
      const id = found?.recordings?.[0]?.id;
      if (!id) {
        return [];
      }
      const rec = await this.get(`recording/${id}?fmt=json&inc=genres+artist-credits`);
      let genres: any[] = rec?.genres ?? [];
      // A recording nobody has tagged gets its artist's genres.
      const artistId = rec?.['artist-credit']?.[0]?.artist?.id;
      if (!genres.length && artistId) {
        genres = (await this.get(`artist/${artistId}?fmt=json&inc=genres`))?.genres ?? [];
      }
      return genres
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
        .map((g) => String(g.name))
        .slice(0, 4);
    });
  }
}

/**
 * Apple Music's motion cover of an album: the album is found with the iTunes Search API, and
 * its page on music.apple.com links its videos as HLS playlists. Of these, the square one is
 * the cover; the page is read as it is, so this breaks when Apple changes the page.
 */
class AppleMotion {
  private readonly cache = new Cache<string | undefined>();

  cover(artist: string, album: string): Promise<string | undefined> {
    return this.cache.get(`${artist}\n${album}`, async () => {
      const term = new URLSearchParams({ term: `${artist} ${album}`, entity: 'album', limit: '10', country: 'us' });
      const results: any[] = (await getJson(`https://itunes.apple.com/search?${term}`))?.results ?? [];
      const a = plain(album);
      const by = plain(artist);
      const match = results.find((r) => {
        const name = plain(String(r.collectionName ?? ''));
        const who = plain(String(r.artistName ?? ''));
        return a && name && (name === a || name.startsWith(`${a} `)) && (who.includes(by) || by.includes(who));
      });
      const page = match?.collectionViewUrl ? String(match.collectionViewUrl).split('?')[0] : undefined;
      if (!page) {
        return undefined;
      }
      const html = await getText(page, { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)' });
      const playlists = [...new Set(html.match(/https:\/\/mvod\.itunes\.apple\.com\/itunes-assets\/[^"\s\\]+?\.m3u8/g) ?? [])].slice(0, 3);
      for (const url of playlists) {
        const sizes = [...(await getText(url)).matchAll(/RESOLUTION=(\d+)x(\d+)/g)].map((m) => Number(m[1]) / Number(m[2]));
        if (sizes.some((r) => Math.abs(r - 1) < 0.1)) {
          return url;
        }
      }
      return undefined;
    });
  }
}

/**
 * Looks up a track's visuals in Yandex Music and, as the user allows, MusicBrainz and Apple
 * Music. Each source reports as soon as it answers; a source that fails is left out.
 */
export class VisualsLookup {
  private readonly client: () => Promise<YandexMusicClient>;
  private readonly options: () => VisualsOptions;
  private readonly log: Logger;
  private genres?: Promise<Map<string, Genre>>;
  private readonly artistVideos = new Cache<string | undefined>();
  private readonly musicBrainz = new MusicBrainz();
  private readonly apple = new AppleMotion();

  constructor(client: () => Promise<YandexMusicClient>, options: () => VisualsOptions, log: Logger) {
    this.client = client;
    this.options = options;
    this.log = log;
  }

  /** Calls `update` with the visuals found so far, every time a source adds to them. */
  async lookUp(track: Track, update: (visuals: TrackVisuals) => void): Promise<void> {
    const found: TrackVisuals = {};
    const add = (part: TrackVisuals) => {
      if (Object.values(part).some((v) => v !== undefined)) {
        Object.assign(found, part);
        update({ ...found });
      }
    };
    if (track.backgroundVideoUri) {
      add({ video: track.backgroundVideoUri });
    }
    const opts = this.options();
    const album = track.albums[0];
    const artist = track.artists[0];
    const client = await this.client();
    const tasks: [string, () => Promise<void>][] = [
      ['genre', async () => add({ genre: album?.genre ? (await this.genreMap(client)).get(album.genre) ?? { id: album.genre, title: album.genre } : undefined })],
      [
        'clips',
        async () => {
          const clip = (await client.clips(track.clipIds ?? [])).find((c) => c.previewUrl);
          add({ clip: clip?.previewUrl ? { title: clip.title, previewUrl: clip.previewUrl, thumbnail: clip.thumbnail } : undefined });
        },
      ],
      ['supplement', async () => add({ youtubeId: (await client.supplementVideos(track.id)).find((v) => v.provider.toLowerCase() === 'youtube')?.providerVideoId })],
      ['artist video', async () => add({ artistVideo: artist ? await this.artistVideos.get(String(artist.id), () => client.artistVideo(artist.id)) : undefined })],
    ];
    if (opts.detailedGenres && track.isrc) {
      const isrc = track.isrc;
      tasks.push(['MusicBrainz', async () => add({ tags: (await this.musicBrainz.genres(isrc)).filter((g) => plain(g) !== plain(found.genre?.title ?? '')) })]);
    }
    if (opts.motionCovers && artist && album) {
      tasks.push(['Apple Music', async () => add({ motionCover: await this.apple.cover(artist.name, album.title) })]);
    }
    await Promise.all(
      tasks.map(([name, task]) =>
        // The supplement is missing for most tracks, and clips for those without any.
        task().catch((e) => name !== 'supplement' && this.log.debug(`visuals: ${name} of ${track.id}: ${e instanceof Error ? e.message : String(e)}`)),
      ),
    );
  }

  private genreMap(client: YandexMusicClient): Promise<Map<string, Genre>> {
    this.genres ??= client.genres().then(
      (list) => new Map(list.map((g) => [g.id, g])),
      (e) => {
        this.genres = undefined; // try again with the next track
        throw e;
      },
    );
    return this.genres;
  }
}
