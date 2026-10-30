import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const EXTENSION_ID = 'entro.vscode-yandex-music';

/** Editors the extension may be installed in: their extensions folder and their name under Application Support. */
const EDITORS: readonly (readonly [extensions: string, appSupport: string])[] = [
  ['.vscode', 'Code'],
  ['.vscode-insiders', 'Code - Insiders'],
  ['.cursor', 'Cursor'],
  ['.vscode-oss', 'VSCodium'],
  ['.windsurf', 'Windsurf'],
];

/** An installed copy of the extension and where its windows keep their global storage. */
export interface Install {
  dir: string;
  storageDir: string;
}

function version(dir: string): number[] {
  return (path.basename(dir).slice(EXTENSION_ID.length + 1).match(/\d+/g) ?? []).map(Number);
}

function newer(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) {
      return d > 0;
    }
  }
  return false;
}

/**
 * The newest copy of the extension, in the first editor (VS Code before its forks) where the
 * user has run it, so its windows find the service on the socket they look at. `YM_EXTENSION_DIR`
 * and `YM_STORAGE_DIR` point at a copy elsewhere, for development.
 */
export function findInstall(): Install | undefined {
  const dir = process.env['YM_EXTENSION_DIR'];
  const storageDir = process.env['YM_STORAGE_DIR'];
  if (dir && storageDir) {
    return { dir, storageDir };
  }
  if (process.platform !== 'darwin') {
    return undefined; // the service plays through AVPlayer: macOS only
  }
  const home = os.homedir();
  const found: (Install & { used: boolean })[] = [];
  for (const [extensions, appSupport] of EDITORS) {
    let best: string | undefined;
    try {
      for (const name of fs.readdirSync(path.join(home, extensions, 'extensions'))) {
        const full = path.join(home, extensions, 'extensions', name);
        if (name.startsWith(`${EXTENSION_ID}-`) && fs.existsSync(path.join(full, 'out', 'service.js')) && (!best || newer(version(full), version(best)))) {
          best = full;
        }
      }
    } catch {
      continue;
    }
    if (best) {
      const storage = path.join(home, 'Library', 'Application Support', appSupport, 'User', 'globalStorage', EXTENSION_ID);
      found.push({ dir: best, storageDir: storage, used: fs.existsSync(storage) });
    }
  }
  const pick = found.find((f) => f.used) ?? found[0];
  return pick && { dir: pick.dir, storageDir: pick.storageDir };
}

/** The service's socket for this storage, as `socketPathFor(storageDir, 'service')` in `src/protocol.ts` names it. */
export function serviceSocket(install: Install): string {
  const id = createHash('sha1').update(install.storageDir).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `vscode-yandex-music-service-${id}.sock`);
}

/**
 * Starts the extension's player service the way a VS Code window does, with this app's Electron
 * in Node mode instead of VS Code's. It runs on its own: it outlives the app while VS Code
 * windows are connected, and exits a few seconds after the last remote leaves.
 */
export function startService(install: Install): void {
  fs.mkdirSync(install.storageDir, { recursive: true });
  const socket = serviceSocket(install);
  fs.rmSync(socket, { force: true }); // left over from a service that crashed: nothing answered on it
  const child = spawn(
    process.execPath,
    [path.join(install.dir, 'out', 'service.js'), socket, path.join(install.dir, 'helper', 'avplayer.js'), path.join(install.storageDir, 'service.log')],
    { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
  );
  child.unref();
}
