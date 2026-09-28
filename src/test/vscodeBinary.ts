import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

/** Path to the test VS Code binary. On macOS the executable in the bundle is named Code, even though test-electron returns a path to Electron. */
export async function vscodeBinary(): Promise<string> {
  const downloaded = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? 'stable');
  return fs.existsSync(downloaded) ? downloaded : path.join(path.dirname(downloaded), 'Code');
}

export interface LaunchOptions {
  /** Extra environment variables for the VS Code process, on top of the inherited ones. */
  env?: Record<string, string>;
  /** File that receives VS Code's stdout and stderr. */
  log: string;
}

/**
 * Launches the test VS Code. On macOS it goes through `open -g` so the windows stay in the
 * background and don't steal focus; the `open` process exits together with VS Code.
 * VS Code's integrated terminal sets ELECTRON_RUN_AS_NODE, which makes Code start as plain Node,
 * so that variable is not passed on.
 */
export function launchVSCode(binary: string, args: string[], opts: LaunchOptions): ChildProcess {
  fs.mkdirSync(path.dirname(opts.log), { recursive: true });
  fs.writeFileSync(opts.log, '');
  // `open` also passes its own environment to the app, so the variable is dropped in both cases.
  const env = { ...process.env, ...opts.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform === 'darwin') {
    const bundle = binary.slice(0, binary.indexOf('.app') + '.app'.length);
    return spawn('open', ['-g', '-n', '-W', '-a', bundle, '--stdout', opts.log, '--stderr', opts.log, '--args', ...args], { env, stdio: 'ignore' });
  }
  const out = fs.openSync(opts.log, 'a');
  return spawn(binary, args, { env, stdio: ['ignore', out, out] });
}

/** A free local port for --remote-debugging-port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}
