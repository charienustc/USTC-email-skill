/**
 * Assemble the installable plugin package.
 *
 * Unlike the skill bundle, this one is a DSH bundle: it declares
 * `dsh.bundle.patch` and a `dsh.client` half, and it carries `lib/` and the
 * Windows keychain helper so the package runs from wherever it is installed.
 *
 *   node tools/build-plugin.mjs            write dist/ustc-mail-plugin
 *   node tools/build-plugin.mjs --check    verify it matches the source
 *
 * Install the result with `plugin_manager` `install_bundle` pointed at the
 * produced directory; nothing here touches the profile.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'dist', 'ustc-mail-plugin');

/**
 * Source file -> destination inside the package.
 *
 * Every path is explicit: a new module that is not listed here does not ship,
 * which is the failure this list exists to make obvious.
 */
const FILES = [
  ['package.json', 'package.json'],
  ['cordis.patch.yml', 'cordis.patch.yml'],
  ['index.js', 'index.js'],
  ['plugin/client.js', 'client.js'],
  ['icon.svg', 'icon.svg'],
  ['locale/zh.json', 'locale/zh.json'],
  ['locale/en.json', 'locale/en.json'],
  ['bin/credential-store.ps1', 'bin/credential-store.ps1'],
  ['lib/args.js', 'lib/args.js'],
  ['lib/attach.js', 'lib/attach.js'],
  ['lib/bodystructure.js', 'lib/bodystructure.js'],
  ['lib/credentials.js', 'lib/credentials.js'],
  ['lib/format.js', 'lib/format.js'],
  ['lib/gate.js', 'lib/gate.js'],
  ['lib/html-text.js', 'lib/html-text.js'],
  ['lib/imap.js', 'lib/imap.js'],
  ['lib/keychain.js', 'lib/keychain.js'],
  ['lib/list.js', 'lib/list.js'],
  ['lib/message.js', 'lib/message.js'],
  ['lib/mime.js', 'lib/mime.js'],
  ['lib/preview.js', 'lib/preview.js'],
  ['lib/read.js', 'lib/read.js'],
  ['lib/search.js', 'lib/search.js'],
  ['lib/tool-schema.js', 'lib/tool-schema.js'],
];

/** @returns the bytes each file should have in the package. */
async function readSources() {
  const entries = [];
  for (const [from, to] of FILES) {
    const source = path.join(ROOT, from);
    if (!existsSync(source)) throw new Error(`Missing source file: ${from}`);
    entries.push({ from, to, bytes: await readFile(source) });
  }
  return entries;
}

/** @returns true when the package on disk already matches. */
async function matches(entries) {
  for (const entry of entries) {
    const target = path.join(OUT, entry.to);
    if (!existsSync(target)) return false;
    if (!(await readFile(target)).equals(entry.bytes)) return false;
  }
  return true;
}

const ENTRIES = await readSources();
const check = process.argv.includes('--check');

if (check) {
  const ok = await matches(ENTRIES);
  process.stdout.write(ok
    ? `plugin package is up to date (${ENTRIES.length} files)\n`
    : 'plugin package is STALE - run node tools/build-plugin.mjs\n');
  process.exit(ok ? 0 : 1);
}

await rm(OUT, { recursive: true, force: true });
for (const entry of ENTRIES) {
  const target = path.join(OUT, entry.to);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, entry.bytes);
}

const manifest = JSON.parse(await readFile(path.join(OUT, 'package.json'), 'utf8'));
process.stdout.write(`wrote ${ENTRIES.length} files to ${path.relative(ROOT, OUT)}\n`);
process.stdout.write(`  bundle id:  ${manifest.name}@${manifest.version}\n`);
process.stdout.write(`  client:     ${manifest.dsh?.client ? 'yes' : 'NO'}\n`);
process.stdout.write(`  install:    plugin_manager install_bundle "${OUT}"\n`);
