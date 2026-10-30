/**
 * Packs the built app into `dist/Yandex Music Remote-darwin-<arch>/Yandex Music Remote.app`,
 * for Apple silicon and Intel Macs. The app is not signed: on first launch open it with
 * right click → Open, or run `xattr -dr com.apple.quarantine "Yandex Music Remote.app"`.
 */
import { packager } from '@electron/packager';
import * as path from 'node:path';

const root = path.join(import.meta.dir, '..');
const archArg = process.argv.find((a) => a.startsWith('--arch='))?.slice('--arch='.length);

const paths = await packager({
  dir: root,
  out: path.join(root, 'dist'),
  name: 'Yandex Music Remote',
  appBundleId: 'net.entro.yandex-music-remote',
  appCategoryType: 'public.app-category.music',
  platform: 'darwin',
  arch: archArg === 'x64' || archArg === 'arm64' ? archArg : ['arm64', 'x64'],
  icon: path.join(root, 'build/icon.icns'),
  overwrite: true,
  asar: true,
  // Only the built files and package.json go into the app.
  ignore: [/^\/(src|dev|scripts|dist|build|node_modules)(\/|$)/, /^\/(tsconfig\.json|bun\.lock|\.gitignore)$/],
});
for (const p of paths) {
  console.log(`packed ${path.relative(process.cwd(), p)}`);
}
