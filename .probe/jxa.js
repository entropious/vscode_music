// Runs a JXA file with osascript and prints its output and errors.
//   node .probe/jxa.js <file.js> [args...]
const { spawnSync } = require('child_process');

const [file, ...args] = process.argv.slice(2);
if (!file) {
  console.error('usage: node .probe/jxa.js <file.js> [args...]');
  process.exit(2);
}
const r = spawnSync('osascript', ['-l', 'JavaScript', file, ...args], { encoding: 'utf8', timeout: 60000 });
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
process.exit(r.status ?? 1);
