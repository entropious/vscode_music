import * as fs from 'fs';
import * as path from 'path';
import { gunzipSync } from 'zlib';
import type { Track, YandexMusicClient } from './api';

/**
 * Whether a track is AI-generated, and who says so:
 * - `full`, `partial`, `possible`: Yandex Music's own label, from the track's credits ("AI use"
 *   in the "About the track" card). The rights holder declares full or partial use of AI; when
 *   they haven't, Yandex's detector may mark a track as possibly made with AI.
 * - `deezer`: Deezer's detector flagged the track, its album or its artist (every release of
 *   whom is AI), in a snapshot Slopless made and mapped to Yandex Music's IDs.
 * A track neither labels is `null`: unlabeled, which doesn't prove it isn't AI.
 */
export type AiMark = 'full' | 'partial' | 'possible' | 'deezer';

/**
 * Deezer's detections mapped to Yandex Music's track, album and artist IDs, published by the
 * Slopless project (MIT): https://github.com/alexeyfv/slopless/tree/main/data. Pinned to a
 * commit, so the file can't change under us; it's a snapshot of May 2026.
 */
export const DEEZER_AI_DATA = 'https://raw.githubusercontent.com/alexeyfv/slopless/84b6547a67b187a352a0c6fe4d056f570c7a0b5c/data/v0.2.0.json.gz';
/** The snapshot as sorted ID arrays, in the extension's global storage. */
const DEEZER_FILE = 'deezer-ai.bin';
/** The labels found, so that they outlive the process; the service and the windows share it. */
export const AI_MARKS_FILE = 'ai-labels.json';

/** An answer, labeled or not, is asked again after this long: labels get added. */
const CHECKED_TTL_MS = 24 * 60 * 60 * 1000;
/** After Yandex Music didn't answer, the track is asked again soon. */
const FAILED_TTL_MS = 5 * 60 * 1000;
/** A label hardly ever goes away. */
const LABEL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
/** Credits are asked for a few tracks at a time, not for a whole queue at once. */
const CONCURRENCY = 4;

const AI_TITLE = /^(использование ии|ai use)$/i;

/** What the value of the "AI use" credit says. Wordings not seen yet count as "possibly". */
export function markOf(value: string): AiMark {
  const v = value.toLowerCase();
  if (/возможно|may have|possibly|likely/.test(v)) {
    return 'possible';
  }
  if (/частичн|partial|partly|in part/.test(v)) {
    return 'partial';
  }
  if (/полност|целиком|fully|entirely|completely/.test(v)) {
    return 'full';
  }
  return 'possible';
}

/** Deezer's detections: sorted IDs, looked up by binary search. */
interface DeezerData {
  tracks: Uint32Array;
  albums: Uint32Array;
  /** Artists all of whose releases are AI. */
  artists: Uint32Array;
}

function has(ids: Uint32Array, id: number): boolean {
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = ids[mid];
    if (v === id) {
      return true;
    }
    if (v < id) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return false;
}

