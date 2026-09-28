/**
 * End-to-end test in a real VS Code: Playwright drives the window the way a user would
 * (command palette, mouse clicks, keyboard shortcuts), while the audio output is recorded
 * from a PulseAudio monitor and analyzed.
 *
 *   YM_AUDIO_DEVICE=<sink>.monitor xvfb-run -a npm run e2e              # mock Yandex Music API
 *   YM_TOKEN=<oauth> YM_AUDIO_DEVICE=... xvfb-run -a npm run e2e        # real Yandex Music
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
/** Modifier key for the extension's shortcuts: Cmd on macOS, Ctrl everywhere else. */
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
  throw new Error(`timed out waiting for ${what}`);
}

function player(page: Page): FrameLocator {
  return page.frameLocator('iframe.webview.ready').frameLocator('#active-frame');
}

async function position(page: Page): Promise<string> {
  return player(page).locator('#pos').innerText();
}

async function expectSound(label: string, minRms: number) {
  if (!audioProbeAvailable()) {
    console.log(`  (sound not checked: YM_AUDIO_DEVICE is not set)`);
    return;
  }
  const a = await recordAudio(2000);
  console.log(`  ${label}: RMS=${a.rms.toFixed(3)} peak=${a.peak.toFixed(3)} f≈${a.zeroCrossHz.toFixed(0)} Hz over ${a.seconds.toFixed(1)} s`);
  assert.ok(a.rms > minRms, `${label}: silence (RMS ${a.rms})`);
  if (!real) {
    assert.ok(Math.abs(a.zeroCrossHz - 440) < 20, `${label}: expected a 440 Hz tone, got ${a.zeroCrossHz}`);
  }
}

