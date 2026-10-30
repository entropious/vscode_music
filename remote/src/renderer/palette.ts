/** Colors taken from a cover: a dark base for the page and two vivid ones for the glow and the blobs. */
export interface Palette {
  base: string;
  a: string;
  b: string;
}

export const DEFAULT_PALETTE: Palette = { base: '#0B0D12', a: '#3B8FA8', b: '#6A5CFF' };

type Rgb = readonly [number, number, number];

const hex = ([r, g, b]: Rgb): string => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

function hsv([r, g, b]: Rgb): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max / 255 };
}

const hueGap = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

/** Brings a color to at least the given brightness, keeping its hue, so it glows on the dark page. */
function lift(c: Rgb, minV: number): Rgb {
  const v = Math.max(...c) / 255;
  if (v >= minV || v === 0) {
    return v === 0 ? [minV * 255, minV * 255, minV * 255] : c;
  }
  const k = minV / v;
  return [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
}

/**
 * Reads the palette from an image whose pixels the page may read: a cover served with CORS
 * (Yandex's avatars are) or a data URL. The vivid colors are the most saturated and bright
 * pixels; the second is picked from another hue when the cover has one.
 */
export async function paletteOf(url: string): Promise<Palette> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  const size = 24;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return DEFAULT_PALETTE;
  }
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const pixels: { c: Rgb; h: number; score: number }[] = [];
  let sum: [number, number, number] = [0, 0, 0];
  for (let i = 0; i + 2 < data.length; i += 4) {
    const c: Rgb = [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
    sum = [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]];
    const { h, s, v } = hsv(c);
    pixels.push({ c, h, score: s * 0.7 + v * 0.3 + (s > 0.25 && v > 0.3 ? 0.4 : 0) });
  }
  const n = pixels.length || 1;
  const avg: Rgb = [sum[0] / n, sum[1] / n, sum[2] / n];
  pixels.sort((x, y) => y.score - x.score);
  const first = pixels[0];
  if (!first) {
    return DEFAULT_PALETTE;
  }
  const second = pixels.find((p) => hueGap(p.h, first.h) > 40 && p.score > 0.5) ?? pixels[Math.floor(pixels.length / 6)] ?? first;
  // The base is the cover's average color, darkened well below the text.
  const base: Rgb = [avg[0] * 0.28, avg[1] * 0.28, avg[2] * 0.28];
  return { base: hex(base), a: hex(lift(first.c, 0.6)), b: hex(lift(second.c, 0.5)) };
}
