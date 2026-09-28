import type { Track } from './api';

/**
 * Whether a track is likely AI-generated, according to slopless.art: a public database that
 * scores Yandex Music tracks with its own model and also collects Yandex's own AI marks. The
 * thresholds match the Slopless browser extension.
 */

export const SLOPLESS_API = 'https://slopless.art/api';
/** How long an answer stays cached; the scores change rarely. */
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 2000;

interface ArtistScore {
  aiTracks: number;
  totalTracks: number;
  yandexAiTracks: number;
  yandexCheckedTracks: number;
}

interface TrackScore {
  /** The slopless model's score; above 0.5 means AI, -1 means not scored. */
  score: number | null;
  /** Yandex's own mark; 1 to 3 means AI. */
  scoreYandex: number | null;
}

/** An artist counts as AI when at least 5% of their checked tracks are. */
function artistIsAi(a: ArtistScore): boolean {
  const byModel = a.totalTracks > 0 && a.aiTracks / a.totalTracks >= 0.05;
  const byYandex = a.yandexCheckedTracks > 0 && a.yandexAiTracks / a.yandexCheckedTracks >= 0.05;
  return byModel || byYandex;
}

function trackIsAi(t: TrackScore): boolean {
  const byModel = t.score !== null && t.score > 0.5;
  const byYandex = t.scoreYandex !== null && t.scoreYandex >= 1 && t.scoreYandex <= 3;
  return byModel || byYandex;
}

export class SlopChecker {
  private readonly cache = new Map<string, { at: number; value: Promise<any | null> }>();
  private readonly fetchImpl: typeof fetch;
  /** The yandexMusic.sloplessBaseUrl setting; changing it drops cached answers. */
  private baseUrl = SLOPLESS_API;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  set base(url: string) {
    const normalized = url.replace(/\/$/, '');
    if (normalized !== this.baseUrl) {
      this.baseUrl = normalized;
      this.cache.clear();
    }
  }

  /** `true` or `false` once slopless.art has answered; `undefined` if it knows nothing or is unreachable. */
  async isAi(track: Track): Promise<boolean | undefined> {
    const [score, ...artists] = await Promise.all([
      this.get<TrackScore>(`track/${track.id.split(':')[0]}`),
      ...track.artists.map((a) => this.get<ArtistScore>(`artist/${a.id}`)),
    ]);
    const known = artists.filter((a): a is ArtistScore => !!a);
    if (!score && !known.length) {
      return undefined;
    }
    return (!!score && trackIsAi(score)) || known.some(artistIsAi);
  }

  private get<T>(path: string): Promise<T | null> {
    const now = Date.now();
    const hit = this.cache.get(path);
    if (hit && now - hit.at < TTL_MS) {
      return hit.value;
    }
    if (this.cache.size >= MAX_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    const value = this.fetchImpl(`${this.baseUrl}/${path}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    this.cache.set(path, { at: now, value });
    return value;
  }
}
