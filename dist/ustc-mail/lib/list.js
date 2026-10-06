/**
 * The mailbox listing operation, independent of how it is invoked.
 *
 * It is deliberately read-only: the fetch uses `BODY.PEEK`, and the session
 * never issues STORE, COPY, EXPUNGE, or APPEND.
 */
import { normalizeCount, normalizeFlag, normalizeFolder } from './args.js';
import { createSession } from './imap.js';
import { toMessage } from './message.js';
import { attachPreviews, MAX_PREVIEW_CHARS } from './preview.js';

/** Newest messages returned when the caller does not choose a count. */
export const DEFAULT_LIMIT = 20;

/** Hard ceiling on returned messages, keeping one result bounded. */
export const MAX_LIMIT = 100;

/** Mailbox listed when the caller does not name one. */
export const DEFAULT_FOLDER = 'INBOX';

/**
 * Validate and default the tool arguments.
 * @param args - the raw tool arguments.
 * @returns a normalized request, or throws with a caller-facing message.
 */
export function normalizeListArgs(args) {
  const input = args === undefined || args === null ? {} : args;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Arguments must be an object.');
  }
  return {
    folder: normalizeFolder(input.folder, DEFAULT_FOLDER),
    limit: normalizeCount(input.limit, 'limit', 1, MAX_LIMIT, DEFAULT_LIMIT),
    unreadOnly: normalizeFlag(input.unreadOnly, 'unreadOnly') === true,
    preview: normalizeCount(input.preview, 'preview', 0, MAX_PREVIEW_CHARS, 0),
  };
}

/**
 * List mailbox metadata over IMAP.
 * @param options - endpoint, credentials, request, and I/O seams.
 * @returns the mailbox summary and the newest matching messages.
 */
export async function listMailbox(options) {
  const {
    host,
    port,
    timeoutMs,
    user,
    password,
    folder,
    limit,
    unreadOnly,
    preview = 0,
    signal,
    socketFactory,
    tlsOptions,
  } = options;

  const session = await createSession({ host, port, timeoutMs, signal, socketFactory, tlsOptions });
  try {
    await session.login(user, password);
    const mailbox = await session.select(folder);
    const matched = await session.uidSearch(unreadOnly ? 'UNSEEN' : 'ALL');
    const selected = matched.slice(-limit);
    const fetched = await session.uidFetch(selected);
    // Newest first, so previews are fetched in the order the caller reads them.
    const ordered = fetched.sort((left, right) => right.uid - left.uid);
    await attachPreviews(session, ordered, preview);
    const messages = ordered.map(toMessage);
    return {
      mailbox: folder,
      exists: mailbox.exists,
      matched: matched.length,
      returned: messages.length,
      preview,
      messages,
    };
  } finally {
    await session.close();
  }
}
