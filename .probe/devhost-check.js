// Actions and checks in the test window over CDP. Called from devhost.sh;
// to run directly: node .probe/devhost-check.js <command>
//
//   targets            list CDP targets
//   layout             sidebar width and whether the player is visible
//   palette <command>  run a command palette command
//   type <text>        type text into the open input box and press Enter
//   open               open the player in the sidebar and start My Vibe
//   panel <expression> evaluate an expression in the player page (doc, win)
//   width <px>         set the sidebar width by dragging the sash
//   shot <name>        screenshot the sidebar to .probe/shot-<name>.png
//   measure            what gets clipped in the panel and where the like button is; exit code 3 on failure
//   progress           whether the waveform fills smoothly and the equalizer moves; exit code 3 if not
//   throttle           whether Chromium throttles timers and frames in the test window

const fs = require('fs');
const path = require('path');

const PORT = process.env.CDP_PORT || 9231;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function workbench() {
  const found = (await targets()).find((t) => t.type === 'page' && (t.url || '').includes('workbench') && t.webSocketDebuggerUrl);
  if (!found) throw new Error('VS Code window not found');
  return found;
}

/** The wrapper page of the player view in the sidebar (not the service worker). */
async function playerView() {
  const found = (await targets()).find(
    (t) => t.type !== 'service_worker' && (t.url || '').startsWith('vscode-webview://') && (t.url || '').includes('index.html') && (t.url || '').includes('purpose=webviewView') && t.webSocketDebuggerUrl,
  );
  if (!found) throw new Error('player view not found');
  return found;
}

