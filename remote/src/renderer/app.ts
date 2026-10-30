import type { Bridge, LinkState } from '../bridge.ts';
import { type PlaybackStatus, type RemoteMethod, type RemoteMethods, type SharedState, type Source, type Track, artistLine, baseId, coverUrl, fullTitle } from '../wire.ts';
import { CoverLayers, DEFAULT_PALETTE, type Palette, alignNewAnimations, alignToFrames, barHeights, paletteOf, preloadCover, recordOut, showCover } from '../../../media/nowArt.js';

declare global {
  interface Window {
    ym: Bridge;
  }
}

const BARS = 64;
const VOLUME_STEP = 0.1;
/** Volume restored by unmuting when nothing was muted in this session. */
const DEFAULT_VOLUME = 0.7;
const SEARCH_DELAY_MS = 450;
const IDLE_MS = 3000;

type Tab = 'queue' | 'playlists' | 'search';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) {
    throw new Error(`#${id} is missing`);
  }
  return e as T;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) {
    e.className = className;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgIcon(className: string, viewBox: string, d: string, attrs: Record<string, string> = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  for (const [k, v] of Object.entries(attrs)) {
    svg.setAttribute(k, v);
  }
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}
const HEART = 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z';
const NOTES = 'M9 18V5l11-2v13M6 15a3 3 0 1 1 0 6a3 3 0 1 1 0-6M17 13a3 3 0 1 1 0 6a3 3 0 1 1 0-6';
const WAVE = 'M3 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0';

const fmt = (sec: number): string => {
  if (!Number.isFinite(sec) || sec < 0) {
    return '0:00';
  }
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** A stable number from a string, for the shapes and colors that belong to a track or playlist. */
function hash(s: string): number {
  let x = 2166136261;
  for (const c of s) {
    x = Math.imul(x ^ (c.codePointAt(0) ?? 0), 16777619);
  }
  return x >>> 0;
}

function sourceLabel(source: Source | undefined): string {
  switch (source?.kind) {
    case 'wave':
      return 'My Vibe';
    case 'station':
      return source.id.startsWith('track:') ? `Radio · ${source.name}` : `Station · ${source.name}`;
    case 'liked':
      return 'Liked';
    case 'playlist':
      return source.playlist.title;
    case 'search':
      return `Search · ${source.query}`;
    default:
      return '';
  }
}

// ---------------------------------------------------------------- elements

const root = el('root');
const bgCovers = new CoverLayers(el('bgArt'));
const showRecord = recordOut(root);
const cover = el('cover');
const coverWrap = el('coverWrap');
const vinylLabel = el('vinylLabel');
const heading = el('heading');
const title = el('title');
const artist = el('artist');
const aiBadge = el('aiBadge');
const sourceWave = el('sourceWave');
const sourceLabelEl = el('sourceLabel');
const radioBtn = el<HTMLButtonElement>('radioBtn');
const stream = el('stream');
const bars = el('bars');
const elapsedEl = el('elapsed');
const totalEl = el('total');
const upNext = el<HTMLButtonElement>('upNext');
const playBtn = el<HTMLButtonElement>('playBtn');
const likeBtn = el<HTMLButtonElement>('likeBtn');
const heartBox = el('heartBox');
const dislikeBtn = el<HTMLButtonElement>('dislikeBtn');
const muteBtn = el<HTMLButtonElement>('muteBtn');
const volLabel = el('volLabel');
const volFill = el('volFill');
const volTrack = el('volTrack');
const queueBtn = el<HTMLButtonElement>('queueBtn');
const pills = { wave: el<HTMLButtonElement>('pillVibe'), liked: el<HTMLButtonElement>('pillLiked'), playlist: el<HTMLButtonElement>('pillPlaylists') };
const tabs: Record<Tab, HTMLButtonElement> = { queue: el('tabQueue'), playlists: el('tabPlaylists'), search: el('tabSearch') };
const panes: Record<Tab, HTMLElement> = { queue: el('queuePane'), playlists: el('playlistsPane'), search: el('searchPane') };
const query = el<HTMLInputElement>('query');
const searchHint = el('searchHint');
const searchList = el('searchList');
const toastEl = el('toast');
const overlay = el('overlay');

const barEls: HTMLElement[] = [];
for (let i = 0; i < BARS; i++) {
  const b = h('i');
  barEls.push(b);
  bars.append(b);
}

// ---------------------------------------------------------------- state

let link: LinkState = 'starting';
/** The account was asked for once on this service; a service the app started knows nothing yet. */
let accountRequested = false;
let state: SharedState | undefined;
let status: PlaybackStatus = { playing: false, position: 0, duration: 0 };
/** When the status arrived: between updates the position runs on from it. */
let statusAt = performance.now();
let drawerOpen = false;
let tab: Tab = 'queue';
let shownTrackId: string | undefined;
/** The cover has been drawn once, for a track or for no track. */
let shownOnce = false;
let lastError: string | undefined;
let playlistsRequested = false;
/** The query the search results belong to. */
let searchedQuery = '';
let searching = false;
let lastQueueKey = '';
let lastPlaylistsKey = '';
let lastSearchKey = '';
let preMuteVolume = DEFAULT_VOLUME;

const current = (): Track | undefined => (state && state.index >= 0 ? state.queue[state.index] : undefined);
const isLiked = (t: Track): boolean => !!state?.liked.includes(baseId(t.id));
const isAi = (t: Track): boolean => state?.slop?.[baseId(t.id)] === true;
const duration = (): number => status.duration || (current()?.durationMs ?? 0) / 1000;
const position = (): number => {
  const at = status.position || 0;
  return status.playing ? Math.min(at + (performance.now() - statusAt) / 1000, duration() || Infinity) : at;
};

// ---------------------------------------------------------------- calls and messages

let toastTimer: number | undefined;
function toast(text: string, error = false): void {
  toastEl.textContent = text;
  toastEl.classList.toggle('error', error);
  toastEl.classList.remove('show');
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), error ? 6000 : 3500);
}

