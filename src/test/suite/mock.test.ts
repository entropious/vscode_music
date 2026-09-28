import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../../extension';
import { MOCK_TOKEN, startMockServer } from '../mockServer';
import { status, waitFor } from './helpers';

const fixtures = path.resolve(__dirname, '../../../test-fixtures');

/**
 * Extension logic inside a real VS Code, against the mock API.
 * Actual audio isn't checked here: the webview won't play without a click on the panel
 * (the Playwright e2e test covers that, see src/test/e2e.ts).
 */
suite('Yandex Music: logic against the mock API', function () {
  this.timeout(60000);
  let server: Awaited<ReturnType<typeof startMockServer>>;

  suiteSetup(async function () {
    if (process.env.YM_TOKEN) {
      this.skip();
    }
    server = await startMockServer(path.join(fixtures, 'tone.mp3'));
    await vscode.workspace.getConfiguration('yandexMusic').update('apiBaseUrl', server.base, vscode.ConfigurationTarget.Global);
    await vscode.extensions.getExtension('entro.vscode-yandex-music')!.activate();
  });

  suiteTeardown(async () => {
    await server?.close();
  });

  test('nothing plays when signed out', async () => {
    await vscode.commands.executeCommand('yandexMusic.signOut');
    const s = await status();
    assert.strictEqual(s.index, -1);
    assert.strictEqual(s.playing, false);
  });

  test('signs in with a token', async () => {
    const acc: any = await vscode.commands.executeCommand('yandexMusic.setToken', MOCK_TOKEN);
    assert.strictEqual(acc.login, 'tester');
  });

  test('on startup My Vibe is queued without playing, and play starts it', async () => {
    const api = vscode.extensions.getExtension<ExtensionApi>('entro.vscode-yandex-music')!.exports;
    await api.player.preloadWave();
    const s = await status();
    assert.strictEqual(s.source, 'My Vibe');
    assert.strictEqual(s.index, 0);
    assert.ok(s.title?.includes('Test Track 1'), s.title);
    assert.strictEqual(s.playing, false);
    assert.ok(!server.log.some((l) => l.startsWith('GET /get-mp3/')), 'the stream must not be requested before play');

    await vscode.commands.executeCommand('yandexMusic.playPause');
    await waitFor('the track to load in the webview', async () => (await status()).duration > 7);
    assert.ok(server.log.some((l) => l.startsWith('GET /get-mp3/')));
  });

  test('My Vibe: the signed MP3 link reaches the webview, which asks for a click if it cannot autoplay', async () => {
    await vscode.commands.executeCommand('yandexMusic.playMyWave');
    const s = await waitFor('the track to load in the webview', async () => {
      const s = await status();
      return s.duration > 7 && s;
    });
    assert.strictEqual(s.source, 'My Vibe');
    assert.ok(s.title?.includes('Test Track 1'), s.title);
    assert.ok(server.log.some((l) => l.startsWith('GET /get-mp3/')), 'the MP3 must be downloaded via the signed link');
    if (!s.playing) {
      assert.ok((await status()).needsGesture, 'when not playing, it must ask for a click');
    }
  });

  test('every My Vibe start opens a new radio session and reports playback to it', async () => {
    const started = await waitFor('radioStarted from two sessions', async () => {
      const ids = new Set(server.feedback.filter((f) => f.event.type === 'radioStarted').map((f) => f.sessionId));
      return ids.size >= 2 && ids;
    });
    const latest = [...started].pop()!;
    await waitFor('trackStarted for the first track', async () =>
      server.feedback.some((f) => f.sessionId === latest && f.event.type === 'trackStarted' && f.event.trackId === '1001:501' && f.batchId),
    );
  });

  test('next track and like', async () => {
    await vscode.commands.executeCommand('yandexMusic.next');
    await waitFor('the second track', async () => (await status()).index === 1);
    await waitFor('a skip for the first track', async () => server.feedback.some((f) => f.event.type === 'skip' && f.event.trackId === '1001:501'));
    assert.ok(!server.liked.has(1002));
    assert.strictEqual(await vscode.commands.executeCommand('yandexMusic.like'), true);
    assert.ok(server.liked.has(1002));
    assert.strictEqual(await vscode.commands.executeCommand('yandexMusic.like'), false);
    assert.ok(!server.liked.has(1002));
  });

  test('reaching the end of My Vibe loads more tracks', async () => {
    await vscode.commands.executeCommand('yandexMusic.next');
    await waitFor('more My Vibe tracks', async () => (await status()).queueLength > 3);
    assert.ok(server.log.some((l) => /^POST \/rotor\/session\/[^/]+\/tracks$/.test(l)), 'more tracks must come from the radio session');
  });

  test('search and Liked', async () => {
    await vscode.commands.executeCommand('yandexMusic.search', 'Test', 4);
    await waitFor('the track from search', async () => {
      const s = await status();
      return s.source.startsWith('Search') && s.index === 4;
    });
    await vscode.commands.executeCommand('yandexMusic.playLiked');
    await waitFor('Liked', async () => {
      const s = await status();
      return s.source === 'Liked' && s.queueLength === 1;
    });
  });
});
