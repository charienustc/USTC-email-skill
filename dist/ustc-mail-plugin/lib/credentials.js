/**
 * Credential resolution for the USTC mailbox, on any platform.
 *
 * A password is never stored in the plugin package or in a patch file. It comes
 * from the environment, from the platform keychain, or from a local file the
 * user owns. Nothing here logs a password, and no password reaches the caller's
 * output.
 *
 * The same order applies everywhere: the keychain layer simply disappears on a
 * machine that has none, so the file remains the universal fallback.
 */
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_SERVICE, keychainBackend } from './keychain.js';

/** Where a password is looked up when no other source is configured. */
export const DEFAULT_PASSWORD_ENV = 'USTC_MAIL_PASS';

/** Where the credential file lives when the config does not name one. */
export const DEFAULT_CREDENTIALS_FILE = path.join(os.homedir(), '.dsh', 'ustc-mail-credentials.json');

/** Keychain item name used by every backend. */
export { DEFAULT_SERVICE as DEFAULT_KEYCHAIN_SERVICE };

/** Permission bits no group or other user may hold on the credential file. */
const FORBIDDEN_MODE_BITS = 0o077;

/** @returns the first non-empty trimmed string, or undefined. */
function firstText(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

/**
 * Read the local credential file.
 * @param file - absolute path to read.
 * @returns the parsed contents, or undefined when the file does not exist.
 */
export async function readCredentialsFile(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Cannot read the credential file ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`The credential file ${file} is not valid JSON: ${error.message}`);
  }
}

/**
 * Write the credential file, readable only by its owner.
 *
 * `mode` is advisory on Windows — which has no POSIX permission bits and where
 * the keychain is the intended store anyway — but it is enforced on Linux and
 * macOS, where this file is the fallback.
 * @param file - absolute path to write.
 * @param credentials - `user` and `password` to store.
 */
export async function writeCredentialsFile(file, credentials) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(
    file,
    `${JSON.stringify({ user: credentials.user, password: credentials.password })}\n`,
    { mode: 0o600 },
  );
  // An existing file keeps its old mode, so set it again explicitly.
  await chmod(file, 0o600).catch(() => {});
}

/**
 * Store credentials in the keychain, falling back to the file when it fails.
 *
 * A keychain backend that reports itself available is not a promise that it
 * works: `secret-tool` is commonly installed on a headless Linux box with no
 * session bus, and a locked macOS login keychain refuses writes. Both keep the
 * command present and the service unreachable.
 *
 * Refusing the credential the user just typed would be the worst outcome, and
 * the file fallback is right there, so a failed keychain write degrades to the
 * file and reports why. The caller is responsible for telling the user which
 * one actually happened — see {@link StoreOutcome}.
 * @param options - the backend (or undefined), the file path, and the credentials.
 * @returns where the credentials ended up, and why if the keychain was bypassed.
 */
export async function storeCredentials(options) {
  const { backend, credentialsFile, credentials, keepFile = false } = options;

  if (backend === undefined) {
    await writeCredentialsFile(credentialsFile, credentials);
    return {
      destination: credentialsFile, fellBack: false, reason: undefined, removedFile: false,
    };
  }

  try {
    backend.write(credentials);
  } catch (error) {
    const reason = String(error?.message ?? error).trim().replace(/\s+/g, ' ');
    await writeCredentialsFile(credentialsFile, credentials);
    return {
      destination: credentialsFile, fellBack: true, reason, removedFile: false,
    };
  }

  // Only once the keychain really holds it is the plaintext copy worth removing.
  let removedFile = false;
  if (!keepFile && await readCredentialsFile(credentialsFile) !== undefined) {
    const { rm } = await import('node:fs/promises');
    await rm(credentialsFile, { force: true });
    removedFile = true;
  }

  return {
    destination: backend.name, fellBack: false, reason: undefined, removedFile,
  };
}

/**
 * Report whether a credential file is readable by anyone but its owner.
 *
 * This never fails a call: it only lets the caller warn. Windows reports no
 * meaningful mode, so it is skipped there.
 * @param file - absolute path to inspect.
 * @returns a warning sentence, or undefined when the file is private or absent.
 */
async function permissionsWarning(file) {
  if (process.platform === 'win32') return undefined;
  try {
    const info = await stat(file);
    if ((info.mode & FORBIDDEN_MODE_BITS) === 0) return undefined;
    const shown = (info.mode & 0o777).toString(8).padStart(3, '0');
    return `${file} is readable by other users (mode ${shown}). Run "chmod 600 ${file}".`;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the account name and password for one call.
 *
 * Sources, in order: the plugin config, the environment, the platform keychain,
 * then the credential file. The account name and the password may come from
 * different sources, so a config that names `user` still reads its password
 * from a store.
 * @param config - the plugin's resolved configuration.
 * @returns the endpoint and credentials, plus where each value came from.
 */
export async function resolveCredentials(config = {}) {
  const host = firstText(config.host, process.env.USTC_MAIL_HOST) ?? 'mail.ustc.edu.cn';
  const port = Number.isInteger(config.port) ? config.port : 993;
  const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs > 0
    ? config.timeoutMs
    : 20000;

  const passwordEnv = firstText(config.passwordEnv) ?? DEFAULT_PASSWORD_ENV;
  const credentialsFile = firstText(config.credentialsFile) ?? DEFAULT_CREDENTIALS_FILE;
  const keychainService = firstText(config.keychainService, config.credentialTarget) ?? DEFAULT_SERVICE;

  let user = firstText(config.user, process.env.USTC_MAIL_USER);
  let userSource = user === undefined ? undefined : 'config or USTC_MAIL_USER';
  let password = firstText(config.password, process.env[passwordEnv]);
  let passwordSource = password === undefined
    ? undefined
    : (firstText(config.password) === undefined ? passwordEnv : 'plugin config');

  /** Take whatever a store can fill in. */
  const applyStored = (stored, source) => {
    if (stored === undefined || typeof stored !== 'object' || stored === null) return;
    if (user === undefined) {
      user = firstText(stored.user);
      if (user !== undefined) userSource = source;
    }
    if (password === undefined) {
      password = firstText(stored.password);
      if (password !== undefined) passwordSource = source;
    }
  };

  if (user === undefined || password === undefined) {
    const backend = keychainBackend({ service: keychainService });
    if (backend !== undefined) {
      let stored;
      try {
        stored = backend.read();
      } catch {
        // A damaged keychain item must not hide a usable file beside it.
        stored = undefined;
      }
      applyStored(stored, backend.name);
    }
  }

  let warning;
  if (user === undefined || password === undefined) {
    applyStored(await readCredentialsFile(credentialsFile), credentialsFile);
    warning = await permissionsWarning(credentialsFile);
  }

  if (user === undefined) {
    throw new Error(
      'The USTC mail account name is not configured. Run bin/setup-credentials.mjs, or set `user` in this '
      + `plugin's config, or export USTC_MAIL_USER, or add a "user" field to ${credentialsFile}.`,
    );
  }
  if (password === undefined) {
    throw new Error(
      `The USTC mail password is not configured. Run bin/setup-credentials.mjs, or export ${passwordEnv}, `
      + `or add a "password" field to ${credentialsFile}. `
      + 'USTC mail requires this password to be the client password from the mailbox settings when two-step verification is on.',
    );
  }

  return {
    host,
    port,
    timeoutMs,
    user,
    password,
    credentialsFile,
    keychainService,
    userSource,
    passwordSource,
    warning,
  };
}