function run<M extends RemoteMethod>(method: M, ...args: RemoteMethods[M]): Promise<unknown> {
  return window.ym.call(method, ...args).catch((e: unknown) => {
    // Electron prefixes errors that cross IPC with where they came from.
    const text = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
    toast(text, true);
  });
}

// Writes that happen on every status from the service go through these: writing the same value
// again still makes the page restyle and repaint.
function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) {
    e.textContent = text;
  }
}

function setAttr(e: Element, name: string, value: string): void {
  if (e.getAttribute(name) !== value) {
    e.setAttribute(name, value);
  }
}

function setHidden(e: HTMLElement, hidden: boolean): void {
  if (e.hidden !== hidden) {
    e.hidden = hidden;
  }
}

/** Restarts a one-shot CSS animation by taking its class off and putting it back. */
function replay(e: HTMLElement, className: string): void {
  e.classList.remove(className);
  void e.offsetWidth;
  e.classList.add(className);
}

// ---------------------------------------------------------------- now playing

function applyPalette(p: Palette): void {
  const s = root.style;
  s.setProperty('--base', p.base);
  s.setProperty('--pal-a', p.a);
  s.setProperty('--pal-b', p.b);
  s.setProperty('--glow', `${p.a}55`);
}

function showTrack(t: Track | undefined): void {
  const id = t?.id;
  if (shownOnce && id === shownTrackId) {
    return;
  }
  const first = !shownOnce;
  shownOnce = true;
  shownTrackId = id;
  if (!first) {
    replay(coverWrap, 'pop');
    replay(heading, 'pop');
  }
  const big = coverUrl(t?.coverUri, 800);
  showCover(cover, big);
  const label = coverUrl(t?.coverUri, 200);
  vinylLabel.style.backgroundImage = label ? `url("${label}")` : '';
  bgCovers.show(coverUrl(t?.coverUri, 400));
  const small = coverUrl(t?.coverUri, 100);
  if (small) {
    paletteOf(small)
      .then((p) => shownTrackId === id && applyPalette(p))
      .catch(() => shownTrackId === id && applyPalette(DEFAULT_PALETTE));
  } else {
    applyPalette(DEFAULT_PALETTE);
  }
  const heights = barHeights(t?.id ?? '', BARS);
  barEls.forEach((b, i) => {
    b.style.height = `${(heights[i] ?? 1) * 100}%`;
  });
}

