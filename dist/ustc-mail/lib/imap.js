/**
 * A minimal IMAP4rev1 client built on `node:tls` alone.
 *
 * It implements exactly what reading mailbox metadata needs: connect, LOGIN,
 * SELECT, UID SEARCH, UID FETCH of headers, LOGOUT. Fetching uses `BODY.PEEK`,
 * so listing a mailbox never marks anything read.
 */
import tls from 'node:tls';

import { acquireSessionSlot } from './gate.js';

const CRLF = Buffer.from('\r\n', 'latin1');

/**
 * Largest literal this client will accept from a server. It is well above the
 * 2 MiB body cap, so only a broken or hostile server can reach it.
 */
const MAX_LITERAL_BYTES = 8 * 1024 * 1024;

/** Largest unterminated line this client will buffer before giving up. */
const MAX_LINE_BYTES = 1024 * 1024;

/** A failure that carries a stable machine-readable code. */
export class ImapError extends Error {
  /**
   * @param message - operator-facing description; never contains a password.
   * @param code - stable failure code, one of the `IMAP_*` values used below.
   */
  constructor(message, code) {
    super(message);
    this.name = 'ImapError';
    this.code = code ?? 'IMAP_ERROR';
  }
}

/**
 * Encode one command argument: a quoted string when it is printable ASCII, and
 * a synchronizing literal otherwise. LOGIN must survive non-ASCII passwords.
 * @param value - the argument text.
 * @returns a command token: either inline text or `{ literal }`.
 */
export function imapString(value) {
  const text = String(value ?? '');
  const bytes = Buffer.from(text, 'utf8');
  const printable = bytes.every((byte) => byte >= 0x20 && byte <= 0x7e);
  if (printable) return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return { literal: bytes };
}

/**
 * Convert a mailbox name to IMAP's modified UTF-7, which is what the wire wants
 * for any non-ASCII folder name.
 * @param name - UTF-8 mailbox name.
 * @returns the modified UTF-7 encoding.
 */
