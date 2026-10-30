/** Builds the app into `out/`: the main process and preload for Electron's Node, the window's script for the browser. */
import { $ } from 'bun';
import * as path from 'node:path';

const root = path.join(import.meta.dir, '..');
const out = path.join(root, 'out');

await $`rm -rf ${out}`;

async function build(config: Bun.BuildConfig): Promise<void> {
  const result = await Bun.build(config);
  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
}

await build({
  entrypoints: [path.join(root, 'src/main.ts'), path.join(root, 'src/preload.ts')],
  outdir: out,
  target: 'node',
  format: 'cjs',
  external: ['electron'],
});
await build({
  entrypoints: [path.join(root, 'src/renderer/app.ts')],
  outdir: path.join(out, 'renderer'),
  target: 'browser',
  format: 'iife',
});

for (const file of ['index.html', 'style.css']) {
  await Bun.write(path.join(out, 'renderer', file), Bun.file(path.join(root, 'src/renderer', file)));
}
// The now-playing art is shared with the extension's player panel; its script is bundled into app.js.
for (const file of ['nowArt.css', 'cover-empty.svg', 'cover-loading.svg']) {
  await Bun.write(path.join(out, 'renderer', file), Bun.file(path.join(root, '../media', file)));
}
const fonts = [
  ...[400, 500, 600, 700].flatMap((w) => ['cyrillic', 'latin'].map((s) => `@fontsource/ibm-plex-sans/files/ibm-plex-sans-${s}-${w}-normal.woff2`)),
  ...['cyrillic', 'latin'].map((s) => `@fontsource/jetbrains-mono/files/jetbrains-mono-${s}-400-normal.woff2`),
];
for (const font of fonts) {
  await Bun.write(path.join(out, 'renderer/fonts', path.basename(font)), Bun.file(path.join(root, 'node_modules', font)));
}
console.log(`built into ${path.relative(process.cwd(), out) || '.'}`);
