#!/usr/bin/env node
/**
 * Build the portable skill bundle.
 *
 *   node tools/build-skill.mjs                write dist/ustc-mail
 *   node tools/build-skill.mjs --check        fail if the bundle is out of date
 *   node tools/build-skill.mjs --install      copy it into $DSH_HOME/skills/ustc-mail
 *   node tools/build-skill.mjs --install <dir>  ... into <dir> instead
 *
 * The repository stays the single source of truth; `dist/ustc-mail` is what you
 * copy to another agent, another machine, or another operating system. The
 * bundle is self-contained: it locates its own code relative to SKILL.md, so no
 * absolute path is baked in.
 */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'ustc-mail');

/**
 * Every file the bundle carries, as source path -> path inside the bundle.
 *
 * Listed explicitly so the bundle is deterministic: adding a module to the
 * repository does not silently add or omit it here.
 */
const FILES = [
  ['skill/SKILL.md', 'SKILL.md'],
  ['LICENSE', 'LICENSE'],
  ['bin/ustc-mail.mjs', 'bin/ustc-mail.mjs'],
  ['bin/setup-credentials.mjs', 'bin/setup-credentials.mjs'],
  // The Windows keychain backend shells out to this; harmless elsewhere.
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
];

/** The only non-portable file the bundle may carry, and only for Windows' sake. */
const ALLOWED_SCRIPT = 'bin/credential-store.ps1';

/**
 * A generated manifest for the bundle root.
 *
 * Without it Node finds no `"type": "module"` above the copied files, re-parses
 * every `.js` as ESM, and prints a MODULE_TYPELESS_PACKAGE_JSON warning on
 * stderr — which pollutes the very output the model reads. It deliberately
 * carries no `dsh` field: the bundle is a skill, not a plugin.
 */
const BUNDLE_PACKAGE_JSON = `${JSON.stringify({
  name: 'ustc-mail-skill',
  version: '1.1.0',
  private: true,
  type: 'module',
  license: 'MIT',
  description: 'Read a USTC mailbox over IMAP. Self-contained skill bundle.',
}, null, 2)}\n`;

/**
 * Collect the bundle's intended contents in memory.
 * @returns a map of bundle path -> file contents.
 */
async function planned() {
  const contents = new Map([['package.json', Buffer.from(BUNDLE_PACKAGE_JSON, 'utf8')]]);
  for (const [source, target] of FILES) {
    const absolute = path.join(ROOT, source);
    if (!existsSync(absolute)) throw new Error(`Missing source file: ${source}`);
    const relative = target.replace(/\\/g, '/');
    if (relative.endsWith('.ps1') && relative !== ALLOWED_SCRIPT) {
      throw new Error(`Refusing to bundle ${relative}: it does not run on every platform.`);
    }
    contents.set(relative, await readFile(absolute));
  }
  return contents;
}

/** Report every difference between the intended bundle and what is on disk. */
async function check() {
  const contents = await planned();
  const problems = [];

  for (const [relative, expected] of contents) {
    const absolute = path.join(DIST, relative);
    if (!existsSync(absolute)) {
      problems.push(`missing: ${relative}`);
      continue;
    }
    const actual = await readFile(absolute);
    if (!actual.equals(expected)) problems.push(`out of date: ${relative}`);
  }

  if (existsSync(DIST)) {
    const { readdir } = await import('node:fs/promises');
    const walk = async (dir, prefix = '') => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const relative = `${prefix}${entry.name}`;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), `${relative}/`);
        else if (!contents.has(relative)) problems.push(`unexpected: ${relative}`);
      }
    };
    await walk(DIST);
  } else {
    problems.push('dist/ustc-mail does not exist');
  }

  if (problems.length === 0) {
    process.stdout.write(`bundle is up to date (${contents.size} files)\n`);
    return 0;
  }
  process.stdout.write(`bundle is out of date:\n${problems.map((line) => `  ${line}`).join('\n')}\n`);
  process.stdout.write('\nRun: node tools/build-skill.mjs\n');
  return 1;
}

/** Write the bundle into `dist/ustc-mail`. */
async function build() {
  await rm(DIST, { recursive: true, force: true });
  const contents = await planned();
  for (const [relative, bytes] of contents) {
    const absolute = path.join(DIST, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
  process.stdout.write(`wrote ${contents.size} files to ${path.relative(ROOT, DIST)}\n`);
  return 0;
}

/**
 * Copy the bundle into a skills directory.
 *
 * The bundle is rebuilt first, so an install can never ship stale code.
 * @param target - destination directory, or undefined for `$DSH_HOME/skills/ustc-mail`.
 */
async function install(target) {
  const home = process.env.DSH_HOME;
  const destination = target ?? (home === undefined
    ? undefined
    : path.join(home, 'skills', 'ustc-mail'));
  if (destination === undefined) {
    process.stderr.write('No target given and DSH_HOME is not set. Pass a directory: --install <dir>\n');
    return 2;
  }
  await build();
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const contents = await planned();
  for (const relative of contents.keys()) {
    const from = path.join(DIST, relative);
    const to = path.join(destination, relative);
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  process.stdout.write(`installed to ${destination}\n`);
  return 0;
}

const USAGE = `Usage: node tools/build-skill.mjs [--check | --install [dir]]

  (no flag)        write dist/ustc-mail from the repository
  --check          fail when the bundle is missing, stale, or has stray files
  --install [dir]  rebuild, then copy into <dir> (default $DSH_HOME/skills/ustc-mail)`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (argv.includes('--check')) process.exit(await check());
if (argv.includes('--install')) {
  const at = argv.indexOf('--install');
  process.exit(await install(argv[at + 1]?.startsWith('-') ? undefined : argv[at + 1]));
}
process.exit(await build());
