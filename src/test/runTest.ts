import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { vscodeBinary } from './vscodeBinary';

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../');
  const extensionTestsPath = path.resolve(__dirname, './suite/index');
  await runTests({
    vscodeExecutablePath: await vscodeBinary(),
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: ['--disable-extensions', '--disable-workspace-trust', '--disable-gpu', '--no-sandbox'],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
