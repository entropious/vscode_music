import { createHash } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import { AddressInfo } from 'net';

const SIGN_SALT = 'XGRlBW9FXlekgbPrRHuSiA';
export const MOCK_TOKEN = 'test-token';

/**
 * Небольшой сервер, повторяющий формат ответов API Яндекс Музыки
 * (api.music.yandex.net + storage для MP3). Нужен для офлайн-тестов.
 */
export async function startMockServer(mp3Path: string) {
  const mp3 = fs.readFileSync(mp3Path);
  const tracks = [1, 2, 3, 4, 5].map((n) => ({
    id: 1000 + n,
    title: `Тестовый трек ${n}`,
    durationMs: 8000,
    available: true,
    artists: [{ id: 1, name: 'Тестовый исполнитель' }],
    albums: [{ id: 500 + n, title: 'Альбом' }],
  }));
  const liked = new Set<number>([1001]);
  const log: string[] = [];
  let base = '';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    log.push(`${req.method} ${url.pathname}`);
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const authed = req.headers['authorization'] === `OAuth ${MOCK_TOKEN}`;
    const p = url.pathname;
    let bodyText = '';
    req.on('data', (c) => (bodyText += c));
    req.on('end', () => {
      const form = new URLSearchParams(bodyText);
      if (p.startsWith('/get-mp3/')) {
        const [, , sign, ts, ...rest] = p.split('/');
        const path = '/' + rest.join('/');
        const expected = createHash('md5').update(SIGN_SALT + path.slice(1) + 'secret').digest('hex');
        if (sign !== expected || ts !== 'ts123') {
          res.writeHead(403);
          return res.end('bad sign');
        }
        const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
        if (range) {
          const start = Number(range[1]);
          const end = range[2] ? Number(range[2]) : mp3.length - 1;
          res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Range': `bytes ${start}-${end}/${mp3.length}`, 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
          return res.end(mp3.subarray(start, end + 1));
        }
        res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': mp3.length, 'Accept-Ranges': 'bytes' });
        return res.end(mp3);
      }
      if (p.startsWith('/dl/')) {
        return json({ host: base.replace('http://', ''), path: `/music/${p.split('/')[2]}.mp3`, ts: 'ts123', s: 'secret' });
      }
      if (p === '/search') {
        return json({ result: { tracks: { results: tracks.filter((t) => t.title.includes(url.searchParams.get('text') ?? '') || true) } } });
      }
      let m: RegExpMatchArray | null;
      if ((m = p.match(/^\/tracks\/(\d+)\/download-info$/))) {
        return json({
          result: [
            { codec: 'mp3', bitrateInKbps: 192, downloadInfoUrl: `${base}/dl/${m[1]}?x=1`, direct: false },
            { codec: 'mp3', bitrateInKbps: 320, downloadInfoUrl: `${base}/dl/${m[1]}?x=1`, direct: false },
            { codec: 'aac', bitrateInKbps: 64, downloadInfoUrl: `${base}/nope`, direct: false },
          ],
        });
      }
      if (!authed) {
        return json({ error: { name: 'session-expired', message: 'Unauthorized' } }, 401);
      }
      if (p === '/account/status') {
        return json({ result: { account: { uid: 42, login: 'tester', displayName: 'Тестер' }, plus: { hasPlus: true } } });
      }
      if (p === '/tracks' && req.method === 'POST') {
        const ids = (form.get('track-ids') ?? '').split(',').map((x) => Number(x.split(':')[0]));
        return json({ result: tracks.filter((t) => ids.includes(t.id)) });
      }
      if (p === '/users/42/likes/tracks') {
        return json({ result: { library: { uid: 42, tracks: [...liked].map((id) => ({ id: String(id), albumId: String(id - 500) })) } } });
      }
      if ((m = p.match(/^\/users\/42\/likes\/tracks\/(add-multiple|remove)$/))) {
        for (const id of (form.get('track-ids') ?? '').split(',')) {
          m[1] === 'remove' ? liked.delete(Number(id.split(':')[0])) : liked.add(Number(id.split(':')[0]));
        }
        return json({ result: { revision: 1 } });
      }
      if (p === '/users/42/playlists/list') {
        return json({ result: [{ uid: 42, kind: 3, title: 'Для работы', trackCount: 2 }] });
      }
      if (p === '/users/42/playlists/3') {
        return json({ result: { tracks: [{ id: 1004, track: tracks[3] }, { id: 1005, track: tracks[4] }] } });
      }
      if (p === '/rotor/station/user:onyourwave/tracks') {
        return json({ result: { sequence: (url.searchParams.get('queue') ? tracks.slice(2) : tracks.slice(0, 3)).map((t) => ({ type: 'track', track: t })) } });
      }
      json({ error: { name: 'not-found', message: p } }, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, log, liked, close: () => new Promise<void>((r) => server.close(() => r())) };
}
