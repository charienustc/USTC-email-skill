/**
 * Searching a mailbox.
 *
 * Read-only, like the rest of this client: the mailbox is opened with EXAMINE
 * and the metadata is fetched with `BODY.PEEK`.
 */
import { normalizeCount, normalizeFolder } from './args.js';
import { createSession, imapString } from './imap.js';
import { toMessage } from './message.js';
import { attachPreviews, MAX_PREVIEW_CHARS } from './preview.js';

/** Newest matches returned when the caller does not choose a count. */
export const DEFAULT_LIMIT = 20;

/** Hard ceiling on returned matches, keeping one result bounded. */
export const MAX_LIMIT = 100;

/** Mailbox searched when the caller does not name one. */
export const DEFAULT_FOLDER = 'INBOX';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Convert an ISO calendar date to the `dd-Mmm-yyyy` form IMAP search wants.
 * @param value - a `YYYY-MM-DD` string.
 * @returns the IMAP date, or undefined when the input is not a calendar date.
 */
export function formatImapDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (match === null) return undefined;
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${match[3]}-${MONTHS[month - 1]}-${match[1]}`;
}

/** True when a value needs the `CHARSET UTF-8` search parameter. */
function hasNonAscii(value) {
  return /[^\u0020-\u007e]/.test(value);
}

/**
 * Build the IMAP search key for a normalized request.
 *
 * A non-ASCII term is sent as a literal under `CHARSET UTF-8`, which is what
 * RFC 3501 requires and what a server needs to match Chinese text at all.
 * @param request - a normalized search request.
 * @returns the token array for `UID SEARCH`.
 */
export function buildSearchCommand(request) {
  const tokens = [];
  const terms = [];
  const add = (key, value) => {
    tokens.push(key, imapString(value));
    terms.push(value);
  };

  if (request.subject !== undefined) add('SUBJECT', request.subject);
  if (request.from !== undefined) add('FROM', request.from);
  if (request.to !== undefined) add('TO', request.to);
  if (request.since !== undefined) tokens.push('SINCE', request.since);
  if (request.before !== undefined) tokens.push('BEFORE', request.before);
  if (request.unreadOnly) tokens.push('UNSEEN');
  if (tokens.length === 0) tokens.push('ALL');

  return terms.some(hasNonAscii) ? ['CHARSET', 'UTF-8', ...tokens] : tokens;
}

/**
 * Render the search key as a sentence for the caller.
 * @param request - a normalized search request.
 * @returns a human-readable description of what was searched.
 */
export function describeQuery(request) {
  const parts = [];
  if (request.subject !== undefined) parts.push(`subject contains "${request.subject}"`);
  if (request.from !== undefined) parts.push(`from contains "${request.from}"`);
  if (request.to !== undefined) parts.push(`to contains "${request.to}"`);
  if (request.since !== undefined) parts.push(`received on or after ${request.since}`);
  if (request.before !== undefined) parts.push(`received before ${request.before}`);
  if (request.unreadOnly) parts.push('unread only');
  return parts.join(', ');
}

/**
 * Validate and default the search arguments.
 * @param args - the raw request.
 * @returns a normalized request, or throws with a caller-facing message.
 */
export function normalizeSearchArgs(args) {
  const input = args === undefined || args === null ? {} : args;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Arguments must be an object.');
  }

  const text = (key) => {
    const value = input[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`"${key}" must be a non-empty string.`);
    }
    const trimmed = value.trim();
    if (/[\r\n\u0000]/.test(trimmed)) throw new Error(`"${key}" must not contain line breaks.`);
    return trimmed;
  };

  const date = (key) => {
    const value = input[key];
    if (value === undefined) return undefined;
    const formatted = formatImapDate(value);
    if (formatted === undefined) throw new Error(`"${key}" must be a calendar date like 2026-10-01.`);
    return formatted;
  };

  const subject = text('subject');
  const from = text('from');
  const to = text('to');
  const since = date('since');
  const before = date('before');
  const unreadOnly = input.unreadOnly === true;

  if (subject === undefined && from === undefined && to === undefined
    && since === undefined && before === undefined && !unreadOnly) {
    throw new Error('Give at least one of "subject", "from", "to", "since", "before", or "unreadOnly".');
  }

  return {
    folder: normalizeFolder(input.folder, DEFAULT_FOLDER),
    limit: normalizeCount(input.limit, 'limit', 1, MAX_LIMIT, DEFAULT_LIMIT),
    preview: normalizeCount(input.preview, 'preview', 0, MAX_PREVIEW_CHARS, 0),
    subject,
    from,
    to,
    since,
    before,
    unreadOnly,
  };
}

/**
 * Search a mailbox over IMAP.
 * @param options - endpoint, credentials, I/O seams, and a request already
 *   normalized by {@link normalizeSearchArgs} (dates converted to IMAP form).
 * @returns the mailbox summary and the newest matches.
 */
export async function searchMailbox(options) {
  const {
    host,
    port,
    timeoutMs,
    user,
    password,
    folder,
    limit,
    signal,
    socketFactory,
    tlsOptions,
  } = options;

  const session = await createSession({ host, port, timeoutMs, signal, socketFactory, tlsOptions });
  try {
    await session.login(user, password);
    const mailbox = await session.select(folder);
    const matched = await session.uidSearch(buildSearchCommand(options));
    const selected = matched.slice(-limit);
    const fetched = await session.uidFetch(selected);
    // Newest first, so previews are fetched in the order the caller reads them.
    const ordered = fetched.sort((left, right) => right.uid - left.uid);
    await attachPreviews(session, ordered, options.preview ?? 0);
    const messages = ordered.map(toMessage);
    return {
      mailbox: folder,
      query: describeQuery(options),
      exists: mailbox.exists,
      matched: matched.length,
      returned: messages.length,
      preview: options.preview ?? 0,
      messages,
    };
  } finally {
    await session.close();
  }
}
