import * as fs from 'fs';
import * as path from 'path';
import type { Track, YandexMusicClient } from './api';

/**
 * Yandex Music's own label of an AI-generated track, from the track's credits ("AI use" in the
 * "About the track" card): the rights holder declares the track made fully or partly with AI;
 * when they haven't, Yandex's detector may label it as possibly made with AI. A track without
 * the label is `null`: unlabeled, which doesn't prove it isn't AI.
 */
export type AiMark = 'full' | 'partial' | 'possible';
const MARKS: readonly AiMark[] = ['full', 'partial', 'possible'];

/** The labels found, so that they outlive the process; the service and the windows share it. */
export const AI_MARKS_FILE = 'ai-labels.json';
/** Files of earlier versions: slopless.art's answers, and a snapshot of Deezer's detections. */
const OLD_FILES = ['ai-marks.json', 'deezer-ai.bin', 'deezer-ai.bin.json'];

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

type Saved = Record<string, { at: number; mark: AiMark }>;

function readSaved(file: string): Saved {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

/** Finds Yandex Music's AI labels of tracks. */
export class AiChecker {
  private readonly storageDir: string;
  private readonly client: () => Promise<YandexMusicClient>;
  private readonly cache = new Map<string, { at: number; ttl: number; mark: Promise<AiMark | null> }>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private saving = Promise.resolve();

  constructor(storageDir: string, client: () => Promise<YandexMusicClient>) {
    this.storageDir = storageDir;
    this.client = client;
    for (const file of OLD_FILES) {
      fs.promises.rm(path.join(storageDir, file), { force: true }).catch(() => undefined);
    }
    const now = Date.now();
    for (const [id, { at, mark }] of Object.entries(readSaved(path.join(storageDir, AI_MARKS_FILE)))) {
      // Labels of another kind were Deezer's, which are no longer used.
      if (now - at < LABEL_TTL_MS && MARKS.includes(mark)) {
        this.cache.set(id, { at, ttl: LABEL_TTL_MS, mark: Promise.resolve(mark) });
      }
    }
  }

  /** The track's label, or `null` when it has none or Yandex Music can't be reached. */
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
    try {
      const credits = await this.limited(async () => (await this.client()).trackCredits(track.id));
      const ai = credits.find((c) => AI_TITLE.test(c.title.trim()));
      return { mark: ai ? markOf(ai.value) : null, answered: true };
    } catch {
      return { mark: null, answered: false };
    }
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
