import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

/** Путь к тестовому VS Code. На macOS бинарник в бандле называется Code, хотя test-electron возвращает путь к Electron. */
export async function vscodeBinary(): Promise<string> {
  const downloaded = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? 'stable');
  return fs.existsSync(downloaded) ? downloaded : path.join(path.dirname(downloaded), 'Code');
}

export interface LaunchOptions {
  /** Переменные окружения для процесса VS Code сверх унаследованных. */
  env?: Record<string, string>;
  /** Файл, куда пишутся stdout и stderr VS Code. */
  log: string;
}

/**
 * Запускает тестовый VS Code. На macOS — через `open -g`, чтобы окна не выходили
 * на передний план и не забирали фокус; процесс `open` завершается вместе с VS Code.
 * Во встроенном терминале VS Code задана ELECTRON_RUN_AS_NODE, с ней Code стартует как Node,
 * поэтому её не передаём.
 */
export function launchVSCode(binary: string, args: string[], opts: LaunchOptions): ChildProcess {
  fs.mkdirSync(path.dirname(opts.log), { recursive: true });
  fs.writeFileSync(opts.log, '');
  // `open` тоже передаёт приложению своё окружение, так что переменную убираем в обоих случаях.
  const env = { ...process.env, ...opts.env } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform === 'darwin') {
    const bundle = binary.slice(0, binary.indexOf('.app') + '.app'.length);
    return spawn('open', ['-g', '-n', '-W', '-a', bundle, '--stdout', opts.log, '--stderr', opts.log, '--args', ...args], { env, stdio: 'ignore' });
  }
  const out = fs.openSync(opts.log, 'a');
  return spawn(binary, args, { env, stdio: ['ignore', out, out] });
}

/** Свободный локальный порт для --remote-debugging-port. */
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
