// Действия и проверки в окне стенда через CDP. Используется из devhost.sh;
// напрямую: node .probe/devhost-check.js <команда>
//
//   targets            список CDP-таргетов
//   layout             ширина боковой панели и видимость плеера
//   palette <команда>  выполнить команду палитры
//   type <текст>       ввести текст в открытое поле ввода и нажать Enter
//   open               открыть плеер в боковой панели и включить «Мою волну»
//   panel <выражение>  выражение в странице плеера (doc, win)
//   width <px>         ширина боковой панели, перетаскиванием разделителя
//   shot <имя>         снимок боковой панели в .probe/shot-<имя>.png
//   measure            что в панели обрезается и где лайк; код 3, если проверка не прошла
//   progress           плавно ли закрашивается «волна» и пляшет ли эквалайзер; код 3, если нет
//   throttle           замедляет ли Chromium таймеры и кадры в окне стенда

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
  if (!found) throw new Error('окно VS Code не найдено');
  return found;
}

/** Обёртка вида плеера в боковой панели (не service worker). */
async function playerView() {
  const found = (await targets()).find(
    (t) => t.type !== 'service_worker' && (t.url || '').startsWith('vscode-webview://') && (t.url || '').includes('index.html') && (t.url || '').includes('purpose=webviewView') && t.webSocketDebuggerUrl,
  );
  if (!found) throw new Error('вид плеера не найден');
  return found;
}

/** Одно соединение CDP с последовательными командами. */
function session(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const opened = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('ошибка соединения CDP'));
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

