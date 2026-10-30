// Checks the macOS player service without VS Code: two connections play the part of two
// windows against the mock API, at zero volume. The music must keep playing when the window
// that started it disconnects, and the service must exit once no window is left.
//   node .probe/service-check.js
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { MOCK_TOKEN, startMockServer } = require('../out/test/mockServer.js');
const { PROTOCOL, serviceBuild } = require('../out/protocol.js');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const socketPath = path.join(os.tmpdir(), `ym-service-check-${process.pid}.sock`);
const logFile = path.join(__dirname, 'service-check.log');

function client(settings) {
  const socket = net.connect(socketPath);
  const c = { socket, state: undefined, status: undefined, notices: [], pending: new Map(), id: 1 };
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const m = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (m.type === 'state') c.state = m.state;
      if (m.type === 'status') c.status = m.status;
      if (m.type === 'notice') c.notices.push(m.text);
      if (m.type === 'result') c.pending.get(m.id)?.(m);
      if (m.type === 'welcome') c.welcomed?.();
      if (m.type === 'outdated') c.outdated = true;
    }
  });
  const write = (m) => socket.write(JSON.stringify(m) + '\n');
  // Like a window: hello on connect, connected once the service welcomes it.
  c.ready = new Promise((r) => socket.once('connect', r)).then(
    () =>
      new Promise((r) => {
        c.welcomed = r;
        write({ type: 'hello', settings });
      }),
  );
  c.call = (method, args = []) =>
    new Promise((resolve) => {
      const id = c.id++;
      c.pending.set(id, resolve);
      write({ type: 'call', id, method, args });
    });
  return c;
}

async function until(fn, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
}

(async () => {
  fs.rmSync(logFile, { force: true });
  const server = await startMockServer(path.join(root, 'test-fixtures/tone.mp3'));
  const build = serviceBuild([path.join(root, 'out/service.js'), path.join(root, 'helper/avplayer.js')]);
  const settings = { protocol: PROTOCOL, ...build, token: MOCK_TOKEN, apiBaseUrl: server.base, quality: 'high', volume: 0, aiLabels: false };
  const service = spawn(process.execPath, [path.join(root, 'out/service.js'), socketPath, path.join(root, 'helper/avplayer.js'), logFile], { stdio: 'ignore' });
  const checks = {};
  await until(() => fs.existsSync(socketPath), 5000);

  const a = client(settings);
  await a.ready;
  const played = await a.call('playSource', [{ kind: 'wave' }]);
  checks.playStarted = !played.error;
  checks.playingInService = await until(() => a.status?.playing && a.status.position > 0.5);

  const b = client(settings);
  await b.ready;
  checks.secondWindowSeesQueue = await until(() => b.state?.queue?.length > 0 && b.state.index === a.state.index);

  // Windows not reloaded since an update run an older build. One that speaks the same protocol
  // is served; one of an older protocol is told it's outdated. The music goes on either way.
  const answer = (c) =>
    Promise.race([
      c.ready.then(() => 'welcomed'),
      new Promise((r) => c.socket.once('close', () => r(c.outdated ? 'outdated' : 'closed'))),
      sleep(3000).then(() => 'no answer'),
    ]);
  const older = client({ ...settings, build: 'older-build', builtAt: 0 });
  checks.olderBuildServed = (await answer(older)) === 'welcomed';
  checks.olderBuildSeesQueue = await until(() => older.state?.queue?.length > 0);
  const oldProtocol = client({ ...settings, protocol: 1, build: 'older-build', builtAt: 0 });
  checks.olderProtocolOutdated = (await answer(oldProtocol)) === 'outdated';
  checks.keepsRunningAfterOlderWindows = service.exitCode === null && !!b.status?.playing;
  older.socket.destroy();

  a.socket.destroy();
  const before = b.status?.position ?? 0;
  await sleep(1500);
  checks.keepsPlayingAfterFirstWindowCloses = (b.status?.position ?? 0) > before && b.status.playing;

  checks.nextTrackAfterEnd = await until(() => b.state?.index >= 1, 12000);

  b.socket.destroy();
  await sleep(3000);
  checks.stillRunningDuringGrace = service.exitCode === null;
  checks.exitsWhenNoWindowsLeft = await until(() => service.exitCode !== null, 10000);
  checks.socketRemoved = !fs.existsSync(socketPath);

  // A window of a newer build (the extension was updated) makes the old service exit.
  const service2 = spawn(process.execPath, [path.join(root, 'out/service.js'), socketPath, path.join(root, 'helper/avplayer.js'), logFile], { stdio: 'ignore' });
  await until(() => fs.existsSync(socketPath), 5000);
  const current = client(settings);
  await current.ready;
  client({ ...settings, build: 'newer-build', builtAt: Date.now() + 60_000 });
  checks.exitsForNewerWindow = await until(() => service2.exitCode !== null, 5000);
  if (service2.exitCode === null) service2.kill();

  await server.close();
  if (service.exitCode === null) service.kill();
  console.log(JSON.stringify(checks, null, 1));
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(failed.length ? `FAILED: ${failed.join(', ')}\nservice log: ${logFile}` : 'PASSED');
  process.exit(failed.length ? 3 : 0);
})();
