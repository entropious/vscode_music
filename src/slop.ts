import * as fs from 'fs';
import * as path from 'path';
import type { Track } from './api';

/**
 * Whether a track is likely AI-generated, according to slopless.art: a public database that
 * scores Yandex Music tracks with its own model and also collects Yandex's own AI marks. The
 * thresholds match the Slopless browser extension.
 */

export const SLOPLESS_API = 'https://slopless.art/api';
/** The file in the extension's global storage that keeps confirmed AI answers. */
export const SLOP_FILE = 'ai-marks.json';
/** How long an answer stays cached; the scores change rarely. */
const TTL_MS = 60 * 60 * 1000;
/** A confirmed AI mark hardly ever goes away, so it is kept longer. */
const AI_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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

/** Confirmed AI answers on disk, by request URL. */
type SavedAnswers = Record<string, { at: number; answer: unknown }>;

function readSaved(file: string): SavedAnswers {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

export class SlopChecker {
  /** Answers by request URL, so answers from different slopless.art endpoints never mix. */
  private readonly cache = new Map<string, { at: number; ttl: number; value: Promise<any | null> }>();
  private readonly fetchImpl: typeof fetch;
  /** The yandexMusic.sloplessBaseUrl setting. */
  private baseUrl = SLOPLESS_API;
  /**
   * Confirmed AI answers are also kept in this file, so they outlive the process. The service
   * and the windows share it: each write merges into what is already there.
   */
  private readonly file: string | undefined;
  private saving = Promise.resolve();

  constructor(file?: string, fetchImpl: typeof fetch = fetch) {
    this.file = file;
    this.fetchImpl = fetchImpl;
    if (file) {
      const now = Date.now();
      for (const [url, { at, answer }] of Object.entries(readSaved(file))) {
        if (now - at < AI_TTL_MS) {
          this.cache.set(url, { at, ttl: AI_TTL_MS, value: Promise.resolve(answer) });
        }
      }
    }
  }

  set base(url: string) {
    this.baseUrl = url.replace(/\/$/, '');
  }

  /** `true` or `false` once slopless.art has answered; `undefined` if it knows nothing or is unreachable. */
  async isAi(track: Track): Promise<boolean | undefined> {
    const [score, ...artists] = await Promise.all([
      this.get<TrackScore>(`track/${track.id.split(':')[0]}`, trackIsAi),
      ...track.artists.map((a) => this.get<ArtistScore>(`artist/${a.id}`, artistIsAi)),
    ]);
    const known = artists.filter((a): a is ArtistScore => !!a);
    if (!score && !known.length) {
      return undefined;
    }
    return (!!score && trackIsAi(score)) || known.some(artistIsAi);
  }

  private get<T>(path: string, isAi: (answer: T) => boolean): Promise<T | null> {
    const url = `${this.baseUrl}/${path}`;
    const now = Date.now();
    const hit = this.cache.get(url);
    if (hit && now - hit.at < hit.ttl) {
      return hit.value;
    }
    if (this.cache.size >= MAX_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    const entry: { at: number; ttl: number; value: Promise<T | null> } = { at: now, ttl: TTL_MS, value: Promise.resolve(null) };
    entry.value = this.fetchImpl(url)
      .then((r): Promise<T> | null => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((answer) => {
        if (answer && isAi(answer)) {
          entry.ttl = AI_TTL_MS;
          this.save(url, now, answer);
        }
        return answer;
      });
    this.cache.set(url, entry);
    return entry.value;
  }

  /** Adds the answer to the file; writes go one at a time and drop answers that have expired. */
  private save(url: string, at: number, answer: unknown): void {
    const file = this.file;
    if (!file) {
      return;
    }
    this.saving = this.saving
      .then(async () => {
        const now = Date.now();
        const saved = readSaved(file);
        saved[url] = { at, answer };
        const fresh = Object.fromEntries(Object.entries(saved).filter(([, s]) => now - s.at < AI_TTL_MS));
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(fresh));
        await fs.promises.rename(tmp, file);
      })
      .catch(() => undefined);
  }
}
