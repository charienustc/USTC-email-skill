/**
 * Checks the credential layer end to end, on whatever platform this runs.
 *
 *   node test/check-credentials.mjs
 *
 * The keychain half runs only where a keychain exists — the point of the design
 * is that its absence costs nothing — and says so when it is skipped.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { resolveCredentials, writeCredentialsFile } from '../lib/credentials.js';
import { keychainBackend } from '../lib/keychain.js';

const SECRET = 'pw-测试-混合-9xQ';
const ACCOUNT = 'check@mail.ustc.edu.cn';

const here = path.dirname(fileURLToPath(import.meta.url));
const setup = path.join(here, '..', 'bin', 'setup-credentials.mjs');

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

/** @returns whether a path exists. */
function exists(target) {
  try {
    readFileSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Run the setup tool with the secret on stdin. */
function runSetup(args, secret = SECRET) {
  return spawnSync(process.execPath, [setup, ...args], {
    input: `${secret}\n`, encoding: 'utf8', timeout: 60000,
  });
}

const directory = mkdtempSync(path.join(os.tmpdir(), 'ustc-credentials-check-'));
const file = path.join(directory, 'credentials.json');
const absentFile = path.join(directory, 'absent.json');
// The keychain outranks the file, so file assertions must name an unused item.
const absentService = `USTC-Mail-Check-Absent-${Date.now().toString(36)}`;
const fileOnly = { keychainService: absentService, credentialsFile: file };

try {
  // ------------------------------------------------------------- file backend

  const written = runSetup(['--user', ACCOUNT, '--secret-stdin', '--file', '--file-path', file, '--no-check']);
  check('the setup tool stores into the file', written.status === 0, `${written.stdout ?? ''}${written.stderr ?? ''}`.trim());

  const stored = JSON.parse(readFileSync(file, 'utf8'));
  check('the account survives the round trip', stored.user === ACCOUNT, `got ${stored.user}`);
  check('a non-ASCII secret survives the round trip', stored.password === SECRET, 'the secret did not round-trip intact');

  if (process.platform === 'win32') {
    process.stdout.write('file mode: skipped (Windows has no POSIX permission bits)\n');
  } else {
    const mode = statSync(file).mode & 0o777;
    check('the credential file is 600', mode === 0o600, `mode is ${mode.toString(8)}`);
  }

  const resolved = await resolveCredentials(fileOnly);
  check('the loader reads the file back', resolved.password === SECRET, 'the loader returned a different secret');
  check(
    'the file is named as the source',
    String(resolved.passwordSource).includes('credentials.json'),
    `got ${resolved.passwordSource}`,
  );

  // The environment still wins, so a temporary override stays possible.
  process.env.USTC_MAIL_PASS = 'from-env';
  const overridden = await resolveCredentials(fileOnly);
  check('the environment overrides the file', overridden.password === 'from-env', 'the environment did not win');
  delete process.env.USTC_MAIL_PASS;

  // ------------------------------------------------------------ validation

  for (const [label, bad] of [
    ['a double dot', 'user@mail.ustc..edu.cn'],
    ['a space', 'user mail.ustc.edu.cn'],
    ['no domain', 'user@mail'],
    ['no at sign', 'user'],
  ]) {
    const target = path.join(directory, 'rejected.json');
    const result = runSetup(['--user', bad, '--secret-stdin', '--file', '--file-path', target, '--no-check']);
    check(
      `the tool rejects an account with ${label}`,
      result.status !== 0 && !exists(target),
      `exit ${result.status}`,
    );
  }

  const noTerminal = spawnSync(process.execPath, [setup, '--file', '--file-path', path.join(directory, 'x.json')], {
    input: '', encoding: 'utf8', timeout: 60000,
  });
  check(
    'a prompt without a terminal fails with a clear message',
    noTerminal.status !== 0 && /交互终端/.test(`${noTerminal.stderr ?? ''}${noTerminal.stdout ?? ''}`),
    `exit ${noTerminal.status}`,
  );

  // ------------------------------------------------------------------- show

  const shown = spawnSync(process.execPath, [setup, '--show', '--keychain', absentService, '--file-path', file], {
    encoding: 'utf8', timeout: 60000,
  });
  check('--show reports the sources', shown.status === 0 && shown.stdout.includes(ACCOUNT), `exit ${shown.status}`);
  check('--show never prints the secret', !shown.stdout.includes(SECRET), 'the secret appeared in --show output');

  // ---------------------------------------------------------------- keychain

  const backend = keychainBackend({ service: 'USTC-Mail-Check-Probe' });
  if (backend === undefined) {
    process.stdout.write('keychain: skipped (this platform has none available)\n');
  } else {
    const service = `USTC-Mail-Check-${Date.now().toString(36)}`;
    const target = keychainBackend({ service });
    check('a keychain backend is available', target !== undefined, 'the probe found one but the item lookup did not');

    try {
      target.write({ user: ACCOUNT, password: SECRET });
      const read = target.read();
      check('the keychain returns the account', read?.user === ACCOUNT, `got ${read?.user}`);
      check('the keychain returns the secret', read?.password === SECRET, 'the secret did not round-trip intact');

      const fromKeychain = await resolveCredentials({ keychainService: service, credentialsFile: absentFile });
      check(
        'the loader prefers the keychain',
        fromKeychain.passwordSource === target.name,
        `got ${fromKeychain.passwordSource}`,
      );

      // The keychain must outrank a file that is also present.
      const decoy = path.join(directory, 'decoy.json');
      writeFileSync(decoy, JSON.stringify({ user: 'decoy@x.cn', password: 'decoy' }), 'utf8');
      const decoyed = await resolveCredentials({ keychainService: service, credentialsFile: decoy });
      check('the keychain outranks the file', decoyed.user === ACCOUNT, `got ${decoyed.user}`);
    } finally {
      check('the keychain item can be removed', target.remove() === true, 'remove reported failure');
    }

    const afterRemove = await resolveCredentials({ keychainService: service, credentialsFile: absentFile })
      .then(() => 'resolved', (error) => error.message);
    check(
      'a removed keychain item is gone',
      String(afterRemove).includes('not configured'),
      `got ${afterRemove}`,
    );
  }

  // ------------------------------------------------------- direct file write

  const direct = path.join(directory, 'direct.json');
  await writeCredentialsFile(direct, { user: 'direct@x.cn', password: 'direct-secret' });
  const directRead = await resolveCredentials({ keychainService: absentService, credentialsFile: direct });
  check('writeCredentialsFile is readable by the loader', directRead.user === 'direct@x.cn', `got ${directRead.user}`);
  assert.ok(exists(direct));
} finally {
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
