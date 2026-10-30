// @ts-check
/**
 * The now-playing art shared by the player panel (media/player.js) and the fullscreen remote
 * (remote/src/renderer/app.ts); its styles are in nowArt.css. Everything here is worked out
 * once per cover or track, so that the animations themselves are plain transforms.
 */

/** @typedef {{ base: string, a: string, b: string }} Palette */
/** @typedef {readonly [number, number, number]} Rgb */

/** @type {Palette} */
export const DEFAULT_PALETTE = { base: '#0B0D12', a: '#3B8FA8', b: '#6A5CFF' };

/** @param {Rgb} c */
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** @param {Rgb} c */
function hsv([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max / 255 };
}

/** @param {number} a @param {number} b */
const hueGap = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/**
 * Brings a color to at least the given brightness, keeping its hue, so it glows on a dark page.
 * @param {Rgb} c
 * @param {number} minV
 * @returns {Rgb}
 */
function lift(c, minV) {
  const v = Math.max(...c) / 255;
  if (v >= minV || v === 0) {
    return v === 0 ? [minV * 255, minV * 255, minV * 255] : c;
  }
  const k = minV / v;
  return [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
}

/**
 * An image whose pixels the page may read: a cover served with CORS (Yandex's avatars are) or a data URL.
 * @param {string} url
 */
async function load(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  return img;
}

/** @param {number} size @param {boolean} read */
function canvas2d(size, read) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: read });
  if (!ctx) {
    throw new Error('No 2D canvas');
  }
  return { canvas, ctx };
}

/**
 * Colors taken from a cover: a dark base for the page and two vivid ones for the glow and the
 * spots. The vivid colors are the most saturated and bright pixels; the second is picked from
 * another hue when the cover has one.
 * @param {string} url
 * @returns {Promise<Palette>}
 */
export async function paletteOf(url) {
  const img = await load(url);
  const size = 24;
  const { ctx } = canvas2d(size, true);
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  /** @type {{ c: Rgb, h: number, score: number }[]} */
  const pixels = [];
  /** @type {[number, number, number]} */
  let sum = [0, 0, 0];
  for (let i = 0; i + 2 < data.length; i += 4) {
    /** @type {Rgb} */
    const c = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
    sum = [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]];
    const { h, s, v } = hsv(c);
    pixels.push({ c, h, score: s * 0.7 + v * 0.3 + (s > 0.25 && v > 0.3 ? 0.4 : 0) });
  }
  const n = pixels.length || 1;
  pixels.sort((x, y) => y.score - x.score);
  const first = pixels[0];
  if (!first) {
    return DEFAULT_PALETTE;
  }
  const second = pixels.find((p) => hueGap(p.h, first.h) > 40 && p.score > 0.5) ?? pixels[Math.floor(pixels.length / 6)] ?? first;
  // The base is the cover's average color, darkened well below the text.
  /** @type {Rgb} */
  const base = [(sum[0] / n) * 0.28, (sum[1] / n) * 0.28, (sum[2] / n) * 0.28];
  return { base: hex(base), a: hex(lift(first.c, 0.6)), b: hex(lift(second.c, 0.5)) };
}

/**
 * The cover blurred once into a small image for the background, so the page doesn't blur a
 * large layer on every frame it drifts. Drawn past the edges so the blur doesn't fade them out.
 * @param {string} url
 */
export async function blurredOf(url) {
  const img = await load(url);
  const size = 64;
  const { canvas, ctx } = canvas2d(size, false);
  ctx.filter = 'blur(5px) saturate(1.5)';
  ctx.drawImage(img, -12, -12, size + 24, size + 24);
  return canvas.toDataURL();
}

/** The background's covers: each new one fades in over the previous ones, which go once it has. */
export class CoverLayers {
  /** @param {HTMLElement} container */
  constructor(container) {
    this.container = container;
    /** @type {string | undefined} */
    this.shown = undefined;
  }

  /** @param {string | undefined} url */
  show(url) {
    if (url === this.shown) {
      return;
    }
    this.shown = url;
    const layer = document.createElement('div');
    layer.className = 'now-bg-cover';
    const art = document.createElement('div');
    layer.append(art);
    const add = () => {
      if (this.shown !== url) {
        return;
      }
      this.container.append(layer);
      setTimeout(() => {
        while (this.container.children.length > 1 && this.container.firstElementChild !== layer) {
          this.container.firstElementChild?.remove();
        }
      }, 1600);
    };
    if (!url) {
      add();
      return;
    }
    blurredOf(url)
      .then((blurred) => {
        art.style.backgroundImage = `url("${blurred}")`;
      })
      .catch(() => undefined)
      .finally(add);
  }
}

