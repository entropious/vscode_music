/**
 * The macOS player service: a background process that plays music independently of VS Code
 * windows. It owns the queue (PlayerCore) and plays audio through AVPlayer (helper/avplayer.js
 * under osascript); windows connect to its socket as remotes. A window starts it the first time
 * music is played, and it exits once no window has been connected for a few seconds.
 *
 *   ELECTRON_RUN_AS_NODE=1 <VS Code helper> out/service.js <socket> <helper/avplayer.js> <log file>
 *
 * The fullscreen remote app (remote/) starts it the same way, with its own Electron, when no
 * VS Code window has: the settings windows sent last are kept next to the log, and the token
 * in the login keychain, so a service started without a window can still play.
 */
import { type ChildProcess, execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { YandexMusicClient, artistLine, fullTitle } from './api';
import { type AudioOutput, type Logger, PlayerCore, REMOTE_METHODS, errorText } from './core';
import { Broadcaster, type Message, PROTOCOL, type ServiceSettings, readMessages, send, serviceBuild } from './protocol';
import { SLOPLESS_API, SLOP_FILE, SlopChecker } from './slop';

/** How long the service keeps playing with no window connected, so reloading a window doesn't stop the music. */
const GRACE_MS = 8000;
/** How long a freshly started service waits for the first window before giving up. */
const FIRST_CLIENT_MS = 20000;

const [socketPath, helperPath, logFile] = process.argv.slice(2);
const BUILD = serviceBuild(__dirname, helperPath);

function fileLogger(file: string): Logger {
  try {
    if (fs.statSync(file).size > 1_000_000) {
      fs.truncateSync(file, 0);
    }
  } catch {
    // no log yet
  }
  const write = (level: string, message: string) => fs.appendFileSync(file, `${new Date().toISOString()} [${level}] ${message}\n`);
  return { info: (m) => write('info', m), warn: (m) => write('warn', m), debug: (m) => write('debug', m) };
}

const log = fileLogger(logFile);

/** AVPlayer under osascript, started on the first track and restarted if it exits. */
class AvAudio implements AudioOutput {
  private proc?: ChildProcess;
  private volume = 0.7;
  private playing = false;
  private lastError?: string;
  private stopping = false;
  /** What the helper plays, so a helper that died can be restarted where it left off. */
  private track?: { url: string; position: number; nowPlaying?: object };
  /** Times the helper died unexpectedly, to give up restarting it if it keeps crashing. */
  private crashes: number[] = [];
  private readonly onEvent: (event: any) => void;

  constructor(onEvent: (event: any) => void) {
    this.onEvent = onEvent;
  }

  private helper(): ChildProcess {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
      return this.proc;
    }
    const proc = spawn('osascript', ['-l', 'JavaScript', helperPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          this.handle(JSON.parse(line));
        } catch {
          log.warn(`audio: unreadable line from the helper: ${line}`);
        }
      }
    });
    proc.stderr!.on('data', (d) => log.warn(`audio: ${String(d).trim()}`));
    proc.on('exit', (code, signal) => {
      log.info(`audio: helper exited with code ${code}${signal ? `, signal ${signal}` : ''}`);
      const wasPlaying = this.playing;
      this.playing = false;
      if (!this.stopping && this.proc === proc) {
        this.restart(wasPlaying);
      }
    });
    proc.stdin!.on('error', () => undefined);
    this.proc = proc;
    this.send({ cmd: 'volume', value: this.volume });
    log.info(`audio: helper started, pid ${proc.pid}`);
    return proc;
  }

  private send(command: object): void {
    this.helper().stdin!.write(JSON.stringify(command) + '\n');
  }

  /** Starts a new helper after one died and resumes the track at the same position, up to three times a minute. */
  private restart(wasPlaying: boolean): void {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 60_000);
    this.crashes.push(now);
    if (this.crashes.length > 3) {
      log.warn('audio: the helper keeps crashing; not restarting it until the next track');
      this.onEvent({ type: 'error', message: 'the audio player keeps crashing' });
      return;
    }
    const track = this.track;
    if (!track) {
      return;
    }
    log.info(`audio: restarting the helper at ${Math.round(track.position)} s`);
    this.send({ cmd: 'load', url: track.url, position: track.position, play: wasPlaying });
    if (track.nowPlaying) {
      this.send(track.nowPlaying);
    }
  }

  private handle(event: any): void {
    if (event.type === 'status') {
      this.playing = !!event.playing;
      if (this.track && event.duration) {
        this.track.position = event.position;
      }
      if (event.error && event.error !== this.lastError) {
        this.lastError = event.error;
        this.onEvent({ type: 'error', message: event.error });
      }
    }
    this.onEvent(event);
  }

  async load(url: string, _trackId: string, position: number): Promise<void> {
    this.lastError = undefined;
    this.track = { url, position };
    this.send({ cmd: 'load', url, position });
  }

  toggle(): void {
    this.send({ cmd: this.playing ? 'pause' : 'play' });
  }

  seek(seconds: number): void {
    this.send({ cmd: 'seek', seconds });
  }

  setVolume(value: number): void {
    this.volume = value;
    if (this.proc) {
      this.send({ cmd: 'volume', value });
    }
  }

  /** Shows the track in the system's Now Playing; media keys reach the player from there. */
  nowPlaying(info: { title: string; artist: string; duration: number }): void {
    const command = { cmd: 'nowPlaying', ...info };
    if (this.track) {
      this.track.nowPlaying = command;
    }
    this.send(command);
  }

  stop(): void {
    this.stopping = true;
    this.proc?.stdin?.end();
  }
}

