/**
 * The platform keychain, behind one interface.
 *
 * Every backend answers the same four questions, and a backend that cannot run
 * on this machine says so instead of failing: the resolver simply moves on to
 * the next credential source. That is what keeps the skill usable on a machine
 * with no keychain at all, such as a headless Linux box.
 *
 * What {@link keychainBackend} can promise is narrower than "the keychain
 * works". A probe can see that a command exists; it cannot see that the service
 * behind it is running, unlocked, or reachable. `secret-tool` is commonly
 * installed on a headless Linux box that has no session bus at all, and on macOS
 * a locked login keychain refuses both reads and writes.
 *
 * So the split is deliberate:
 *
 *   reads   fail soft — the resolver catches the error and falls through to the
 *           next source, so a broken keychain never hides a usable file.
 *   writes  fail loud — a caller that stores a credential MUST handle the throw
 *           and decide what to do instead. Silently losing the credential the
 *           user just typed would be worse than refusing it.
 *
 * The value stored is always the same pair — the account name and the
 * authorization code. Each backend maps that pair onto its own shape:
 *
 *   Windows  account in the credential's user field, secret in its blob
 *   macOS    a base64 blob in the password field of a generic password item
 *   Linux    a JSON blob as the Secret Service item's secret
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Keychain item name used on every platform. */
export const DEFAULT_SERVICE = 'USTC-Mail';

/** Seconds any one keychain command may take. */
const COMMAND_TIMEOUT_MS = 20000;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The Windows helper shipping beside this module (`lib/` and `bin/` are siblings). */
export const WINDOWS_HELPER = path.join(HERE, '..', 'bin', 'credential-store.ps1');

/** PowerShell hosts to try, in order. Windows PowerShell 5.1 always exists. */
export function powershellCandidates() {
  const candidates = ['powershell'];
  if (process.env.SystemRoot !== undefined) {
    candidates.push(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  }
  candidates.push('pwsh');
  return candidates;
}

/**
 * @param command - the executable to look for.
 * @param args - arguments that make it exit immediately on every platform.
 * @returns true when the executable can be spawned at all.
 */
function commandExists(command, args) {
  const probe = spawnSync(command, args, {
    stdio: 'ignore', timeout: 5000, windowsHide: true,
  });
  // A non-zero exit still proves the binary exists; only ENOENT does not.
  return probe.error === undefined || probe.error.code !== 'ENOENT';
}

/** Spawn arguments that only prove a PowerShell host runs, without a pager. */
const POWERSHELL_PROBE = ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'];

/** @returns whether a command's result counts as success. */
const ok = (result) => result.error === undefined && result.status === 0;

/**
 * Windows: the Credential Manager, through a PowerShell helper.
 * @param service - keychain item name.
 * @returns a backend.
 */
function windowsBackend(service) {
  const run = (args, input) => {
    let last = { error: { message: 'no PowerShell host could be started' } };
    for (const shell of powershellCandidates()) {
      const result = spawnSync(
        shell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_HELPER, ...args],
        { input, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, windowsHide: true },
      );
      if (result.error === undefined) return result;
      last = result;
    }
    return last;
  };

  return {
    name: `Windows Credential Manager "${service}"`,
    read() {
      const result = run(['-Action', 'read', '-Target', service]);
      if (!ok(result)) return undefined;
      const text = String(result.stdout ?? '').trim();
      if (text === '') return undefined;
      const parsed = JSON.parse(text);
      return { user: parsed.user, password: parsed.password };
    },
    write(credentials) {
      const result = run(
        ['-Action', 'write', '-Target', service, '-User', credentials.user],
        credentials.password,
      );
      if (!ok(result)) throw new Error(`Storing the Windows credential failed: ${String(result.stderr ?? '').trim()}`);
    },
    remove() {
      const result = run(['-Action', 'delete', '-Target', service]);
      return ok(result);
    },
  };
}

/**
 * Encode the credential pair for the macOS Keychain.
 *
 * `security find-generic-password -w` prints a password that contains bytes
 * outside the printable range as a hex dump rather than as text. A JSON blob
 * holding a non-ASCII authorization code hits that, and reading it back then
 * fails to parse. Base64 keeps the stored value pure ASCII on every input,
 * which the tool prints verbatim.
 *
 * USTC authorization codes are usually ASCII, so this only bites sometimes —
 * which is exactly why it went unnoticed until a macOS runner tried it.
 * @param credentials - `user` and `password`.
 * @returns a base64 string safe to hand to the `security` tool.
 */
