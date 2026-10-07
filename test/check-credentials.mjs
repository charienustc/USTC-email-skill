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

import { resolveCredentials, storeCredentials, writeCredentialsFile } from '../lib/credentials.js';
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
  //
  // A backend that reports itself available is not a promise that it works.
  // On a headless Linux box `secret-tool` is often installed with no session
  // bus behind it, and a locked macOS keychain refuses writes, so this block
  // decides what it can test by trying, and otherwise checks the fallback.

  const backend = keychainBackend({ service: 'USTC-Mail-Check-Probe' });
  if (backend === undefined) {
    process.stdout.write('keychain: skipped (this platform has none available)\n');
  } else {
    const service = `USTC-Mail-Check-${Date.now().toString(36)}`;
    const target = keychainBackend({ service });
    check('a keychain backend is available', target !== undefined, 'the probe found one but the item lookup did not');

    let usable = false;
    let unusableReason = '';
    try {
      target.write({ user: ACCOUNT, password: SECRET });
      usable = true;
    } catch (error) {
      unusableReason = String(error.message ?? error).trim().replace(/\s+/g, ' ');
    }

    if (!usable) {
      // A real environment where the command exists and the service does not.
      process.stdout.write(`keychain: present but unusable — ${unusableReason}\n`);
      process.stdout.write('keychain: round-trip checks skipped; checking the fallback instead\n');

      const probeFile = path.join(directory, 'unusable-keychain.json');
      const outcome = await storeCredentials({
        backend: target,
        credentialsFile: probeFile,
        credentials: { user: ACCOUNT, password: SECRET },
      });
      check('an unusable keychain falls back to the file', outcome.fellBack === true, `fellBack=${outcome.fellBack}`);
      check('the fallback reports the keychain error', outcome.reason === unusableReason, `got ${outcome.reason}`);

      const stored = await resolveCredentials({ keychainService: service, credentialsFile: probeFile });
      check(
        'the credential survives an unusable keychain',
        stored.password === SECRET && stored.user === ACCOUNT,
        'the credential the user typed was lost',
      );
      check(
        'an unusable keychain does not claim to be the source',
        stored.passwordSource === probeFile,
        `got ${stored.passwordSource}`,
      );
      if (process.platform !== 'win32') {
        check(
          'the fallback file is 600',
          (statSync(probeFile).mode & 0o777) === 0o600,
          `mode ${(statSync(probeFile).mode & 0o777).toString(8)}`,
        );
      }
    } else {
      try {
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

      // Storing twice must leave exactly one item, which is what makes the
      // service-only read and delete unambiguous. This is the macOS account
      // change: -U would have kept the old item beside the new one.
      const changed = keychainBackend({ service });
      changed.write({ user: 'first@x.cn', password: 'first-secret' });
      changed.write({ user: 'second@x.cn', password: 'second-secret' });
      const replaced = changed.read();
      check('a second store replaces rather than duplicates', replaced?.user === 'second@x.cn', `got ${replaced?.user}`);
      check('the replacement removed the item', changed.remove() === true, 'remove reported failure');
      const gone = changed.read();
      check('removal left nothing behind', gone === undefined, `got ${JSON.stringify(gone)}`);
    }
  }

  // ------------------------------------------------------- direct file write

  const direct = path.join(directory, 'direct.json');
  await writeCredentialsFile(direct, { user: 'direct@x.cn', password: 'direct-secret' });
  const directRead = await resolveCredentials({ keychainService: absentService, credentialsFile: direct });
  check('writeCredentialsFile is readable by the loader', directRead.user === 'direct@x.cn', `got ${directRead.user}`);
  assert.ok(exists(direct));

  // ------------------------------------------------- keychain write fallback
  //
  // A backend that reports itself available is not a promise that it works:
  // `secret-tool` ships on headless Linux with no session bus, and a locked
  // macOS login keychain refuses writes. Losing the credential the user just
  // typed would be the worst outcome, so the write degrades to the file.

  const fellBackFile = path.join(directory, 'fell-back.json');
  const refused = {
    name: 'a keychain that refuses',
    write() {
      throw new Error('Storing the Secret Service item failed: Cannot autolaunch D-Bus');
    },
  };
  const outcome = await storeCredentials({
    backend: refused,
    credentialsFile: fellBackFile,
    credentials: { user: 'fallback@x.cn', password: 'fallback-secret' },
  });
  check('a refused keychain write falls back to the file', outcome.fellBack === true, `fellBack=${outcome.fellBack}`);
  check('the fallback names the file as the destination', outcome.destination === fellBackFile, `got ${outcome.destination}`);
  check('the fallback reason is passed through', /autolaunch/i.test(outcome.reason ?? ''), `got ${outcome.reason}`);

  const recovered = await resolveCredentials({ keychainService: absentService, credentialsFile: fellBackFile });
  check(
    'the credential survives a refused keychain write',
    recovered.password === 'fallback-secret',
    'the secret the user typed was lost',
  );
  if (process.platform !== 'win32') {
    check('the fallback file is still 600', (statSync(fellBackFile).mode & 0o777) === 0o600, `mode ${(statSync(fellBackFile).mode & 0o777).toString(8)}`);
  }

  // A keychain that works must still win, and must clear the plaintext copy.
  const keptFile = path.join(directory, 'kept.json');
  await writeCredentialsFile(keptFile, { user: 'old@x.cn', password: 'old-secret' });
  const writes = [];
  const working = {
    name: 'a keychain that works',
    write(credentials) { writes.push(credentials); },
  };
  const placed = await storeCredentials({
    backend: working,
    credentialsFile: keptFile,
    credentials: { user: 'new@x.cn', password: 'new-secret' },
  });
  check('a working keychain is the destination', placed.destination === 'a keychain that works', `got ${placed.destination}`);
  check('a working keychain does not fall back', placed.fellBack === false, `fellBack=${placed.fellBack}`);
  check('the credential reached the backend', writes.length === 1 && writes[0].password === 'new-secret', JSON.stringify(writes));
  check('the stale plaintext file is removed', !exists(keptFile), 'the old file survived');
  check('removal is reported', placed.removedFile === true, `removedFile=${placed.removedFile}`);

  // --keep-file must leave the plaintext copy alone even so.
  const keepFile = path.join(directory, 'keep.json');
  await writeCredentialsFile(keepFile, { user: 'old@x.cn', password: 'old-secret' });
  const kept = await storeCredentials({
    backend: working,
    credentialsFile: keepFile,
    credentials: { user: 'new@x.cn', password: 'new-secret' },
    keepFile: true,
  });
  check('--keep-file preserves the plaintext copy', exists(keepFile) && kept.removedFile === false, 'the file was removed anyway');

  // No keychain at all is the ordinary path, not a fallback.
  const noBackendFile = path.join(directory, 'no-backend.json');
  const plain = await storeCredentials({
    backend: undefined,
    credentialsFile: noBackendFile,
    credentials: { user: 'plain@x.cn', password: 'plain-secret' },
  });
  check('no keychain is not reported as a fallback', plain.fellBack === false, `fellBack=${plain.fellBack}`);
  check('no keychain writes the file', exists(noBackendFile), 'nothing was written');
} finally {
  rmSync(directory, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
