#!/usr/bin/env node
/**
 * Store the USTC mailbox credentials, on any platform.
 *
 *   node bin/setup-credentials.mjs            ask, then store
 *   node bin/setup-credentials.mjs --show     report where credentials come from
 *   node bin/setup-credentials.mjs --remove   forget the stored credential
 *   node bin/setup-credentials.mjs --file     store in the file even if a keychain exists
 *   node bin/setup-credentials.mjs --no-check skip the login check after storing
 *
 * The secret is read from the terminal with echo off, so it never reaches the
 * command line, the shell history, or a log. It is written to the platform
 * keychain when there is one, and otherwise to a file only its owner can read.
 *
 * `--user X --secret-stdin` is the unattended form: it reads the secret from one
 * stdin line and needs no terminal at all.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CREDENTIALS_FILE,
  readCredentialsFile,
  resolveCredentials,
  writeCredentialsFile,
} from '../lib/credentials.js';
import { DEFAULT_SERVICE, keychainBackend } from '../lib/keychain.js';

const USAGE = `Usage: node bin/setup-credentials.mjs [options]

Options:
  --user <address>    account name, to skip the first prompt
  --secret-stdin      read the authorization code from one stdin line, so no
                      terminal is needed (requires --user)
  --file              store in the credential file even when a keychain exists
  --keychain <name>   keychain item name (default ${DEFAULT_SERVICE})
  --file-path <path>  credential file to use
  --keep-file         do not delete an older credential file after storing
  --no-check          skip the login check after storing
  --show              report where credentials currently come from, then exit
  --remove            forget the stored credential, then exit
  -h, --help          show this help

Exit codes: 0 success, 1 failure or a failed login check, 2 usage error.`;

/** Thrown for a malformed command line, which exits with code 2. */
class UsageError extends Error {}

/** Read one line with the terminal's normal echo. */
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Read one line with echo suppressed.
 *
 * `readline` decides whether to echo based on the stream it is given, so it is
 * handed a sink and the real prompt is written to stdout instead. This works on
 * Windows, macOS, and Linux without any dependency.
 * @param question - the prompt to print.
 * @returns what the user typed.
 */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY !== true) {
      reject(new Error(
        'This needs an interactive terminal. Run it yourself in a terminal; an agent cannot answer the prompt.',
      ));
      return;
    }
    const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const rl = readline.createInterface({ input: process.stdin, output: sink, terminal: true });
    process.stdout.write(question);
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

/**
 * Reject an account that is visibly wrong, before anything is stored.
 *
 * A masked prompt hides typos, and without this the first sign of one is a
 * failed login somewhere else entirely.
 * @param value - the account the user typed.
 */
function assertAccountLooksValid(value) {
  if (/\s/.test(value)) throw new Error(`账号不能包含空格：'${value}'`);
  if (value.includes('..')) throw new Error(`账号里有连续两个点：'${value}'，请检查域名拼写。`);
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(value)) {
    throw new Error(`账号要是完整邮箱地址，例如 学号@mail.ustc.edu.cn（当前是 '${value}'）。`);
  }
}

/**
 * Parse the command line.
 * @param argv - arguments after the script name.
 * @returns the requested action and options.
 */
function parseArgs(argv) {
  const options = {
    action: 'store',
    file: false,
    keepFile: false,
    check: true,
    service: DEFAULT_SERVICE,
    credentialsFile: DEFAULT_CREDENTIALS_FILE,
    user: undefined,
    secretStdin: false,
  };
  const args = [...argv];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      index += 1;
      if (index >= args.length) throw new UsageError(`${arg} needs a value.`);
      return args[index];
    };
    if (arg === '--user') options.user = next();
    else if (arg === '--secret-stdin') options.secretStdin = true;
    else if (arg === '--file') options.file = true;
    else if (arg === '--keychain') options.service = next();
    else if (arg === '--file-path') options.credentialsFile = next();
    else if (arg === '--keep-file') options.keepFile = true;
    else if (arg === '--no-check') options.check = false;
    else if (arg === '--show') options.action = 'show';
    else if (arg === '--remove') options.action = 'remove';
    else if (arg === '--help' || arg === '-h') options.action = 'help';
    else throw new UsageError(`Unknown argument "${arg}".`);
  }
  return options;
}

/**
 * Check that the stored credentials really work.
 *
 * The value entered is passed to the check through the environment, so the check
 * exercises exactly what was just typed regardless of where it was stored.
 * @param credentials - the account and secret to try.
 * @returns true when the mailbox answered.
 */
