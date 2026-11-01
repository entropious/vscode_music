import type { Genre, Track, YandexMusicClient } from './api';
import type { Logger } from './core';

/**
 * What the fullscreen remote shows besides the cover: videos of a track and its genres. The
 * remote picks one video by its own order (a music video from the iTunes Store or YouTube, the
 * track's video shot, the artist's video, Apple Music's motion cover); the rest is there for it
 * to fall back on. Every video plays without sound.
 */
export interface TrackVisuals {
  /** The album's genre, with its names and color from `/genres`. */
  genre?: { id: string; title: string; titleRu?: string; color?: string };
  /** Finer genres from MusicBrainz, found by the track's artist and title, most voted first. */
  tags?: string[];
  /** A music video in the iTunes Store: its 30-second preview, MP4. */
  musicVideo?: string;
  /** A music video on YouTube, as Wikidata links it, or else Genius. */
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
  musicVideos: boolean;
  detailedGenres: boolean;
  /** Genius's API token, which the music videos are also looked up on Genius with. */
  geniusToken?: string;
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

/** A phrase for a Lucene query, as MusicBrainz's search takes. */
const phrase = (s: string): string => `"${s.replace(/["\\]/g, '\\$&')}"`;

/** How sure MusicBrainz's search must be of a recording, out of 100, for its genres to be taken. */
const MUSICBRAINZ_MIN_SCORE = 90;
/** How many people must have given an artist a genre for a track of theirs to get it. */
const MUSICBRAINZ_MIN_ARTIST_VOTES = 2;

/**
 * MusicBrainz's genres of a recording, found by its artist and title; requests go one at a
 * time, a second apart.
 */
class MusicBrainz {
  private queue: Promise<unknown> = Promise.resolve();
  private last = 0;
  private readonly cache = new Cache<string[]>();

  private get(path: string): Promise<any> {
    const attempt = async (): Promise<any> => {
      const wait = this.last + MUSICBRAINZ_GAP_MS - Date.now();
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
      this.last = Date.now();
      return getJson(`${MUSICBRAINZ}/${path}`);
    };
    // Connections to MusicBrainz drop now and then, and it answers 503 to a client that asks
    // too often: one more try, a gap later, gets through.
    const run = this.queue.then(() => attempt().catch(attempt));
    this.queue = run.catch(() => undefined);
    return run;
  }

