import * as vscode from 'vscode';

/**
 * The mini player card in the status bar is drawn with SVG images: VS Code's markdown tooltip
 * strips CSS but allows <img> with data: URIs, and an image can be wrapped in a command link.
 * That way the card looks like the panel and its buttons stay clickable.
 */

export interface CardTrack {
  title: string;
  artists: string;
  /** Cover as a data: URI, since an SVG rendered as an image won't load external images. */
  cover?: string;
  source?: string;
  details: string[];
  playing: boolean;
  liked: boolean;
}

const WIDTH = 360;
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Ubuntu, sans-serif`;
const MONO = `ui-monospace, 'SF Mono', Menlo, Consolas, monospace`;

interface Palette {
  fg: string;
  muted: string;
  chip: string;
  accentText: string;
  like: string;
}

function palette(): Palette {
  const kind = vscode.window.activeColorTheme.kind;
  const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
  return light
    ? { fg: '#1A1A1C', muted: '#5E5E66', chip: 'rgba(0,0,0,0.07)', accentText: '#8A6A00', like: '#E0351A' }
    : { fg: '#E8EAEE', muted: '#A7ADB8', chip: 'rgba(255,255,255,0.09)', accentText: '#FFCC00', like: '#FF5A36' };
}

function xml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}

function dataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function image(svg: string, alt: string): string {
  return `![${alt}](${dataUri(svg)})`;
}

/** An image that links to a command. */
function button(svg: string, command: string, title: string): string {
  return `[${image(svg, title)}](command:${command} "${title}")`;
}

const ICONS = {
  prev: '<path d="M6 5v14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M19 5 9 12l10 7z" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  next: '<path d="M18 5v14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M5 5l10 7-10 7z" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  heartOn: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" fill="currentColor"/>',
  note: '<path d="M9 18V5l11-2v13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="17" cy="16" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  wave: '<path d="M3 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
};

function icon(body: string, x: number, y: number, size: number, color: string): string {
  return `<g transform="translate(${x} ${y}) scale(${size / 24})" color="${color}">${body}</g>`;
}

/** Cover, title, artist and the source line. */
function header(t: CardTrack, p: Palette): string {
  const h = 80;
  const tx = 92;
  const clipW = WIDTH - tx;
  const cover = t.cover
    ? `<image href="${t.cover}" x="0" y="0" width="${h}" height="${h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#c)"/>`
    : `<rect width="${h}" height="${h}" rx="10" fill="${p.chip}"/>${icon(ICONS.note, 28, 28, 24, p.muted)}`;
  const source = t.source
    ? `<tspan fill="${p.accentText}" font-weight="600">${xml(t.source)}</tspan>${t.details.length ? `<tspan fill="${p.muted}"> · ${xml(t.details.join(' · '))}</tspan>` : ''}`
    : `<tspan fill="${p.muted}">${xml(t.details.join(' · '))}</tspan>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${h}" viewBox="0 0 ${WIDTH} ${h}">
<defs><clipPath id="c"><rect width="${h}" height="${h}" rx="10"/></clipPath><clipPath id="t"><rect x="${tx}" y="0" width="${clipW}" height="${h}"/></clipPath>
<linearGradient id="f" x1="0" x2="1"><stop offset="0" stop-color="#fff"/><stop offset="0.88" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>
<mask id="m"><rect x="${tx}" y="0" width="${clipW}" height="${h}" fill="url(#f)"/></mask></defs>
${cover}
<g clip-path="url(#t)" mask="url(#m)" font-family="${FONT}">
<text x="${tx}" y="28" font-size="16" font-weight="700" fill="${p.fg}">${xml(t.title)}</text>
<text x="${tx}" y="49" font-size="13" fill="${p.muted}">${xml(t.artists)}</text>
<text x="${tx}" y="70" font-size="11.5">${source}</text>
</g>
</svg>`;
}

/** A tile button in the controls row; the row width is split four ways. */
function tile(body: string, fill: string, color: string, size: number): string {
  const w = (WIDTH - 3 * 6) / 4;
  const h = 38;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<rect width="${w}" height="${h}" rx="8" fill="${fill}"/>${icon(body, (w - size) / 2, (h - size) / 2, size, color)}
</svg>`;
}

export function renderCard(t: CardTrack): string {
  const p = palette();
  const controls = [
    button(tile(ICONS.prev, p.chip, p.fg, 18), 'yandexMusic.previous', 'Previous'),
    t.playing
      ? button(tile(ICONS.pause, '#FFCC00', '#141416', 18), 'yandexMusic.playPause', 'Pause')
      : button(tile(ICONS.play, '#FFCC00', '#141416', 18), 'yandexMusic.playPause', 'Play'),
    button(tile(ICONS.next, p.chip, p.fg, 18), 'yandexMusic.next', 'Next'),
    t.liked
      ? button(tile(ICONS.heartOn, p.chip, p.like, 18), 'yandexMusic.like', 'Remove from Liked')
      : button(tile(ICONS.heart, p.chip, p.fg, 18), 'yandexMusic.like', 'Like'),
  ];
  return `${image(header(t, p), `${t.artists} — ${t.title}`)}\n\n${controls.join('&nbsp;')}`;
}
