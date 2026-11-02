import * as fs from 'fs';
import * as path from 'path';

/**
 * The chosen My Vibe settings, kept in the extension's global storage: the macOS service and a
 * window that plays the music itself read and write the same file.
 */
const FILE = 'wave-settings.json';

export function loadWaveSettings(storageDir: string): Record<string, string> {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(storageDir, FILE), 'utf8'));
    return s && typeof s === 'object' ? Object.fromEntries(Object.entries(s).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
  } catch {
    return {};
  }
}

export function saveWaveSettings(storageDir: string, settings: Record<string, string>): void {
  fs.promises
    .mkdir(storageDir, { recursive: true })
    .then(() => fs.promises.writeFile(path.join(storageDir, FILE), JSON.stringify(settings)))
    .catch(() => undefined); // only the next start's settings are lost
}