/** The three arrays one after another, each led by its length. */
function encode(d: DeezerData): Buffer {
  const parts = [d.tracks, d.albums, d.artists];
  const out = new Uint32Array(parts.reduce((n, p) => n + 1 + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out[at++] = p.length;
    out.set(p, at);
    at += p.length;
  }
  return Buffer.from(out.buffer);
}

function decode(buf: Buffer): DeezerData {
  const all = new Uint32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const parts: Uint32Array[] = [];
  let at = 0;
  for (let i = 0; i < 3; i++) {
    const n = all[at++];
    if (n === undefined || at + n > all.length) {
      throw new Error('broken file');
    }
    parts.push(all.subarray(at, at + n));
    at += n;
  }
  return { tracks: parts[0], albums: parts[1], artists: parts[2] };
}

const sorted = (ids: unknown): Uint32Array => Uint32Array.from(Array.isArray(ids) ? ids.filter((x) => Number.isInteger(x) && x > 0) : []).sort();

type Saved = Record<string, { at: number; mark: AiMark }>;

function readSaved(file: string): Saved {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

export interface AiCheckerOptions {
  /** Look up Deezer's detections too. */
  deezer: boolean;
  /** Where Deezer's snapshot is downloaded from (a setting, so the tests can serve their own). */
  deezerUrl: string;
}

/** Finds the AI labels of tracks: Yandex Music's own, then Deezer's. */
export class AiChecker {
  private readonly storageDir: string;
  private readonly client: () => Promise<YandexMusicClient>;
  private readonly fetchImpl: typeof fetch;
  options: AiCheckerOptions = { deezer: true, deezerUrl: DEEZER_AI_DATA };
  private readonly cache = new Map<string, { at: number; ttl: number; mark: Promise<AiMark | null> }>();
  private deezer?: Promise<DeezerData | undefined>;
  private deezerFrom?: string;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private saving = Promise.resolve();

  constructor(storageDir: string, client: () => Promise<YandexMusicClient>, fetchImpl: typeof fetch = fetch) {
    this.storageDir = storageDir;
    this.client = client;
    this.fetchImpl = fetchImpl;
    const now = Date.now();
    for (const [id, { at, mark }] of Object.entries(readSaved(path.join(storageDir, AI_MARKS_FILE)))) {
      if (now - at < LABEL_TTL_MS) {
        this.cache.set(id, { at, ttl: LABEL_TTL_MS, mark: Promise.resolve(mark) });
      }
    }
  }

  /** The track's label, or `null` when neither source labels it or can't be reached. */
  check(track: Track): Promise<AiMark | null> {
    const id = track.id.split(':')[0];
    const now = Date.now();
    const hit = this.cache.get(id);
    if (hit && now - hit.at < hit.ttl) {
      return hit.mark;
    }
    if (this.cache.size >= MAX_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    const entry = { at: now, ttl: CHECKED_TTL_MS, mark: Promise.resolve<AiMark | null>(null) };
    entry.mark = this.find(track).then(({ mark, answered }) => {
      if (mark) {
        entry.ttl = LABEL_TTL_MS;
        this.save(id, now, mark);
      } else if (!answered) {
        entry.ttl = FAILED_TTL_MS;
      }
      return mark;
    });
    this.cache.set(id, entry);
    return entry.mark;
  }

  /** The label, and whether Yandex Music answered: without its answer "no label" means little. */
  private async find(track: Track): Promise<{ mark: AiMark | null; answered: boolean }> {
    let answered = true;
    const fromYandex = await this.limited(() => this.fromYandex(track)).catch(() => {
      answered = false;
      return null;
    });
    const mark = fromYandex ?? (this.options.deezer ? await this.fromDeezer(track).catch(() => null) : null);
    return { mark, answered };
  }

  private async fromYandex(track: Track): Promise<AiMark | null> {
    const credits = await (await this.client()).trackCredits(track.id);
    const ai = credits.find((c) => AI_TITLE.test(c.title.trim()));
    return ai ? markOf(ai.value) : null;
  }

  private async fromDeezer(track: Track): Promise<AiMark | null> {
    const data = await this.deezerData();
    if (!data) {
      return null;
    }
    const flagged =
      has(data.tracks, Number(track.id.split(':')[0])) ||
      track.albums.some((a) => has(data.albums, Number(a.id))) ||
      track.artists.some((a) => has(data.artists, Number(a.id)));
    return flagged ? 'deezer' : null;
  }

  /** Deezer's snapshot: from the disk, or downloaded once and kept there in compact form. */
  private deezerData(): Promise<DeezerData | undefined> {
    const url = this.options.deezerUrl;
    if (!this.deezer || this.deezerFrom !== url) {
      this.deezerFrom = url;
      const file = path.join(this.storageDir, DEEZER_FILE);
      this.deezer = (async () => {
        try {
          const saved = JSON.parse(await fs.promises.readFile(`${file}.json`, 'utf8'));
          if (saved?.url === url) {
            return decode(await fs.promises.readFile(file));
          }
        } catch {
          // not downloaded yet
        }
        const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(60000) });
        if (!res.ok) {
          throw new Error(`${res.status}`);
        }
        const raw = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'))?.deezer ?? {};
        const data = { tracks: sorted(raw.tracks), albums: sorted(raw.albums), artists: sorted(raw.artists_100) };
        await fs.promises.mkdir(this.storageDir, { recursive: true });
        await fs.promises.writeFile(file, encode(data));
        await fs.promises.writeFile(`${file}.json`, JSON.stringify({ url, at: Date.now() }));
        return data;
      })().catch(() => {
        this.deezer = undefined; // try again with a later track
        return undefined;
      });
    }
    return this.deezer;
  }

  /** Runs at most CONCURRENCY lookups at once. */
  private async limited<T>(task: () => Promise<T>): Promise<T> {
    if (this.running >= CONCURRENCY) {
      await new Promise<void>((r) => this.waiting.push(r));
    }
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** Adds a label to the file; writes go one at a time and drop labels that have expired. */
  private save(id: string, at: number, mark: AiMark): void {
    const file = path.join(this.storageDir, AI_MARKS_FILE);
    this.saving = this.saving
      .then(async () => {
        const now = Date.now();
        const saved = readSaved(file);
        saved[id] = { at, mark };
        const fresh = Object.fromEntries(Object.entries(saved).filter(([, s]) => now - s.at < LABEL_TTL_MS));
        await fs.promises.mkdir(this.storageDir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(fresh));
        await fs.promises.rename(tmp, file);
      })
      .catch(() => undefined);
  }
}
