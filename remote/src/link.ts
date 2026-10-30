import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LinkState } from './bridge.ts';
import { findInstall, startService } from './launch.ts';
import { type Message, PROTOCOL, type PlaybackStatus, type RemoteMethod, type SharedState } from './wire.ts';

/** The service's socket, `socketPathFor(storageDir, 'service')` in `src/protocol.ts`: one per VS Code installation and profile. */
const SOCKET_NAME = /^vscode-yandex-music-service-[0-9a-f]{12}\.sock$/;
const RETRY_MS = 1500;
/** A service that turned the app away is asked again rarely, until a VS Code update replaces it. */
const OUTDATED_RETRY_MS = 15000;
/** How often the app may start the service itself, and how long it waits for one it started. */
const LAUNCH_EVERY_MS = 30000;
const LAUNCH_WAIT_MS = 8000;
/** A service that answers `attach` with silence predates remotes other than windows. */
const WELCOME_MS = 2500;

export interface LinkEvents {
  link(state: LinkState): void;
  state(state: SharedState): void;
  status(status: PlaybackStatus): void;
  notice(text: string): void;
}

/** Sockets of running services, the most recently started first. */
function serviceSockets(): string[] {
  const dir = os.tmpdir();
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => SOCKET_NAME.test(n));
  } catch {
    return [];
  }
  const withTime = names.flatMap((n) => {
    const file = path.join(dir, n);
    try {
      return [{ file, at: fs.statSync(file).mtimeMs }];
    } catch {
      return [];
    }
  });
  return withTime.sort((a, b) => b.at - a.at).map((s) => s.file);
}

function connect(file: string): Promise<net.Socket> {
  const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
  const socket = net.connect(file);
  socket.once('connect', () => resolve(socket));
  socket.once('error', reject);
  return promise;
}

/**
 * Keeps the app attached to the player service: finds its socket, attaches as a remote, passes
 * on what the service broadcasts and runs calls there. When no service is running, it starts the
 * one of the installed extension; when the service exits (the extension was updated), it looks
 * for the next one.
 */
export class ServiceLink {
  private socket: net.Socket | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, PromiseWithResolvers<unknown>>();
  private retry: NodeJS.Timeout | undefined;
  private stopped = false;
  private linkState: LinkState = 'starting';
  /** When the app last started the service itself. */
  private launchedAt = 0;
  private readonly events: LinkEvents;
  /** A socket path given on the command line, for a service in another temp directory. */
  private readonly fixedSocket: string | undefined;

  constructor(events: LinkEvents, fixedSocket?: string) {
    this.events = events;
    this.fixedSocket = fixedSocket;
  }

  get state(): LinkState {
    return this.linkState;
  }

  start(): void {
    void this.attach();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.destroy();
  }

  call(method: RemoteMethod, args: unknown[]): Promise<unknown> {
    const socket = this.socket;
    if (!socket || this.linkState !== 'connected') {
      return Promise.reject(new Error('The player is not running.'));
    }
    const id = this.nextId++;
    const request = Promise.withResolvers<unknown>();
    this.pending.set(id, request);
    this.write(socket, { type: 'call', id, method, args });
    return request.promise;
  }

  private setLink(state: LinkState): void {
    if (state !== this.linkState) {
      this.linkState = state;
      this.events.link(state);
    }
  }

  private later(): void {
    if (!this.stopped) {
      clearTimeout(this.retry);
      this.retry = setTimeout(() => void this.attach(), this.linkState === 'outdated' ? OUTDATED_RETRY_MS : RETRY_MS);
    }
  }

  private async attach(): Promise<void> {
    const files = this.fixedSocket ? [this.fixedSocket] : serviceSockets();
    for (const file of files) {
      try {
        this.use(await connect(file));
        return;
      } catch {
        // A socket left by a service that crashed: try the next one.
      }
    }
    this.launch();
    this.later();
  }

  /** Starts the extension's service, unless one started recently is still coming up. */
  private launch(): void {
    if (this.fixedSocket) {
      this.setLink('searching');
      return;
    }
    const install = findInstall();
    if (!install) {
      this.setLink('no-extension');
      return;
    }
    const since = Date.now() - this.launchedAt;
    if (since > LAUNCH_EVERY_MS) {
      this.launchedAt = Date.now();
      try {
        startService(install);
        this.setLink('starting');
      } catch {
        this.setLink('searching');
      }
    } else if (since > LAUNCH_WAIT_MS) {
      this.setLink('searching'); // it started but never answered; see its service.log
    }
  }

  private use(socket: net.Socket): void {
    this.socket = socket;
    let welcomed = false;
    const welcome = setTimeout(() => {
      if (!welcomed) {
        this.setLink('old-service');
      }
    }, WELCOME_MS);

    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let m: Message;
        try {
          m = JSON.parse(line) as Message;
        } catch {
          continue; // the next update arrives in full anyway
        }
        if (m.type === 'welcome') {
          welcomed = true;
          clearTimeout(welcome);
          this.setLink('connected');
        }
        this.handle(m);
      }
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      clearTimeout(welcome);
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      for (const p of this.pending.values()) {
        p.reject(new Error('The player service has stopped.'));
      }
      this.pending.clear();
      if (this.linkState !== 'outdated') {
        this.setLink('starting');
      }
      this.later();
    });
    this.write(socket, { type: 'attach', protocol: PROTOCOL });
  }

  private handle(m: Message): void {
    switch (m.type) {
      case 'state':
        this.events.state(m.state);
        return;
      case 'status':
        this.events.status(m.status);
        return;
      case 'notice':
        this.events.notice(m.text);
        return;
      case 'outdated':
        this.setLink('outdated');
        return;
      case 'result': {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error !== undefined) {
          p?.reject(new Error(m.error));
        } else {
          p?.resolve(m.value);
        }
        return;
      }
    }
  }

  private write(socket: net.Socket, m: Message): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(m) + '\n');
    }
  }
}