function verifyLogin(credentials) {
  const cli = fileURLToPath(new URL('./ustc-mail.mjs', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [cli, 'list', '--limit', '1'],
    {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, USTC_MAIL_USER: credentials.user, USTC_MAIL_PASS: credentials.password },
    },
  );
  if (result.status === 0) return { ok: true };
  const line = String(result.stderr ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.includes('FAILED'));
  return { ok: false, reason: line ?? `the check exited with code ${result.status}` };
}

/** Report where each value currently comes from, without revealing the secret. */
async function show(options) {
  let resolved;
  try {
    resolved = await resolveCredentials({
      keychainService: options.service,
      credentialsFile: options.credentialsFile,
    });
  } catch (error) {
    process.stdout.write(`没有可用的凭据：${error.message}\n`);
    return 0;
  }
  process.stdout.write(`账号    : ${resolved.user}\n`);
  process.stdout.write(`账号来源: ${resolved.userSource}\n`);
  process.stdout.write(`密码来源: ${resolved.passwordSource}\n`);
  process.stdout.write(`密码长度: ${resolved.password.length}（不显示内容）\n`);
  if (resolved.warning !== undefined) process.stdout.write(`警告    : ${resolved.warning}\n`);
  return 0;
}

/** Forget the stored credential in both possible places. */
async function remove(options) {
  const backend = keychainBackend({ service: options.service });
  let removed = false;
  if (backend !== undefined && backend.remove()) {
    process.stdout.write(`已从 ${backend.name} 删除。\n`);
    removed = true;
  }
  const existing = await readCredentialsFile(options.credentialsFile);
  if (existing !== undefined) {
    const { rm } = await import('node:fs/promises');
    await rm(options.credentialsFile, { force: true });
    process.stdout.write(`已删除 ${options.credentialsFile}\n`);
    removed = true;
  }
  if (!removed) process.stdout.write('本来就没有已保存的凭据。\n');
  return 0;
}

/** @returns the first line of stdin, with the line ending removed. */
function readStdinLine() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('error', reject);
    process.stdin.on('end', () => resolve(data.split('\n')[0].replace(/\r$/, '').replace(/^\uFEFF/, '')));
  });
}

/** Ask, validate, store, and check. */
async function store(options) {
  const backend = options.file ? undefined : keychainBackend({ service: options.service });
  const destination = backend !== undefined ? backend.name : options.credentialsFile;

  process.stdout.write(`存放位置: ${destination}\n\n`);

  let account;
  let password;

  if (options.secretStdin) {
    if (options.user === undefined) {
      throw new UsageError('--secret-stdin needs --user, because there is no terminal to ask for the account.');
    }
    account = options.user.trim();
    password = await readStdinLine();
  } else {
    // Checked before any prompt, so an agent calling this gets one clear
    // sentence instead of an empty answer read from a closed stdin.
    if (process.stdin.isTTY !== true) {
      throw new Error(
        '这需要交互终端，而当前 stdin 不是终端。请你自己在终端里运行；'
        + '要无人值守地写入，用 --user <账号> --secret-stdin。',
      );
    }
    account = (options.user ?? await ask('邮箱账号: ')).trim();
    if (account === '') throw new Error('账号不能为空。');
    assertAccountLooksValid(account);
    password = await askHidden('授权码  : ');
  }

  if (account === '') throw new Error('账号不能为空。');
  assertAccountLooksValid(account);
  if (password.trim() === '') throw new Error('授权码不能为空。');

  const credentials = { user: account, password: password.trim() };
  if (backend !== undefined) {
    backend.write(credentials);
    if (!options.keepFile && await readCredentialsFile(options.credentialsFile) !== undefined) {
      const { rm } = await import('node:fs/promises');
      await rm(options.credentialsFile, { force: true });
      process.stdout.write(`\n已删除旧的凭据文件 ${options.credentialsFile}\n`);
    }
  } else {
    await writeCredentialsFile(options.credentialsFile, credentials);
    process.stdout.write(`\n已写入 ${options.credentialsFile}（权限 600）\n`);
  }

  process.stdout.write('授权码未回显，也未写入任何明文位置。\n');

  if (!options.check) return 0;

  process.stdout.write('\n正在验证登录……\n');
  const checked = verifyLogin(credentials);
  if (checked.ok) {
    process.stdout.write('验证通过：已在邮箱里读到邮件。\n');
    return 0;
  }
  process.stdout.write('验证失败 —— 凭据已保存，但登录不成功：\n');
  process.stdout.write(`  ${checked.reason}\n`);
  process.stdout.write('  请核对账号和授权码，然后重新运行本脚本覆盖即可。\n');
  return 1;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n\n${USAGE}\n`);
  process.exit(2);
}

if (options.action === 'help') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

try {
  if (options.action === 'show') process.exit(await show(options));
  if (options.action === 'remove') process.exit(await remove(options));
  process.exit(await store(options));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
