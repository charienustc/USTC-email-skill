/**
 * Downloading message attachments to a directory.
 *
 * This is the only operation in the client that writes anything, so it is the
 * only place where a filename chosen by a stranger reaches the filesystem. Every
 * name is therefore rebuilt rather than trusted, and every destination is proven
 * to sit inside the chosen directory before a byte is written.
 *
 * Read-only with respect to the mailbox: the parts are fetched with `BODY.PEEK`
 * over the same read-only session everything else uses.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { normalizeCount, normalizeFolder } from './args.js';
import { listAttachmentParts, parseBodyStructure } from './bodystructure.js';
import { createSession, ImapError } from './imap.js';
import { decodeQuotedPrintable, parseHeaderBlock, readMessageHeaders, normalizeBytes } from './mime.js';

/** Most attachments one call may save. */
export const MAX_ATTACHMENTS_PER_CALL = 10;

/** Largest decoded attachment written, in bytes. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Largest total the one call may write, in bytes. */
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

/** Bytes pulled per FETCH while walking one part. */
const CHUNK_BYTES = 1024 * 1024;

/** Longest filename kept, extension included. */
const MAX_NAME_LENGTH = 120;

/** Directory created under the working directory when none is named. */
export const DEFAULT_OUT_DIR = 'ustc-mail-attachments';

/**
 * Names Windows refuses to create, with or without an extension.
 * A file called `CON` is a device, not a file, on every Windows machine.
 */
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** Characters Windows forbids in a filename, plus the path separators. */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

/**
 * Rebuild a filename supplied by the sender into one that is safe to create.
 *
 * A message can name its attachment anything at all, including `../../.ssh/id_rsa`,
 * `C:\Windows\System32\evil.dll`, `CON`, or a name of pure control characters.
 * None of that is allowed through: only the final path component survives, and
 * every character that carries meaning to a filesystem is replaced.
 * @param raw - the filename the message declared.
 * @param fallback - the name to use when nothing usable remains.
 * @returns a name that is safe to join onto the output directory.
 */
export function safeFileName(raw, fallback = 'attachment') {
  // Only the last component, so neither separator style can climb out of the
  // directory: '../../etc/passwd' and '..\\..\\evil' both reduce to a leaf name.
  const leaf = String(raw ?? '').split(/[/\\]/).pop() ?? '';

  let name = leaf
    .replace(ILLEGAL, '_')
    // Leading dots would hide the file; trailing dots and spaces are silently
    // stripped by Windows, which turns 'evil.txt.' into a different file.
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
    .trim();

  if (name === '') return fallback;

  // A reserved name is still reserved when it carries an extension.
  const stem = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
  if (RESERVED_NAMES.has(stem.toUpperCase())) name = `_${name}`;

  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    name = `${name.slice(0, MAX_NAME_LENGTH - extension.length)}${extension}`;
  }

  const finalStem = name.includes('.') ? name.slice(0, name.indexOf('.')) : name;
  if (finalStem.replace(/[.\s]/g, '') === '') return fallback;
  return name;
}

/**
 * Resolve where one attachment will be written, and prove it stays inside `dir`.
 * @param dir - the output directory.
 * @param name - an already-sanitized filename.
 * @returns the absolute destination path.
 * @throws when the path would escape the directory.
 */
