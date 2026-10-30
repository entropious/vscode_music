import { spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import type { RemoteMethod } from './core';
import type { Player } from './player';
import { type Message, type ServiceSettings, readMessages, send } from './protocol';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How often a window that isn't connected checks whether another window has started the service. */
const POLL_MS = 2000;
/** Longer than a few API requests in a row, each of which gives up after 15 s on its own. */
const CALL_TIMEOUT_MS = 45000;

export interface ServicePaths {
  /** out/service.js */
  script: string;
  /** helper/avplayer.js */
  helper: string;
  log: string;
}

/**
 * A window's connection to the macOS player service. While the service runs, the window is its
 * remote. The service is started by the first command that needs audio, and it receives this
 * window's queue so playback continues from what the window was showing.
 */
export class ServiceClient implements vscode.Disposable {
  private socket?: net.Socket;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextCallId = 1;
  private starting?: Promise<void>;
  private poll?: NodeJS.Timeout;
  private disposed = false;
  private readonly player: Player;
  private readonly socketPath: string;
  private readonly paths: ServicePaths;
  private readonly settings: () => Promise<ServiceSettings>;

  constructor(player: Player, socketPath: string, paths: ServicePaths, settings: () => Promise<ServiceSettings>) {
    this.player = player;
    this.socketPath = socketPath;
    this.paths = paths;
    this.settings = settings;
  }

  get connected(): boolean {
    return !!this.socket;
  }

  /** Connects if the service is already running and keeps checking for it; never starts it. */
  async start(): Promise<void> {
    await this.connect(false);
    this.poll = setInterval(() => {
      if (!this.socket && !this.starting && !this.disposed) {
        void this.connect(false);
      }
    }, POLL_MS);
  }

  /** Starts the service unless it's running, and connects to it. */
  ensureRunning(): Promise<void> {
    if (this.socket) {
      return Promise.resolve();
    }
    this.starting ??= this.launch().finally(() => (this.starting = undefined));
    return this.starting;
  }

  /** Sends the current token and settings to the service. */
  async sendSettings(): Promise<void> {
    const socket = this.socket;
    if (socket) {
      send(socket, { type: 'hello', settings: await this.settings() });
    }
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.poll);
    this.socket?.destroy();
  }

  private async launch(): Promise<void> {
    if (await this.connect(true)) {
      return;
    }
    // No service of this build answered: the socket file is either left over from one that
    // crashed or belongs to an older build, which exits on its own once no window is connected.
    await fs.promises.unlink(this.socketPath).catch(() => undefined);
    await fs.promises.mkdir(path.dirname(this.paths.log), { recursive: true });
    const child = spawn(process.execPath, [this.paths.script, this.socketPath, this.paths.helper, this.paths.log], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
    this.player.log.info(`Service: started, pid ${child.pid}; its log is ${this.paths.log}`);
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      if (await this.connect(true)) {
        return;
      }
    }
    throw new Error("the player service didn't start");
  }

  /**
   * Connects to the service. The connection counts only once the service welcomes this window's
   * hello; a service of another build doesn't, and is then treated as absent. With `adopt`, hands
   * over this window's queue, which the service takes only if it has none of its own yet.
   */
  private async connect(adopt: boolean): Promise<boolean> {
    if (this.socket) {
      return true;
    }
    const settings = await this.settings();
    return new Promise((resolve) => {
      const socket = net.connect(this.socketPath);
      let settled = false;
      // The service sends its state on connect, before the welcome; it's applied once welcomed.
      const early: Message[] = [];
      const fail = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(false);
        }
      };
      const timer = setTimeout(fail, 2000);
      socket.on('error', fail);
      socket.on('close', () => (settled ? this.onClosed(socket) : fail()));
      socket.once('connect', () => send(socket, { type: 'hello', settings }));
      readMessages(socket, (m) => {
        if (settled) {
          this.onMessage(m);
          return;
        }
        if (m.type !== 'welcome') {
          early.push(m);
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (this.socket || this.disposed) {
          socket.destroy();
          resolve(!!this.socket);
          return;
        }
        if (adopt) {
          send(socket, { type: 'adopt', state: this.player.sharedState(), status: this.player.playbackStatus });
        }
        this.socket = socket;
        this.player.setRemote({ call: (method, args) => this.call(method, args) });
        early.forEach((e) => this.onMessage(e));
        this.player.log.info('Service: connected; the music plays in the background service');
        resolve(true);
      });
    });
  }

  private call(method: RemoteMethod, args: unknown[]): Promise<any> {
    const socket = this.socket;
    if (!socket) {
      return Promise.reject(new Error("Can't reach the player service"));
    }
    const id = this.nextCallId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      send(socket, { type: 'call', id, method, args });
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error("The player service didn't respond"));
        }
      }, CALL_TIMEOUT_MS);
    });
  }

  private onMessage(m: Message): void {
    switch (m.type) {
      case 'result': {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error !== undefined ? p?.reject(new Error(m.error)) : p?.resolve(m.value);
        break;
      }
      case 'state':
        this.player.applySharedState(m.state);
        break;
      case 'status':
        this.player.applyPlaybackStatus(m.status);
        break;
      case 'notice':
        // Every window gets the notice; only the one the user is looking at shows it.
        if (vscode.window.state.focused) {
          vscode.window.setStatusBarMessage(m.text, 4000);
        }
        break;
    }
  }

  private onClosed(socket: net.Socket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.pending.forEach((p) => p.reject(new Error('The player service has stopped')));
    this.pending.clear();
    if (!this.disposed) {
      this.player.log.warn('Service: disconnected; this window plays on its own until the service is back');
      this.player.setRemote(undefined);
    }
  }
}
