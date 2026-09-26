import * as fs from 'fs';
import * as path from 'path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';

/** Путь к тестовому VS Code. На macOS бинарник в бандле называется Code, хотя test-electron возвращает путь к Electron. */
export async function vscodeBinary(): Promise<string> {
  const downloaded = await downloadAndUnzipVSCode(process.env.VSCODE_VERSION ?? 'stable');
  return fs.existsSync(downloaded) ? downloaded : path.join(path.dirname(downloaded), 'Code');
}