export function encodeSecret(credentials) {
  return Buffer.from(JSON.stringify(credentials), 'utf8').toString('base64');
}

/**
 * Decode a value the macOS Keychain returned.
 *
 * Items written before the base64 envelope existed hold raw JSON, and those are
 * still read rather than discarded; a `{` is the giveaway.
 * @param text - the value `security` printed.
 * @returns the credential pair.
 * @throws when the value is neither base64 JSON nor raw JSON.
 */
export function decodeSecret(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  return JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
}

/**
 * macOS: a generic password in the login keychain.
 *
 * Note that `security add-generic-password` only takes the secret as an
 * argument, so it is briefly visible to a process listing on this machine.
 * @param service - keychain item name.
 * @returns a backend.
 */
function macosBackend(service) {
  const run = (args, input) => spawnSync('security', args, {
    input, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS,
  });

  return {
    name: `macOS Keychain "${service}"`,
    read() {
      const result = run(['find-generic-password', '-s', service, '-w']);
      if (!ok(result)) return undefined;
      const text = String(result.stdout ?? '').trim();
      if (text === '') return undefined;
      return decodeSecret(text);
    },
    write(credentials) {
      // Delete first. `-U` only updates an existing item when both the account
      // and the service match, so storing a different account would silently
      // leave the previous item behind and make the later `-s`-only read and
      // delete pick between two items. Removing first keeps exactly one.
      run(['delete-generic-password', '-s', service]);
      const result = run([
        'add-generic-password', '-a', credentials.user, '-s', service,
        '-w', encodeSecret(credentials),
      ]);
      if (!ok(result)) throw new Error(`Storing the Keychain item failed: ${String(result.stderr ?? '').trim()}`);
    },
    remove() {
      const result = run(['delete-generic-password', '-s', service]);
      return ok(result);
    },
  };
}

/**
 * Linux: the Secret Service, through `secret-tool`.
 *
 * `secret-tool store` reads the secret from stdin, so it never reaches a
 * command line.
 * @param service - keychain item name.
 * @returns a backend.
 */
function linuxBackend(service) {
  const run = (args, input) => spawnSync('secret-tool', args, {
    input, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS,
  });

  return {
    name: `Secret Service "${service}"`,
    read() {
      const result = run(['lookup', 'service', service]);
      if (!ok(result)) return undefined;
      const text = String(result.stdout ?? '').trim();
      if (text === '') return undefined;
      return JSON.parse(text);
    },
    write(credentials) {
      // Clear first, for the same reason as the Keychain backend: the item is
      // keyed only by `service`, so replacing it explicitly beats relying on
      // the store to deduplicate.
      run(['clear', 'service', service]);
      const result = run(
        ['store', '--label', `${service} (USTC mail)`, 'service', service],
        JSON.stringify(credentials),
      );
      if (!ok(result)) throw new Error(`Storing the Secret Service item failed: ${String(result.stderr ?? '').trim()}`);
    },
    remove() {
      const result = run(['clear', 'service', service]);
      return ok(result);
    },
  };
}

/**
 * Pick the keychain this platform has, without probing it.
 *
 * Availability is decided separately by {@link keychainBackend}, because a
 * backend can exist and still be unusable (no session bus, no helper script).
 * @param service - keychain item name.
 * @param platform - a `process.platform` value.
 * @returns a backend, or undefined on a platform with none.
 */
function backendFor(service, platform) {
  if (platform === 'win32') return windowsBackend(service);
  if (platform === 'darwin') return macosBackend(service);
  if (platform === 'linux') return linuxBackend(service);
  return undefined;
}

/**
 * The keychain for this machine, or undefined when there is none to use.
 *
 * "Usable" means the platform has a backend, its command exists, and — for
 * Windows — the bundled helper script is present. A probe never reads or
 * writes a credential.
 * @param options - `service` and `platform` overrides, for tests.
 * @returns a backend, or undefined.
 */
export function keychainBackend(options = {}) {
  const service = options.service ?? DEFAULT_SERVICE;
  const platform = options.platform ?? process.platform;

  const backend = backendFor(service, platform);
  if (backend === undefined) return undefined;

  if (platform === 'win32') {
    if (!existsSync(WINDOWS_HELPER)) return undefined;
    if (powershellCandidates().every((shell) => !commandExists(shell, POWERSHELL_PROBE))) return undefined;
    return backend;
  }
  if (platform === 'darwin') return commandExists('security', ['help']) ? backend : undefined;
  return commandExists('secret-tool', ['--help']) ? backend : undefined;
}
