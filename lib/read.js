/**
 * Reading one message's text body.
 *
 * Read-only: the mailbox is opened with EXAMINE and the body is fetched with
 * `BODY.PEEK`, so reading a message does not mark it read.
 */
import { normalizeCount, normalizeFolder } from './args.js';
import { parseBodyStructure, findTextPart, listAttachments } from './bodystructure.js';
import { htmlToText } from './html-text.js';
import { createSession, ImapError } from './imap.js';
import { decodeBody, decodeWords, formatAddress, formatDate, normalizeBytes, parseHeaderBlock } from './mime.js';

/** Characters of body text returned when the caller does not choose a cap. */
export const DEFAULT_MAX_CHARS = 20000;

/** Hard ceiling on returned body text. */
export const MAX_CHARS_LIMIT = 200000;

/** Most encoded bytes ever pulled for one body part. */
const MAX_FETCH_BYTES = 2 * 1024 * 1024;

/** Longest quoted header value kept before it is clipped. */
const MAX_HEADER_CHARS = 1000;

/**
 * Validate and default the read arguments.
 * @param args - the raw request.
 * @returns a normalized request, or throws with a caller-facing message.
 */
export function normalizeReadArgs(args) {
  const input = args === undefined || args === null ? {} : args;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Arguments must be an object.');
  }
  if (!Number.isInteger(input.uid) || input.uid < 1) {
    throw new Error('"uid" must be a positive integer, as returned by the list command.');
  }
  return {
    uid: input.uid,
    folder: normalizeFolder(input.folder, 'INBOX'),
    maxChars: normalizeCount(input.maxChars, 'maxChars', 500, MAX_CHARS_LIMIT, DEFAULT_MAX_CHARS),
  };
}

/** Decode one header value and clip it, so a hostile header cannot flood output. */
function headerValue(headers, name) {
  const decoded = decodeWords(normalizeBytes(headers.get(name) ?? '')).replace(/\s+/g, ' ').trim();
  return decoded.length > MAX_HEADER_CHARS ? `${decoded.slice(0, MAX_HEADER_CHARS)}…` : decoded;
}

/**
 * Decode one message's text body from an ALREADY-FETCHED record.
 *
 * Split out from {@link readMessage} so a listing can preview many messages over
 * one connection: the record's BODYSTRUCTURE is what names the text part, so a
 * preview costs one section fetch per message and never a new session.
 * @param session - a session with the mailbox already selected.
 * @param record - a parsed FETCH response carrying `structure`.
 * @param options - `maxChars` for the returned text, `maxBytes` for the fetch.
 * @returns the decoded body and how it was encoded.
 */
export async function extractTextBody(session, record, options = {}) {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const maxBytes = options.maxBytes ?? MAX_FETCH_BYTES;

  const structure = record.structure === '' ? undefined : parseBodyStructure(record.structure);
  const part = structure === undefined ? undefined : findTextPart(structure);
  const section = part?.section ?? (structure === undefined ? 'TEXT' : '');

  let raw = '';
  if (section !== '') {
    const fetched = await session.uidFetchSection(record.uid, section, maxBytes);
    raw = fetched === undefined ? '' : fetched.value;
  }

  let body = decodeBody(raw, part?.encoding ?? '7bit', part?.params.CHARSET ?? 'utf-8');
  if (part?.subtype === 'html') body = htmlToText(body);
  body = body.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  const clipped = body.length > maxChars;
  const incomplete = raw.length >= maxBytes || (part !== undefined && part.size > raw.length);

  return {
    body: clipped ? body.slice(0, maxChars) : body,
    bodyType: part === undefined ? '' : `${part.type}/${part.subtype}`,
    bodyCharset: part?.params.CHARSET ?? '',
    bodyTruncated: clipped || incomplete,
  };
}

/**
 * Read one message's text body and envelope.
 * @param options - endpoint, credentials, the request, and I/O seams.
 * @returns the message envelope, body text, and attachment names.
 */
export async function readMessage(options) {
  const {
    host,
    port,
    timeoutMs,
    user,
    password,
    folder,
    uid,
    maxChars = DEFAULT_MAX_CHARS,
    signal,
    socketFactory,
    tlsOptions,
  } = options;

  const session = await createSession({ host, port, timeoutMs, signal, socketFactory, tlsOptions });
  try {
    await session.login(user, password);
    await session.select(folder);

    const [record] = await session.uidFetch([uid], { fullHeader: true });
    if (record === undefined) {
      throw new ImapError(`No message with uid ${uid} in "${folder}".`, 'IMAP_NOT_FOUND');
    }

    const headers = parseHeaderBlock(normalizeBytes(record.headerBlock));
    const structure = record.structure === '' ? undefined : parseBodyStructure(record.structure);
    const body = await extractTextBody(session, record, { maxChars });

    return {
      mailbox: folder,
      uid: record.uid,
      subject: headerValue(headers, 'subject'),
      from: formatAddress(headerValue(headers, 'from')),
      to: formatAddress(headerValue(headers, 'to')),
      cc: formatAddress(headerValue(headers, 'cc')),
      date: formatDate(headers.get('date') ?? ''),
      messageId: headerValue(headers, 'message-id'),
      unread: !record.seen,
      size: record.size,
      bodyType: body.bodyType,
      bodyCharset: body.bodyCharset,
      bodyTruncated: body.bodyTruncated,
      body: body.body,
      attachments: structure === undefined ? [] : listAttachments(structure),
    };
  } finally {
    await session.close();
  }
}
