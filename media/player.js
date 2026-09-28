// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();
  const audio = /** @type {HTMLAudioElement} */ (document.getElementById('audio'));
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  const saved = vscode.getState() || {};
  let tab = saved.tab || 'queue';
  let searchQuery = saved.searchQuery || '';
  /** @type {any} */
  let state = { signedOut: false, account: null, current: null, queue: [], index: -1, playlists: [], searchResults: [], source: '', liked: false, error: null };
  let currentTrackId = null;
  let seeking = false;
  let needsGesture = false;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (sec) => {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };
  const cmd = (command, ...args) => vscode.postMessage({ type: 'command', command, args });

  // In a remote-control window the audio plays in another window, so playback follows the reported status.
  const isPlaying = () => (state.remote ? !!(state.status && state.status.playing) : !audio.paused);
  // The playing window reports status once a second; in between, the position is extrapolated from the clock.
  let statusAt = performance.now();
  const position = () => {
    if (!state.remote) return audio.currentTime;
    const st = state.status;
    if (!st) return 0;
    const at = st.position || 0;
    return st.playing ? Math.min(at + (performance.now() - statusAt) / 1000, st.duration || Infinity) : at;
  };
  const duration = () => (state.remote ? (state.status && state.status.duration) || 0 : audio.duration);

  function reportStatus() {
    vscode.postMessage({ type: 'status', playing: !audio.paused && !audio.ended, position: audio.currentTime, duration: audio.duration || 0, trackId: currentTrackId, needsGesture });
  }

  // Icons: outline SVGs colored via currentColor.
  const svg = (body, size = 20, extra = '') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" ${extra}>${body}</svg>`;
  const line = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  const I = {
    prev: svg('<path d="M6 5v14"/><path d="M19 5 9 12l10 7z"/>', 20, 'fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'),
    next: svg('<path d="M18 5v14"/><path d="M5 5l10 7-10 7z"/>', 20, 'fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'),
    play: svg('<path d="M8 5.5v13l10.5-6.5z"/>', 22, 'fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"'),
    pause: svg('<path d="M8.5 5.5v13"/><path d="M15.5 5.5v13"/>', 22, 'fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"'),
    heart: svg('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>', 18, line),
    heartOn: svg('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>', 18, 'fill="currentColor"'),
    wave: (size) => svg('<path d="M3 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/>', size, 'fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"'),
    speaker: svg('<path d="M4 9h3l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6"/>', 16, line),
    mute: svg('<path d="M4 9h3l5-4v14l-5-4H4z"/><path d="M16 10l4 4"/><path d="M20 10l-4 4"/>', 16, line),
    logout: svg('<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>', 18, line),
    search: svg('<path d="M11 4a7 7 0 1 1 0 14a7 7 0 1 1 0-14"/><path d="M20 20l-4-4"/>', 16, 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'),
    note: svg('<path d="M9 18V5l11-2v13"/><path d="M6 15a3 3 0 1 1 0 6a3 3 0 1 1 0-6"/><path d="M17 13a3 3 0 1 1 0 6a3 3 0 1 1 0-6"/>', 18, line),
    list: svg('<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M4 6h.01"/><path d="M4 12h.01"/><path d="M4 18h.01"/>', 16, 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'),
    info: svg('<path d="M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18"/><path d="M12 11v5"/><path d="M12 8v.01"/>', 16, 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'),
  };
  const LOGO = `<svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect width="24" height="24" rx="5.4" fill="#110503"/><g transform="translate(2.4 2.4) scale(0.8)"><path d="M7 4c-2 0-2.5 1-2.5 3v2c0 1.5-.8 2.5-2 3 1.2.5 2 1.5 2 3v2c0 2 .5 3 2.5 3" stroke="#F4F1EA" stroke-width="1.9"/><path d="M17 4c2 0 2.5 1 2.5 3v2c0 1.5.8 2.5 2 3-1.2.5-2 1.5-2 3v2c0 2-.5 3-2.5 3" stroke="#F4F1EA" stroke-width="1.9"/><path d="m130.863 57.739-.468-2.327-19.788-3.457 11.498-15.557-1.337-1.462-16.913 8.11 2.139-21.54-1.738-.997-10.295 17.418L82.395 12H80.39l2.74 25.064-29.08-23.269-2.474.732 22.396 28.122-44.323-14.76-2.006 2.261L67.22 52.686l-54.618 4.521-.602 3.39 56.757 6.184-47.33 39.157 2.005 2.726 56.356-30.648-11.164 53.983h3.41l21.592-50.792 13.17 39.756 2.34-1.795-5.415-40.42 20.524 23.268 1.337-2.128-15.711-28.853 21.928 8.111.201-2.46-19.655-14.493 18.518-4.454Z" transform="translate(5.55 6.9) scale(0.085)" fill="#FFEE00"/></g></svg>`;

  // Waveform bar heights are derived from the track ID, so each track gets its own shape.
  const BARS = 44;
  function barHeights(id) {
    let h = 2166136261;
    for (const c of String(id)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    const out = [];
    for (let i = 0; i < BARS; i++) {
      h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
      const r = (h % 1000) / 1000;
      const env = 0.55 + 0.45 * Math.abs(Math.sin(i * 0.23 + 1));
      out.push(Math.round(6 + env * (8 + r * 20)));
    }
    return out;
  }
  /** Last fill of each bar, so the DOM is only touched when it changes. */
  let barFill = [];

  function trackRow(t, i, current) {
    const eq = current ? '<span class="eq"><i></i><i></i><i></i></span>' : '';
    const img = t.cover ? `<img src="${esc(t.cover)}" alt="">` : I.note;
    const d = t.duration ? fmt(t.duration / 1000) : '';
    return `<li data-i="${i}" class="${current ? 'current' : ''} ${t.available ? '' : 'na'}"><span class="thumb">${img}${eq}</span><div class="t"><div>${esc(t.title)}</div><div class="a">${esc(t.artists)}</div></div><span class="d">${d}</span></li>`;
  }

  function signInView() {
    return `<div class="signin">
        ${LOGO}
        <div><h1>Yandex Music in&nbsp;VS&nbsp;Code</h1><p>My Vibe, Liked, playlists and search, right in your editor.</p></div>
        <div class="actions">
          <button class="primary" data-cmd="yandexMusic.signIn">Sign in with Yandex</button>
          <button class="link" data-cmd="yandexMusic.setToken">Enter OAuth token manually</button>
        </div>
        ${state.error ? `<div class="error">${esc(state.error)}</div>` : ''}
        <div class="note">${I.info}<span>Without Yandex Plus, you only get 30-second previews.</span></div>
      </div>`;
  }

  function nowCard() {
    const s = state;
    const cur = s.current;
    const vol = Math.round(audio.volume * 100);
    const head = cur
      ? `<div class="head">
          ${cur.cover ? `<img class="cover" src="${esc(cur.cover)}" alt="">` : `<div class="cover">${I.note}</div>`}
          <div class="meta">
            ${s.source ? `<div class="source" title="${esc(s.source)}">${/^My Vibe/.test(s.source) ? I.wave(14) : ''}<span>${esc(s.sourceShort || s.source)}</span></div>` : ''}
            <div class="title" title="${esc(cur.title)}">${esc(cur.title)}</div>
            <div class="artist" title="${esc(cur.artists)}">${esc(cur.artists)}</div>
          </div>
        </div>`
      : `<div class="empty">Nothing is playing. Start My Vibe or search for a track.</div>`;
    const bars = '<i></i>'.repeat(BARS);
    barFill = [];
    return `<section class="card now">
        ${head}
        <div class="wave"><div class="bars" id="bars">${bars}</div><input id="seek" type="range" min="0" max="1000" value="0" aria-label="Seek"></div>
        <div class="times"><span id="pos">${fmt(position())}</span><span id="dur">${fmt(duration())}</span></div>
        <div class="controls">
          <button data-cmd="yandexMusic.previous" title="Previous" aria-label="Previous">${I.prev}</button>
          <button class="play" id="play"></button>
          <button data-cmd="yandexMusic.next" title="Next" aria-label="Next">${I.next}</button>
        </div>
        <div class="vol">${vol ? I.speaker : I.mute}<input id="vol" type="range" min="0" max="100" value="${vol}" aria-label="Volume"><span class="v" id="volv">${vol}</span>${cur ? `<button class="like ${s.liked ? 'on' : ''}" data-cmd="yandexMusic.like" title="${s.liked ? 'Remove from Liked' : 'Like'}" aria-label="${s.liked ? 'Remove from Liked' : 'Like'}">${s.liked ? I.heartOn : I.heart}</button>` : ''}</div>
      </section>`;
  }

  function render() {
    const s = state;
    if (s.signedOut) {
      app.innerHTML = signInView();
      return;
    }
    const acc = s.account
      ? `<div class="account"><span class="avatar">${esc((s.account.name || s.account.login || '?').trim().charAt(0).toUpperCase())}</span><span class="name">${esc(s.account.name || s.account.login)}</span><button class="icon-btn" data-cmd="yandexMusic.signOut" title="Sign out" aria-label="Sign out">${I.logout}</button></div>`
      : '';
    const cur = s.current;

    let body = '';
    if (tab === 'queue') {
      body = s.queue.length
        ? `<ul class="list" id="queue">${s.queue.map((t, i) => trackRow(t, i, i === s.index)).join('')}</ul>`
        : '<div class="hint">The queue is empty.</div>';
    } else if (tab === 'playlists') {
      body = s.playlists.length
        ? `<ul class="list" id="playlists">${s.playlists.map((p) => `<li data-id="${esc(p.id)}"><span class="thumb">${I.list}</span><div class="t"><div>${esc(p.title)}</div><div class="a">${p.count} ${p.count === 1 ? 'track' : 'tracks'}</div></div></li>`).join('')}</ul>`
        : `<button class="btn" id="loadPlaylists">Load playlists</button>`;
    } else if (tab === 'search') {
      body = `<form class="searchbox" id="searchForm">${I.search}<input id="q" placeholder="Artist or track…" value="${esc(searchQuery)}" aria-label="Search"><button type="submit">Search</button></form>
        <ul class="list" id="results">${s.searchResults.map((t, i) => trackRow(t, i, !!cur && t.id === cur.id)).join('')}</ul>`;
    }

    app.innerHTML = `
      ${needsGesture ? `<button class="gesture" id="gesture">${I.play} Enable sound</button>` : ''}
      ${acc}
      ${nowCard()}
      ${s.error ? `<div class="error">${esc(s.error)}</div>` : ''}
      <div class="quick">
        <button data-cmd="yandexMusic.playMyWave" title="Play My Vibe"><span class="wave-ic">${I.wave(18)}</span><span>Vibe</span></button>
        <button data-cmd="yandexMusic.playLiked" title="Play Liked"><span class="heart-ic">${I.heartOn}</span><span>Liked</span></button>
      </div>
      <div class="tabs">
        <button data-tab="queue" class="${tab === 'queue' ? 'active' : ''}">Queue</button>
        <button data-tab="playlists" class="${tab === 'playlists' ? 'active' : ''}">Playlists</button>
        <button data-tab="search" class="${tab === 'search' ? 'active' : ''}">Search</button>
      </div>
      ${body}`;
    // The panel's CSP forbids inline styles in markup, so sizes are set through the DOM.
    const heights = barHeights(cur ? cur.id : '');
    document.querySelectorAll('#bars i').forEach((b, i) => { /** @type {HTMLElement} */ (b).style.height = `${heights[i]}px`; });
    const vol = /** @type {HTMLInputElement|null} */ (document.getElementById('vol'));
    if (vol) vol.style.setProperty('--p', `${vol.value}%`);
    updateProgress();
  }

  /**
   * Waveform fill: bar i covers the track segment [i, i+1) / BARS and is filled by
   * the fraction of that segment already played, so the edge moves smoothly.
   */
  function paintBars() {
    const bars = document.getElementById('bars');
    if (!bars) return;
    const seek = /** @type {HTMLInputElement|null} */ (document.getElementById('seek'));
    const frac = seeking && seek ? Number(seek.value) / 1000 : duration() ? Math.min(1, position() / duration()) : 0;
    const filled = frac * BARS;
    Array.from(bars.children).forEach((b, i) => {
      const f = Math.round(Math.min(1, Math.max(0, filled - i)) * 100) / 100;
      if (barFill[i] !== f) {
        barFill[i] = f;
        /** @type {HTMLElement} */ (b).style.setProperty('--f', String(f));
      }
    });
  }

  // While audio is playing, the waveform and time counter update every frame rather than
  // on timeupdate (~4 times a second) or on the playing window's status (once a second).
  function frame() {
    if (isPlaying()) {
      paintBars();
      const pos = document.getElementById('pos');
      const text = fmt(position());
      if (pos && pos.textContent !== text) pos.textContent = text;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function updateProgress() {
    const pos = document.getElementById('pos');
    const dur = document.getElementById('dur');
    const seek = /** @type {HTMLInputElement|null} */ (document.getElementById('seek'));
    const play = document.getElementById('play');
    const frac = duration() ? Math.min(1, position() / duration()) : 0;
    if (pos) pos.textContent = fmt(position());
    if (dur) dur.textContent = fmt(duration());
    if (seek && !seeking) seek.value = String(Math.round(frac * 1000));
    paintBars();
    document.body.classList.toggle('playing', isPlaying());
    if (play) {
      const label = isPlaying() ? 'Pause' : 'Play';
      if (play.getAttribute('aria-label') !== label) {
        play.setAttribute('aria-label', label);
        play.title = label;
        play.innerHTML = isPlaying() ? I.pause : I.play;
      }
    }
  }

  async function tryPlay() {
    try {
      await audio.play();
      reportUnlocked(true);
      if (needsGesture) {
        needsGesture = false;
        render();
      }
    } catch (e) {
      if (e && e.name === 'NotAllowedError') {
        // The webview hasn't had a user gesture yet: ask for a single click.
        needsGesture = true;
        render();
        vscode.postMessage({ type: 'needsGesture' });
      } else if (e && e.name !== 'AbortError') {
        vscode.postMessage({ type: 'mediaError', message: e && e.message ? e.message : String(e) });
      }
    }
  }

  // Audio is allowed only once the user has clicked or pressed something inside this panel.
  let unlockReported = false;
  /** @param {boolean} [played] audio has already started successfully */
  function reportUnlocked(played) {
    if (unlockReported || !(played || (navigator.userActivation && navigator.userActivation.hasBeenActive))) return;
    unlockReported = true;
    vscode.postMessage({ type: 'audioUnlocked' });
  }

  // Any click in the panel counts as a user gesture: start the pending playback.
  document.addEventListener('click', () => {
    reportUnlocked(false);
    if (needsGesture && audio.src) tryPlay();
  }, true);
  document.addEventListener('keydown', () => reportUnlocked(false), true);

  // ------------------------------------------------------------------ events
  app.addEventListener('click', (ev) => {
    const el = /** @type {HTMLElement} */ (ev.target).closest('[data-cmd],[data-tab],li,#play,#loadPlaylists');
    if (!el || el.id === 'gesture') return;
    if (el.id === 'play') {
      if (needsGesture) return; // the gesture handler is already starting it
      if (state.remote) cmd('yandexMusic.playPause');
      else if (audio.src) audio.paused ? tryPlay() : audio.pause();
      else cmd('yandexMusic.playPause');
    } else if (el.id === 'loadPlaylists') {
      vscode.postMessage({ type: 'loadPlaylists' });
    } else if (el.dataset.cmd) {
      cmd(el.dataset.cmd);
    } else if (el.dataset.tab) {
      tab = el.dataset.tab;
      vscode.setState({ tab, searchQuery });
      if (tab === 'playlists' && !state.playlists.length && state.account) vscode.postMessage({ type: 'loadPlaylists' });
      render();
    } else if (el.tagName === 'LI') {
      const list = el.parentElement && el.parentElement.id;
      if (list === 'queue') vscode.postMessage({ type: 'playIndex', index: Number(el.dataset.i) });
      if (list === 'results') vscode.postMessage({ type: 'playSearchResult', index: Number(el.dataset.i), query: searchQuery });
      if (list === 'playlists') {
        vscode.postMessage({ type: 'openPlaylist', id: el.dataset.id });
        tab = 'queue';
      }
    }
  });

  app.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const q = /** @type {HTMLInputElement} */ (document.getElementById('q')).value.trim();
    if (!q) return;
    searchQuery = q;
    vscode.setState({ tab, searchQuery });
    vscode.postMessage({ type: 'search', query: q });
  });

  app.addEventListener('input', (ev) => {
    const t = /** @type {HTMLInputElement} */ (ev.target);
    if (t.id === 'seek') {
      seeking = true;
      updateProgress();
    }
    if (t.id === 'vol') {
      audio.volume = Number(t.value) / 100;
      t.style.setProperty('--p', `${t.value}%`);
      const v = document.getElementById('volv');
      if (v) v.textContent = t.value;
    }
  });

  app.addEventListener('change', (ev) => {
    const t = /** @type {HTMLInputElement} */ (ev.target);
    if (t.id === 'seek') {
      const to = (Number(t.value) / 1000) * duration();
      if (state.remote) vscode.postMessage({ type: 'seekTo', value: to });
      else if (audio.duration) audio.currentTime = to;
      seeking = false;
    }
    if (t.id === 'vol') vscode.postMessage({ type: 'volume', value: audio.volume });
  });

  for (const e of ['play', 'pause', 'playing', 'loadedmetadata']) {
    audio.addEventListener(e, () => {
      updateProgress();
      reportStatus();
    });
  }
  let lastReport = 0;
  audio.addEventListener('timeupdate', () => {
    updateProgress();
    const now = Date.now();
    if (now - lastReport > 1000) {
      lastReport = now;
      reportStatus();
    }
  });
  audio.addEventListener('ended', () => {
    reportStatus();
    vscode.postMessage({ type: 'ended' });
  });
  audio.addEventListener('error', () => {
    const err = audio.error;
    vscode.postMessage({ type: 'mediaError', message: err ? `code ${err.code} ${err.message || ''}` : 'unknown' });
  });

  // Media keys and the system Now Playing controls.
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => tryPlay());
    ms.setActionHandler('pause', () => audio.pause());
    ms.setActionHandler('nexttrack', () => cmd('yandexMusic.next'));
    ms.setActionHandler('previoustrack', () => cmd('yandexMusic.previous'));
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'state':
        state = m;
        statusAt = performance.now();
        render();
        if ('mediaSession' in navigator && m.current) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: m.current.title,
            artist: m.current.artists,
            artwork: m.current.cover ? [{ src: m.current.cover, sizes: '200x200' }] : [],
          });
        }
        break;
      case 'load':
        currentTrackId = m.trackId;
        audio.src = m.url;
        audio.currentTime = m.position || 0;
        if (m.autoplay) tryPlay();
        break;
      case 'progress':
        state.status = m.status;
        statusAt = performance.now();
        updateProgress();
        break;
      case 'toggle':
        if (!audio.src) return;
        if (needsGesture) {
          needsGesture = false;
          audio.pause();
          render();
          reportStatus();
          return;
        }
        audio.paused ? tryPlay() : audio.pause();
        break;
      case 'play':
        tryPlay();
        break;
      case 'pause':
        audio.pause();
        break;
      case 'seek':
        audio.currentTime = m.value;
        break;
      case 'volume':
        audio.volume = m.value;
        render();
        break;
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });
})();
