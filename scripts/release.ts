/**
 * Releases the extension from a clean main: bumps the version, packages the extension with the
 * remote's release build and publishes it on GitHub with the given notes, then installs that
 * extension here with the personal build of the remote (build-app.sh --personal).
 *   bun scripts/release.ts <patch|minor|major|x.y.z> <notes.md>
 */
import { resolve } from 'node:path';
import { $ } from 'bun';

const VSCODE_CLI = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code';

const [bump, notesArg] = Bun.argv.slice(2);
if (!bump || !notesArg) {
  console.error('usage: bun scripts/release.ts <patch|minor|major|x.y.z> <notes.md>');
  process.exit(1);
}
const notes = resolve(notesArg);
if (!(await Bun.file(notes).exists())) {
  throw new Error(`no release notes at ${notes}`);
}

$.cwd(resolve(import.meta.dir, '..'));
if ((await $`git branch --show-current`.text()).trim() !== 'main') {
  throw new Error('releases are made from main');
}
if ((await $`git status --porcelain`.text()).trim()) {
  throw new Error('the working tree has changes: commit them first');
}

await $`npm version ${bump} --no-git-tag-version`.quiet();
const { version } = (await Bun.file('package.json').json()) as { version: string };
await $`bun run compile`;

// The release, with the remote everyone gets.
const vsix = `vscode-yandex-music-${version}.vsix`;
await $`bash remote/scripts/build-app.sh`;
await $`bun x vsce package --no-dependencies -o ${vsix}`;
await $`git commit -qam ${`Release ${version}`}`;
await $`git tag v${version}`;
await $`git push -q origin main v${version}`;
await $`gh release create v${version} ${vsix} --title ${version} --notes-file ${notes}`;

// Here: the released extension, and the personal build of the remote in ~/Applications. It has
// the extension's version, so the extension doesn't replace it with the one it carries.
await $`${VSCODE_CLI} --install-extension ${vsix} --force`;
await $`bash remote/scripts/build-app.sh --personal`;
await $`bash remote/scripts/install-app.sh`;
console.log(`released ${version}; installed it here with the personal remote`);