/** Covers already loaded, which show at once. */
const loadedCovers = new Set();
/** Covers being loaded: whether each one came in. */
const pendingCovers = new Map();

/**
 * @param {string} url
 * @returns {Promise<boolean>}
 */
function loadCover(url) {
  let pending = pendingCovers.get(url);
  if (!pending) {
    const img = new Image();
    img.src = url;
    pending = img.decode().then(
      () => {
        loadedCovers.add(url);
        pendingCovers.delete(url);
        return true;
      },
      () => {
        pendingCovers.delete(url);
        return false;
      },
    );
    pendingCovers.set(url, pending);
  }
  return pending;
}

/**
 * Loads a cover ahead of time, such as the next track's, so that it shows at once.
 * @param {string | undefined | null} url
 */
export function preloadCover(url) {
  if (url && !loadedCovers.has(url)) {
    void loadCover(url);
  }
}

/**
 * Shows a cover as an element's background (`.now-cover` in nowArt.css). While the next cover
 * loads the element keeps the one it has, however long that takes; the loading placeholder is
 * only for an element with no cover yet, and the empty one for no cover or one that failed to load.
 * @param {HTMLElement} el
 * @param {string | undefined | null} url
 */
export function showCover(el, url) {
  el.dataset['cover'] = url ?? '';
  /** @param {string} state */
  const set = (state) => {
    el.classList.toggle('cover-loading', state === 'loading');
    el.classList.toggle('cover-empty', state === 'empty');
    el.style.backgroundImage = state === 'loaded' && url ? `url("${url}")` : '';
  };
  if (!url || loadedCovers.has(url)) {
    set(url ? 'loaded' : 'empty');
    return;
  }
  if (!el.style.backgroundImage) {
    set('loading');
  }
  void loadCover(url).then((loaded) => {
    if (el.dataset['cover'] === url) {
      set(loaded ? 'loaded' : 'empty');
    }
  });
}

/** How long music may stop, as it does between two tracks, before the record slides back under the cover. */
const RECORD_HOLD_MS = 1500;

/**
 * Keeps the class `record-out` (the record slid out from under the cover) on an element while
 * music plays and for a moment after it stops, so that a track change doesn't move the record.
 * @param {Element} el
 * @returns {(playing: boolean) => void} to call on every playback status
 */
export function recordOut(el) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  return (playing) => {
    if (playing) {
      clearTimeout(timer);
      timer = undefined;
      el.classList.add('record-out');
    } else if (timer === undefined && el.classList.contains('record-out')) {
      timer = setTimeout(() => {
        timer = undefined;
        el.classList.remove('record-out');
      }, RECORD_HOLD_MS);
    }
  };
}

/** The art's endless animations move in steps of this length (see nowArt.css). */
export const FRAME_MS = 1000 / 30;

/**
 * Puts the running CSS animations under `root` on one grid of FRAME_MS, so that all their steps
 * fall on the same frames and the page draws only those. Called for animations that have just
 * started or resumed; an animation's start moves by less than half a step.
 * @param {Element} root
 */
export function alignToFrames(root) {
  for (const a of root.getAnimations({ subtree: true })) {
    if (a.constructor.name !== 'CSSAnimation') {
      continue;
    }
    a.ready
      .then(() => {
        if (a.playState !== 'running' || a.startTime === null) {
          return;
        }
        const start = Number(a.startTime);
        const aligned = Math.round(start / FRAME_MS) * FRAME_MS;
        if (aligned !== start) {
          a.startTime = aligned;
        }
      })
      .catch(() => undefined);
  }
}

/**
 * Aligns every CSS animation that starts on the page from now on (see alignToFrames), and again
 * on each new cycle, which catches the ones that started before their first frame was known.
 */
export function alignNewAnimations() {
  for (const type of ['animationstart', 'animationiteration']) {
    document.addEventListener(type, (e) => {
      if (e.target instanceof Element) {
        alignToFrames(e.target);
      }
    });
  }
}

/**
 * Heights of a track's progress bars, as fractions of the tallest, shaped by the track's ID so
 * that each track looks its own.
 * @param {string} id
 * @param {number} count
 * @returns {number[]}
 */
export function barHeights(id, count) {
  let h = 2166136261;
  for (const c of id) {
    h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
    const r = (h % 1000) / 1000;
    const env = 0.55 + 0.45 * Math.abs(Math.sin(i * 0.23 + 1));
    out.push((6 + env * (8 + r * 20)) / 34);
  }
  return out;
}