function containedPath(dir, name) {
  const base = path.resolve(dir);
  const target = path.resolve(base, name);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Refusing to write outside ${base}: ${name}`);
  }
  return target;
}

/** @returns whether a path exists. */
async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick a destination that does not overwrite an existing file.
 * @param dir - the output directory.
 * @param name - an already-sanitized filename.
 * @returns the absolute path to write.
 */
async function freePath(dir, name) {
  const first = containedPath(dir, name);
  if (!await exists(first)) return first;

  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let index = 1; index <= 999; index += 1) {
    const candidate = containedPath(dir, `${stem}-${index}${extension}`);
    if (!await exists(candidate)) return candidate;
  }
  throw new Error(`Cannot find a free name for ${name} in ${dir}.`);
}

/**
 * Pull one part in pieces and decode it.
 *
 * The session's literal limit applies per FETCH, so a large part is walked in
 * chunks and joined before decoding — decoding per chunk would corrupt a
 * quoted-printable escape or a base64 group split across the boundary.
 * @param session - a session with the mailbox already selected.
 * @param record - the fetched message record.
 * @param part - the attachment part to fetch.
 * @returns the decoded bytes.
 */
async function fetchPart(session, record, part) {
  const encodedLimit = Math.ceil(MAX_ATTACHMENT_BYTES * 1.4) + 4096;
  const total = Math.min(part.encodedSize > 0 ? part.encodedSize : encodedLimit, encodedLimit);

  const chunks = [];
  let offset = 0;
  while (offset < total) {
    const length = Math.min(CHUNK_BYTES, total - offset);
    const fetched = await session.uidFetchSection(record.uid, part.section, length, offset);
    if (fetched === undefined || fetched.value.length === 0) break;
    // The reader hands back one character per byte, so latin1 restores the bytes.
    chunks.push(Buffer.from(fetched.value, 'latin1'));
    offset += fetched.value.length;
    if (fetched.value.length < length) break;
  }

  const raw = Buffer.concat(chunks);
  const label = String(part.encoding ?? '7bit').toUpperCase();
  if (label === 'BASE64') {
    return Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  }
  if (label === 'QUOTED-PRINTABLE') return decodeQuotedPrintable(raw);
  return raw;
}

/**
 * Validate and default the attach arguments.
 * @param args - the raw request.
 * @returns a normalized request, or throws with a caller-facing message.
 */
export function normalizeAttachArgs(args) {
  const input = args === undefined || args === null ? {} : args;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Arguments must be an object.');
  }
  if (!Number.isInteger(input.uid) || input.uid < 1) {
    throw new Error('"uid" must be a positive integer, as returned by the list command.');
  }
  const name = input.name === undefined ? undefined : String(input.name).trim();
  if (input.name !== undefined && name.length === 0) {
    throw new Error('"name" must be a non-empty string when given.');
  }
  return {
    uid: input.uid,
    folder: normalizeFolder(input.folder, 'INBOX'),
    outDir: input.outDir === undefined ? DEFAULT_OUT_DIR : String(input.outDir),
    name,
    index: input.index === undefined
      ? undefined
      : normalizeCount(input.index, 'index', 1, MAX_ATTACHMENTS_PER_CALL, 1),
  };
}

/**
 * Save a message's attachments into a directory.
 * @param options - endpoint, credentials, the request, and I/O seams.
 * @returns what was written and what was skipped, with a reason for each skip.
 */
export async function downloadAttachments(options) {
  const {
    host,
    port,
    timeoutMs,
    user,
    password,
    folder,
    uid,
    outDir,
    name,
    index,
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
    const parts = structure === undefined ? [] : listAttachmentParts(structure);

    if (parts.length === 0) {
      return {
        mailbox: folder,
        uid,
        subject: readMessageHeaders(record.headerBlock).subject,
        outDir: path.resolve(outDir),
        requested: 0,
        saved: [],
        skipped: [],
      };
    }

    // A named attachment or an index narrows the set; the default is all of them.
    let chosen = parts.map((part, position) => ({ part, position }));
    if (name !== undefined) {
      chosen = chosen.filter(({ part }) => part.filename === name);
    } else if (index !== undefined) {
      chosen = chosen.filter(({ position }) => position + 1 === index);
    }
    if (chosen.length > MAX_ATTACHMENTS_PER_CALL) chosen = chosen.slice(0, MAX_ATTACHMENTS_PER_CALL);

    await mkdir(outDir, { recursive: true });

    const saved = [];
    const skipped = [];
    let written = 0;

    for (const { part, position } of chosen) {
      const label = part.filename === '' ? `attachment ${position + 1}` : part.filename;
      if (part.encodedSize > Math.ceil(MAX_ATTACHMENT_BYTES * 1.4) + 4096) {
        skipped.push({ filename: label, reason: `larger than the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB limit` });
        continue;
      }
      if (written >= MAX_TOTAL_BYTES) {
        skipped.push({ filename: label, reason: 'the per-call total was reached' });
        continue;
      }

      const bytes = await fetchPart(session, record, part);
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        skipped.push({ filename: label, reason: `decoded to more than the ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB limit` });
        continue;
      }
      if (written + bytes.length > MAX_TOTAL_BYTES) {
        skipped.push({ filename: label, reason: 'the per-call total would be exceeded' });
        continue;
      }

      const safe = safeFileName(part.filename, `attachment-${position + 1}`);
      const destination = await freePath(outDir, safe);
      await writeFile(destination, bytes);
      written += bytes.length;
      saved.push({
        filename: path.basename(destination),
        contentType: part.contentType,
        bytes: bytes.length,
        path: destination,
      });
    }

    return {
      mailbox: folder,
      uid,
      subject: readMessageHeaders(record.headerBlock).subject,
      outDir: path.resolve(outDir),
      requested: chosen.length,
      saved,
      skipped,
    };
  } finally {
    await session.close();
  }
}
