/**
 * Сквозной тест в настоящем VS Code: Playwright управляет окном как пользователь
 * (палитра команд, клики мышью, горячие клавиши), а звук записывается
 * с монитора PulseAudio и анализируется.
 *
 *   YM_AUDIO_DEVICE=<sink>.monitor xvfb-run -a npm run e2e              # mock-API Яндекс Музыки
 *   YM_TOKEN=<oauth> YM_AUDIO_DEVICE=... xvfb-run -a npm run e2e        # настоящая Яндекс Музыка
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, FrameLocator, Page } from 'playwright-core';
import { freePort, launchVSCode, vscodeBinary } from './vscodeBinary';
import { audioProbeAvailable, recordAudio } from './audioProbe';
import { MOCK_TOKEN, startMockServer } from './mockServer';

const root = path.resolve(__dirname, '../..');
const shots = path.join(root, 'screenshots');
const real = !!process.env.YM_TOKEN;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Модификатор горячих клавиш расширения: Cmd на macOS, Ctrl на остальных ОС. */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`• ${name} … `);
  const t = Date.now();
  const r = await fn();
  console.log(`ok (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  return r;
}

async function until<T>(what: string, fn: () => Promise<T | false | undefined>, ms = 20000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => undefined);
    if (v) {
      return v;
    }
    await sleep(250);
  }
  throw new Error(`не дождались: ${what}`);
}

function player(page: Page): FrameLocator {
  return page.frameLocator('iframe.webview.ready').frameLocator('#active-frame');
}

async function position(page: Page): Promise<string> {
  return player(page).locator('#pos').innerText();
}

async function expectSound(label: string, minRms: number) {
  if (!audioProbeAvailable()) {
    console.log(`  (звук не проверяется: не задан YM_AUDIO_DEVICE)`);
    return;
  }
  const a = await recordAudio(2000);
  console.log(`  ${label}: RMS=${a.rms.toFixed(3)} peak=${a.peak.toFixed(3)} f≈${a.zeroCrossHz.toFixed(0)} Гц за ${a.seconds.toFixed(1)}с`);
  assert.ok(a.rms > minRms, `${label}: тишина (RMS ${a.rms})`);
  if (!real) {
    assert.ok(Math.abs(a.zeroCrossHz - 440) < 20, `${label}: ожидали тон 440 Гц, получили ${a.zeroCrossHz}`);
  }
}

async function expectSilence(label: string) {
  if (!audioProbeAvailable()) {
    return;
  }
  const a = await recordAudio(1000);
  console.log(`  ${label}: RMS=${a.rms.toFixed(4)}`);
  assert.ok(a.rms < 0.005, `${label}: должна быть тишина, RMS ${a.rms}`);
}

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  const server = real ? undefined : await startMockServer(path.join(root, 'test-fixtures/tone.mp3'));
  const token = process.env.YM_TOKEN ?? MOCK_TOKEN;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ym-e2e-'));
  const userData = path.join(tmp, 'user');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'User/settings.json'),
    JSON.stringify({
      ...(server ? { 'yandexMusic.apiBaseUrl': server.base } : {}),
      'yandexMusic.volume': 1,
      'workbench.startupEditor': 'none',
      'security.workspace.trust.enabled': false,
      'workbench.tips.enabled': false,
      'update.mode': 'none',
      'telemetry.telemetryLevel': 'off',
      'chat.disableAIFeatures': true,
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
    }),
  );
  const workspace = path.join(tmp, 'ws');
  fs.mkdirSync(workspace);

  const cdpPort = await freePort();
  const proc = launchVSCode(
    await vscodeBinary(),
    [
      `--remote-debugging-port=${cdpPort}`,
      '--no-sandbox',
      '--disable-gpu',
      '--disable-gpu-sandbox',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--password-store=basic', // в контейнере нет системного keyring
      `--extensionDevelopmentPath=${root}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${path.join(tmp, 'ext')}`,
      workspace,
    ],
    { log: path.join(tmp, 'vscode.log') },
  );
  // Playwright подключается к уже запущенному VS Code: так на macOS его окна не выходят на передний план.
  const browser = await until('DevTools-порта VS Code', () => chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`), 60000);
  const context = browser.contexts()[0];
  const workbench = (p: Page) => p.url().includes('workbench');
  const page = await until('окна VS Code', async () => context.pages().find(workbench), 60000);
  page.setDefaultTimeout(30000);
  const nextWindow = async () => {
    const known = new Set(context.pages());
    return until('нового окна VS Code', async () => context.pages().find((p) => workbench(p) && !known.has(p)), 60000);
  };
  const quit = async () => {
    const cdp = await browser.newBrowserCDPSession().catch(() => undefined);
    await cdp?.send('Browser.close').catch(() => undefined);
    await new Promise((r) => (proc.exitCode !== null ? r(undefined) : proc.once('exit', r)));
  };

  try {
    await step('VS Code запустился', async () => {
      await page.waitForSelector('.monaco-workbench', { timeout: 60000 });
      await until('статус-бар расширения', async () => (await page.locator('.statusbar-item', { hasText: 'Яндекс Музыка' }).count()) > 0, 60000);
    });

    await step('вход: палитра команд → «Ввести OAuth-токен вручную»', async () => {
      await page.keyboard.press('F1');
      await page.keyboard.type('Яндекс Музыка: Ввести OAuth');
      await page.screenshot({ path: path.join(shots, '0-palette.png') });
      await page.locator('.quick-input-list .monaco-list-row', { hasText: 'Ввести OAuth-токен' }).first().click();
      await page.locator('.quick-input-box input').fill(token);
      await page.screenshot({ path: path.join(shots, '0-token.png') });
      await page.keyboard.press('Enter');
      await page.locator('.activitybar [aria-label="Яндекс Музыка"]').first().click();
      await player(page).locator('.account', { hasText: '👤' }).waitFor({ timeout: 30000 });
      console.log(`(${await player(page).locator('.account').innerText()})`);
    });

    await step('горячая клавиша Ctrl+Alt+P → включается «Моя волна»', async () => {
      await page.locator('.monaco-workbench .part.editor').click({ position: { x: 300, y: 200 } });
      await page.keyboard.press(`${mod}+Alt+P`);
      // Нажатие клавиши в окне VS Code — жест пользователя, обычно этого достаточно.
      // Если webview всё же заблокировал автозапуск, панель покажет «▶ Включить звук».
      const how = await until('воспроизведения или запроса клика', async () => {
        if (await player(page).locator('#gesture').isVisible()) {
          return 'gesture';
        }
        return (await position(page)) !== '0:00' && 'playing';
      });
      if (how === 'gesture') {
        await page.screenshot({ path: path.join(shots, '1-needs-click.png') });
        await expectSilence('до клика');
        await player(page).locator('#gesture').click();
        await until('роста позиции', async () => (await position(page)) !== '0:00');
      }
      console.log(`(${how === 'gesture' ? 'понадобился клик «Включить звук»' : 'заиграло сразу'})`);
    });
    await expectSound('играет трек', real ? 0.01 : 0.1);
    await page.screenshot({ path: path.join(shots, '2-playing.png') });

    await step('Ctrl+Alt+P → пауза', async () => {
      await page.locator('.monaco-workbench .part.editor').click({ position: { x: 300, y: 200 } });
      await page.keyboard.press(`${mod}+Alt+P`);
      await player(page).locator('#play', { hasText: '▶' }).waitFor();
    });
    await sleep(300);
    await expectSilence('на паузе');

    await step('кнопка ▶ в панели → продолжает', async () => {
      await player(page).locator('#play').click();
      await player(page).locator('#play', { hasText: '⏸' }).waitFor();
    });
    await expectSound('после паузы', real ? 0.01 : 0.1);

    if (!real) {
      await step('вкладка «Поиск»: ищем и кликаем по 3-му треку', async () => {
        await player(page).locator('[data-tab="search"]').click();
        await player(page).locator('#q').fill('Тестовый');
        await player(page).locator('#searchForm button').click();
        await player(page).locator('#results li').nth(2).click();
        await player(page).locator('.now .title', { hasText: 'Тестовый трек 3' }).waitFor();
        await until('статус-бара с треком 3', async () => (await page.locator('.statusbar-item', { hasText: 'Тестовый трек 3' }).count()) > 0);
      });
      await expectSound('трек из поиска', 0.1);

      await step('♡ → лайк уходит в API', async () => {
        await player(page).locator('.like').click();
        await player(page).locator('.like.on').waitFor();
        assert.ok(server!.liked.has(1003));
      });

      await step('Ctrl+Alt+→ → следующий трек', async () => {
        await page.locator('.monaco-workbench .part.editor').click({ position: { x: 300, y: 200 } });
        await page.keyboard.press(`${mod}+Alt+ArrowRight`);
        await player(page).locator('.now .title', { hasText: 'Тестовый трек 4' }).waitFor();
        await until('воспроизведения', async () => (await position(page)) !== '0:00');
      });
      await expectSound('следующий трек', 0.1);
      await page.screenshot({ path: path.join(shots, '3-search-like.png') });

      await step('трек доигрывает до конца → автоматически следующий', async () => {
        await player(page).locator('.now .title', { hasText: 'Тестовый трек 5' }).waitFor({ timeout: 20000 });
      });

      const sb = (id: string) => page.locator(`[id="entropious.vscode-yandex-music.yandexMusic.${id}"]`);

      await step('статус-бар: кнопка ⏸ ставит паузу', async () => {
        await sb('play').click();
        await player(page).locator('#play', { hasText: '▶' }).waitFor();
      });
      await sleep(300);
      await expectSilence('пауза из статус-бара');

      await step('статус-бар: наведение на трек показывает карточку с кнопками', async () => {
        await sb('track').hover();
        await page.locator('.monaco-hover', { hasText: 'Тестовый трек 5' }).waitFor();
        await page.screenshot({ path: path.join(shots, '4-statusbar-hover.png') });
        await page.locator('.monaco-hover a[href*="yandexMusic.playPause"], .monaco-hover a[data-href*="yandexMusic.playPause"]').first().click();
        await player(page).locator('#play', { hasText: '⏸' }).waitFor();
      });
      await expectSound('play из всплывающей карточки', 0.1);

      await step('клик по треку в статус-баре → карточка мини-плеера → «Следующий»', async () => {
        await page.keyboard.press('Escape');
        await page.mouse.move(700, 500);
        await page.locator('.monaco-hover').first().waitFor({ state: 'hidden' });
        await sb('track').click();
        const card = page.locator('.monaco-hover', { hasText: 'Моя волна' });
        await card.waitFor({ timeout: 3000 });
        // Трек играет, позиция обновляется каждую секунду — карточка не должна мигать.
        for (let i = 0; i < 6; i++) {
          await sleep(500);
          assert.ok(await card.isVisible(), `карточка пропала через ${(i + 1) * 0.5} с`);
        }
        await page.screenshot({ path: path.join(shots, '5-card-on-click.png') });
        const before = await player(page).locator('.now .title').innerText();
        await card.locator('a[href*="yandexMusic.next"], a[data-href*="yandexMusic.next"]').first().click();
        await until('смены трека', async () => (await player(page).locator('.now .title').innerText()) !== before);
      });
      await expectSound('после «Следующий» из карточки', 0.1);
      await page.screenshot({ path: path.join(shots, '6-final.png') });

      const sbIn = (p: Page, id: string) => p.locator(`[id="entropious.vscode-yandex-music.yandexMusic.${id}"]`);
      let second!: Page;

      await step('второе окно — пульт: показывает трек, который играет в первом', async () => {
        await page.keyboard.press('Escape');
        const opened = nextWindow();
        await page.keyboard.press(`${mod}+Shift+N`);
        second = await opened;
        second.setDefaultTimeout(30000);
        await second.waitForSelector('.monaco-workbench', { timeout: 60000 });
        const title = await sb('track').innerText();
        await until('трека первого окна во втором', async () => (await sbIn(second, 'track').innerText()) === title, 30000);
        await second.screenshot({ path: path.join(shots, '7-second-window.png') });
      });

      await step('«Следующий» во втором окне переключает трек в первом', async () => {
        const before = await player(page).locator('.now .title').innerText();
        await sbIn(second, 'next').click();
        await until('смены трека в первом окне', async () => (await player(page).locator('.now .title').innerText()) !== before);
        await until('воспроизведения в первом окне', async () => (await position(page)) !== '0:00');
        const now = await sb('track').innerText();
        await until('того же трека во втором окне', async () => (await sbIn(second, 'track').innerText()) === now);
      });
      await expectSound('трек, переключённый из второго окна', 0.1);

      await step('первое окно закрыто → второе становится ведущим и продолжает', async () => {
        const title = await sbIn(second, 'track').innerText();
        await page.keyboard.press(`${mod}+Shift+W`);
        const how = await until('воспроизведения или запроса клика во втором окне', async () => {
          if (await player(second).locator('#gesture').isVisible()) {
            return 'gesture';
          }
          return (await position(second)) !== '0:00' && 'playing';
        });
        if (how === 'gesture') {
          await player(second).locator('#gesture').click();
          await until('роста позиции', async () => (await position(second)) !== '0:00');
        }
        assert.strictEqual(await sbIn(second, 'track').innerText(), title);
        console.log(`(${how === 'gesture' ? 'понадобился клик «Включить звук»' : 'заиграло сразу'})`);
        await second.screenshot({ path: path.join(shots, '8-takeover.png') });
      });
      await expectSound('второе окно после закрытия первого', 0.1);
    } else {
      const title = await player(page).locator('.now .title').innerText();
      const artist = await player(page).locator('.now .artist').innerText();
      console.log(`  сейчас играет: ${artist} — ${title}`);
    }
    console.log('\nE2E: всё прошло');
  } catch (e) {
    await page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => undefined);
    throw e;
  } finally {
    await quit();
    await server?.close();
  }
}

main().catch((e) => {
  console.error('\nE2E FAILED:', e);
  process.exit(1);
});
