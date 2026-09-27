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

/** Сокет, общий для всех окон одной установки и профиля VS Code. */
export function socketPathFor(storageDir: string): string {
  const id = createHash('sha1').update(storageDir).digest('hex').slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\vscode-yandex-music-${id}` : path.join(os.tmpdir(), `vscode-yandex-music-${id}.sock`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Команды, которые запускают звук. Webview может играть только после нажатия внутри
 * панели своего окна, поэтому пульт выполняет их у себя, забрав роль ведущего, если
 * звук разрешён здесь или не разрешён и в ведущем окне (см. Player.shouldPlayHere).
 */
const STARTS_PLAYBACK = new Set<RemoteMethod>(['playSource', 'playTracks', 'playIndex', 'next', 'previous']);

/** Сообщения — JSON по одному на строку. */
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
        // Битую строку пропускаем: следующее состояние всё равно придёт целиком.
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
 * Синхронизирует плеер между окнами VS Code. Первое окно занимает сокет и становится
 * ведущим: в нём играет звук и живёт очередь. Остальные подключаются как пульты:
 * их команды выполняет ведущее окно, а его состояние они показывают у себя.
 * Когда ведущее окно закрывается, одно из пультов занимает сокет и продолжает с того же места.
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
  /** Окно-пульт забирает роль ведущего: закрытие связи со старым ведущим ожидаемо. */
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
   * Выбирает роль окна; завершается, когда окно стало ведущим или подключилось как пульт.
   * `resume`: став ведущим, продолжить воспроизведение, которое шло в прежнем ведущем окне.
   */
  async start(resume = true): Promise<void> {
    for (let attempt = 0; attempt < 5 && !this.disposed; attempt++) {
      if (await this.listen()) {
        await this.player.takeOver(resume);
        return;
      }
      if (await this.connect()) {
        return;
      }
      // Файл сокета есть, но его никто не слушает: остался от упавшего окна.
      if (process.platform !== 'win32') {
        await fs.promises.unlink(this.socketPath).catch(() => undefined);
      }
      await sleep(50 + Math.random() * 200);
    }
    // Договориться не удалось: окно играет само по себе, чтобы кнопки не остались без связи.
    if (!this.disposed) {
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

  // ---------------------------------------------------------------- ведущее окно

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
   * Отдаёт роль ведущего пульту, который об этом попросил: останавливает звук,
   * рассылает последнее состояние и освобождает сокет. Сам подключается позже,
   * когда новое ведущее окно уже займёт сокет.
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

  // ---------------------------------------------------------------- окно-пульт

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

  /** Забирает роль ведущего у текущего ведущего окна; `true`, если окно стало ведущим. */
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
        return false; // ведущее окно не ответило — выполняем команду по-старому
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
      return Promise.reject(new Error('Нет связи с окном, в котором играет музыка'));
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
    this.pending.forEach((p) => p.reject(new Error('Окно, в котором играла музыка, закрылось')));
    this.pending.clear();
    if (this.disposed || this.acquiring) {
      return;
    }
    // Разброс по времени, чтобы оставшиеся окна не делили сокет одновременно. Минимальная
    // задержка оставляет сокет окну, которое как раз забирает роль ведущего.
    setTimeout(() => void this.start().catch(() => undefined), 300 + Math.random() * 500);
  }
}
