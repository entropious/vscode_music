import * as vscode from 'vscode';
import { Track, YandexMusicClient, artistLine, fullTitle } from './api';
import { Auth } from './auth';
import { Player } from './player';
import { PlayerSync, socketPathFor } from './sync';

export interface ExtensionApi {
  player: Player;
  auth: Auth;
  sync: PlayerSync;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const auth = new Auth(context.secrets, context.globalStorageUri.fsPath);
  const config = () => vscode.workspace.getConfiguration('yandexMusic');
  const clientFactory = async () => new YandexMusicClient(config().get<string>('apiBaseUrl', 'https://api.music.yandex.net'), await auth.getToken());

  const player = new Player(context.extensionUri, clientFactory);
  const sync = new PlayerSync(player, socketPathFor(context.globalStorageUri.fsPath));

  const guard =
    <A extends unknown[]>(fn: (...args: A) => Promise<unknown>) =>
    async (...args: A) => {
      try {
        return await fn(...args);
      } catch (e) {
        player.showError(e);
        return undefined;
      }
    };

  context.subscriptions.push(
    player,
    vscode.window.registerWebviewViewProvider(Player.viewId, player, { webviewOptions: { retainContextWhenHidden: true } }),
    auth.onDidChange(() => void player.refreshAccount()),

    vscode.commands.registerCommand(
      'yandexMusic.signIn',
      guard(async () => {
        const choice = await vscode.window.showQuickPick(
          [
            { label: '$(globe) Sign in with browser', description: 'Opens the Yandex sign-in page', id: 'browser' },
            { label: '$(key) Enter OAuth token', description: 'If you already have one', id: 'token' },
          ],
          { placeHolder: 'How do you want to sign in to Yandex Music?' },
        );
        if (choice?.id === 'browser') {
          const token = await auth.signInWithBrowser(config().get<string>('oauthBaseUrl', 'https://oauth.yandex.ru'));
          if (token) {
            const acc = await player.refreshAccount();
            vscode.window.showInformationMessage(`Yandex Music: signed in as ${acc?.login ?? '?'}`);
          }
        } else if (choice?.id === 'token') {
          await vscode.commands.executeCommand('yandexMusic.setToken');
        }
      }),
    ),
    vscode.commands.registerCommand(
      'yandexMusic.setToken',
      guard(async (token?: string) => {
        const value =
          token ??
          (await vscode.window.showInputBox({ prompt: 'Yandex Music OAuth token', password: true, ignoreFocusOut: true, placeHolder: 'y0_…' }));
        if (!value) {
          return;
        }
        await auth.setToken(value);
        const acc = await player.refreshAccount();
        if (!acc) {
          throw new Error('This token was rejected. Check it and try again.');
        }
        if (!token) {
          vscode.window.showInformationMessage(`Yandex Music: signed in as ${acc.login}`);
        }
        return acc;
      }),
    ),
    vscode.commands.registerCommand(
      'yandexMusic.signOut',
      guard(async () => {
        await auth.setToken(undefined);
        await player.refreshAccount();
      }),
    ),
    // Clicking a status bar item leaves it focused, and showHover shows the focused
    // item's tooltip, which is the mini player card.
    vscode.commands.registerCommand('yandexMusic.showCard', () => vscode.commands.executeCommand('workbench.action.showHover')),
    vscode.commands.registerCommand('yandexMusic.playPause', guard(() => player.playPause())),
    vscode.commands.registerCommand('yandexMusic.next', guard(() => player.next())),
    vscode.commands.registerCommand('yandexMusic.previous', guard(() => player.previous())),
    vscode.commands.registerCommand('yandexMusic.like', guard(() => player.toggleLike())),
    vscode.commands.registerCommand('yandexMusic.playMyWave', guard(() => player.playSource({ kind: 'wave' }))),
    vscode.commands.registerCommand('yandexMusic.playLiked', guard(() => player.playSource({ kind: 'liked' }))),
    vscode.commands.registerCommand(
      'yandexMusic.playPlaylist',
      guard(async () => {
        const lists = await player.loadPlaylists();
        const pick = await vscode.window.showQuickPick(
          lists.map((p) => ({ label: p.title, description: `${p.trackCount} ${p.trackCount === 1 ? 'track' : 'tracks'}`, p })),
          { placeHolder: 'Choose a playlist' },
        );
        if (pick) {
          await player.playSource({ kind: 'playlist', playlist: pick.p });
        }
      }),
    ),
    vscode.commands.registerCommand(
      'yandexMusic.search',
      guard(async (query?: string, index?: number) => {
        const q = query ?? (await vscode.window.showInputBox({ prompt: 'Search Yandex Music', placeHolder: 'Artist or track' }));
        if (!q) {
          return;
        }
        const results = await player.search(q);
        if (!results.length) {
          vscode.window.showInformationMessage(`No results for "${q}"`);
          return;
        }
        let i = index;
        if (i === undefined) {
          const pick = await vscode.window.showQuickPick(
            results.map((t: Track, n) => ({ label: fullTitle(t), description: artistLine(t), n })),
            { placeHolder: 'Choose a track' },
          );
          i = pick?.n;
        }
        if (i !== undefined) {
          await player.playTracks(results, i, { kind: 'search', query: q });
        }
      }),
    ),
    // Used by tests and for debugging.
    vscode.commands.registerCommand('yandexMusic.getStatus', () => player.getStatus()),
  );

  context.subscriptions.push(sync);
  void sync
    .start()
    .then(() => player.preloadWave())
    .catch(() => undefined);

  return { player, auth, sync };
}

export function deactivate(): void {}
