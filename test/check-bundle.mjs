/**
 * Guards the portable bundle.
 *
 *   node test/check-bundle.mjs
 *
 * The bundle is what gets copied to another agent, another machine, or another
 * operating system, so the properties that make it portable are asserted here
 * rather than trusted: no absolute path from this repository, no file that only
 * runs on Windows, and a manifest that keeps Node from re-parsing as it loads.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const dist = path.join(root, 'dist', 'ustc-mail');

let failed = 0;
let passed = 0;
const check = (label, ok, detail) => {
  if (ok) {
    passed += 1;
    process.stdout.write(`${label}: ok\n`);
    return;
  }
  failed += 1;
  process.stdout.write(`${label}: FAILED — ${detail}\n`);
};

/** Every file in the bundle, as bundle-relative POSIX paths. */
function bundleFiles() {
  const found = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), `${relative}/`);
      else found.push(relative);
    }
  };
  walk(dist, '');
  return found;
}

const built = spawnSync(process.execPath, [path.join(root, 'tools', 'build-skill.mjs')], {
  encoding: 'utf8', timeout: 60000,
});
check('the bundle builds', built.status === 0, `${built.stdout ?? ''}${built.stderr ?? ''}`.trim());

const checked = spawnSync(process.execPath, [path.join(root, 'tools', 'build-skill.mjs'), '--check'], {
  encoding: 'utf8', timeout: 60000,
});
check('the bundle matches its sources', checked.status === 0, `${checked.stdout ?? ''}`.trim());

const files = bundleFiles();

check('SKILL.md is the entry point', files.includes('SKILL.md'), `files: ${files.join(', ')}`);
check(
  'the entry point is named SKILL.md at the root',
  existsSync(path.join(dist, 'SKILL.md')),
  'the skill loader could not find it',
);

// Every agent needs the CLI; the setup tool is what keeps secrets off disk.
for (const required of ['bin/ustc-mail.mjs', 'bin/setup-credentials.mjs', 'lib/credentials.js', 'lib/keychain.js']) {
  check(`the bundle carries ${required}`, files.includes(required), 'missing');
}

// The plugin half must not leak in: it needs this profile's runtime.
for (const excluded of ['index.js', 'lib/tool-schema.js', 'cordis.patch.yml']) {
  check(`the bundle omits ${excluded}`, !files.includes(excluded), 'it would only work inside DSH');
}

const scripts = files.filter((name) => name.endsWith('.ps1'));
check(
  'the only Windows script is the keychain helper',
  scripts.length === 1 && scripts[0] === 'bin/credential-store.ps1',
  `found: ${scripts.join(', ') || '(none)'}`,
);

const manifest = JSON.parse(readFileSync(path.join(dist, 'package.json'), 'utf8'));
check('the manifest declares an ES module', manifest.type === 'module', `type is ${manifest.type}`);
check('the manifest carries no dsh field', manifest.dsh === undefined, 'it would look like a plugin');

// A hard-coded absolute path anywhere is the bug this whole design exists to avoid.
const offenders = [];
for (const relative of files) {
  if (!/\.(js|mjs|md|json)$/.test(relative)) continue;
  const text = readFileSync(path.join(dist, relative), 'utf8');
  if (/F:\\dsh-email/i.test(text)) offenders.push(relative);
  if (/C:\\Users\\/i.test(text) && !/C:\\\\Users/.test(text)) offenders.push(`${relative} (a user path)`);
}
check('no absolute path from this machine is baked in', offenders.length === 0, offenders.join(', '));

// The skill must tell the model how to resolve its own directory.
const skill = readFileSync(path.join(dist, 'SKILL.md'), 'utf8');
check('SKILL.md explains how to locate itself', /<skill>/.test(skill) && /SKILL\.md/.test(skill), 'no <skill> convention');
check('SKILL.md documents every platform keychain', /Windows/.test(skill) && /macOS/.test(skill) && /Linux/.test(skill), 'a platform is undocumented');
check('SKILL.md warns that setup needs a terminal', /交互终端/.test(skill), 'an agent could block on the prompt');

assert.ok(files.length >= 19, `expected at least 19 bundled files, got ${files.length}`);

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