  genres(artist: string, title: string): Promise<string[]> {
    return this.cache.get(`${artist}\n${title}`, async () => {
      const query = `recording:${phrase(title)} AND artist:${phrase(artist)}`;
      const found = await this.get(`recording?${new URLSearchParams({ query, fmt: 'json', limit: '5' })}`);
      const by = plain(artist);
      const t = plain(title);
      // Common titles have many recordings: only one by this artist under this very title will do.
      const match = (found?.recordings ?? []).find(
        (r: any) =>
          (r.score ?? 0) >= MUSICBRAINZ_MIN_SCORE &&
          plain(String(r.title ?? '')) === t &&
          (r['artist-credit'] ?? []).some((c: any) => {
            const who = plain(String(c.name ?? c.artist?.name ?? ''));
            return who && (who.includes(by) || by.includes(who));
          }),
      );
      const id = match?.id;
      if (!id) {
        return [];
      }
      const rec = await this.get(`recording/${id}?fmt=json&inc=genres+artist-credits`);
      let genres: any[] = rec?.genres ?? [];
      // A recording nobody has tagged gets its artist's genres, those that more than one person
      // gave: a single vote on an artist is often a stray one, unlike the rest of their music.
      const artistId = rec?.['artist-credit']?.[0]?.artist?.id;
      if (!genres.length && artistId) {
        genres = ((await this.get(`artist/${artistId}?fmt=json&inc=genres`))?.genres ?? []).filter((g: any) => (g.count ?? 0) >= MUSICBRAINZ_MIN_ARTIST_VOTES);
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
 * A track's music video in the iTunes Store, found with the iTunes Search API by artist and
 * title. The API gives only a 30-second preview of it, which is enough for a background. A
 * studio video is preferred to a live one.
 */
class AppleMusicVideos {
  private readonly cache = new Cache<string | undefined>();

  video(artist: string, title: string): Promise<string | undefined> {
    return this.cache.get(`${artist}\n${title}`, async () => {
      const term = new URLSearchParams({ term: `${artist} ${title}`, entity: 'musicVideo', limit: '10', country: 'us' });
      const results: any[] = (await getJson(`https://itunes.apple.com/search?${term}`))?.results ?? [];
      const t = plain(title);
      const by = plain(artist);
      const matches = results.filter((r) => {
        const who = plain(String(r.artistName ?? ''));
        return t && r.previewUrl && plain(String(r.trackName ?? '')) === t && who && (who.includes(by) || by.includes(who));
      });
      const live = (r: any) => /\blive\b/i.test(String(r.trackName ?? ''));
      const best = matches.find((r) => !live(r)) ?? matches[0];
      return best ? String(best.previewUrl) : undefined;
    });
  }
}

/**
 * A song's video on YouTube as Wikidata knows it (property P1651): the song is searched by its
 * title, and of the items found the one whose performer is the artist is taken.
 */
class WikidataVideos {
  private readonly cache = new Cache<string | undefined>();

  youtubeId(artist: string, title: string): Promise<string | undefined> {
    return this.cache.get(`${artist}\n${title}`, async () => {
      const search = new URLSearchParams({ action: 'wbsearchentities', search: title, language: 'en', type: 'item', limit: '10', format: 'json' });
      const ids: string[] = ((await getJson(`https://www.wikidata.org/w/api.php?${search}`))?.search ?? []).map((s: any) => String(s.id)).filter((id: string) => /^Q\d+$/.test(id));
      if (!ids.length) {
        return undefined;
      }
      const query = `SELECT ?item ?yt ?performer WHERE {
        VALUES ?item { ${ids.map((id) => `wd:${id}`).join(' ')} }
        ?item wdt:P1651 ?yt; wdt:P175 ?p. ?p rdfs:label ?performer. FILTER(LANG(?performer) = "en")
      }`;
      const rows: any[] = (await getJson(`https://query.wikidata.org/sparql?${new URLSearchParams({ query, format: 'json' })}`))?.results?.bindings ?? [];
      const by = plain(artist);
      // The search ranks the items; the first of them by the artist wins.
      const match = ids
        .map((id) => rows.find((r) => String(r.item?.value).endsWith(`/${id}`) && by && plain(String(r.performer?.value ?? '')) === by))
        .find((r) => r);
      return match ? String(match.yt.value) : undefined;
    });
  }
}

/**
 * Whether a YouTube video is worth showing, by its title and channel from YouTube's oEmbed: an
 * auto-generated "Artist - Topic" upload or an "Official Audio" one is the album's cover on a
 * still frame, and a video YouTube won't describe is gone or can't be embedded.
 */
class YouTubeCheck {
  private readonly cache = new Cache<boolean>();

  isVideo(id: string): Promise<boolean> {
    return this.cache.get(id, async () => {
      const q = new URLSearchParams({ url: `https://www.youtube.com/watch?v=${id}`, format: 'json' });
      const info = await getJson(`https://www.youtube.com/oembed?${q}`).catch(() => undefined);
      if (!info) {
        return false;
      }
      return !/ - Topic$/.test(String(info.author_name ?? '')) && !/\baudio\b/i.test(String(info.title ?? ''));
    });
  }
}

/**
 * A song's video on YouTube as Genius links it: the song is searched by artist and title, and
 * its page's media give the link. Genius wants an API token; without one nothing is looked up.
 */
class GeniusVideos {
  private readonly cache = new Cache<string | undefined>();

  youtubeId(token: string, artist: string, title: string): Promise<string | undefined> {
    return this.cache.get(`${artist}\n${title}`, async () => {
      const get = async (p: string): Promise<any> => JSON.parse(await getText(`https://api.genius.com${p}`, { Authorization: `Bearer ${token}`, Accept: 'application/json' }))?.response;
      const hits: any[] = (await get(`/search?${new URLSearchParams({ q: `${artist} ${title}` })}`))?.hits ?? [];
      const t = plain(title);
      const by = plain(artist);
      const song = hits
        .map((h) => h.result)
        .find((r) => {
          const who = plain(String(r?.primary_artist?.name ?? ''));
          // Genius adds the original title in brackets to translated ones: "Ночь (Night)".
          return who && (who.includes(by) || by.includes(who)) && plain(String(r?.title ?? '')).startsWith(t);
        });
      if (!song) {
        return undefined;
      }
      const media: any[] = (await get(`/songs/${song.id}`))?.song?.media ?? [];
      const url = media.find((m) => m.provider === 'youtube')?.url;
      return url ? new URL(String(url)).searchParams.get('v') ?? undefined : undefined;
    });
  }
}

/**
 * Looks up a track's visuals in Yandex Music and, as the user allows, MusicBrainz, Apple Music,
 * the iTunes Store, Wikidata and Genius. Each source reports as soon as it answers; a source that fails
 * is left out.
 */
export class VisualsLookup {
  private readonly client: () => Promise<YandexMusicClient>;
  private readonly options: () => VisualsOptions;
  private readonly log: Logger;
  private genres?: Promise<Map<string, Genre>>;
  private readonly artistVideos = new Cache<string | undefined>();
  private readonly musicBrainz = new MusicBrainz();
  private readonly apple = new AppleMotion();
  private readonly appleVideos = new AppleMusicVideos();
  private readonly wikidata = new WikidataVideos();
  private readonly genius = new GeniusVideos();
  private readonly youtube = new YouTubeCheck();

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
      ['artist video', async () => add({ artistVideo: artist ? await this.artistVideos.get(String(artist.id), () => client.artistVideo(artist.id)) : undefined })],
    ];
    if (opts.detailedGenres && artist) {
      tasks.push(['MusicBrainz', async () => add({ tags: (await this.musicBrainz.genres(artist.name, track.title)).filter((g) => plain(g) !== plain(found.genre?.title ?? '')) })]);
    }
    if (opts.motionCovers && artist && album) {
      tasks.push(['Apple Music', async () => add({ motionCover: await this.apple.cover(artist.name, album.title) })]);
    }
    if (opts.musicVideos && artist) {
      tasks.push(['iTunes music video', async () => add({ musicVideo: await this.appleVideos.video(artist.name, track.title) })]);
      /** A YouTube video found, unless it is only the cover on a still frame. */
      const video = async (id: string | undefined) => (id && (await this.youtube.isVideo(id)) ? id : undefined);
      tasks.push(['Wikidata', async () => add({ youtubeId: await video(await this.wikidata.youtubeId(artist.name, track.title)) })]);
      const geniusToken = opts.geniusToken;
      if (geniusToken) {
        tasks.push([
          'Genius',
          async () => {
            const id = await video(await this.genius.youtubeId(geniusToken, artist.name, track.title));
            // Wikidata's link is the official video; Genius sometimes links a lyric video.
            if (!found.youtubeId) {
              add({ youtubeId: id });
            }
          },
        ]);
      }
    }
    await Promise.all(tasks.map(([name, task]) => task().catch((e) => this.log.debug(`visuals: ${name} of ${track.id}: ${e instanceof Error ? e.message : String(e)}`))));
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