/** Выражение в странице плеера: она во вложенном фрейме обёртки. */
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
  throw new Error(`не дождались: ${what}`);
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
    const r = await inWorkbench((s) => s.eval(`({ боковаяПанель: ${rectOf('.part.sidebar')}, плеер: !!document.querySelector('.part.sidebar iframe') })`));
    console.log(JSON.stringify(r, null, 1));
  },

  // Фокус сначала уводится в статус-бар: иначе текст палитры может уйти в вебвью.
  async palette(command) {
    if (!command) throw new Error('нужна команда');
    await inWorkbench(async (s) => {
      await s.eval(`document.querySelector('.statusbar')?.click(); true`);
      await keys(s, 'cmd+shift+p');
      await until('палитры', () => s.eval(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) .quick-input-box input')`));
      await s.send('Input.insertText', { text: command });
      await sleep(600);
      await keys(s, 'Enter');
      await sleep(800);
    });
    console.log('ok');
  },

  async type(text) {
    await inWorkbench(async (s) => {
      await until('поля ввода', () => s.eval(`!!document.querySelector('.quick-input-widget:not([style*="display: none"]) .quick-input-box input')`));
      await s.send('Input.insertText', { text });
      await keys(s, 'Enter');
      await sleep(1000);
    });
    console.log('ok');
  },

  // Иконка на Activity Bar, затем кнопка «Волна» внутри панели — нажатие в ней
  // заодно разрешает вебвью звук.
  async open() {
    await inWorkbench((s) =>
      // Повторный клик по активной иконке сворачивает панель, поэтому жмём только неактивную.
      s.eval(`(() => {
        const link = document.querySelector('.activitybar .action-item a[aria-label^="Яндекс Музыка"]');
        const item = link && link.closest('.action-item');
        const sidebar = document.querySelector('.part.sidebar');
        const visible = sidebar && sidebar.getBoundingClientRect().width > 0;
        if (link && !(visible && item.classList.contains('checked'))) link.click();
        return !!link;
      })()`),
    );
    await until('вида плеера', () => playerView(), 30000);
    await until('панели с аккаунтом', () => inPanel(`!!doc.querySelector('.quick button')`), 30000);
    await inPanel(`doc.querySelector('.quick button[data-cmd="yandexMusic.playMyWave"]').click(); true`);
    await until('трека в панели', () => inPanel(`!!doc.querySelector('.now .title')`), 30000);
    console.log('ok');
  },

  async panel(expression) {
    if (!expression) throw new Error('нужно выражение');
    console.log(JSON.stringify(await inPanel(expression), null, 1));
  },

  async width(px) {
    const want = Number(px);
    if (!want) throw new Error('нужна ширина в px');
    await inWorkbench(async (s) => {
      const sb = await s.eval(rectOf('.part.sidebar'));
      if (Math.abs(sb.w - want) < 4) {
        console.log(`ширина боковой панели: ${Math.round(sb.w)} px`);
        return;
      }
      const sash = await s.eval(`(() => {
        const edge = ${sb.x + sb.w};
        const sash = [...document.querySelectorAll('.monaco-sash.vertical')]
          .map((el) => el.getBoundingClientRect())
          .find((r) => r.height > 100 && Math.abs(r.left + r.width / 2 - edge) < 6);
        return sash ? { x: sash.left + sash.width / 2, y: sash.top + sash.height / 2 } : null;
      })()`);
      if (!sash) throw new Error('разделитель боковой панели не найден');
      const move = (type, x) => s.send('Input.dispatchMouseEvent', { type, x, y: sash.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
      await move('mousePressed', sash.x);
      for (let i = 1; i <= 10; i++) await move('mouseMoved', sash.x + ((sb.x + want - sash.x) * i) / 10);
      await move('mouseReleased', sb.x + want);
      await sleep(600);
      const after = await s.eval(rectOf('.part.sidebar'));
      console.log(`ширина боковой панели: ${Math.round(after.w)} px`);
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

  // Замедляет ли Chromium окно стенда: окно под другими окнами получает таймеры
  // раз в секунду и может не получать кадров вовсе. Тогда проверки анимации в нём врут.
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
      return { шагТаймера100мс: t.slice(1).map((x, i) => Math.round(x - t[i])), кадровЗаСекунду: frames, видимость: doc.visibilityState };
    })()`), null, 1));
  },

  // Плавность прогресса: закраска «волны» снимается каждые 100 мс. Дробная доля
  // хотя бы у одного столбика и рост суммы между снимками — значит, заполнение
  // идёт внутри делений, а не скачками по целому столбику. Там же — пляшут ли
  // столбики эквалайзера у играющего трека.
  async progress() {
    const r = await inPanel(`(async () => {
      // Тестовый трек длится 8 с и к началу проверки мог закончиться.
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
        samples.push({ сумма: Math.round(f.reduce((a, b) => a + b, 0) * 100) / 100, дробных: f.filter((x) => x > 0 && x < 1).length });
        await new Promise((r) => setTimeout(r, 100));
      }
      return {
        играет: playing,
        снимки: samples,
        столбиковЭквалайзера: eq.length,
        эквалайзерДвижется: eq.length > 0 && a.some((t, i) => t !== b[i]),
      };
    })()`);
    const sums = r.снимки.map((s) => s.сумма);
    const distinct = new Set(sums).size;
    const problems = [
      ...(!r.играет ? ['трек не играет'] : []),
      ...(!r.снимки.some((s) => s.дробных > 0) ? ['нет частично закрашенных столбиков'] : []),
      ...(distinct < 5 ? [`закраска менялась только ${distinct} раз за 1 с`] : []),
      ...(r.столбиковЭквалайзера !== 3 ? [`столбиков эквалайзера: ${r.столбиковЭквалайзера}`] : []),
      ...(!r.эквалайзерДвижется ? ['эквалайзер стоит'] : []),
    ];
    console.log(JSON.stringify(r, null, 1));
    console.log(problems.length ? 'НЕ ПРОШЛО:\n  ' + problems.join('\n  ') : 'ПРОШЛО');
    if (problems.length) process.exit(3);
  },

  // Обрезанный текст: содержимое шире или выше видимой области. Лайк стоит в ряду
  // громкости, а название занимает всю ширину блока.
  async measure() {
    const r = await inPanel(`(() => {
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) }; };
      const cut = (el) => ({ текст: el.textContent.trim(), обрезан: el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1 });
      const label = (b) => b.querySelector('span:last-child') || b;
      const title = doc.querySelector('.meta .title');
      const meta = doc.querySelector('.meta');
      const like = doc.querySelector('.like');
      return {
        кнопки: [...doc.querySelectorAll('.quick button')].map((b) => cut(label(b))),
        вкладки: [...doc.querySelectorAll('.tabs button[data-tab]')].map(cut),
        источник: cut(doc.querySelector('.meta .source')),
        заКраемКарточки: (() => {
          const card = doc.querySelector('.card.now').getBoundingClientRect();
          return [...doc.querySelectorAll('.card.now *')]
            .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > card.right + 1 || r.left < card.left - 1); })
            .map((el) => el.className || el.id || el.tagName);
        })(),
        название: { ...cut(title), ширина: box(title).width, ширинаБлока: box(meta).width },
        исполнитель: cut(doc.querySelector('.meta .artist')),
        лайк: like ? { ...box(like), вРядуГромкости: like.parentElement.classList.contains('vol') } : null,
      };
    })()`);
    const problems = [
      ...r.кнопки.filter((b) => b.обрезан).map((b) => `кнопка «${b.текст}» обрезана`),
      ...r.вкладки.filter((b) => b.обрезан).map((b) => `вкладка «${b.текст}» обрезана`),
      ...(r.источник.обрезан ? [`источник «${r.источник.текст}» обрезан`] : []),
      ...r.заКраемКарточки.map((c) => `за краем карточки: ${c}`),
      ...(r.название.обрезан ? [`название «${r.название.текст}» обрезано`] : []),
      ...(r.исполнитель.обрезан ? [`исполнитель «${r.исполнитель.текст}» обрезан`] : []),
      ...(r.название.ширина < r.название.ширинаБлока - 1 ? [`название уже блока: ${r.название.ширина} из ${r.название.ширинаБлока} px`] : []),
      ...(!r.лайк ? ['лайка нет'] : !r.лайк.вРядуГромкости ? ['лайк не в ряду громкости'] : []),
    ];
    console.log(JSON.stringify(r, null, 1));
    console.log(problems.length ? 'НЕ ПРОШЛО:\n  ' + problems.join('\n  ') : 'ПРОШЛО');
    if (problems.length) process.exit(3);
  },
};

const [name, ...rest] = process.argv.slice(2);
const command = commands[name];
if (!command) {
  console.error('команды: ' + Object.keys(commands).join(', '));
  process.exit(2);
}
command(...rest).catch((e) => {
  console.error('ошибка:', e.message);
  process.exit(1);
});
