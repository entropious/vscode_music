import { createHash } from 'crypto';
import * as fs from 'fs';
import type * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { PlaybackStatus, RemoteMethod, SharedState } from './core';

/**
 * Version of the messages between windows and the service. A service serves any window that
 * speaks the same version, whatever its build, so a window not reloaded after an update keeps
 * working; it is bumped only when a message changes in a way older code can't handle.
 */
export const PROTOCOL = 2;

/** A window too old for the running service: it must be reloaded to control the music again. */
export class OutdatedWindowError extends Error {
  constructor() {
    super('Yandex Music was updated. Reload this window (Developer: Reload Window) to control the music from it.');
  }
}

/** Settings a window passes to the macOS player service. */
export interface ServiceSettings {
  protocol: number;
  /** The window's serviceBuild(). */
  build: string;
  /**
   * When the window's service files were written. A service of an older build exits when a
   * window with newer files connects (the extension was updated), so that window starts the
   * new one; the other windows then reconnect to it.
   */
  builtAt: number;
  token?: string;
  apiBaseUrl: string;
  quality: 'high' | 'low';
  volume: number;
  /** Mark AI-generated tracks via slopless.art. */
  aiLabels: boolean;
  sloplessBaseUrl: string;
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
  /**
   * A remote that is not a VS Code window, such as the fullscreen macOS app, joins the service
   * without settings: the token and the rest stay as the windows set them.
   */
  | { type: 'attach'; protocol: number }
  /** The service accepted the window's first hello or a remote's attach: it is now its remote. */
  | { type: 'welcome' }
  /** The service turned the window away: it speaks an older protocol and must be reloaded. */
  | { type: 'outdated' }
  /** The window that started the service hands over its queue; the service takes it if it has none. */
  | { type: 'adopt'; state: SharedState; status: PlaybackStatus }
  /** The service passes a message on to the windows, shown by the focused one. */
  | { type: 'notice'; text: string };

/**
 * Fingerprint of the service's code, so a window can tell a service of another build: every
 * module in `outDir` (the service loads the player core and the API client from there too)
 * plus the audio helper.
 */
export function serviceBuild(outDir: string, helper: string): { build: string; builtAt: number } {
  const files = [
    ...fs
      .readdirSync(outDir)
      .filter((f) => f.endsWith('.js'))
      .sort()
      .map((f) => path.join(outDir, f)),
    helper,
  ];
  const hash = createHash('sha1');
  files.forEach((f) => hash.update(fs.readFileSync(f)));
  const builtAt = Math.max(...files.map((f) => fs.statSync(f).mtimeMs));
  return { build: hash.digest('hex').slice(0, 12), builtAt };
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
