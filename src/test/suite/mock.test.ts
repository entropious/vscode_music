import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { MOCK_TOKEN, startMockServer } from '../mockServer';
import { status, waitFor } from './helpers';

const fixtures = path.resolve(__dirname, '../../../test-fixtures');

/**
 * Логика расширения внутри настоящего VS Code на mock-API.
 * Сам звук здесь не проверяется: без клика по панели webview не даёт играть
 * (это проверяет e2e-тест на Playwright, см. src/test/e2e.ts).
 */
suite('Яндекс Музыка: логика на mock-API', function () {
  this.timeout(60000);
  let server: Awaited<ReturnType<typeof startMockServer>>;

  suiteSetup(async function () {
    if (process.env.YM_TOKEN) {
      this.skip();
    }
    server = await startMockServer(path.join(fixtures, 'tone.mp3'));
    await vscode.workspace.getConfiguration('yandexMusic').update('apiBaseUrl', server.base, vscode.ConfigurationTarget.Global);
    await vscode.extensions.getExtension('entropious.vscode-yandex-music')!.activate();
  });

  suiteTeardown(async () => {
    await server?.close();
  });

  test('без входа ничего не играет', async () => {
    await vscode.commands.executeCommand('yandexMusic.signOut');
    const s = await status();
    assert.strictEqual(s.index, -1);
    assert.strictEqual(s.playing, false);
  });

  test('вход по токену', async () => {
    const acc: any = await vscode.commands.executeCommand('yandexMusic.setToken', MOCK_TOKEN);
    assert.strictEqual(acc.login, 'tester');
  });

  test('«Моя волна»: подписанная ссылка на MP3 отдаётся в webview, без клика просит жест', async () => {
    await vscode.commands.executeCommand('yandexMusic.playMyWave');
    const s = await waitFor('загрузки трека в webview', async () => {
      const s = await status();
      return s.duration > 7 && s;
    });
    assert.strictEqual(s.source, 'Моя волна');
    assert.ok(s.title?.includes('Тестовый трек 1'), s.title);
    assert.ok(server.log.some((l) => l.startsWith('GET /get-mp3/')), 'MP3 должен скачиваться по подписанной ссылке');
    if (!s.playing) {
      assert.ok((await status()).needsGesture, 'если не играет — должен просить клик');
    }
  });

  test('следующий трек и лайк', async () => {
    await vscode.commands.executeCommand('yandexMusic.next');
    await waitFor('второго трека', async () => (await status()).index === 1);
    assert.ok(!server.liked.has(1002));
    assert.strictEqual(await vscode.commands.executeCommand('yandexMusic.like'), true);
    assert.ok(server.liked.has(1002));
    assert.strictEqual(await vscode.commands.executeCommand('yandexMusic.like'), false);
    assert.ok(!server.liked.has(1002));
  });

  test('конец волны подгружает новые треки', async () => {
    await vscode.commands.executeCommand('yandexMusic.next');
    await waitFor('подгрузки волны', async () => (await status()).queueLength > 3);
  });

  test('поиск, «Мне нравится», плейлист', async () => {
    await vscode.commands.executeCommand('yandexMusic.search', 'Тестовый', 4);
    await waitFor('трека из поиска', async () => {
      const s = await status();
      return s.source.startsWith('Поиск') && s.index === 4;
    });
    await vscode.commands.executeCommand('yandexMusic.playLiked');
    await waitFor('«Мне нравится»', async () => {
      const s = await status();
      return s.source === 'Мне нравится' && s.queueLength === 1;
    });
  });
});
