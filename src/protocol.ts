import { createHash } from 'crypto';
import * as fs from 'fs';
import type * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { PlaybackStatus, RemoteMethod, SharedState } from './core';

/** Settings a window passes to the macOS player service. */
export interface ServiceSettings {
  /** The window's serviceBuild(); a service built from other files exits so the window's build can start. */
  build: string;
  token?: string;
  apiBaseUrl: string;
  quality: 'high' | 'low';
  volume: number;
}

/** Messages between windows and the leader window or the service, one JSON object per line. */
export type Message =
  | { type: 'call'; id: number; method: RemoteMethod; args: unknown[] }
  | { type: 'result'; id: number; value?: unknown; error?: string }
  | { type: 'state'; state: SharedState }
  | { type: 'status'; status: PlaybackStatus }
  /** A remote asks the leader window to hand its role over. */
  | { type: 'handover' }
  /** A window tells the service its token and settings, on connect and whenever they change. */
  | { type: 'hello'; settings: ServiceSettings }
  /** The service accepted the window's first hello: same build, the window is now its remote. */
  | { type: 'welcome' }
  /** The window that started the service hands over its queue; the service takes it if it has none. */
  | { type: 'adopt'; state: SharedState; status: PlaybackStatus }
  /** The service passes a message on to the windows, shown by the focused one. */
  | { type: 'notice'; text: string; error?: boolean };

/** Fingerprint of the service and audio helper files, so a window can tell a service of another build. */
export function serviceBuild(files: string[]): string {
  const hash = createHash('sha1');
  files.forEach((f) => hash.update(fs.readFileSync(f)));
  return hash.digest('hex').slice(0, 12);
}

/**
 * Socket shared by all windows of the same VS Code installation and profile. The macOS
 * service has a socket of its own, so windows that sync among themselves never take it.
 */
export function socketPathFor(storageDir: string, kind: 'windows' | 'service' = 'windows'): string {
  const id = createHash('sha1').update(storageDir).digest('hex').slice(0, 12);
  const name = kind === 'service' ? `vscode-yandex-music-service-${id}` : `vscode-yandex-music-${id}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

export function readMessages(socket: net.Socket, onMessage: (m: Message) => void): void {
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

export function send(socket: net.Socket, message: Message | string): void {
  if (!socket.destroyed) {
    socket.write((typeof message === 'string' ? message : JSON.stringify(message)) + '\n');
  }
}

/** Sends the core's state and status to every client whose copy is out of date. */
export class Broadcaster {
  private lastState?: string;
  private lastStatus?: string;

  reset(): void {
    this.lastState = undefined;
    this.lastStatus = undefined;
  }

  broadcast(clients: Iterable<net.Socket>, state: SharedState, status: PlaybackStatus): void {
    const s = JSON.stringify(state);
    const all = [...clients];
    if (s !== this.lastState) {
      this.lastState = s;
      all.forEach((c) => send(c, `{"type":"state","state":${s}}`));
    }
    const st = JSON.stringify(status);
    if (st !== this.lastStatus) {
      this.lastStatus = st;
      all.forEach((c) => send(c, `{"type":"status","status":${st}}`));
    }
  }
}
