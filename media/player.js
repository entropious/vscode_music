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
  let state = { account: null, current: null, queue: [], index: -1, playlists: [], searchResults: [], source: '', liked: false, error: null };
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

  function reportStatus() {
    vscode.postMessage({ type: 'status', playing: !audio.paused && !audio.ended, position: audio.currentTime, duration: audio.duration || 0, trackId: currentTrackId, needsGesture });
  }

  function trackRow(t, i, cls) {
    const img = t.cover ? `<img src="${esc(t.cover)}" alt="">` : '<span class="ph">♪</span>';
    const d = t.duration ? fmt(t.duration / 1000) : '';
    return `<li data-i="${i}" class="${cls} ${t.available ? '' : 'na'}">${img}<div class="t"><div>${esc(t.title)}</div><div class="a">${esc(t.artists)}</div></div><span class="d">${d}</span></li>`;
  }

  function render() {
    const s = state;
    const acc = s.account
      ? `<span>👤 ${esc(s.account.name || s.account.login)}${s.account.hasPlus ? '<span class="plus">Плюс</span>' : ''}</span><button class="link" data-cmd="yandexMusic.signOut">Выйти</button>`
      : `<span>Не выполнен вход</span><button class="link" data-cmd="yandexMusic.signIn">Войти</button>`;

    const cur = s.current;
    const now = cur
      ? `<div class="now">
          ${cur.cover ? `<img class="cover" src="${esc(cur.cover)}" alt="">` : '<div class="cover"></div>'}
          <div class="meta"><div class="title" title="${esc(cur.title)}">${esc(cur.title)}</div><div class="artist">${esc(cur.artists)}</div><div class="source">${esc(s.source)}</div></div>
          <button class="like ${s.liked ? 'on' : ''}" data-cmd="yandexMusic.like" title="Нравится">${s.liked ? '♥' : '♡'}</button>
        </div>`
      : `<div class="hint">Ничего не играет. Включите «Мою волну» или найдите трек.</div>`;

    let body = '';
    if (tab === 'queue') {
      body = s.queue.length
        ? `<ul class="list" id="queue">${s.queue.map((t, i) => trackRow(t, i, i === s.index ? 'current' : '')).join('')}</ul>`
        : `<button class="btn big" data-cmd="yandexMusic.playMyWave">▶ Моя волна</button><button class="btn big" data-cmd="yandexMusic.playLiked">♥ Мне нравится</button>`;
    } else if (tab === 'playlists') {
      body = s.playlists.length
        ? `<ul class="list" id="playlists">${s.playlists.map((p) => `<li data-id="${esc(p.id)}"><div class="t"><div>${esc(p.title)}</div><div class="a">${p.count} треков</div></div></li>`).join('')}</ul>`
        : `<button class="btn big" id="loadPlaylists">Загрузить плейлисты</button>`;
    } else if (tab === 'search') {
      body = `<form class="searchbox" id="searchForm"><input id="q" placeholder="Исполнитель, трек…" value="${esc(searchQuery)}"><button class="btn" type="submit">Найти</button></form>
        <ul class="list" id="results">${s.searchResults.map((t, i) => trackRow(t, i, cur && t.id === cur.id ? 'current' : '')).join('')}</ul>`;
    }

    app.innerHTML = `
      ${needsGesture ? '<button class="btn big gesture" id="gesture">▶ Включить звук</button>' : ''}
      <div class="account">${acc}</div>
      ${now}
      <div class="controls">
        <button data-cmd="yandexMusic.previous" title="Предыдущий">⏮</button>
        <button class="play" id="play" title="Play/Pause">${!audio.paused ? '⏸' : '▶'}</button>
        <button data-cmd="yandexMusic.next" title="Следующий">⏭</button>
      </div>
      <div class="seek"><span id="pos">${fmt(audio.currentTime)}</span><input id="seek" type="range" min="0" max="1000" value="0"><span id="dur">${fmt(audio.duration)}</span></div>
      <div class="vol">🔈<input id="vol" type="range" min="0" max="100" value="${Math.round(audio.volume * 100)}"></div>
      ${s.error ? `<div class="error">${esc(s.error)}</div>` : ''}
      <div class="tabs">
        <button data-tab="queue" class="${tab === 'queue' ? 'active' : ''}">Очередь</button>
        <button data-tab="playlists" class="${tab === 'playlists' ? 'active' : ''}">Плейлисты</button>
        <button data-tab="search" class="${tab === 'search' ? 'active' : ''}">Поиск</button>
        <button data-cmd="yandexMusic.playMyWave" title="Включить Мою волну">🌊 Волна</button>
        <button data-cmd="yandexMusic.playLiked" title="Включить Мне нравится">♥</button>
      </div>
      ${body}`;
    updateProgress();
  }

  function updateProgress() {
    const pos = document.getElementById('pos');
    const dur = document.getElementById('dur');
    const seek = /** @type {HTMLInputElement|null} */ (document.getElementById('seek'));
    const play = document.getElementById('play');
    if (pos) pos.textContent = fmt(audio.currentTime);
    if (dur) dur.textContent = fmt(audio.duration);
    if (seek && !seeking) seek.value = String(audio.duration ? Math.round((audio.currentTime / audio.duration) * 1000) : 0);
    if (play) play.textContent = !audio.paused ? '⏸' : '▶';
  }

  async function tryPlay() {
    try {
      await audio.play();
      if (needsGesture) {
        needsGesture = false;
        render();
      }
    } catch (e) {
      if (e && e.name === 'NotAllowedError') {
        // Webview ещё не получил жест пользователя: просим один раз кликнуть.
        needsGesture = true;
        render();
        vscode.postMessage({ type: 'needsGesture' });
      } else if (e && e.name !== 'AbortError') {
        vscode.postMessage({ type: 'mediaError', message: e && e.message ? e.message : String(e) });
      }
    }
  }

  // Любой клик по панели — жест пользователя: запускаем отложенное воспроизведение.
  document.addEventListener('click', () => {
    if (needsGesture && audio.src) tryPlay();
  }, true);

  // ------------------------------------------------------------------ events
  app.addEventListener('click', (ev) => {
    const el = /** @type {HTMLElement} */ (ev.target).closest('[data-cmd],[data-tab],li,#play,#loadPlaylists');
    if (!el || el.id === 'gesture') return;
    if (el.id === 'play') {
      if (needsGesture) return; // уже запускается обработчиком жеста
      if (audio.src) audio.paused ? tryPlay() : audio.pause();
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
    if (t.id === 'seek') seeking = true;
    if (t.id === 'vol') audio.volume = Number(t.value) / 100;
  });

  app.addEventListener('change', (ev) => {
    const t = /** @type {HTMLInputElement} */ (ev.target);
    if (t.id === 'seek') {
      if (audio.duration) audio.currentTime = (Number(t.value) / 1000) * audio.duration;
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

  // Медиа-клавиши и системная панель «Сейчас играет».
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
        audio.currentTime = 0;
        if (m.autoplay) tryPlay();
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
