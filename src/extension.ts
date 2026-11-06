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
const REMOTE_DOCS = 'https://github.com/entropious/vscode_music#fullscreen-remote-macos';
/** The repository whose remote/scripts/install.sh builds and installs the remote. */
const REMOTE_REPO = 'entropious/vscode_music';
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
   * ~/Applications, where the install script puts it. A copy anywhere else, such as a build in a
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

  /** The version of the extension the installed remote was built with (see remote/scripts/package.ts). */
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
   * Opens the fullscreen remote; it starts the player service itself if no window has. A remote
   * built with an older version of the extension is offered an update first.
   */
  const openRemote = async () => {
    const app = findRemote();
    if (!app) {
      const install = 'Install';
      const more = 'Learn More';
      const choice = await vscode.window.showInformationMessage(
        "Yandex Music Remote, the fullscreen app that controls this player, isn't installed. Install it? It is built on this Mac: about 120 MB to download and a few minutes. Bun is installed too if you don't have it.",
        install,
        more,
      );
      if (choice === install) {
        installRemote();
      } else if (choice === more) {
        void vscode.env.openExternal(vscode.Uri.parse(REMOTE_DOCS));
      }
      return;
    }
    const version = String(context.extension.packageJSON.version);
    const built = await remoteVersion(app);
    if (older(built, version)) {
      const update = 'Update';
      const open = 'Open Anyway';
      const choice = await vscode.window.showInformationMessage(
        `Yandex Music Remote was built with ${built && /^\d+(\.\d+)*$/.test(built) ? `version ${built} of this extension` : 'an older version of this extension'}, and this one is ${version}. Update it? It is built again on this Mac in a minute or two.`,
        update,
        open,
      );
      if (choice === update) {
        installRemote();
        return;
      }
      if (choice !== open) {
        return;
      }
    }
    // `open` passes its environment on to the app, and VS Code's ELECTRON_RUN_AS_NODE would start
    // the app's Electron as plain Node, which quits at once.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ELECTRON_')));
    const opened = await new Promise<boolean>((resolve) => execFile('open', [app], { env }, (err) => resolve(!err)));
    if (!opened) {
      vscode.window.showErrorMessage(`Couldn't open Yandex Music Remote at ${app}.`);
    }
  };

  /** Builds and installs the remote in a terminal, with the install script of this version's tag. */
  const installRemote = () => {
    const ref = `v${String(context.extension.packageJSON.version)}`;
    const script = `https://raw.githubusercontent.com/${REMOTE_REPO}/${ref}/remote/scripts/install.sh`;
    const terminal = vscode.window.createTerminal({
      name: 'Yandex Music Remote',
      shellPath: '/bin/bash',
      shellArgs: ['-c', `curl -fsSL '${script}' | bash -s -- '${ref}'; echo; read -n 1 -s -r -p 'Press any key to close.'`],
      env: { ELECTRON_RUN_AS_NODE: null },
    });
    terminal.show();
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
    vscode.commands.registerCommand('yandexMusic.installRemote', installRemote),
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
