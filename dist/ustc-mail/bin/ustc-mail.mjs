#!/usr/bin/env node
/**
 * USTC mailbox CLI — the command the `ustc-mail` skill drives.
 *
 * Read-only: it lists mailbox metadata, searches, and reads message text over
 * IMAP, and never downloads attachments, changes a flag, or sends anything.
 *
 *   node bin/ustc-mail.mjs list --limit 20
 *   node bin/ustc-mail.mjs search --subject 开题 --since 2026-10-01
 *   node bin/ustc-mail.mjs read 100002
 *   node bin/ustc-mail.mjs search --from gitlab --unread --json
 *
 * Credentials come from the environment or the local credential file; the
 * password is never printed.
 */
import process from 'node:process';

import { resolveCredentials } from '../lib/credentials.js';
import { renderMailboxList, renderMessage, renderSearchResult } from '../lib/format.js';
import { listMailbox, normalizeListArgs } from '../lib/list.js';
import { normalizeReadArgs, readMessage } from '../lib/read.js';
import { normalizeSearchArgs, searchMailbox } from '../lib/search.js';

const USAGE = `Usage: node bin/ustc-mail.mjs <command> [options]

Commands:
  list                       list mailbox metadata (default)
  search                     find messages by subject, sender, recipient, or date
  read <uid>                 read one message's text body and envelope

Options:
  --folder <name>            mailbox to use (default INBOX)
  --limit <n>                list/search: newest n results, 1-100 (default 20)
  --preview <n>              list/search: also show the first n characters of each
                             text body, 0-600 (default 0). One connection, one
                             section fetch per message: use it to triage a digest
                             without reading every message separately.
  --unread                   list/search: only unread messages
  --subject <text>           search: substring of the subject
  --from <text>              search: substring of the sender
  --to <text>                search: substring of a recipient
  --since <YYYY-MM-DD>       search: received on or after this date
  --before <YYYY-MM-DD>      search: received before this date
  --max-chars <n>            read: body characters to return, 500-200000 (default 20000)
  --json                     print the raw structured result after the summary
  --user <address>           account name (default $USTC_MAIL_USER)
  --host <host>              server (default mail.ustc.edu.cn)
  --port <port>              IMAP over TLS port (default 993)
  --credentials-file <path>  JSON file with "user" and "password"
  --password-env <name>      environment variable holding the password
  -h, --help                 show this help

search needs at least one of --subject, --from, --to, --since, --before, --unread.

Exit codes: 0 success, 1 mail or credential failure, 2 usage error.`;

const COMMANDS = new Set(['list', 'search', 'read']);

/** Thrown for a malformed command line, which exits with code 2. */
class UsageError extends Error {}

/**
 * @param argv - arguments after the script name.
 * @returns the selected command and its options.
 */
function parseArgs(argv) {
  const options = {
    command: 'list',
    folder: 'INBOX',
    limit: 20,
    preview: 0,
    unreadOnly: false,
    maxChars: undefined,
    uid: undefined,
    json: false,
    config: {},
    search: {},
  };
  const args = [...argv];

  if (args.length > 0 && !args[0].startsWith('-')) {
    const command = args.shift();
    if (!COMMANDS.has(command)) throw new UsageError(`Unknown command "${command}".`);
    options.command = command;
  }

  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      index += 1;
      if (index >= args.length) throw new UsageError(`${arg} needs a value.`);
      return args[index];
    };
    const integer = () => {
      const raw = next();
      if (!/^\d+$/.test(raw)) throw new UsageError(`${arg} needs an integer, got "${raw}".`);
      return Number.parseInt(raw, 10);
    };
    if (arg === '--folder') options.folder = next();
    else if (arg === '--limit') options.limit = integer();
    else if (arg === '--preview') options.preview = integer();
    else if (arg === '--max-chars') options.maxChars = integer();
    else if (arg === '--subject') options.search.subject = next();
    else if (arg === '--from') options.search.from = next();
    else if (arg === '--to') options.search.to = next();
    else if (arg === '--since') options.search.since = next();
    else if (arg === '--before') options.search.before = next();
    else if (arg === '--unread') options.unreadOnly = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--user') options.config.user = next();
    else if (arg === '--host') options.config.host = next();
    else if (arg === '--port') options.config.port = integer();
    else if (arg === '--credentials-file') options.config.credentialsFile = next();
    else if (arg === '--password-env') options.config.passwordEnv = next();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new UsageError(`Unknown argument "${arg}".`);
    else positional.push(arg);
  }

  if (options.command === 'read') {
    if (positional.length === 0) throw new UsageError('read needs a uid: read <uid>.');
    if (positional.length > 1) throw new UsageError(`read takes one uid, got ${positional.length}.`);
    if (!/^\d+$/.test(positional[0])) throw new UsageError(`read needs a numeric uid, got "${positional[0]}".`);
    options.uid = Number.parseInt(positional[0], 10);
  } else if (positional.length > 0) {
    throw new UsageError(`Unexpected argument "${positional[0]}".`);
  }

  return options;
}

/** Build the validated request for the selected command. */
function buildRequest(options) {
  if (options.command === 'read') {
    return normalizeReadArgs({ uid: options.uid, folder: options.folder, maxChars: options.maxChars });
  }
  if (options.command === 'search') {
    return normalizeSearchArgs({
      ...options.search,
      folder: options.folder,
      limit: options.limit,
      preview: options.preview,
      unreadOnly: options.unreadOnly,
    });
  }
  return normalizeListArgs({
    folder: options.folder,
    limit: options.limit,
    preview: options.preview,
    unreadOnly: options.unreadOnly,
  });
}

let options;
let request;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help !== true) request = buildRequest(options);
} catch (error) {
  process.stderr.write(`${error.message}\n\n${USAGE}\n`);
  process.exit(2);
}

if (options.help === true) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

try {
  const credentials = await resolveCredentials(options.config);
  process.stdout.write(
    `Connecting to ${credentials.host}:${credentials.port} as ${credentials.user} `
    + `(account from ${credentials.userSource}, password from ${credentials.passwordSource})\n\n`,
  );
  const connection = {
    host: credentials.host,
    port: credentials.port,
    timeoutMs: credentials.timeoutMs,
    user: credentials.user,
    password: credentials.password,
  };

  let value;
  let text;
  if (options.command === 'read') {
    value = await readMessage({ ...connection, ...request });
    text = renderMessage(value);
  } else if (options.command === 'search') {
    value = await searchMailbox({ ...connection, ...request });
    text = renderSearchResult(value);
  } else {
    value = await listMailbox({ ...connection, ...request });
    text = renderMailboxList(value);
  }

  process.stdout.write(`${text}\n`);
  if (options.json) process.stdout.write(`\n${JSON.stringify(value, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`\nFAILED [${error.code ?? 'ERROR'}] ${error.message}\n`);
  process.exit(1);
}