async function expectSilence(label: string) {
  if (!audioProbeAvailable()) {
    return;
  }
  const a = await recordAudio(1000);
  console.log(`  ${label}: RMS=${a.rms.toFixed(4)}`);
  assert.ok(a.rms < 0.005, `${label}: expected silence, RMS ${a.rms}`);
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
      '--password-store=basic', // no system keyring in the container
      `--extensionDevelopmentPath=${root}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${path.join(tmp, 'ext')}`,
      workspace,
    ],
    { log: path.join(tmp, 'vscode.log') },
  );
  // Playwright attaches to an already running VS Code, so on macOS its windows stay in the background.
  const browser = await until('the VS Code DevTools port', () => chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`), 60000);
  const context = browser.contexts()[0];
  const workbench = (p: Page) => p.url().includes('workbench');
  const page = await until('a VS Code window', async () => context.pages().find(workbench), 60000);
  page.setDefaultTimeout(30000);
  const nextWindow = async () => {
    const known = new Set(context.pages());
    return until('a new VS Code window', async () => context.pages().find((p) => workbench(p) && !known.has(p)), 60000);
  };
  const quit = async () => {
    const cdp = await browser.newBrowserCDPSession().catch(() => undefined);
    await cdp?.send('Browser.close').catch(() => undefined);
    await new Promise((r) => (proc.exitCode !== null ? r(undefined) : proc.once('exit', r)));
  };

  try {
    await step('VS Code started', async () => {
      await page.waitForSelector('.monaco-workbench', { timeout: 60000 });
      await until('the extension status bar item', async () => (await page.locator('.statusbar-item', { hasText: 'Yandex Music' }).count()) > 0, 60000);
    });

    await step('sign in: Command Palette → "Enter OAuth Token Manually"', async () => {
      await page.keyboard.press('F1');
      await page.keyboard.type('Yandex Music: Enter OAuth');
      await page.screenshot({ path: path.join(shots, '0-palette.png') });
      await page.locator('.quick-input-list .monaco-list-row', { hasText: 'Enter OAuth Token Manually' }).first().click();
      await page.locator('.quick-input-box input').fill(token);
      await page.screenshot({ path: path.join(shots, '0-token.png') });
      await page.keyboard.press('Enter');
      await page.locator('.activitybar [aria-label="Yandex Music"]').first().click();
      await player(page).locator('.account .name').waitFor({ timeout: 30000 });
      console.log(`(${await player(page).locator('.account').innerText()})`);
    });

    await step('Ctrl+Alt+P shortcut → My Vibe starts', async () => {
      await page.locator('.monaco-workbench .part.editor').click({ position: { x: 300, y: 200 } });
      await page.keyboard.press(`${mod}+Alt+P`);
      // A key press in the VS Code window counts as a user gesture, which is usually enough.
      // If the webview still blocks autoplay, the panel shows a "▶ Enable sound" button.
      const how = await until('playback or a click request', async () => {
        if (await player(page).locator('#gesture').isVisible()) {
          return 'gesture';
        }
        return (await position(page)) !== '0:00' && 'playing';
      });
      if (how === 'gesture') {
        await page.screenshot({ path: path.join(shots, '1-needs-click.png') });
        await expectSilence('before the click');
        await player(page).locator('#gesture').click();
        await until('the position to advance', async () => (await position(page)) !== '0:00');
      }
      console.log(`(${how === 'gesture' ? 'needed a click on "Enable sound"' : 'started playing right away'})`);
    });
    await expectSound('track playing', real ? 0.01 : 0.1);
    await page.screenshot({ path: path.join(shots, '2-playing.png') });

    await step('Ctrl+Alt+P → pause', async () => {
      await page.locator('.monaco-workbench .part.editor').click({ position: { x: 300, y: 200 } });
      await page.keyboard.press(`${mod}+Alt+P`);
      await player(page).locator('#play[aria-label="Play"]').waitFor();
    });
    await sleep(300);
    await expectSilence('paused');

    await step('▶ button in the panel → resumes', async () => {
      await player(page).locator('#play').click();
      await player(page).locator('#play[aria-label="Pause"]').waitFor();
    });
    await expectSound('after pause', real ? 0.01 : 0.1);

    if (!real) {
      await step('Search tab: search and click the 3rd track', async () => {
        await player(page).locator('[data-tab="search"]').click();
        await player(page).locator('#q').fill('Test');
        await player(page).locator('#searchForm button').click();
        await player(page).locator('#results li').nth(2).click();
        await player(page).locator('.now .title', { hasText: 'Test Track 3' }).waitFor();
        await until('track 3 in the status bar', async () => (await page.locator('.statusbar-item', { hasText: 'Test Track 3' }).count()) > 0);
      });
      await expectSound('track from search', 0.1);

      await step('♡ → the like reaches the API', async () => {
        await player(page).locator('.like').click();
        await player(page).locator('.like.on').waitFor();
        assert.ok(server!.liked.has(1003));
      });

      await step('Ctrl+Alt+→ → next track', async () => {
        await page.locator('.monaco-workbench .part.editor').click({ position: { x: 300, y: 200 } });
        await page.keyboard.press(`${mod}+Alt+ArrowRight`);
        await player(page).locator('.now .title', { hasText: 'Test Track 4' }).waitFor();
        await until('playback', async () => (await position(page)) !== '0:00');
      });
      await expectSound('next track', 0.1);
      await page.screenshot({ path: path.join(shots, '3-search-like.png') });

      await step('track plays to the end → next one starts automatically', async () => {
        await player(page).locator('.now .title', { hasText: 'Test Track 5' }).waitFor({ timeout: 20000 });
      });

      const sb = (id: string) => page.locator(`[id="entro.vscode-yandex-music.yandexMusic.${id}"]`);

      await step('status bar: ⏸ button pauses', async () => {
        await sb('play').click();
        await player(page).locator('#play[aria-label="Play"]').waitFor();
      });
      await sleep(300);
      await expectSilence('paused from the status bar');

      await step('status bar: hovering the track shows the card with buttons', async () => {
        await sb('track').hover();
        await page.locator('.monaco-hover img[alt*="Test Track 5"]').waitFor();
        await page.screenshot({ path: path.join(shots, '4-statusbar-hover.png') });
        await page.locator('.monaco-hover a[href*="yandexMusic.playPause"], .monaco-hover a[data-href*="yandexMusic.playPause"]').first().click();
        await player(page).locator('#play[aria-label="Pause"]').waitFor();
      });
      await expectSound('play from the hover card', 0.1);

      await step('click the track in the status bar → mini player card → Next', async () => {
        await page.keyboard.press('Escape');
        await page.mouse.move(700, 500);
        await page.locator('.monaco-hover').first().waitFor({ state: 'hidden' });
        await sb('track').click();
        const card = page.locator('.monaco-hover').filter({ has: page.locator('a[href*="yandexMusic.next"], a[data-href*="yandexMusic.next"]') });
        await card.waitFor({ timeout: 3000 });
        // The track is playing and the position updates every second; the card must not flicker.
        for (let i = 0; i < 6; i++) {
          await sleep(500);
          assert.ok(await card.isVisible(), `the card disappeared after ${(i + 1) * 0.5} s`);
        }
        await page.screenshot({ path: path.join(shots, '5-card-on-click.png') });
        const before = await player(page).locator('.now .title').innerText();
        await card.locator('a[href*="yandexMusic.next"], a[data-href*="yandexMusic.next"]').first().click();
        await until('the track to change', async () => (await player(page).locator('.now .title').innerText()) !== before);
      });
      await expectSound('after Next from the card', 0.1);
      await page.screenshot({ path: path.join(shots, '6-final.png') });

      const sbIn = (p: Page, id: string) => p.locator(`[id="entro.vscode-yandex-music.yandexMusic.${id}"]`);
      let second!: Page;

      await step('second window is a remote: shows the track playing in the first', async () => {
        await page.keyboard.press('Escape');
        const opened = nextWindow();
        await page.keyboard.press(`${mod}+Shift+N`);
        second = await opened;
        second.setDefaultTimeout(30000);
        await second.waitForSelector('.monaco-workbench', { timeout: 60000 });
        const title = await sb('track').innerText();
        await until("the first window's track in the second", async () => (await sbIn(second, 'track').innerText()) === title, 30000);
        await second.screenshot({ path: path.join(shots, '7-second-window.png') });
      });

      await step('Next in the second window switches the track in the first', async () => {
        const before = await player(page).locator('.now .title').innerText();
        await sbIn(second, 'next').click();
        await until('the track to change in the first window', async () => (await player(page).locator('.now .title').innerText()) !== before);
        await until('playback in the first window', async () => (await position(page)) !== '0:00');
        const now = await sb('track').innerText();
        await until('the same track in the second window', async () => (await sbIn(second, 'track').innerText()) === now);
      });
      await expectSound('track switched from the second window', 0.1);

      await step('first window closed → the second takes over and keeps playing', async () => {
        const title = await sbIn(second, 'track').innerText();
        await page.keyboard.press(`${mod}+Shift+W`);
        const how = await until('playback or a click request in the second window', async () => {
          if (await player(second).locator('#gesture').isVisible()) {
            return 'gesture';
          }
          return (await position(second)) !== '0:00' && 'playing';
        });
        if (how === 'gesture') {
          await player(second).locator('#gesture').click();
          await until('the position to advance', async () => (await position(second)) !== '0:00');
        }
        assert.strictEqual(await sbIn(second, 'track').innerText(), title);
        console.log(`(${how === 'gesture' ? 'needed a click on "Enable sound"' : 'started playing right away'})`);
        await second.screenshot({ path: path.join(shots, '8-takeover.png') });
      });
      await expectSound('second window after the first closed', 0.1);
    } else {
      const title = await player(page).locator('.now .title').innerText();
      const artist = await player(page).locator('.now .artist').innerText();
      console.log(`  now playing: ${artist} — ${title}`);
    }
    console.log('\nE2E: all passed');
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
