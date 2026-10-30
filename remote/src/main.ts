/**
 * Yandex Music Remote: a fullscreen remote for the big screen. It plays nothing itself; it
 * attaches to the player service the VS Code extension runs on macOS (`out/service.js`) and
 * controls it the way a VS Code window does.
 *
 *   electron . [--windowed] [--socket <path>]
 */
import * as path from 'node:path';
import { BrowserWindow, app, ipcMain, powerSaveBlocker, shell } from 'electron';
import { type BridgeEvent, CHANNEL } from './bridge.ts';
import { ServiceLink } from './link.ts';
import type { PlaybackStatus, RemoteMethod, SharedState } from './wire.ts';

const argv = process.argv.slice(1);
const windowed = argv.includes('--windowed');
const socketArg = argv[argv.indexOf('--socket') + 1];
const fixedSocket = argv.includes('--socket') ? socketArg : undefined;

/** The built files; Bun's bundler fixes `__dirname` at build time, so they are found from the app's root. */
const OUT = (): string => path.join(app.getAppPath(), 'out');

let win: BrowserWindow | undefined;
let lastState: SharedState | undefined;
let lastStatus: PlaybackStatus | undefined;
/** Keeps the display awake while music plays, the way a video player does. */
let awake: number | undefined;

function emit(event: BridgeEvent): void {
  win?.webContents.send(CHANNEL.event, event);
}

function keepAwake(playing: boolean): void {
  if (playing && awake === undefined) {
    awake = powerSaveBlocker.start('prevent-display-sleep');
  } else if (!playing && awake !== undefined) {
    powerSaveBlocker.stop(awake);
    awake = undefined;
  }
}

const link = new ServiceLink(
  {
    link: (state) => {
      if (state !== 'connected') {
        keepAwake(false);
      }
      emit({ type: 'link', link: state });
    },
    state: (state) => {
      lastState = state;
      emit({ type: 'state', state });
    },
    status: (status) => {
      lastStatus = status;
      keepAwake(status.playing);
      emit({ type: 'status', status });
    },
    notice: (text) => emit({ type: 'notice', text }),
  },
  fixedSocket,
);

function createWindow(): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 600,
    fullscreen: !windowed,
    backgroundColor: '#06070A',
    title: 'Yandex Music Remote',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: path.join(OUT(), 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => (win = undefined));
  // Links never open inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  void win.loadFile(path.join(OUT(), 'renderer', 'index.html'));
}

ipcMain.handle(CHANNEL.call, (_e, method: RemoteMethod, args: unknown[]) => link.call(method, args));
// A window that has (re)loaded gets the current picture at once.
ipcMain.on(CHANNEL.ready, () => {
  emit({ type: 'link', link: link.state });
  if (lastState) {
    emit({ type: 'state', state: lastState });
  }
  if (lastStatus) {
    emit({ type: 'status', status: lastStatus });
  }
});
ipcMain.on(CHANNEL.fullScreen, () => win?.setFullScreen(!win.isFullScreen()));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win?.isMinimized()) {
      win.restore();
    }
    win?.focus();
  });
  void app.whenReady().then(() => {
    createWindow();
    link.start();
    app.on('activate', () => {
      if (!win) {
        createWindow();
      }
    });
  });
  // A remote is no use without its window, on macOS too.
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => link.stop());
}
