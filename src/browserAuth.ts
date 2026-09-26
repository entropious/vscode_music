import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Readable, Writable } from 'stream';

const MAC_BROWSERS = [
  'Google Chrome.app/Contents/MacOS/Google Chrome',
  'Chromium.app/Contents/MacOS/Chromium',
  'Yandex.app/Contents/MacOS/Yandex',
  'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  'Brave Browser.app/Contents/MacOS/Brave Browser',
];

const WIN_BROWSERS = [
  'Google\\Chrome\\Application\\chrome.exe',
  'Yandex\\YandexBrowser\\Application\\browser.exe',
  'Microsoft\\Edge\\Application\\msedge.exe',
  'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  'Chromium\\Application\\chrome.exe',
];

const LINUX_BROWSERS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'yandex-browser', 'microsoft-edge', 'brave-browser'];

/** Путь к установленному Chromium-браузеру: им можно управлять через DevTools-протокол. */
export function findChromium(): string | undefined {
  let candidates: string[];
  if (process.platform === 'darwin') {
    const roots = ['/Applications', path.join(process.env.HOME ?? '', 'Applications')];
    candidates = roots.flatMap((r) => MAC_BROWSERS.map((b) => path.join(r, b)));
  } else if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter((r): r is string => !!r);
    candidates = roots.flatMap((r) => WIN_BROWSERS.map((b) => path.join(r, b)));
  } else {
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    candidates = LINUX_BROWSERS.flatMap((b) => dirs.map((d) => path.join(d, b)));
  }
  return candidates.find((c) => fs.existsSync(c));
}

export interface CaptureOptions {
  browserPath: string;
  /** Отдельный профиль браузера: в нём остаётся вход в Яндекс между запусками. */
  profileDir: string;
  startUrl: string;
  /** Шаблон Fetch-перехвата, например `https://music.yandex.ru/oauth*`. */
  interceptPattern: string;
  /** HTML, который увидит пользователь вместо перехваченной страницы. */
  doneHtml: string;
  signal: AbortSignal;
}

/**
 * Открывает браузер на `startUrl` и ждёт навигации, подходящей под `interceptPattern`.
 * Возвращает адрес этой навигации, не давая странице загрузиться, или `undefined`,
 * если пользователь закрыл браузер или отменил вход.
 * Браузер управляется через DevTools-протокол по pipe (`--remote-debugging-pipe`).
 */
export function captureNavigation(opts: CaptureOptions): Promise<string | undefined> {
  fs.mkdirSync(opts.profileDir, { recursive: true });
  const proc = spawn(
    opts.browserPath,
    [
      '--remote-debugging-pipe',
      `--user-data-dir=${opts.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const toBrowser = proc.stdio[3] as Writable;
  const fromBrowser = proc.stdio[4] as Readable;

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => {
    const id = nextId++;
    toBrowser.write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  return new Promise<string | undefined>((resolve, reject) => {
    let settled = false;
    let attached = false;
    const finish = (value: string | undefined, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      opts.signal.removeEventListener('abort', onAbort);
      // Даём браузеру показать страницу «готово», затем закрываем его.
      setTimeout(() => {
        send('Browser.close').catch(() => undefined);
        setTimeout(() => proc.kill(), 2000);
      }, value ? 1500 : 0);
      error ? reject(error) : resolve(value);
    };
    const onAbort = () => finish(undefined);
    opts.signal.addEventListener('abort', onAbort);

    proc.on('error', (e) => finish(undefined, new Error(`Не удалось запустить браузер: ${e.message}`)));
    proc.on('exit', () => {
      for (const p of pending.values()) {
        p.reject(new Error('Браузер закрыт'));
      }
      pending.clear();
      finish(undefined);
    });
    toBrowser.on('error', () => undefined);

    const attach = async (targetId: string) => {
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      await send('Fetch.enable', { patterns: [{ urlPattern: opts.interceptPattern, requestStage: 'Request' }] }, sessionId);
      await send('Page.navigate', { url: opts.startUrl }, sessionId);
    };

    const onMessage = (msg: any) => {
      if (msg.id !== undefined) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? p?.reject(new Error(msg.error.message)) : p?.resolve(msg.result);
        return;
      }
      if (msg.method === 'Target.targetCreated' && msg.params.targetInfo.type === 'page' && !attached) {
        attached = true;
        attach(msg.params.targetInfo.targetId).catch((e) => finish(undefined, e));
      } else if (msg.method === 'Fetch.requestPaused') {
        send(
          'Fetch.fulfillRequest',
          {
            requestId: msg.params.requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
            body: Buffer.from(opts.doneHtml).toString('base64'),
          },
          msg.sessionId,
        ).catch(() => undefined);
        finish(msg.params.request.url);
      }
    };

    let buffer = '';
    fromBrowser.setEncoding('utf8');
    fromBrowser.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          onMessage(JSON.parse(raw));
        } catch {
          // Нераспознанное сообщение протокола пропускаем.
        }
      }
    });

    send('Target.setDiscoverTargets', { discover: true }).catch((e) => finish(undefined, e));
  });
}