export function encodeMailboxName(name) {
  const text = String(name ?? '');
  let out = '';
  let pending = '';
  const flush = () => {
    if (pending.length === 0) return;
    const utf16 = Buffer.from(pending, 'utf16le').swap16();
    out += `&${utf16.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
    pending = '';
  };
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) {
      flush();
      out += char === '&' ? '&-' : char;
      continue;
    }
    pending += char;
  }
  flush();
  return out;
}

/**
 * Read one balanced parenthesized list, tolerating quoted strings, escapes, and
 * `{n}` literals.
 * @param text - the text to scan.
 * @param start - index of the opening parenthesis.
 * @returns the list including its parentheses, or undefined when unbalanced.
 */
export function balancedList(text, start) {
  if (!Number.isInteger(start) || start < 0 || text[start] !== '(') return undefined;
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '\\') index += 1;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '{') {
      const literal = /^\{(\d+)\}/.exec(text.slice(index));
      if (literal !== null) {
        index += literal[0].length + Number.parseInt(literal[1], 10) - 1;
        continue;
      }
    }
    if (char === '"') quoted = true;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/** Split off the `BODY[...]` section of a FETCH response. */
function splitFetchBody(meta) {
  const at = meta.indexOf('BODY[');
  if (at < 0) return { head: meta, section: '' };
  return { head: meta.slice(0, at), section: meta.slice(at) };
}

/**
 * Read the value that follows a `BODY[...]` item: a `{n}` literal when the
 * server used one, otherwise inline text.
 * @param text - response text starting just after the closing bracket.
 * @returns the value and whatever follows it.
 */
function readSectionValue(text) {
  const literal = /^ ?\{(\d+)\}/.exec(text);
  if (literal !== null) {
    const start = literal[0].length;
    const length = Number.parseInt(literal[1], 10);
    return { value: text.slice(start, start + length), rest: text.slice(start + length) };
  }
  const nil = /^ ?NIL(?=[ )]|$)/.exec(text);
  if (nil !== null) return { value: '', rest: text.slice(nil[0].length) };
  const quoted = /^ ?"((?:[^"\\]|\\.)*)"/.exec(text);
  if (quoted !== null) {
    return { value: quoted[1].replace(/\\(.)/g, '$1'), rest: text.slice(quoted[0].length) };
  }
  // No literal: the value runs to the blank line that ends a header block.
  const blank = text.search(/\r\n\r\n|\n\n/);
  const value = blank < 0 ? text : text.slice(0, blank);
  return { value: value.replace(/^ /, '').replace(/\)\s*$/, ''), rest: blank < 0 ? '' : text.slice(blank) };
}

/** Extract the inline header text a `BODY[HEADER...]` item returned. */
function readInlineHeaders(section) {
  const close = section.indexOf(']');
  if (close < 0) return { headers: '', rest: '' };
  const { value, rest } = readSectionValue(section.slice(close + 1));
  return { headers: value, rest };
}

/**
 * Parse one `* n FETCH (...)` line carrying a `BODY[<section>]` value.
 * @param line - one logical response line.
 * @returns the uid, section path, and raw value, or undefined when absent.
 */
export function parseSectionFetchLine(line) {
  const text = String(line ?? '');
  if (!text.startsWith('* ')) return undefined;
  const bodyAt = text.indexOf('BODY[');
  if (bodyAt < 0) return undefined;
  const close = text.indexOf(']', bodyAt);
  if (close < 0) return undefined;
  const uidMatch = /(?:^|[\s(])UID (\d+)/.exec(text.slice(0, bodyAt));
  if (uidMatch === null) return undefined;
  const after = text.slice(close + 1);
  const partial = /^<(\d+)>/.exec(after);
  const { value } = readSectionValue(partial === null ? after : after.slice(partial[0].length));
  return {
    uid: Number.parseInt(uidMatch[1], 10),
    section: text.slice(bodyAt + 'BODY['.length, close),
    offset: partial === null ? 0 : Number.parseInt(partial[1], 10),
    value,
  };
}

/**
 * Parse one `* n FETCH (...)` response line into message metadata. Literals that
 * the reader inlined are accepted as-is.
 * @param line - one logical response line.
 * @returns parsed metadata, or undefined when the line is not a FETCH response.
 */
export function parseFetchLine(line) {
  const text = String(line ?? '');
  if (!text.startsWith('* ')) return undefined;
  const fetchAt = text.indexOf(' FETCH ');
  if (fetchAt < 0) return undefined;
  const sequence = Number.parseInt(text.slice(2, fetchAt), 10);
  const meta = text.slice(fetchAt + 7);
  const { head, section } = splitFetchBody(meta);
  const { headers, rest } = section.length > 0 ? readInlineHeaders(section) : { headers: '', rest: '' };

  const uidMatch = /(?:^|[\s(])UID (\d+)/.exec(head);
  if (uidMatch === null) return undefined;
  const sizeMatch = /RFC822\.SIZE (\d+)/.exec(head);
  const flagsMatch = /FLAGS \(([^)]*)\)/.exec(head);

  let structure = '';
  for (const haystack of [head, rest]) {
    const at = haystack.indexOf('BODYSTRUCTURE');
    if (at < 0) continue;
    const open = haystack.indexOf('(', at);
    const found = balancedList(haystack, open);
    if (found !== undefined) {
      structure = found;
      break;
    }
  }

  return {
    sequence,
    uid: Number.parseInt(uidMatch[1], 10),
    seen: flagsMatch !== null && /\\Seen/i.test(flagsMatch[1]),
    size: sizeMatch === null ? 0 : Number.parseInt(sizeMatch[1], 10),
    structure,
    headerBlock: headers,
  };
}

/** One IMAP session over an already-open socket. */
class ImapSession {
  #socket;
  #timeoutMs;
  #raw = Buffer.alloc(0);
  #line = Buffer.alloc(0);
  #literalRemaining = 0;
  #queue = [];
  #waiters = [];
  #prefetched = [];
  #failure;
  #disposed = false;
  #sequence = 0;
  #signal;
  #onAbort;
  #release;

  /**
   * @param socket - connected socket.
   * @param options - inactivity timeout, the caller's abort signal, and the
   *   concurrency-slot release function.
   */
  constructor(socket, options) {
    this.#socket = socket;
    this.#timeoutMs = options.timeoutMs;
    this.#release = options.release;
    socket.setTimeout(this.#timeoutMs);
    socket.on('data', (chunk) => {
      this.#raw = Buffer.concat([this.#raw, chunk]);
      this.#pump();
    });
    socket.on('timeout', () => {
      this.#fail(new ImapError(`The mail server stopped responding after ${this.#timeoutMs} ms.`, 'IMAP_TIMEOUT'));
    });
    socket.on('error', (error) => {
      this.#fail(new ImapError(`The mail server connection failed: ${error.message}`, 'IMAP_CONNECT_FAILED'));
    });
    socket.on('close', () => {
      // Free the concurrency slot exactly once, when the socket is really gone.
      this.#release?.();
      this.#fail(new ImapError('The mail server closed the connection.', 'IMAP_CLOSED'));
    });
    if (options.signal !== undefined) {
      this.#signal = options.signal;
      this.#onAbort = () => this.#fail(new ImapError('The call was cancelled.', 'IMAP_ABORTED'));
      if (options.signal.aborted) this.#onAbort();
      else options.signal.addEventListener('abort', this.#onAbort, { once: true });
    }
  }

  /** Release the caller's abort signal; the session outlives one tool call. */
  #detachAbort() {
    if (this.#signal !== undefined && this.#onAbort !== undefined) {
      this.#signal.removeEventListener('abort', this.#onAbort);
      this.#onAbort = undefined;
    }
  }

  /** Record a terminal failure and wake every reader. */
  #fail(error) {
    if (this.#failure !== undefined || this.#disposed) return;
    this.#failure = error;
    this.#detachAbort();
    // Prompt release; the socket `close` handler is the backstop. The release
    // function is idempotent, so both paths are safe.
    this.#release?.();
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
    try {
      this.#socket.destroy();
    } catch {
      /* the socket is already gone; the recorded failure is what matters. */
    }
  }

  /** Hand a decoded logical line to the next reader, or queue it. */
  #emit(line) {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter.resolve(line);
    else this.#queue.push(line);
  }

  /**
   * Consume buffered bytes into logical lines. A `{n}` literal announcement is
   * followed by exactly n raw bytes, which are inlined into the same line; this
   * is what makes header text survive intact.
   */
  #pump() {
    for (;;) {
      if (this.#literalRemaining > 0) {
        if (this.#raw.length === 0) return;
        const take = Math.min(this.#literalRemaining, this.#raw.length);
        this.#line = Buffer.concat([this.#line, this.#raw.subarray(0, take)]);
        this.#raw = this.#raw.subarray(take);
        this.#literalRemaining -= take;
        continue;
      }
      const end = this.#raw.indexOf(CRLF);
      if (end < 0) {
        // No line terminator in sight: a broken or hostile server must not be
        // able to grow this buffer without bound.
        if (this.#raw.length > MAX_LINE_BYTES) {
          this.#fail(new ImapError(
            `The mail server sent an unterminated response line over ${MAX_LINE_BYTES} bytes.`,
            'IMAP_PROTOCOL',
          ));
        }
        return;
      }
      this.#line = Buffer.concat([this.#line, this.#raw.subarray(0, end)]);
      this.#raw = this.#raw.subarray(end + 2);
      const text = this.#line.toString('latin1');
      const announcement = /\{(\d+)\}$/.exec(text);
      if (announcement !== null) {
        // Keep the `{n}` marker in the logical line: it is the only reliable way
        // to know where the inlined literal ends, and both the header and the
        // body parsers need that boundary.
        const size = Number.parseInt(announcement[1], 10);
        if (size > MAX_LITERAL_BYTES) {
          this.#fail(new ImapError(
            `The mail server announced a ${size}-byte literal, over the ${MAX_LITERAL_BYTES}-byte limit.`,
            'IMAP_PROTOCOL',
          ));
          return;
        }
        this.#literalRemaining = size;
        continue;
      }
      this.#line = Buffer.alloc(0);
      this.#emit(text);
    }
  }

  /** @returns the next logical line, or rejects with the recorded failure. */
  #next() {
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift());
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  /** Write raw command text; command text is always ASCII. */
  #write(text) {
    if (this.#failure !== undefined) throw this.#failure;
    this.#socket.write(text, 'latin1');
  }

  /** Wait for a `+` continuation, keeping any untagged responses. */
  async #awaitContinuation() {
    for (;;) {
      const line = await this.#next();
      if (line.startsWith('+')) return line;
      this.#prefetched.push(line);
    }
  }

  /**
   * Run one tagged command to completion.
   * @param tokens - command tokens: inline text or `imapString` literals.
   * @returns the completion status and every untagged response line.
   */
  async command(tokens) {
    const tag = `A${String((this.#sequence += 1)).padStart(4, '0')}`;
    const segments = [];
    let pending = tag;
    for (const token of tokens) {
      if (typeof token === 'string') {
        pending += ` ${token}`;
        continue;
      }
      if (token !== null && typeof token === 'object' && token.literal instanceof Uint8Array) {
        // The announcement ends the line: the literal starts on a fresh one.
        pending += ` {${token.literal.length}}\r\n`;
        segments.push(pending, token.literal);
        pending = '';
        continue;
      }
      throw new TypeError('Unsupported IMAP command token.');
    }
    segments.push(`${pending}\r\n`);

    for (const segment of segments) {
      if (typeof segment === 'string') {
        this.#write(segment);
        continue;
      }
      await this.#awaitContinuation();
      this.#write(segment.toString('latin1'));
    }

    const lines = this.#prefetched.splice(0);
    for (;;) {
      const line = await this.#next();
      if (line.startsWith(`${tag} `)) {
        const remainder = line.slice(tag.length + 1);
        return { status: remainder.split(' ')[0].toUpperCase(), text: remainder, lines };
      }
      lines.push(line);
    }
  }

  /** Read and validate the server greeting. */
  async greeting() {
    const line = await this.#next();
    if (line.startsWith('* PREAUTH')) return line;
    if (line.startsWith('* OK')) return line;
    throw new ImapError(`The mail server refused the connection: ${line}`, 'IMAP_GREETING_FAILED');
  }

  /**
   * Authenticate.
   * @param user - account name.
   * @param password - account password.
   */
  async login(user, password) {
    const result = await this.command(['LOGIN', imapString(user), imapString(password)]);
    if (result.status !== 'OK') {
      throw new ImapError(
        `USTC mail rejected the login for ${user}: ${result.text}. Check the password, and that IMAP is enabled for this account in the USTC webmail settings.`,
        'IMAP_AUTH_FAILED',
      );
    }
  }

  /**
   * Open a mailbox read-only.
   *
   * EXAMINE rather than SELECT: the server then rejects any write itself, so the
   * read-only promise does not rest on this client's own restraint.
   * @param mailbox - mailbox name in UTF-8.
   * @returns message count and the UIDVALIDITY value that scopes the UIDs.
   */
  async select(mailbox) {
    const result = await this.command(['EXAMINE', imapString(encodeMailboxName(mailbox))]);
    if (result.status !== 'OK') {
      throw new ImapError(`Cannot open mailbox "${mailbox}": ${result.text}`, 'IMAP_MAILBOX_FAILED');
    }
    let exists = 0;
    let uidValidity;
    for (const line of result.lines) {
      const count = /^\* (\d+) EXISTS$/.exec(line);
      if (count !== null) exists = Number.parseInt(count[1], 10);
      const validity = /\[UIDVALIDITY (\d+)\]/.exec(line);
      if (validity !== null) uidValidity = Number.parseInt(validity[1], 10);
    }
    return { exists, uidValidity };
  }

  /**
   * Search the open mailbox.
   * @param criteria - an IMAP search key string such as `ALL`, or an array of
   *   command tokens when the key needs quoting, literals, or a CHARSET prefix.
   * @returns matching UIDs in ascending order.
   */
  async uidSearch(criteria) {
    const tokens = Array.isArray(criteria) ? criteria : [criteria];
    const result = await this.command(['UID', 'SEARCH', ...tokens]);
    if (result.status !== 'OK') {
      const label = tokens.map((token) => (typeof token === 'string' ? token : '{...}')).join(' ');
      throw new ImapError(
        `The search "${label}" was rejected: ${result.text}`,
        'IMAP_SEARCH_FAILED',
      );
    }
    for (const line of result.lines) {
      if (!line.startsWith('* SEARCH')) continue;
      return line
        .slice('* SEARCH'.length)
        .trim()
        .split(/\s+/)
        .filter((entry) => /^\d+$/.test(entry))
        .map((entry) => Number.parseInt(entry, 10));
    }
    return [];
  }

  /**
   * Fetch headers and structure for specific UIDs.
   * @param uids - UIDs to fetch.
   * @param options - which header fields to ask for, or the whole header.
   * @returns one metadata record per message the server returned.
   */
  async uidFetch(uids, options = {}) {
    if (uids.length === 0) return [];
    const { fullHeader = false, headerFields = ['FROM', 'SUBJECT', 'DATE', 'CONTENT-DISPOSITION'] } = options;
    const headerItem = fullHeader
      ? 'BODY.PEEK[HEADER]'
      : `BODY.PEEK[HEADER.FIELDS (${headerFields.join(' ')})]`;
    const result = await this.command([
      'UID',
      'FETCH',
      uids.join(','),
      `(UID FLAGS RFC822.SIZE BODYSTRUCTURE ${headerItem})`,
    ]);
    if (result.status !== 'OK') {
      throw new ImapError(`Fetching message headers failed: ${result.text}`, 'IMAP_FETCH_FAILED');
    }
    const messages = [];
    for (const line of result.lines) {
      const parsed = parseFetchLine(line);
      if (parsed !== undefined) messages.push(parsed);
    }
    return messages;
  }

  /**
   * Fetch one body section, optionally a byte range of it.
   *
   * `BODY.PEEK` never sets `\Seen`, so reading a message leaves it unread.
   * @param uid - the message UID.
   * @param section - an IMAP section path such as `1` or `2.1`.
   * @param maxBytes - byte cap for a partial fetch; 0 fetches the whole section.
   * @param offset - first byte of the range, for fetching a large part in pieces.
   * @returns the raw section value, or undefined when the server returned none.
   */
  async uidFetchSection(uid, section, maxBytes = 0, offset = 0) {
    const partial = maxBytes > 0 ? `<${offset}.${maxBytes}>` : '';
    const result = await this.command([
      'UID',
      'FETCH',
      String(uid),
      `(UID BODY.PEEK[${section}]${partial})`,
    ]);
    if (result.status !== 'OK') {
      throw new ImapError(`Fetching the message body failed: ${result.text}`, 'IMAP_FETCH_FAILED');
    }
    for (const line of result.lines) {
      const parsed = parseSectionFetchLine(line);
      if (parsed !== undefined) return parsed;
    }
    return undefined;
  }

  /** Send LOGOUT and drop the socket. Idempotent. */
  async close() {
    if (this.#disposed) return;
    try {
      if (this.#failure === undefined) await this.command(['LOGOUT']);
    } catch {
      /* a closed connection needs no farewell. */
    }
    this.#disposed = true;
    this.#detachAbort();
    this.#release?.();
    this.#failure ??= new ImapError('The session is closed.', 'IMAP_CLOSED');
    for (const waiter of this.#waiters.splice(0)) waiter.reject(this.#failure);
    try {
      this.#socket.destroy();
    } catch {
      /* already destroyed. */
    }
  }
}

/**
 * Open a connection and complete the greeting.
 *
 * Certificate verification is forced on after `tlsOptions` is applied, so a
 * caller can supply a private CA but cannot silently disable verification.
 * @param options - endpoint, timeouts, abort signal, and an optional socket factory.
 * @returns a connected session, ready for `login`.
 */
export async function createSession(options) {
  const {
    host,
    port = 993,
    timeoutMs = 20000,
    signal,
    socketFactory,
    tlsOptions,
  } = options;

  // One slot per live session, so a burst of parallel calls cannot open an
  // unbounded number of connections and logins against the account.
  const release = await acquireSessionSlot();

  try {
    const socket = socketFactory !== undefined && socketFactory !== null
      ? socketFactory({ host, port })
      : tls.connect({
        ...(tlsOptions ?? {}),
        host,
        port,
        servername: host,
        rejectUnauthorized: true,
      });
    socket.setNoDelay?.(true);

    await new Promise((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        try {
          socket.destroy();
        } catch {
          /* nothing left to close. */
        }
        reject(new ImapError(`Cannot reach ${host}:${port} — ${error.message}`, 'IMAP_CONNECT_FAILED'));
      };
      const cleanup = () => {
        socket.removeListener('connect', onReady);
        socket.removeListener('secureConnect', onReady);
        socket.removeListener('error', onError);
      };
      socket.once('connect', onReady);
      socket.once('secureConnect', onReady);
      socket.once('error', onError);
      if (signal?.aborted) onError(new ImapError('The call was cancelled.', 'IMAP_ABORTED'));
    });

    const session = new ImapSession(socket, { timeoutMs, signal, release });
    await session.greeting();
    return session;
  } catch (error) {
    release();
    throw error;
  }
}