let settings: ServiceSettings = { protocol: PROTOCOL, ...BUILD, apiBaseUrl: 'https://api.music.yandex.net', quality: 'high', volume: 0.7, aiLabels: true, sloplessBaseUrl: SLOPLESS_API };

/** Settings of the last window without the token, for a service started by the remote app. */
const SETTINGS_FILE = path.join(path.dirname(logFile), 'service-settings.json');
/** The token's item in the login keychain, written and read by /usr/bin/security, which may then read it without asking. */
const KEYCHAIN = ['-s', 'vscode-yandex-music', '-a', 'token'];
/** What was last saved, so a window's repeated hello doesn't write it again. */
let savedSettings: string | undefined;
let savedToken: string | undefined;
/** A window has sent its settings; the saved ones must not override them. */
let windowSettings = false;

/** Runs `security` with commands on stdin, so the token never shows in the process list. */
function keychain(command: string): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    p.stderr!.on('data', (d) => log.warn(`keychain: ${String(d).trim()}`));
    p.on('error', () => resolve());
    p.on('exit', () => resolve());
    p.stdin!.end(`${command}\n`);
  });
}

async function saveSettings(s: ServiceSettings): Promise<void> {
  const { token, protocol, build, builtAt, ...rest } = s;
  const json = JSON.stringify(rest);
  if (json !== savedSettings) {
    savedSettings = json;
    await fs.promises.writeFile(SETTINGS_FILE, json).catch((e) => log.warn(`settings: can't save them: ${errorText(e)}`));
  }
  if (token !== savedToken) {
    savedToken = token;
    if (token && /^[\w.-]+$/.test(token)) {
      await keychain(`add-generic-password -U ${KEYCHAIN.join(' ')} -w ${token}`);
    } else if (!token) {
      await keychain(`delete-generic-password ${KEYCHAIN.join(' ')}`);
    }
  }
}

/** Takes the settings and token saved by an earlier window, unless a window has already sent its own. */
async function loadSettings(): Promise<void> {
  let saved: Partial<ServiceSettings> = {};
  try {
    savedSettings = await fs.promises.readFile(SETTINGS_FILE, 'utf8');
    saved = JSON.parse(savedSettings);
  } catch {
    // never saved: a window must say hello first
  }
  const token = await new Promise<string | undefined>((resolve) =>
    execFile('security', ['find-generic-password', ...KEYCHAIN, '-w'], (err, out) => resolve(err ? undefined : out.trim() || undefined)),
  );
  savedToken = token;
  if (windowSettings) {
    return;
  }
  settings = { ...settings, ...saved, token, protocol: PROTOCOL, ...BUILD };
  core.volume = settings.volume;
  audio.setVolume(settings.volume);
  log.info(`service: took the saved settings${token ? ' and token' : ', no token'}`);
}
// The log lies in the extension's global storage, next to the file of AI marks.
const slopChecker = new SlopChecker(path.join(path.dirname(logFile), SLOP_FILE));
const clients = new Set<net.Socket>();
const broadcaster = new Broadcaster();

function notify(text: string): void {
  clients.forEach((c) => send(c, { type: 'notice', text }));
}

const audio = new AvAudio((event) => {
  if (event.type === 'status') {
    core.audioStatus({ playing: !!event.playing, position: event.position ?? 0, duration: event.duration ?? 0 });
  } else if (event.type === 'ended') {
    void core.audioEnded().catch((e) => log.warn(`next track after the end: ${errorText(e)}`));
  } else if (event.type === 'error') {
    log.warn(`audio: ${event.message}`);
    core.audioError(event.message);
  } else if (event.type === 'remote') {
    void onRemote(event.command, event.position).catch((e) => log.warn(`media key ${event.command}: ${errorText(e)}`));
  }
});

/** A media key or a Now Playing control in Control Center. */
async function onRemote(command: string, position?: number): Promise<void> {
  log.debug(`media key: ${command}`);
  switch (command) {
    case 'toggle':
      return core.playPause();
    case 'play':
      return core.status.playing ? undefined : core.playPause();
    case 'pause':
      return core.status.playing ? core.playPause() : undefined;
    case 'next':
      return core.next();
    case 'previous':
      return core.previous();
    case 'seek':
      return position === undefined ? undefined : core.seek(position);
  }
}

