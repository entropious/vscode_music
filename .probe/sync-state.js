// Reads the player state of running VS Code windows through their sync sockets,
// the same way a remote window does, without sending any commands.
//   node .probe/sync-state.js
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const sockets = fs
  .readdirSync(os.tmpdir())
  .filter((f) => /^vscode-yandex-music-[0-9a-f]+\.sock$/.test(f))
  .map((f) => path.join(os.tmpdir(), f));

if (!sockets.length) {
  console.log('no sync sockets: no window is playing');
  process.exit(0);
}

const read = (file) =>
  new Promise((resolve) => {
    const socket = net.connect(file);
    let buffer = '';
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.on('error', (e) => done({ socket: file, error: e.code }));
    socket.on('data', (d) => (buffer += d));
    setTimeout(() => {
      const messages = buffer.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const state = messages.find((m) => m.type === 'state')?.state;
      const status = messages.find((m) => m.type === 'status')?.status;
      done({
        socket: path.basename(file),
        source: state?.source,
        index: state?.index,
        queue: state?.queue.map((t) => `${t.id} ${t.title}`),
        playing: status?.playing,
        position: status && Math.round(status.position),
      });
    }, 1500);
  });

Promise.all(sockets.map(read)).then((results) => console.log(JSON.stringify(results, null, 1)));
