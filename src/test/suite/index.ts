import * as fs from 'fs';
import Mocha from 'mocha';
import * as path from 'path';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60000 });
  for (const f of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'))) {
    mocha.addFile(path.join(__dirname, f));
  }
  return new Promise((resolve, reject) => mocha.run((failures) => (failures ? reject(new Error(`${failures} tests failed`)) : resolve())));
}