const core = new PlayerCore(
  {
    client: async () => {
      await loaded;
      return new YandexMusicClient(settings.apiBaseUrl, settings.token);
    },
    quality: () => settings.quality,
    log,
    notice: (text) => notify(text),
    slop: () => {
      if (!settings.aiLabels) {
        return undefined;
      }
      slopChecker.base = settings.sloplessBaseUrl;
      return slopChecker;
    },
  },
  audio,
);
core.volume = settings.volume;
const loaded = loadSettings().catch((e) => log.warn(`settings: can't load them: ${errorText(e)}`));
core.onDidChange(() => broadcaster.broadcast(clients, core.sharedState(), core.status));

/** Track last shown in Now Playing; it's announced once the stream has been handed to the player. */
let announced: string | undefined;
core.onDidChange(() => {
  const track = core.current();
  if (!track || core.loadedTrackId !== track.id || announced === track.id) {
    return;
  }
  announced = track.id;
  audio.nowPlaying({ title: fullTitle(track), artist: artistLine(track), duration: (track.durationMs ?? 0) / 1000 });
});

let shutdownTimer: NodeJS.Timeout | undefined = setTimeout(() => shutdown('no window connected'), FIRST_CLIENT_MS);

function shutdown(reason: string): void {
  log.info(`service: exiting (${reason})`);
  audio.stop();
  server.close();
  setTimeout(() => process.exit(0), 200);
}

/** Counts a connection as a remote, so its calls run and the service stays up while it is connected. */
function accept(socket: net.Socket, kind: string): void {
  if (!clients.has(socket)) {
    clients.add(socket);
    clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
    log.info(`service: ${kind} connected (${clients.size} now)`);
  }
  send(socket, { type: 'welcome' });
}

async function execute(socket: net.Socket, m: Message): Promise<void> {
  if (m.type !== 'hello' && m.type !== 'attach' && !clients.has(socket)) {
    return;
  }
  switch (m.type) {
    case 'hello': {
      if (m.settings.build !== BUILD.build && (m.settings.builtAt ?? 0) > BUILD.builtAt) {
        // The extension was updated; this service is left over from the previous build. The other
        // windows reconnect to the one the newer window starts.
        log.info(`service: a window runs the newer build ${m.settings.build}, this is ${BUILD.build}; exiting so it can start its own`);
        shutdown('replaced by a newer build');
        return;
      }
      if ((m.settings.protocol ?? 1) !== PROTOCOL) {
        // A window not reloaded since an update that changed the protocol.
        log.info(`service: turned away a window of protocol ${m.settings.protocol ?? 1}, this is ${PROTOCOL}`);
        send(socket, { type: 'outdated' });
        socket.end();
        return;
      }
      const volumeChanged = m.settings.volume !== settings.volume;
      settings = m.settings;
      windowSettings = true;
      void saveSettings(settings);
      if (volumeChanged) {
        void core.setVolume(settings.volume);
      }
      accept(socket, 'window');
      return;
    }
    case 'attach':
      if (m.protocol !== PROTOCOL) {
        log.info(`service: turned away a remote of protocol ${m.protocol}, this is ${PROTOCOL}`);
        send(socket, { type: 'outdated' });
        socket.end();
        return;
      }
      accept(socket, 'remote app');
      return;
    case 'adopt':
      if (core.index < 0 && m.state.index >= 0) {
        core.applySharedState(m.state);
        core.applyPlaybackStatus({ ...m.status, playing: false });
        log.info(`service: took over a queue of ${m.state.queue.length} tracks`);
      }
      return;
    case 'call': {
      if (!REMOTE_METHODS.includes(m.method)) {
        send(socket, { type: 'result', id: m.id, error: `The player service doesn't support "${m.method}" yet. Reload every VS Code window to update it.` });
        return;
      }
      try {
        const method = core[m.method] as (...args: unknown[]) => Promise<unknown>;
        send(socket, { type: 'result', id: m.id, value: await method.apply(core, m.args) });
      } catch (e) {
        send(socket, { type: 'result', id: m.id, error: errorText(e) });
      }
      return;
    }
  }
}

// A connection counts as a window only once its hello is accepted (see execute()).
const server = net.createServer((socket) => {
  socket.on('error', () => undefined);
  socket.on('close', () => {
    if (!clients.delete(socket)) {
      return;
    }
    log.info(`service: remote disconnected (${clients.size} left)`);
    if (!clients.size) {
      shutdownTimer = setTimeout(() => shutdown('no window connected'), GRACE_MS);
    }
  });
  readMessages(socket, (m) => void execute(socket, m));
  send(socket, { type: 'state', state: core.sharedState() });
  send(socket, { type: 'status', status: core.status });
});

server.on('error', (e) => {
  log.warn(`service: can't listen on ${socketPath}: ${errorText(e)}`);
  process.exit(1);
});

server.listen(socketPath, () => log.info(`service: listening, pid ${process.pid}`));
