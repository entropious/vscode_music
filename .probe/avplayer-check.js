// Checks helper/avplayer.js, the macOS audio output, without a VS Code window:
// plays the test tone from a file and over HTTP from the mock API at zero volume,
// publishes it to Now Playing, then pauses, seeks and lets the track end.
//   node .probe/avplayer-check.js
const { spawn } = require('child_process');
const path = require('path');
const { buildDirectLink } = require('../out/api.js');
const { startMockServer } = require('../out/test/mockServer.js');

const root = path.join(__dirname, '..');
const tone = path.join(root, 'test-fixtures/tone.mp3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x) => (typeof x === 'number' ? Math.round(x * 10) / 10 : x);

function startHelper() {
  const proc = spawn('osascript', ['-l', 'JavaScript', path.join(root, 'helper/avplayer.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const events = [];
  let buffer = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      events.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const send = (command) => proc.stdin.write(JSON.stringify(command) + '\n');
  const last = (type) => [...events].reverse().find((e) => e.type === type);
  return { proc, events, send, last, stderr: () => stderr };
}

async function scenario(name, url) {
  const h = startHelper();
  const results = { name };
  const deadline = Date.now() + 5000;
  while (!h.last('ready') && Date.now() < deadline) await sleep(50);
  results.ready = !!h.last('ready');
  h.send({ cmd: 'volume', value: 0 });
  h.send({ cmd: 'load', url });
  h.send({ cmd: 'nowPlaying', title: 'Check', artist: 'vscode-yandex-music', duration: 8 });
  await sleep(1500);
  results.aliveAfterNowPlaying = h.proc.exitCode === null;
  const playing = h.last('status');
  results.playing = { position: round(playing?.position), duration: round(playing?.duration), playing: playing?.playing };
  h.send({ cmd: 'pause' });
  await sleep(600);
  const paused1 = h.last('status');
  await sleep(600);
  const paused2 = h.last('status');
  results.paused = { playing: paused2?.playing, positionStill: round(paused1?.position) === round(paused2?.position) };
  h.send({ cmd: 'seek', seconds: 6.5 });
  h.send({ cmd: 'play' });
  await sleep(2500);
  results.endedAfterSeek = h.events.some((e) => e.type === 'ended');
  results.errors = h.events.filter((e) => e.type === 'error' || e.error).map((e) => e.message || e.error);
  h.proc.stdin.end();
  await sleep(500);
  results.exitedOnStdinClose = h.proc.exitCode !== null;
  if (h.stderr()) results.stderr = h.stderr().trim().slice(0, 300);
  if (!results.exitedOnStdinClose) h.proc.kill();
  return results;
}

(async () => {
  const server = await startMockServer(tone);
  const httpUrl = buildDirectLink({ host: server.base.replace('http://', ''), path: '/music/1001.mp3', ts: 'ts123', s: 'secret' });
  const out = [await scenario('file', `file://${tone}`), await scenario('http', httpUrl)];
  await server.close();
  console.log(JSON.stringify(out, null, 1));
  const failed = out.filter(
    (r) => !r.ready || !r.aliveAfterNowPlaying || !(r.playing.position > 0.5) || !r.playing.playing || r.paused.playing || !r.paused.positionStill || !r.endedAfterSeek || !r.exitedOnStdinClose,
  );
  console.log(failed.length ? `FAILED: ${failed.map((r) => r.name).join(', ')}` : 'PASSED');
  process.exit(failed.length ? 3 : 0);
})();
