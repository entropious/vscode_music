import { createHash } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { PlaybackStatus, Player, REMOTE_METHODS, RemoteMethod, SharedState } from './player';

type Message =
  | { type: 'call'; id: number; method: RemoteMethod; args: unknown[] }
  | { type: 'handover' }
  | { type: 'result'; id: number; value?: unknown; error?: string }
  | { type: 'state'; state: SharedState }
  | { type: 'status'; status: PlaybackStatus };

/** Socket shared by all windows of the same VS Code installation and profile. */
export function socketPathFor(storageDir: string): string {
  const id = createHash('sha1').update(storageDir).digest('hex').slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\vscode-yandex-music-${id}` : path.join(os.tmpdir(), `vscode-yandex-music-${id}.sock`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Commands that start audio. A webview can only play after a click inside its own window's
 * panel, so a remote runs these itself, after taking over as leader, when audio is unlocked
 * here or isn't unlocked in the leader window either (see Player.shouldPlayHere).
 */
const STARTS_PLAYBACK = new Set<RemoteMethod>(['playSource', 'playTracks', 'playIndex', 'next', 'previous']);

/** Messages are newline-delimited JSON, one per line. */
function readMessages(socket: net.Socket, onMessage: (m: Message) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        onMessage(JSON.parse(line));
      } catch {
        // Skip a malformed line: the next state update arrives in full anyway.
      }
    }
  });
}

function send(socket: net.Socket, message: Message | string): void {
  if (!socket.destroyed) {
    socket.write((typeof message === 'string' ? message : JSON.stringify(message)) + '\n');
  }
}

/**
 * Keeps the player in sync across VS Code windows. The first window binds the socket and
 * becomes the leader: it plays the audio and owns the queue. The others connect as remotes:
 * the leader runs their commands, and they mirror its state.
 * When the leader window closes, one of the remotes binds the socket and picks up where it left off.
 */
export class PlayerSync implements vscode.Disposable {
  private server?: net.Server;
  private readonly clients = new Set<net.Socket>();
  private leader?: net.Socket;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextCallId = 1;
  private lastState?: string;
  private lastStatus?: string;
  private disposed = false;
  /** This remote is taking over as leader, so the old leader closing the connection is expected. */
  private acquiring = false;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly player: Player,
    private readonly socketPath: string,
  ) {
    this.subscription = player.onDidChange(() => this.broadcast());
  }

  get role(): 'leader' | 'remote' | undefined {
    return this.server ? 'leader' : this.leader ? 'remote' : undefined;
  }

  /**
   * Picks this window's role; resolves once the window is the leader or connected as a remote.
   * `resume`: on becoming leader, continue whatever was playing in the previous leader window.
   */
  async start(resume = true): Promise<void> {
    for (let attempt = 0; attempt < 5 && !this.disposed; attempt++) {
      if (await this.listen()) {
        this.player.log.info('Sync: this window plays the music (leader)');
        await this.player.takeOver(resume);
        return;
      }
      if (await this.connect()) {
        this.player.log.info('Sync: another window plays the music; this one is a remote');
        return;
      }
      // The socket file exists but nobody is listening: it's left over from a crashed window.
      if (process.platform !== 'win32') {
        await fs.promises.unlink(this.socketPath).catch(() => undefined);
      }
      await sleep(50 + Math.random() * 200);
    }
    // Couldn't settle on a role: play standalone so the controls aren't left disconnected.
    if (!this.disposed) {
      this.player.log.warn('Sync: no role settled; this window plays on its own');
      await this.player.takeOver(resume);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.subscription.dispose();
    this.server?.close();
    this.clients.forEach((c) => c.destroy());
    this.leader?.destroy();
  }

  // ---------------------------------------------------------------- leader window

  private listen(): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => this.onClient(socket));
      server.once('error', () => resolve(false));
      server.listen(this.socketPath, () => {
        this.server = server;
        this.lastState = undefined;
        this.lastStatus = undefined;
        resolve(true);
      });
    });
  }

  private onClient(socket: net.Socket): void {
    this.clients.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => this.clients.delete(socket));
    readMessages(socket, (m) => void this.execute(socket, m));
    send(socket, { type: 'state', state: this.player.sharedState() });
    send(socket, { type: 'status', status: this.player.playbackStatus });
  }

  private async execute(socket: net.Socket, m: Message): Promise<void> {
    if (m.type === 'handover') {
      await this.handOver();
      return;
    }
    if (m.type !== 'call' || !REMOTE_METHODS.includes(m.method)) {
      return;
    }
    try {
      const method = this.player[m.method] as (...args: unknown[]) => Promise<unknown>;
      send(socket, { type: 'result', id: m.id, value: await method.apply(this.player, m.args) });
    } catch (e) {
      send(socket, { type: 'result', id: m.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Hands the leader role to the remote that asked for it: stops audio,
   * sends out the final state and releases the socket. Reconnects later,
   * once the new leader window has bound the socket.
   */
  private async handOver(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.player.releaseAudio();
    const state = JSON.stringify(this.player.sharedState());
    const status = JSON.stringify(this.player.playbackStatus);
    this.clients.forEach((c) => {
      send(c, `{"type":"state","state":${state}}`);
      send(c, `{"type":"status","status":${status}}`);
      c.end();
    });
    this.server = undefined;
    server.close();
    await sleep(1000);
    if (!this.disposed && !this.role) {
      await this.start(false);
    }
  }

  private broadcast(): void {
    if (!this.server || !this.clients.size) {
      return;
    }
    const state = JSON.stringify(this.player.sharedState());
    if (state !== this.lastState) {
      this.lastState = state;
      this.clients.forEach((c) => send(c, `{"type":"state","state":${state}}`));
    }
    const status = JSON.stringify(this.player.playbackStatus);
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.clients.forEach((c) => send(c, `{"type":"status","status":${status}}`));
    }
  }

  // ---------------------------------------------------------------- remote window

  private connect(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect(this.socketPath);
      socket.once('error', () => resolve(false));
      socket.once('connect', () => {
        socket.removeAllListeners('error');
        socket.on('error', () => undefined);
        socket.on('close', () => this.onLeaderClosed());
        readMessages(socket, (m) => this.onLeaderMessage(m));
        this.leader = socket;
        this.player.setRemote({ call: (method, args) => this.call(method, args) });
        resolve(true);
      });
    });
  }

  private async call(method: RemoteMethod, args: unknown[]): Promise<any> {
    const startsPlayback = STARTS_PLAYBACK.has(method) || (method === 'playPause' && !this.player.playbackStatus.playing);
    if (startsPlayback && this.player.shouldPlayHere && (await this.acquireLeadership())) {
      const local = this.player[method] as (...a: unknown[]) => Promise<unknown>;
      return local.apply(this.player, args);
    }
    return this.forward(method, args);
  }

  /** Takes the leader role from the current leader window; `true` if this window became the leader. */
  private async acquireLeadership(): Promise<boolean> {
    const leader = this.leader;
    if (!leader || this.acquiring) {
      return false;
    }
    this.acquiring = true;
    try {
      const closed = new Promise<void>((r) => leader.once('close', () => r()));
      send(leader, { type: 'handover' });
      await Promise.race([closed, sleep(3000)]);
      if (this.leader === leader) {
        return false; // the leader didn't respond, so forward the command as usual
      }
      await this.start(false);
      return this.role === 'leader';
    } finally {
      this.acquiring = false;
    }
  }

  private forward(method: RemoteMethod, args: unknown[]): Promise<any> {
    const leader = this.leader;
    if (!leader) {
      return Promise.reject(new Error("Can't reach the window that is playing music"));
    }
    const id = this.nextCallId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      send(leader, { type: 'call', id, method, args });
    });
  }

  private onLeaderMessage(m: Message): void {
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
    }
  }

  private onLeaderClosed(): void {
    this.leader = undefined;
    this.pending.forEach((p) => p.reject(new Error('The window that was playing music has closed')));
    this.pending.clear();
    if (this.disposed || this.acquiring) {
      return;
    }
    // Random jitter so the remaining windows don't all race for the socket at once. The minimum
    // delay leaves the socket to a window that is in the middle of taking over as leader.
    setTimeout(() => void this.start().catch(() => undefined), 300 + Math.random() * 500);
  }
}
