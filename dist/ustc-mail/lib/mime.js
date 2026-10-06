/**
 * Header decoding for mailbox metadata.
 *
 * Everything here is a pure function over strings: this module never touches the
 * network, the filesystem, or the clock. The IMAP layer hands it raw header
 * bytes; it hands back display-ready text.
 */

/** Charset labels seen in the wild, mapped onto the labels TextDecoder accepts. */
const CHARSET_LABELS = new Map([
  ['utf8', 'utf-8'],
  ['utf-8', 'utf-8'],
  ['us-ascii', 'utf-8'],
  ['ascii', 'utf-8'],
  ['gb2312', 'gbk'],
  ['gbk', 'gbk'],
  ['gb18030', 'gbk'],
  ['cp936', 'gbk'],
  ['ms936', 'gbk'],
  ['big5', 'big5'],
  ['big-5', 'big5'],
  ['ks_c_5601-1987', 'euc-kr'],
  ['iso-2022-jp', 'iso-2022-jp'],
]);

/** Charsets decoded byte-for-byte rather than through TextDecoder. */
const BYTE_LABELS = new Map([
  ['iso-8859-1', 'latin1'],
  ['latin1', 'latin1'],
  ['iso8859-1', 'latin1'],
  ['windows-1252', 'latin1'],
  ['cp1252', 'latin1'],
]);

/**
 * Reinterpret a string that was read one byte per character but actually carries
 * UTF-8. Headers that are not encoded words still arrive as raw bytes, and some
 * servers emit them as UTF-8.
 * @param value - byte-per-character string.
 * @returns the UTF-8 reading when the bytes are valid UTF-8, else the input.
 */
export function normalizeBytes(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  /* eslint-disable-next-line no-control-regex -- byte-per-character detection is the point. */
  if (!/[\u0080-\u00ff]/.test(value)) return value;
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  return decoded.includes('\ufffd') ? value : decoded;
}

/**
 * Decode a whole `=?...?=` encoded word.
 * @param data - the encoded payload between the last two question marks.
 * @param encoding - `B` for base64, `Q` for quoted-printable.
 * @returns the payload bytes.
 */
function decodePayload(data, encoding) {
  if (encoding === 'B') return Buffer.from(data, 'base64');
  const out = [];
  for (let index = 0; index < data.length; index += 1) {
    const char = data[index];
    if (char === '_') {
      out.push(0x20);
      continue;
    }
    if (char === '=') {
      const hex = data.slice(index + 1, index + 3);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        out.push(Number.parseInt(hex, 16));
        index += 2;
        continue;
      }
    }
    out.push(char.charCodeAt(0) & 0xff);
  }
  return Buffer.from(out);
}

/**
 * Turn payload bytes into text under the declared charset.
 * @param bytes - payload bytes.
 * @param charset - charset label from the encoded word.
 * @returns decoded text, falling back to UTF-8 then latin1.
 */
export function decodeCharset(bytes, charset) {
  const label = String(charset ?? '').trim().toLowerCase();
  const byteLabel = BYTE_LABELS.get(label);
  if (byteLabel !== undefined) return bytes.toString(byteLabel);
  const target = CHARSET_LABELS.get(label) ?? 'utf-8';
  try {
    return new TextDecoder(target).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/**
 * Decode every RFC 2047 encoded word in a header value. Whitespace that merely
 * separated two adjacent encoded words is dropped, as the RFC requires.
 * @param value - raw header value.
 * @returns decoded text.
 */
export function decodeWords(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  const joined = value.replace(/\?=\s+=\?/g, '?==?');
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset, encoding, data) => {
    try {
      return decodeCharset(decodePayload(data, encoding.toUpperCase()), charset);
    } catch {
      return whole;
    }
  });
}

/**
 * Decode a quoted-printable payload.
 * @param bytes - the raw payload bytes.
 * @returns the decoded bytes.
 */
export function decodeQuotedPrintable(bytes) {
  const out = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte !== 0x3d) {
      out.push(byte);
      continue;
    }
    const next = bytes[index + 1];
    if (next === 0x0d && bytes[index + 2] === 0x0a) {
      index += 2;
      continue;
    }
    if (next === 0x0a) {
      index += 1;
      continue;
    }
    const hex = String.fromCharCode(next ?? 0, bytes[index + 2] ?? 0);
    if (/^[0-9a-f]{2}$/i.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    out.push(byte);
  }
  return Buffer.from(out);
}

/**
 * Decode a message body part by its Content-Transfer-Encoding and charset.
 * @param text - the raw payload, read one byte per character.
 * @param encoding - the transfer-encoding label.
 * @param charset - the charset label.
 * @returns the decoded text.
 */
export function decodeBody(text, encoding, charset) {
  const raw = Buffer.from(String(text ?? ''), 'latin1');
  const label = String(encoding ?? '').trim().toUpperCase();
  let bytes = raw;
  if (label === 'BASE64') {
    bytes = Buffer.from(raw.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  } else if (label === 'QUOTED-PRINTABLE') {
    bytes = decodeQuotedPrintable(raw);
  }
  return decodeCharset(bytes, charset === undefined || charset === '' ? 'utf-8' : charset);
}

/**
 * Split a raw header block into unfolded `name -> value` entries. The last
 * occurrence of a name wins.
 * @param block - raw header block, with lines already byte-normalized.
 * @returns lowercase header name to raw (still encoded) value.
 */
export function parseHeaderBlock(block) {
  const headers = new Map();
  let current;
  for (const line of String(block ?? '').split(/\r\n|\n|\r/)) {
    if (/^[ \t]/.test(line) && current !== undefined) {
      headers.set(current, `${headers.get(current)} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    current = line.slice(0, colon).trim().toLowerCase();
    headers.set(current, line.slice(colon + 1).trim());
  }
  return headers;
}

/**
 * Render a `From`-style header as a single readable line.
 * @param value - raw header value.
 * @returns `Name <address>`, a bare address, or the decoded text unchanged.
 */
export function formatAddress(value) {
  const decoded = decodeWords(normalizeBytes(value)).replace(/\s+/g, ' ').trim();
  const angled = /^(.*?)\s*<([^>]*)>\s*$/.exec(decoded);
  if (angled === null) return decoded;
  const display = angled[1].replace(/^"(.*)"$/, '$1').trim();
  const address = angled[2].trim();
  if (display.length === 0) return address;
  if (address.length === 0) return display;
  return `${display} <${address}>`;
}

/**
 * Normalize a `Date` header to ISO-8601.
 * @param value - raw header value.
 * @returns an ISO timestamp, or the decoded original when it cannot be parsed.
 */
export function formatDate(value) {
  const decoded = decodeWords(normalizeBytes(value)).trim();
  const parsed = Date.parse(decoded);
  if (Number.isNaN(parsed)) return decoded;
  return new Date(parsed).toISOString();
}

/**
 * Project a fetched header block onto the metadata the list tool reports.
 * @param block - raw header block bytes, one byte per character.
 * @returns decoded subject, sender, date, and top-level disposition.
 */
export function readMessageHeaders(block) {
  const headers = parseHeaderBlock(normalizeBytes(block));
  return {
    subject: decodeWords(headers.get('subject') ?? ''),
    from: formatAddress(headers.get('from') ?? ''),
    date: formatDate(headers.get('date') ?? ''),
    contentDisposition: decodeWords(headers.get('content-disposition') ?? ''),
  };
}
