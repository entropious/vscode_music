/**
 * A stand-in for the extension's player service, for working on the app without macOS, VS Code
 * or a Yandex account: it listens where the real service does, takes the app's attach and
 * plays a made-up queue with generated covers.
 *
 *   bun dev/mock-service.ts [--paused] [--signed-out]
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { type Message, PROTOCOL, type PlaybackStatus, type Playlist, type SharedState, type Source, type Track } from '../src/wire.ts';

const SOCKET = path.join(os.tmpdir(), 'vscode-yandex-music-service-0123456789ab.sock');
const args = new Set(process.argv.slice(2));

/** A cover as an SVG data URL: circles over a gradient, in the spirit of the design's placeholders. */
function cover(a: string, b: string, c: string, base: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="${base}"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><circle cx="120" cy="136" r="84" fill="${a}"/><circle cx="272" cy="264" r="124" fill="${b}" opacity=".85"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

const raw: [string, string, number, [string, string, string, string]][] = [
  ['Hidden in Shadow', 'Mos Elian', 154, ['#3B8FA8', '#A9D6E2', '#173A52', '#0B1720']],
  ['lovelorn', '5l33p', 211, ['#FF4F9A', '#6A5CFF', '#8A2E9C', '#22103A']],
  ['LOOK BACK', 'V.I.P.N', 139, ['#ECECF0', '#6B6F78', '#34363C', '#141519']],
  ['Drown in You', 'Mos Elian', 216, ['#3FB7FF', '#0E5C9E', '#0A2E52', '#03152A']],
  ['I STILL LOVE YOU', 'WORMSOUL', 173, ['#9A5CFF', '#4A2490', '#2A1060', '#130829']],
  ['Звёзды над Невой', 'Полина Гагарина', 184, ['#4FE3FF', '#FF5FD2', '#1A4A8C', '#061A2E']],
  ['effloresce', 'southiyd', 154, ['#F2D2A0', '#C08A5A', '#6E4E30', '#2E2014']],
  ['Miss You', 'eyfect, sxulq', 126, ['#4C7BFF', '#A0B8FF', '#10204A', '#040A1C']],
  ['Phoenix', 'Tim Dian', 139, ['#FF3B5C', '#FFB03B', '#6E1638', '#1C0512']],
];
const tracks: Track[] = raw.map(([title, artist, sec, [a, b, c, base]], i) => ({
  id: `${1000 + i}:${2000 + i}`,
  title,
  durationMs: sec * 1000,
  artists: artist.split(', ').map((name, k) => ({ id: i * 10 + k, name })),
  albums: [{ id: 2000 + i, title }],
  coverUri: cover(a, b, c, base),
  available: true,
}));
const playlists: Playlist[] = ['Playlist of the Day', 'Premiere', 'Déjà Vu', 'Stash', 'Coding nights'].map((title, i) => ({ uid: 1, kind: i + 3, title, trackCount: 20 + i * 7 }));

const state: SharedState = {
  queue: tracks,
  index: 0,
  source: { kind: 'wave' },
  liked: ['1000', '1003'],
  disliked: [],
  playlists: [],
  searchResults: [],
  searchStations: [],
  ...(args.has('--signed-out') ? {} : { account: { uid: 1, login: 'entro', displayName: 'Entro', hasPlus: true } }),
  accountChecked: true,
  streamInfo: 'MP3 320 kbps',
  slop: { '1008': true, '1001': false },
  volume: 0.7,
};
const status: PlaybackStatus = { playing: !args.has('--paused'), position: 37, duration: 154, trackId: '1000:2000' };

// node:net rather than Bun.listen: its sockets buffer what the kernel doesn't take at once,
// and a state with a queue of covers is larger than one write.
const clients = new Set<net.Socket>();
const send = (s: net.Socket, m: Message): void => void s.write(JSON.stringify(m) + '\n');
const broadcast = (): void => {
  for (const c of clients) {
    send(c, { type: 'state', state });
    send(c, { type: 'status', status });
  }
};
const notice = (text: string): void => clients.forEach((c) => send(c, { type: 'notice', text }));

function playIndex(i: number): void {
  const t = state.queue[i];
  if (!t) {
    return;
  }
  state.index = i;
  Object.assign(status, { playing: true, position: 0, duration: (t.durationMs ?? 0) / 1000, trackId: t.id });
}

const methods: Record<string, (...a: any[]) => unknown> = {
  playPause: () => (status.playing = !status.playing),
  next: () => playIndex((state.index + 1) % state.queue.length),
  previous: () => (status.position > 3 ? (status.position = 0) : playIndex(Math.max(0, state.index - 1))),
  playIndex: (i: number) => playIndex(i),
  seek: (sec: number) => (status.position = sec),
  setVolume: (v: number) => (state.volume = v),
  toggleLike: () => {
    const id = state.queue[state.index]?.id.split(':')[0] ?? '';
    const on = !state.liked.includes(id);
    state.liked = on ? [...state.liked, id] : state.liked.filter((x) => x !== id);
    notice(on ? '♥ Added to Liked' : 'Removed from Liked');
    return on;
  },
  toggleDislike: () => {
    notice('Disliked: this track will not be recommended');
    playIndex(state.index + 1);
  },
  search: (q: string) => {
    const words = q.toLowerCase();
    state.searchResults = tracks.filter((t) => `${t.title} ${t.artists.map((a) => a.name).join(' ')}`.toLowerCase().includes(words));
    state.searchStations = /rock|рок/.test(words) ? [{ id: 'genre:rock', tag: 'rock', name: 'Rock', color: '#B03A2E' }] : [];
    return state.searchResults;
  },
  loadPlaylists: async () => {
    await Bun.sleep(400);
    state.playlists = playlists;
  },
  playSource: (source: Source) => {
    state.source = source;
    state.queue = [...tracks].sort(() => Math.random() - 0.5);
    playIndex(0);
  },
  playTracks: (list: Track[], i: number, source: Source) => {
    state.source = source;
    state.queue = list;
    playIndex(i);
  },
  startTrackRadio: () => {
    const t = state.queue[state.index];
    if (t) {
      state.source = { kind: 'station', id: `track:${t.id.split(':')[0]}`, name: t.title };
    }
  },
  refreshAccount: () => state.account,
};

await Bun.$`rm -f ${SOCKET}`.quiet();
net
  .createServer((s) => {
    let buffer = '';
    send(s, { type: 'state', state });
    send(s, { type: 'status', status });
    s.on('close', () => clients.delete(s));
    s.on('error', () => undefined);
    s.on('data', async (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const m = JSON.parse(buffer.slice(0, end)) as Message;
        buffer = buffer.slice(end + 1);
        if (m.type === 'attach') {
          if (m.protocol !== PROTOCOL) {
            send(s, { type: 'outdated' });
            s.end();
            continue;
          }
          clients.add(s);
          send(s, { type: 'welcome' });
          console.log(`remote attached (${clients.size})`);
        } else if (m.type === 'call' && clients.has(s)) {
          console.log(`call ${m.method}(${JSON.stringify(m.args).slice(1, -1).slice(0, 80)})`);
          try {
            const value = await methods[m.method]?.(...m.args);
            send(s, { type: 'result', id: m.id, value });
          } catch (e) {
            send(s, { type: 'result', id: m.id, error: String(e) });
          }
          broadcast();
        }
      }
    });
  })
  .listen(SOCKET);

setInterval(() => {
  if (!status.playing) {
    return;
  }
  status.position += 1;
  if (status.position >= status.duration) {
    playIndex((state.index + 1) % state.queue.length);
  }
  broadcast();
}, 1000);

console.log(`mock player service on ${SOCKET}`);