const TITLE_MIN_PX = 32;
/** A title stays on one line as long as that takes no less than this share of the full size. */
const TITLE_ONE_LINE_SHARE = 0.6;
let fittedWidth = 0;

/**
 * Picks the title size, up to the one in the stylesheet, at which no word is broken: one line
 * if that doesn't make it much smaller, otherwise the largest size for two lines. Holding on
 * to one line keeps the title from rewrapping, and the cover from moving, while the drawer
 * slides. Words are broken only when one doesn't fit even at the smallest size.
 */
function fitTitle(): void {
  fittedWidth = title.clientWidth;
  title.classList.remove('cut');
  title.style.fontSize = '';
  // Measured as a plain block: the line clamp hides extra lines, and the glyphs stick out of
  // the tight lines, so neither the clamped height nor scrollHeight tells the line count.
  title.style.display = 'block';
  const full = parseFloat(getComputedStyle(title).fontSize);
  const fits = (lines: number, px: number): boolean => {
    title.style.fontSize = `${px}px`;
    return title.scrollWidth <= title.clientWidth && title.clientHeight <= lines * parseFloat(getComputedStyle(title).lineHeight) + 1;
  };
  const largest = (lines: number, min: number): number | undefined => {
    if (fits(lines, full)) {
      return full;
    }
    if (!fits(lines, min)) {
      return undefined;
    }
    let lo = min;
    let hi = full;
    while (hi - lo > 1) {
      const mid = (lo + hi) / 2;
      if (fits(lines, mid)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return Math.floor(lo);
  };
  const size = largest(1, Math.max(TITLE_MIN_PX, full * TITLE_ONE_LINE_SHARE)) ?? largest(2, TITLE_MIN_PX);
  title.style.fontSize = size === full ? '' : `${size ?? TITLE_MIN_PX}px`;
  title.classList.toggle('cut', size === undefined);
  title.style.display = '';
}
new ResizeObserver(() => {
  if (title.clientWidth !== fittedWidth) {
    fitTitle();
  }
}).observe(title);
void document.fonts.ready.then(fitTitle);

function renderNow(): void {
  const t = current();
  showTrack(t);
  const playing = status.playing && !!t;
  showRecord(playing);
  if (root.classList.contains('playing') !== playing) {
    root.classList.toggle('playing', playing);
    // Resumed animations start anew, off the 30 Hz grid.
    alignToFrames(root);
  }
  const titleText = t ? fullTitle(t) : 'Nothing is playing';
  if (title.textContent !== titleText) {
    title.textContent = titleText;
    fitTitle();
  }
  setText(artist, t ? artistLine(t) : 'Start My Vibe or Liked above');
  const label = t ? sourceLabel(state?.source) : '';
  setText(sourceLabelEl, label);
  sourceWave.toggleAttribute('hidden', !(state?.source?.kind === 'wave' || state?.source?.kind === 'station'));
  setHidden(aiBadge, !t || !isAi(t));
  setHidden(el('source'), !label && aiBadge.hidden);
  const trackRadio = !!t && state?.source?.kind === 'station' && state.source.id === `track:${baseId(t.id)}`;
  setHidden(radioBtn, !t || trackRadio);
  setText(stream, t ? (state?.streamInfo ?? '').replace(/^MP3 /, 'MP3 · ') : '');

  const next = state && t ? state.queue[state.index + 1] : undefined;
  setHidden(upNext, !next);
  if (next) {
    preloadCover(coverUrl(next.coverUri, 800));
    const art = coverUrl(next.coverUri, 100);
    el('nextArt').style.backgroundImage = art ? `url("${art}")` : '';
    setText(el('nextTitle'), fullTitle(next));
    setText(el('nextArtist'), `· ${artistLine(next)}`);
  }

  setAttr(playBtn, 'aria-label', status.playing ? 'Pause' : 'Play');
  const liked = !!t && isLiked(t);
  setAttr(likeBtn, 'aria-pressed', String(liked));
  setAttr(likeBtn, 'aria-label', liked ? 'Remove from Liked' : 'Like');
  const disliked = !!t && !!state?.disliked?.includes(baseId(t.id));
  setAttr(dislikeBtn, 'aria-pressed', String(disliked));
  setAttr(dislikeBtn, 'aria-label', disliked ? 'Remove dislike' : 'Dislike and skip');
  likeBtn.disabled = dislikeBtn.disabled = !t;

  const kind = state?.source?.kind;
  setAttr(pills.wave, 'aria-pressed', String(kind === 'wave'));
  setAttr(pills.liked, 'aria-pressed', String(kind === 'liked'));
  setAttr(pills.playlist, 'aria-pressed', String(kind === 'playlist'));

  const acc = state?.account;
  const avatar = el('avatar');
  setText(avatar, acc ? (acc.displayName || acc.login).trim().charAt(0).toUpperCase() : '');
  setAttr(avatar, 'aria-label', acc ? acc.displayName || acc.login : 'Account');
  setAttr(avatar, 'title', acc ? acc.login : '');

  const vol = state?.volume;
  const pct = vol === undefined ? undefined : Math.round(vol * 100);
  setText(volLabel, pct === undefined ? '—' : String(pct));
  volFill.style.width = `${pct ?? 0}%`;
  setAttr(volTrack, 'aria-label', pct === undefined ? 'Volume' : `Volume ${pct}%`);
  const muted = vol === 0;
  root.classList.toggle('muted', muted);
  setAttr(muteBtn, 'aria-pressed', String(muted));
  setAttr(muteBtn, 'aria-label', muted ? 'Unmute' : 'Mute');
  setText(totalEl, fmt(duration()));
  paintProgress();
}

/** The played bars and the clock; runs every frame while music plays. */
let litBars = -1;
function paintProgress(): void {
  const d = duration();
  const frac = d ? Math.min(1, position() / d) : 0;
  const lit = Math.round(frac * BARS * 2) / 2;
  if (lit !== litBars) {
    litBars = lit;
    barEls.forEach((b, i) => b.classList.toggle('on', (i + 0.5) / BARS <= frac));
  }
  setAttr(bars, 'aria-valuenow', String(Math.round(frac * 100)));
  setAttr(bars, 'aria-valuetext', `${fmt(position())} of ${fmt(d)}`);
  setText(elapsedEl, fmt(position()));
}

/** The progress moves in whole seconds and half bars, so a few updates a second are enough. */
const PROGRESS_TICK_MS = 250;

// ---------------------------------------------------------------- drawer

function trackRow(t: Track, opts: { current?: boolean; past?: boolean; onPlay: () => void }): HTMLButtonElement {
  const row = h('button', 'row');
  row.classList.toggle('current', !!opts.current);
  row.classList.toggle('past', !!opts.past);
  row.classList.toggle('na', t.available === false);
  const thumb = h('span', 'thumb');
  const art = coverUrl(t.coverUri, 100);
  if (art) {
    thumb.style.backgroundImage = `url("${art}")`;
  }
  if (opts.current) {
    const eq = h('span', 'eq');
    eq.append(h('i'), h('i'), h('i'));
    thumb.append(eq);
  }
  const text = h('span', 'text');
  text.append(h('span', 't', fullTitle(t)), h('span', 'a', artistLine(t)));
  row.append(thumb, text);
  if (isLiked(t)) {
    row.append(svgIcon('heart', '0 0 24 24', HEART, { role: 'img', 'aria-label': 'Liked' }));
  }
  if (isAi(t)) {
    row.append(h('span', 'ai', 'AI'));
  }
  if (t.durationMs) {
    row.append(h('span', 'd', fmt(t.durationMs / 1000)));
  }
  row.addEventListener('click', opts.onPlay);
  return row;
}

function renderQueue(): void {
  const s = state;
  const pane = panes.queue;
  const key = s ? JSON.stringify([s.index, s.queue.map((t) => t.id), s.liked.length, Object.keys(s.slop ?? {}).length]) : '';
  if (key === lastQueueKey) {
    return;
  }
  lastQueueKey = key;
  pane.replaceChildren();
  if (!s || !s.queue.length) {
    pane.append(h('div', 'hint', 'The queue is empty. Start My Vibe or a playlist.'));
    return;
  }
  const start = Math.max(0, s.index - 1);
  s.queue.slice(start).forEach((t, k) => {
    const i = start + k;
    pane.append(trackRow(t, { current: i === s.index, past: i < s.index, onPlay: () => void run('playIndex', i) }));
  });
  pane.querySelector('.row.current')?.scrollIntoView({ block: 'nearest' });
}

const TILE_COLORS: readonly (readonly [string, string])[] = [
  ['#8E1E10', '#FF5A36'],
  ['#0E3E48', '#5FE0C8'],
  ['#2E1B5C', '#B69CFF'],
  ['#5A4410', '#FFCC00'],
  ['#14305E', '#7FB4FF'],
  ['#1E2028', '#FF4F9A'],
];

function tile(name: string, sub: string, icon: SVGSVGElement, colors: readonly [string, string], isCurrent: boolean, onPick: () => void): HTMLButtonElement {
  const b = h('button', 'tile');
  b.classList.toggle('current', isCurrent);
  const art = h('span', 'tile-art');
  art.style.background = `radial-gradient(circle at 30% 30%, ${colors[1]} 0 22%, transparent 22.5%), linear-gradient(140deg, ${colors[0]} 0%, #0B0D12 100%)`;
  art.append(icon);
  b.append(art, h('span', 'n', name), h('span', 'sub', sub));
  b.addEventListener('click', onPick);
  return b;
}

function renderPlaylists(): void {
  const s = state;
  const pane = panes.playlists;
  const src = s?.source;
  const key = s ? JSON.stringify([s.playlists, src, !!s.account, playlistsRequested]) : '';
  if (key === lastPlaylistsKey) {
    return;
  }
  lastPlaylistsKey = key;
  pane.replaceChildren();
  if (!s?.account) {
    pane.append(h('div', 'hint', 'Sign in to Yandex Music in VS Code to see your playlists.'));
    return;
  }
  const grid = h('div', 'grid');
  grid.append(
    tile('Liked', 'Your collection', svgIcon('', '0 0 24 24', HEART, { fill: 'currentColor' }), TILE_COLORS[0] ?? ['#000', '#fff'], src?.kind === 'liked', () => {
      void run('playSource', { kind: 'liked' });
    }),
  );
  for (const p of s.playlists) {
    const isCurrent = src?.kind === 'playlist' && `${src.playlist.uid}:${src.playlist.kind}` === `${p.uid}:${p.kind}`;
    const colors = TILE_COLORS[hash(`${p.uid}:${p.kind}`) % TILE_COLORS.length] ?? ['#000', '#fff'];
    const sub = `${p.trackCount} ${p.trackCount === 1 ? 'track' : 'tracks'}`;
    const icon = svgIcon('', '0 0 24 24', NOTES, { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    grid.append(tile(p.title, sub, icon, colors, isCurrent, () => void run('playSource', { kind: 'playlist', playlist: p })));
  }
  pane.append(grid);
  if (!s.playlists.length) {
    pane.append(h('div', 'hint', playlistsRequested ? 'Loading playlists…' : 'No playlists yet.'));
  }
}

function renderSearch(): void {
  const s = state;
  const q = query.value.trim();
  const fresh = !!s && q !== '' && q === searchedQuery;
  const stations = fresh ? (s.searchStations ?? []) : [];
  const results = fresh ? s.searchResults : [];
  searchHint.textContent = !q ? 'Type a track, artist or genre. Tap a result to play it.' : searching ? 'Searching…' : fresh && !stations.length && !results.length ? 'Nothing found' : '';
  searchHint.hidden = !searchHint.textContent;
  const key = JSON.stringify([fresh, stations.map((x) => x.id), results.map((t) => t.id), s?.index, s?.source]);
  if (key === lastSearchKey) {
    return;
  }
  lastSearchKey = key;
  searchList.replaceChildren();
  for (const st of stations) {
    const row = h('button', 'row');
    row.classList.toggle('current', s?.source?.kind === 'station' && s.source.id === st.id);
    const thumb = h('span', 'thumb');
    if (st.color && /^#[0-9a-f]{3,8}$/i.test(st.color)) {
      thumb.style.backgroundColor = st.color;
    }
    if (st.icon) {
      const img = h('img');
      img.alt = '';
      img.src = st.icon;
      img.addEventListener('error', () => img.remove());
      thumb.append(img);
    } else {
      thumb.append(svgIcon('', '0 0 24 24', WAVE, { width: '28', height: '28', fill: 'none', stroke: '#FFCC00', 'stroke-width': '2.3', 'stroke-linecap': 'round' }));
    }
    const text = h('span', 'text');
    text.append(h('span', 't', st.name), h('span', 'a', 'Genre station'));
    row.append(thumb, text);
    row.addEventListener('click', () => void run('playSource', { kind: 'station', id: st.id, name: st.name }));
    searchList.append(row);
  }
  const cur = current();
  results.forEach((t, i) => {
    searchList.append(trackRow(t, { current: !!cur && cur.id === t.id, onPlay: () => void run('playTracks', [...results], i, { kind: 'search', query: searchedQuery }) }));
  });
}

function renderDrawer(): void {
  root.classList.toggle('drawer-open', drawerOpen);
  queueBtn.setAttribute('aria-pressed', String(drawerOpen));
  for (const k of Object.keys(tabs) as Tab[]) {
    tabs[k].setAttribute('aria-selected', String(k === tab));
    panes[k].hidden = k !== tab;
  }
  if (!drawerOpen) {
    return;
  }
  if (tab === 'queue') {
    renderQueue();
  } else if (tab === 'playlists') {
    if (state?.account && !state.playlists.length && !playlistsRequested) {
      playlistsRequested = true;
      void run('loadPlaylists').finally(() => {
        playlistsRequested = false;
        renderDrawer();
      });
    }
    renderPlaylists();
  } else {
    renderSearch();
  }
}

function openDrawer(open: boolean, which: Tab = tab): void {
  drawerOpen = open;
  tab = which;
  renderDrawer();
  if (open && which === 'search') {
    query.focus();
  }
}

let searchTimer: number | undefined;
function search(now: boolean): void {
  clearTimeout(searchTimer);
  const q = query.value.trim();
  if (!q) {
    renderSearch();
    return;
  }
  searchTimer = window.setTimeout(
    () => {
      searching = true;
      searchedQuery = q;
      renderSearch();
      void run('search', q).finally(() => {
        searching = false;
        renderSearch();
      });
    },
    now ? 0 : SEARCH_DELAY_MS,
  );
}

// ---------------------------------------------------------------- overlay

function renderOverlay(): void {
  let head = '';
  let text = '';
  if (link === 'starting') {
    head = 'Starting the player';
    text = 'Connecting to Yandex Music…';
  } else if (link === 'searching') {
    head = 'The player didn’t start';
    text = 'Open VS Code with the Yandex Music extension once, then try again. The remote keeps trying by itself.';
  } else if (link === 'no-extension') {
    head = 'Install Yandex Music for VS Code';
    text = 'The remote controls the player of the Yandex Music extension. Install it in VS Code from the Extensions view, sign in there once, and the remote will start the player by itself.';
  } else if (link === 'outdated') {
    head = 'Update needed';
    text = 'This remote and the Yandex Music extension in VS Code speak different versions. Update both, then reload the VS Code windows.';
  } else if (link === 'old-service') {
    head = 'Restart the player';
    text = 'The player was started by an older version of the Yandex Music extension. Update the extension, then reload the VS Code windows.';
  } else if (state?.accountChecked && !state.account) {
    head = 'Sign in in VS Code';
    text = 'Run “Yandex Music: Sign In” from the VS Code Command Palette.';
  }
  overlay.hidden = !head;
  el('overlayTitle').textContent = head;
  el('overlayText').textContent = text;
}

function renderAll(): void {
  renderOverlay();
  renderNow();
  renderDrawer();
}

// ---------------------------------------------------------------- input

function setVolume(value: number): void {
  const v = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
  if (state) {
    state.volume = v; // shown at once; the service confirms with its next state
    renderNow();
  }
  void run('setVolume', v);
}

function stepVolume(delta: number): void {
  setVolume((state?.volume ?? DEFAULT_VOLUME) + delta);
}

function toggleMute(): void {
  const v = state?.volume ?? DEFAULT_VOLUME;
  if (v > 0) {
    preMuteVolume = v;
    setVolume(0);
  } else {
    setVolume(preMuteVolume || DEFAULT_VOLUME);
  }
}

function like(): void {
  if (!current()) {
    return;
  }
  replay(heartBox, 'beat');
  void run('toggleLike');
}

pills.wave.addEventListener('click', () => void run('playSource', { kind: 'wave' }));
pills.liked.addEventListener('click', () => void run('playSource', { kind: 'liked' }));
pills.playlist.addEventListener('click', () => openDrawer(true, 'playlists'));
queueBtn.addEventListener('click', () => openDrawer(!drawerOpen));
el('closeDrawer').addEventListener('click', () => openDrawer(false));
for (const k of Object.keys(tabs) as Tab[]) {
  tabs[k].addEventListener('click', () => openDrawer(true, k));
}
radioBtn.addEventListener('click', () => void run('startTrackRadio'));
upNext.addEventListener('click', () => void run('next'));
playBtn.addEventListener('click', () => void run('playPause'));
el('prevBtn').addEventListener('click', () => void run('previous'));
el('nextBtn').addEventListener('click', () => void run('next'));
likeBtn.addEventListener('click', like);
dislikeBtn.addEventListener('click', () => void run('toggleDislike'));
muteBtn.addEventListener('click', toggleMute);
el('volDown').addEventListener('click', () => stepVolume(-VOLUME_STEP));
el('volUp').addEventListener('click', () => stepVolume(VOLUME_STEP));
query.addEventListener('input', () => search(false));
el('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  search(true);
});

function seekTo(frac: number): void {
  const d = duration();
  if (!d || !current()) {
    return;
  }
  const to = Math.min(1, Math.max(0, frac)) * d;
  status = { ...status, position: to };
  statusAt = performance.now();
  paintProgress();
  void run('seek', to);
}
bars.addEventListener('pointerdown', (e) => {
  const r = bars.getBoundingClientRect();
  seekTo((e.clientX - r.left) / r.width);
});

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) {
    return;
  }
  const typing = e.target instanceof HTMLInputElement;
  if (e.key === 'Escape') {
    if (typing) {
      query.blur();
    } else if (drawerOpen) {
      openDrawer(false);
    } else {
      window.ym.leaveFullScreen();
    }
    return;
  }
  if (typing) {
    return;
  }
  const action: Record<string, () => void> = {
    ' ': () => void run('playPause'),
    ArrowRight: () => void run('next'),
    ArrowLeft: () => void run('previous'),
    ArrowUp: () => stepVolume(VOLUME_STEP),
    ArrowDown: () => stepVolume(-VOLUME_STEP),
    l: like,
    m: toggleMute,
    q: () => openDrawer(!drawerOpen || tab !== 'queue', 'queue'),
    '/': () => openDrawer(true, 'search'),
    f: () => window.ym.toggleFullScreen(),
  };
  const act = action[e.key];
  if (act) {
    e.preventDefault();
    act();
  }
});

let idleTimer: number | undefined;
document.addEventListener('pointermove', () => {
  root.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => root.classList.add('idle'), IDLE_MS);
});

// ---------------------------------------------------------------- events from the service

/** A service the app has just started hasn't looked up the account; VS Code windows do it on their own. */
function checkAccount(): void {
  if (link === 'connected' && state && !state.accountChecked && !accountRequested) {
    accountRequested = true;
    void run('refreshAccount');
  }
}

window.ym.onEvent((event) => {
  switch (event.type) {
    case 'link':
      link = event.link;
      if (link !== 'connected') {
        accountRequested = false;
      }
      checkAccount();
      renderAll();
      break;
    case 'state':
      state = event.state;
      checkAccount();
      if (state.lastError && state.lastError !== lastError) {
        toast(state.lastError, true);
      }
      lastError = state.lastError;
      renderAll();
      break;
    case 'status':
      status = event.status;
      statusAt = performance.now();
      renderNow();
      break;
    case 'notice':
      toast(event.text.replace(/^Yandex Music: /, ''));
      break;
  }
});

alignNewAnimations();
renderAll();
window.setInterval(() => status.playing && paintProgress(), PROGRESS_TICK_MS);
