import { execFile } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { type Station, Track, YandexMusicClient, artistLine, fullTitle } from './api';
import { Auth } from './auth';
import { Player } from './player';
import { PROTOCOL, serviceBuild, socketPathFor } from './protocol';
import { ServiceClient } from './serviceClient';
import { PlayerSync } from './sync';

const REMOTE_APP = 'Yandex Music Remote.app';
/** Where Homebrew may be, which installs yt-dlp for the remote's music videos from YouTube. */
const BREW = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
const YT_DLP = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', `${process.env.HOME ?? ''}/.local/bin/yt-dlp`];
/** The Genius API token in VS Code's secret storage; the player service keeps its own copy in the login keychain. */
const GENIUS_SECRET = 'geniusToken';

export interface ExtensionApi {
  player: Player;
  auth: Auth;
  /** Connection to the background player service (macOS). */
  service?: ServiceClient;
  /** Leader election between windows where there is no service. */
  sync?: PlayerSync;
}

export function activate(context: vscode.ExtensionContext): ExtensionApi {
  const auth = new Auth(context.secrets, context.globalStorageUri.fsPath);
  const config = () => vscode.workspace.getConfiguration('yandexMusic');
  const apiBaseUrl = () => config().get<string>('apiBaseUrl', 'https://api.music.yandex.net');
  const clientFactory = async () => new YandexMusicClient(apiBaseUrl(), await auth.getToken());

  const player = new Player(context.extensionUri, context.globalStorageUri, clientFactory);
  let service: ServiceClient | undefined;
  let sync: PlayerSync | undefined;
  if (process.platform === 'darwin') {
    const script = context.asAbsolutePath('out/service.js');
    const helper = context.asAbsolutePath('helper/avplayer.js');
    const build = serviceBuild(context.asAbsolutePath('out'), helper);
    service = new ServiceClient(
      player,
      socketPathFor(context.globalStorageUri.fsPath, 'service'),
      { script, helper, log: vscode.Uri.joinPath(context.globalStorageUri, 'service.log').fsPath },
      async () => ({
        protocol: PROTOCOL,
        ...build,
        token: await auth.getToken(),
        apiBaseUrl: apiBaseUrl(),
        quality: config().get<'high' | 'low'>('quality', 'high'),
        volume: config().get<number>('volume', 0.7),
        aiLabels: config().get<boolean>('aiLabels', true),
        motionCovers: config().get<boolean>('remote.motionCovers', true),
        musicVideos: config().get<boolean>('remote.musicVideos', true),
        geniusToken: await context.secrets.get(GENIUS_SECRET),
      }),
    );
    const s = service;
    player.useService(() => s.ensureRunning());
  } else {
    sync = new PlayerSync(player, socketPathFor(context.globalStorageUri.fsPath));
  }

  /** The service gets the new token before the account is reloaded, so it reloads with it. */
  const onTokenChanged = async () => {
    await service?.sendSettings();
    await player.refreshAccount();
  };

  /**
   * Where Yandex Music Remote, the fullscreen app in `remote/`, is installed on macOS: in
   * ~/Applications, where the extension copies it. A copy anywhere else, such as a build in a
   * checkout, doesn't count.
   */
  const findRemote = (): string | undefined => {
    const app = `${process.env.HOME ?? ''}/Applications/${REMOTE_APP}`;
    return process.platform === 'darwin' && fs.existsSync(app) ? app : undefined;
  };

  /**
   * Keeps a Genius API token, which the player service finds music videos on Genius with for
   * the fullscreen remote; an empty one removes it.
   */
  const setGeniusToken = async () => {
    if (process.platform !== 'darwin') {
      vscode.window.showInformationMessage('Music videos from Genius are for the fullscreen remote, which runs on macOS.');
      return;
    }
    const token = await vscode.window.showInputBox({
      title: 'Genius API Token',
      prompt: 'The Client Access Token of an API client at genius.com/api-clients. The fullscreen remote finds music videos on Genius with it. Leave empty to remove it.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (!v || /^[\w-]+$/.test(v.trim()) ? undefined : 'A token has only letters, digits, _ and -.'),
    });
    if (token === undefined) {
      return;
    }
    await (token.trim() ? context.secrets.store(GENIUS_SECRET, token.trim()) : context.secrets.delete(GENIUS_SECRET));
    await service?.sendSettings();
    vscode.window.showInformationMessage(token.trim() ? 'Genius token saved.' : 'Genius token removed.');
  };

  /** The version of the extension the installed remote came with (see remote/scripts/build-app.sh). */
  const remoteVersion = (app: string) =>
    new Promise<string | undefined>((resolve) =>
      execFile('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', `${app}/Contents/Info.plist`], (err, out) => resolve(err ? undefined : out.trim())),
    );

  /** Whether version `a` comes before `b`; one that isn't a version at all comes before any. */
  const older = (a: string | undefined, b: string) => {
    const parts = (v: string) => v.split('.').map(Number);
    if (!a || !/^\d+(\.\d+)*$/.test(a)) {
      return true;
    }
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) {
        return (x[i] ?? 0) < (y[i] ?? 0);
      }
    }
    return false;
  };

  /**
   * Opens the fullscreen remote; it starts the player service itself if no window has. The remote
   * that comes with this extension is installed first, without asking, when there is none or the
   * one there came with an older version of the extension.
   */
  const openRemote = async () => {
    const app = findRemote();
    if (!app || older(await remoteVersion(app), String(context.extension.packageJSON.version))) {
      await installRemote();
      return;
    }
    await launchRemote(app);
  };

  const run = (file: string, args: string[]) =>
    new Promise<string | undefined>((resolve) => execFile(file, args, (err, out) => resolve(err ? undefined : String(out))));

  const launchRemote = async (app: string) => {
    if ((await run('open', [app])) === undefined) {
      vscode.window.showErrorMessage(`Couldn't open Yandex Music Remote at ${app}.`);
    }
  };

  /**
   * Installs the remote that comes with this extension into ~/Applications, takes it out of
   * quarantine and opens it. yt-dlp, which finds the streams of music videos on YouTube, is
   * installed with Homebrew if it isn't there.
   */
  const installRemote = async () => {
    if (process.platform !== 'darwin') {
      vscode.window.showInformationMessage('Yandex Music Remote runs on macOS.');
      return;
    }
    const source = context.asAbsolutePath(`remote/dist/${REMOTE_APP}`);
    if (!fs.existsSync(source)) {
      vscode.window.showErrorMessage('This build of the extension came without Yandex Music Remote.');
      return;
    }
    const dir = `${process.env.HOME ?? ''}/Applications`;
    const app = `${dir}/${REMOTE_APP}`;
    const installed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing Yandex Music Remote' }, async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.rm(app, { recursive: true, force: true });
      if ((await run('ditto', [source, app])) === undefined) {
        return false;
      }
      await run('xattr', ['-dr', 'com.apple.quarantine', app]);
      // An extension's files may lose the executable bit on the way.
      await run('chmod', ['+x', `${app}/Contents/MacOS/YandexMusicRemote`]);
      return true;
    });
    if (!installed) {
      vscode.window.showErrorMessage(`Couldn't install Yandex Music Remote into ${dir}.`);
      return;
    }
    await installYtDlp();
    await launchRemote(app);
  };

  /** yt-dlp for the remote's music videos from YouTube; without it they are left out. */
  const installYtDlp = async () => {
    if (YT_DLP.some((p) => fs.existsSync(p))) {
      return;
    }
    const brew = BREW.find((p) => fs.existsSync(p));
    if (!brew) {
      vscode.window.showInformationMessage('Install yt-dlp (with Homebrew: brew install yt-dlp) for music videos from YouTube in Yandex Music Remote.');
      return;
    }
    const done = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Installing yt-dlp with Homebrew, for music videos from YouTube' },
      () => run(brew, ['install', 'yt-dlp']),
    );
    if (done === undefined) {
      vscode.window.showWarningMessage("Homebrew couldn't install yt-dlp; music videos from YouTube are left out. Try brew install yt-dlp in a terminal.");
    }
  };

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
    auth.onDidChange(() => void onTokenChanged().catch(() => undefined)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('yandexMusic')) {
        void service?.sendSettings();
      }
    }),

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
    vscode.commands.registerCommand('yandexMusic.openRemote', guard(openRemote)),
    vscode.commands.registerCommand('yandexMusic.installRemote', guard(installRemote)),
    vscode.commands.registerCommand('yandexMusic.setGeniusToken', guard(setGeniusToken)),
    vscode.commands.registerCommand('yandexMusic.showCard', () => vscode.commands.executeCommand('workbench.action.showHover')),
    vscode.commands.registerCommand('yandexMusic.playPause', guard(() => player.playPause())),
    vscode.commands.registerCommand('yandexMusic.next', guard(() => player.next())),
    vscode.commands.registerCommand('yandexMusic.previous', guard(() => player.previous())),
    vscode.commands.registerCommand('yandexMusic.like', guard(() => player.toggleLike())),
    vscode.commands.registerCommand('yandexMusic.dislike', guard(() => player.toggleDislike())),
    vscode.commands.registerCommand('yandexMusic.trackRadio', guard(() => player.startTrackRadio())),
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
        const q = query ?? (await vscode.window.showInputBox({ prompt: 'Search Yandex Music', placeHolder: 'Artist, track or genre' }));
        if (!q) {
          return;
        }
        const results = await player.search(q);
        const stations = player.core.searchStations;
        if (!results.length && !stations.length) {
          vscode.window.showInformationMessage(`No results for "${q}"`);
          return;
        }
        let i = index;
        if (i === undefined) {
          const pick = await vscode.window.showQuickPick<vscode.QuickPickItem & { n?: number; station?: Station }>(
            [
              ...stations.map((s) => ({ label: `$(radio-tower) ${s.name}`, description: 'Genre station', station: s })),
              ...results.map((t: Track, n) => ({ label: fullTitle(t), description: artistLine(t), n })),
            ],
            { placeHolder: 'Choose a genre station or a track' },
          );
          if (pick?.station) {
            await player.playSource({ kind: 'station', id: pick.station.id, name: pick.station.name });
            return;
          }
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

  if (service) {
    context.subscriptions.push(service);
    void service
      .start()
      .then(() => player.preloadWave())
      .catch(() => undefined);
  }
  if (sync) {
    context.subscriptions.push(sync);
    void sync
      .start()
      .then(() => player.preloadWave())
      .catch(() => undefined);
  }

  return { player, auth, service, sync };
}

export function deactivate(): void {}
