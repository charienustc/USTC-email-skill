/**
 * IMAP BODYSTRUCTURE parsing.
 *
 * `{n}` markers are preserved by the response reader, so an inlined literal can
 * be consumed by exact length instead of by guessing where it ends.
 *
 * Pure functions only: no network, no filesystem.
 */
import { decodeWords, normalizeBytes } from './mime.js';

/** Skip the spaces the server uses between tokens. */
function skipSpaces(state) {
  while (state.index < state.text.length && state.text[state.index] === ' ') state.index += 1;
}

/** Read a parenthesized list. */
function readList(state) {
  state.index += 1;
  const items = [];
  for (;;) {
    skipSpaces(state);
    if (state.index >= state.text.length) break;
    if (state.text[state.index] === ')') {
      state.index += 1;
      break;
    }
    items.push(readValue(state));
  }
  return items;
}

/** Read a quoted string, unescaping `\"` and `\\`. */
function readQuoted(state) {
  state.index += 1;
  let out = '';
  while (state.index < state.text.length) {
    const char = state.text[state.index];
    if (char === '\\') {
      out += state.text[state.index + 1] ?? '';
      state.index += 2;
      continue;
    }
    if (char === '"') {
      state.index += 1;
      break;
    }
    out += char;
    state.index += 1;
  }
  return out;
}

/** Read a literal announced by a `{n}` marker. */
function readLiteral(state) {
  const marker = /^\{(\d+)\}/.exec(state.text.slice(state.index));
  if (marker === null) {
    state.index += 1;
    return '';
  }
  const start = state.index + marker[0].length;
  const length = Number.parseInt(marker[1], 10);
  state.index = start + length;
  return state.text.slice(start, start + length);
}

/** Read an atom: a number, `NIL`, or a bare token. */
function readAtom(state) {
  const start = state.index;
  while (state.index < state.text.length) {
    const char = state.text[state.index];
    if (char === ' ' || char === '(' || char === ')') break;
    state.index += 1;
  }
  const raw = state.text.slice(start, state.index);
  if (/^NIL$/i.test(raw)) return null;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return raw;
}

/** Read one value: a list, a string, a literal, or an atom. */
function readValue(state) {
  skipSpaces(state);
  const char = state.text[state.index];
  if (char === '(') return readList(state);
  if (char === '"') return readQuoted(state);
  if (char === '{') return readLiteral(state);
  return readAtom(state);
}

/** Turn IMAP's flat attribute/value array into an uppercase-keyed object. */
function toParams(node) {
  const params = {};
  if (!Array.isArray(node)) return params;
  for (let index = 0; index + 1 < node.length; index += 2) {
    const key = node[index];
    const value = node[index + 1];
    if (typeof key === 'string' && typeof value === 'string') params[key.toUpperCase()] = value;
  }
  return params;
}

/**
 * Find a Content-Disposition anywhere in a part's trailing extension elements.
 * @param items - the part's extension elements.
 * @returns the disposition type and parameters, when present.
 */
function readDisposition(items) {
  for (const item of items) {
    if (!Array.isArray(item)) continue;
    const first = item[0];
    if (typeof first === 'string' && /^(attachment|inline)$/i.test(first)) {
      return { type: first.toLowerCase(), params: toParams(item[1]) };
    }
  }
  return undefined;
}

/** Interpret one raw list as a body part or a multipart container. */
function interpret(node) {
  if (!Array.isArray(node) || node.length === 0) return undefined;

  // A multipart body starts with its child parts, all lists.
  if (Array.isArray(node[0])) {
    const children = [];
    let index = 0;
    while (index < node.length && Array.isArray(node[index])) {
      const child = interpret(node[index]);
      if (child !== undefined) children.push(child);
      index += 1;
    }
    const subtype = String(node[index] ?? 'mixed').toLowerCase();
    return {
      kind: 'multipart',
      type: 'multipart',
      subtype,
      params: toParams(node[index + 1]),
      children,
      disposition: readDisposition(node.slice(index + 2)),
    };
  }

  const [type, subtype, params, , , encoding, size, ...rest] = node;
  const part = {
    kind: 'part',
    type: String(type ?? '').toLowerCase(),
    subtype: String(subtype ?? '').toLowerCase(),
    params: toParams(params),
    encoding: String(encoding ?? '7bit').toUpperCase(),
    size: typeof size === 'number' ? size : 0,
    disposition: readDisposition(rest),
  };
  if (part.type === 'message') {
    // rest is [envelope, body, lines]; the body is the second list.
    const nested = rest.filter((item) => Array.isArray(item));
    if (nested.length > 1) part.nested = interpret(nested[1]);
  }
  return part;
}

/**
 * Parse an IMAP body structure.
 * @param text - the `(...)` structure as returned by a FETCH response.
 * @returns the parsed tree, or undefined when the text is not a structure.
 */
export function parseBodyStructure(text) {
  const state = { text: String(text ?? ''), index: 0 };
  const value = readValue(state);
  return Array.isArray(value) ? interpret(value) : undefined;
}

/**
 * Walk every leaf part, recording the IMAP section path that addresses it.
 * @param node - the structure node to walk.
 * @param prefix - the section path of the parent.
 * @param out - collector for leaf parts.
 */
function collectLeaves(node, prefix, out) {
  if (node === undefined) return;
  if (node.kind === 'multipart') {
    node.children.forEach((child, index) => {
      collectLeaves(child, prefix === '' ? String(index + 1) : `${prefix}.${index + 1}`, out);
    });
    return;
  }
  const section = prefix === '' ? '1' : prefix;
  out.push({ ...node, section });
  if (node.nested !== undefined) collectLeaves(node.nested, `${section}.1`, out);
}

/**
 * Choose the part to read as the message body: the first non-attachment
 * `text/plain`, else the first non-attachment `text/html`, else the first text
 * part of any kind.
 * @param structure - a parsed body structure.
 * @returns the chosen part including its `section`, or undefined.
 */
export function findTextPart(structure) {
  const leaves = [];
  collectLeaves(structure, '', leaves);
  const texts = leaves.filter((leaf) => leaf.type === 'text' && leaf.disposition?.type !== 'attachment');
  return texts.find((leaf) => leaf.subtype === 'plain')
    ?? texts.find((leaf) => leaf.subtype === 'html')
    ?? texts[0];
}

/**
 * List the parts that are attachments rather than the message body.
 * @param structure - a parsed body structure.
 * @returns filename, content type, and encoded size for each attachment.
 */
export function listAttachments(structure) {
  const leaves = [];
  collectLeaves(structure, '', leaves);
  return leaves
    .filter((leaf) => leaf.disposition?.type === 'attachment'
      || (leaf.disposition?.type !== 'inline' && leaf.type !== 'text' && leaf.type !== 'message'))
    .map((leaf) => ({
      filename: decodeWords(normalizeBytes(leaf.disposition?.params.FILENAME ?? leaf.params.NAME ?? '')),
      contentType: `${leaf.type}/${leaf.subtype}`,
      size: leaf.size,
    }));
}