/** A single CDP connection that sends commands one after another. */
function session(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('CDP connection error'));
  });
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  };
  return {
    async send(method, params = {}) {
      await opened;
      return new Promise((resolve, reject) => {
        pending.set(++id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async eval(expression) {
      const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
      return r.result?.value;
    },
    close: () => ws.close(),
  };
}

async function inWorkbench(fn) {
  const s = session((await workbench()).webSocketDebuggerUrl);
  try {
    return await fn(s);
  } finally {
    s.close();
  }
}

/** Evaluates an expression in the player page, which lives in an iframe inside the wrapper. */
async function inPanel(expression) {
  const s = session((await playerView()).webSocketDebuggerUrl);
  try {
    return await s.eval(`(async () => {
      const frame = document.querySelector('iframe#active-frame') || document.querySelector('iframe');
      const win = frame ? frame.contentWindow : window;
      const doc = win.document;
      return await eval(${JSON.stringify(expression)});
    })()`);
  } finally {
    s.close();
  }
}

async function until(what, fn, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function keys(s, combo) {
  const parts = combo.split('+');
  const key = parts.pop();
  const bits = { alt: 1, ctrl: 2, cmd: 4, meta: 4, shift: 8 };
  const modifiers = parts.reduce((m, p) => m | (bits[p] || 0), 0);
  const named = { Enter: 13, Escape: 27 };
  const code = named[key] || key.toUpperCase().charCodeAt(0);
  const ev = (type) => ({ type, modifiers, key, code: named[key] ? key : `Key${key.toUpperCase()}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await s.send('Input.dispatchKeyEvent', ev('rawKeyDown'));
  await s.send('Input.dispatchKeyEvent', ev('keyUp'));
}

const rectOf = (selector) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`;

const commands = {
  async targets() {
    for (const t of await targets()) console.log(t.type, '|', (t.url || '').slice(0, 120));
  },

  async layout() {
    const r = await inWorkbench((s) => s.eval(`({ sidebar: ${rectOf('.part.sidebar')}, player: !!document.querySelector('.part.sidebar iframe') })`));
    console.log(JSON.stringify(r, null, 1));
  },

  // Focus moves to the status bar first; otherwise the palette text may end up in the webview.
  async palette(command) {
    if (!command) throw new Error('a command is required');
    await inWorkbench(async (s) => {
      await s.eval(`document.querySelector('.statusbar')?.click(); true`);
      await keys(s, 'cmd+shift+p');
      await until('the Command Palette', () => s.eval(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) .quick-input-box input')`));
      await s.send('Input.insertText', { text: command });
      await sleep(600);
      await keys(s, 'Enter');
      await sleep(800);
    });
    console.log('ok');
  },

  async type(text) {
    await inWorkbench(async (s) => {
      await until('the input box', () => s.eval(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) .quick-input-box input')`));
      await s.send('Input.insertText', { text });
      await keys(s, 'Enter');
      await sleep(1000);
    });
    console.log('ok');
  },

  // Clicks the Activity Bar icon, then the Wave button inside the panel; that click
  // also unlocks audio in the webview.
  async open() {
    await inWorkbench((s) =>
      // Clicking the active icon again collapses the sidebar, so only an inactive one is clicked.
      s.eval(`(() => {
        const link = document.querySelector('.activitybar .action-item a[aria-label^="Yandex Music"]');
        const item = link && link.closest('.action-item');
        const sidebar = document.querySelector('.part.sidebar');
        const visible = sidebar && sidebar.getBoundingClientRect().width > 0;
        if (link && !(visible && item.classList.contains('checked'))) link.click();
        return !!link;
      })()`),
    );
    await until('the player view', () => playerView(), 30000);
    await until('the panel with the account', () => inPanel(`!!doc.querySelector('.quick button')`), 30000);
    await inPanel(`doc.querySelector('.quick button[data-cmd="yandexMusic.playMyWave"]').click(); true`);
    await until('a track in the panel', () => inPanel(`!!doc.querySelector('.now .title')`), 30000);
    console.log('ok');
  },

  async panel(expression) {
    if (!expression) throw new Error('an expression is required');
    console.log(JSON.stringify(await inPanel(expression), null, 1));
  },

  async width(px) {
    const want = Number(px);
    if (!want) throw new Error('a width in px is required');
    await inWorkbench(async (s) => {
      const sb = await s.eval(rectOf('.part.sidebar'));
      if (Math.abs(sb.w - want) < 4) {
        console.log(`sidebar width: ${Math.round(sb.w)} px`);
        return;
      }
      const sash = await s.eval(`(() => {
        const edge = ${sb.x + sb.w};
        const sash = [...document.querySelectorAll('.monaco-sash.vertical')]
          .map((el) => el.getBoundingClientRect())
          .find((r) => r.height > 100 && Math.abs(r.left + r.width / 2 - edge) < 6);
        return sash ? { x: sash.left + sash.width / 2, y: sash.top + sash.height / 2 } : null;
      })()`);
      if (!sash) throw new Error('sidebar sash not found');
      const move = (type, x) => s.send('Input.dispatchMouseEvent', { type, x, y: sash.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
      await move('mousePressed', sash.x);
      for (let i = 1; i <= 10; i++) await move('mouseMoved', sash.x + ((sb.x + want - sash.x) * i) / 10);
      await move('mouseReleased', sb.x + want);
      await sleep(600);
      const after = await s.eval(rectOf('.part.sidebar'));
      console.log(`sidebar width: ${Math.round(after.w)} px`);
    });
  },

  async shot(name = 'shot') {
    await inWorkbench(async (s) => {
      const sb = await s.eval(rectOf('.part.sidebar'));
      const r = await s.send('Page.captureScreenshot', { format: 'png', clip: { x: sb.x, y: sb.y, width: sb.w, height: Math.min(sb.h, 560), scale: 2 } });
      const file = path.join(__dirname, `shot-${name}.png`);
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log(file);
    });
  },

  // Whether Chromium throttles the test window: a window behind others gets timers
  // once a second and may get no frames at all, which makes animation checks unreliable.
  async throttle() {
    console.log(JSON.stringify(await inPanel(`(async () => {
      const t = [];
      for (let k = 0; k < 4; k++) {
        t.push(performance.now());
        await new Promise((r) => setTimeout(r, 100));
      }
      let frames = 0;
      const start = performance.now();
      await new Promise((r) => {
        const f = () => { frames++; performance.now() - start < 1000 ? requestAnimationFrame(f) : r(); };
        requestAnimationFrame(f);
        setTimeout(r, 3000);
      });
      return { timer100msSteps: t.slice(1).map((x, i) => Math.round(x - t[i])), framesPerSecond: frames, visibility: doc.visibilityState };
    })()`), null, 1));
  },

  // Progress smoothness: the waveform fill is sampled every 100 ms. A fractional fill
  // on at least one bar and a growing total between samples mean the fill advances
  // within a bar rather than jumping a whole bar at a time. Also checks that the
  // equalizer bars on the current track are moving.
  async progress() {
    const r = await inPanel(`(async () => {
      // The test track is 8 s long and may have ended before the check starts.
      if (!doc.body.classList.contains('playing')) {
        doc.getElementById('play').click();
        await new Promise((r) => setTimeout(r, 700));
      }
      const playing = doc.body.classList.contains('playing');
      const eq = [...doc.querySelectorAll('.list li.current .eq i')];
      const scales = () => eq.map((i) => getComputedStyle(i).transform);
      const a = scales();
      await new Promise((r) => setTimeout(r, 250));
      const b = scales();
      const bars = [...doc.querySelectorAll('#bars i')];
      const fill = () => bars.map((b) => Number(getComputedStyle(b).getPropertyValue('--f') || 0));
      const samples = [];
      for (let k = 0; k < 10; k++) {
        const f = fill();
        samples.push({ sum: Math.round(f.reduce((a, b) => a + b, 0) * 100) / 100, partial: f.filter((x) => x > 0 && x < 1).length });
        await new Promise((r) => setTimeout(r, 100));
      }
      return {
        playing,
        samples,
        equalizerBars: eq.length,
        equalizerMoving: eq.length > 0 && a.some((t, i) => t !== b[i]),
      };
    })()`);
    const sums = r.samples.map((s) => s.sum);
    const distinct = new Set(sums).size;
    const problems = [
      ...(!r.playing ? ['track is not playing'] : []),
      ...(!r.samples.some((s) => s.partial > 0) ? ['no partially filled bars'] : []),
      ...(distinct < 5 ? [`fill changed only ${distinct} times in 1 s`] : []),
      ...(r.equalizerBars !== 3 ? [`equalizer bars: ${r.equalizerBars}`] : []),
      ...(!r.equalizerMoving ? ['equalizer is not moving'] : []),
    ];
    console.log(JSON.stringify(r, null, 1));
    console.log(problems.length ? 'FAILED:\n  ' + problems.join('\n  ') : 'PASSED');
    if (problems.length) process.exit(3);
  },

  // Clipped text means content wider or taller than its visible box. The like button
  // must sit in the volume row, and the title must span the full block width.
  async measure() {
    const r = await inPanel(`(() => {
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) }; };
      const cut = (el) => ({ text: el.textContent.trim(), clipped: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 });
      const label = (b) => b.querySelector('span:last-child') || b;
      const title = doc.querySelector('.meta .title');
      const meta = doc.querySelector('.meta');
      const like = doc.querySelector('.like');
      return {
        buttons: [...doc.querySelectorAll('.quick button')].map((b) => cut(label(b))),
        tabs: [...doc.querySelectorAll('.tabs button[data-tab]')].map(cut),
        source: cut(doc.querySelector('.meta .source')),
        outsideCard: (() => {
          const card = doc.querySelector('.card.now').getBoundingClientRect();
          return [...doc.querySelectorAll('.card.now *')]
            .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > card.right + 1 || r.left < card.left - 1); })
            .map((el) => el.className || el.id || el.tagName);
        })(),
        title: { ...cut(title), width: box(title).width, blockWidth: box(meta).width },
        artist: cut(doc.querySelector('.meta .artist')),
        like: like ? { ...box(like), inVolumeRow: like.parentElement.classList.contains('vol') } : null,
      };
    })()`);
    const problems = [
      ...r.buttons.filter((b) => b.clipped).map((b) => `button "${b.text}" is clipped`),
      ...r.tabs.filter((b) => b.clipped).map((b) => `tab "${b.text}" is clipped`),
      ...(r.source.clipped ? [`source "${r.source.text}" is clipped`] : []),
      ...r.outsideCard.map((c) => `outside the card: ${c}`),
      ...(r.title.clipped ? [`title "${r.title.text}" is clipped`] : []),
      ...(r.artist.clipped ? [`artist "${r.artist.text}" is clipped`] : []),
      ...(r.title.width < r.title.blockWidth - 1 ? [`title narrower than its block: ${r.title.width} of ${r.title.blockWidth} px`] : []),
      ...(!r.like ? ['like button missing'] : !r.like.inVolumeRow ? ['like button not in the volume row'] : []),
    ];
    console.log(JSON.stringify(r, null, 1));
    console.log(problems.length ? 'FAILED:\n  ' + problems.join('\n  ') : 'PASSED');
    if (problems.length) process.exit(3);
  },
};

const [name, ...rest] = process.argv.slice(2);
const command = commands[name];
if (!command) {
  console.error('commands: ' + Object.keys(commands).join(', '));
  process.exit(2);
}
command(...rest).catch((e) => {
  console.error('error:', e.message);
  process.exit(1);
});
