/**
 * Offline self-test: pure-function units plus an end-to-end listing against the
 * fake IMAP server. No network, no account, no credentials.
 *
 * Run: node test/self-test.mjs
 */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { apply, inject } from '../index.js';
import { findTextPart, listAttachments, parseBodyStructure } from '../lib/bodystructure.js';
import { renderMailboxList, renderMessage, renderMessages, renderSearchResult, renderAttachmentSave, formatDateTime, formatSize } from '../lib/format.js';
import {
  MAX_CONCURRENT_SESSIONS,
  acquireSessionSlot,
  activeSessionCount,
  peakSessionCount,
  resetGateStats,
} from '../lib/gate.js';
import { decodeEntities, htmlToText } from '../lib/html-text.js';
import {
  balancedList,
  encodeMailboxName,
  imapString,
  parseFetchLine,
  parseSectionFetchLine,
} from '../lib/imap.js';
import { listMailbox, normalizeListArgs } from '../lib/list.js';
import {
  decodeBody,
  decodeQuotedPrintable,
  decodeWords,
  formatAddress,
  normalizeBytes,
  parseHeaderBlock,
} from '../lib/mime.js';
import { normalizeReadArgs, normalizeReadManyArgs, readMessage, readMessages, MULTI_DEFAULT_MAX_CHARS } from '../lib/read.js';
import { downloadAttachments, normalizeAttachArgs, safeFileName } from '../lib/attach.js';
import { attachPreviews, MAX_PREVIEW_CHARS } from '../lib/preview.js';
import {
  buildSearchCommand,
  describeQuery,
  formatImapDate,
  normalizeSearchArgs,
  searchMailbox,
} from '../lib/search.js';
import {
  LIST_TOOL_NAME,
  READ_TOOL_NAME,
  READ_MANY_TOOL_NAME,
  SEARCH_TOOL_NAME,
  TOOLS,
} from '../lib/tool-schema.js';
import { startFakeServer } from './fake-server.mjs';

let passed = 0;
const failures = [];

/**
 * @param label - the assertion name.
 * @param body - the assertion; a throw counts as a failure.
 */
function check(label, body) {
  try {
    body();
    passed += 1;
  } catch (error) {
    failures.push({ label, error });
  }
}

/**
 * @param label - the assertion name.
 * @param body - an async assertion.
 */
async function checkAsync(label, body) {
  try {
    await body();
    passed += 1;
  } catch (error) {
    failures.push({ label, error });
  }
}

const utf8Word = (text) => `=?utf-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
/** GBK bytes for 测试邮件, spelled out because Node cannot encode GBK. */
const GBK_SAMPLE = Buffer.from('b2e2cad4d3cabcfe', 'hex');

const HEADER_END = '\r\n\r\n';
const makeHeaders = (lines) => `${lines.join('\r\n')}${HEADER_END}`;

const FIXTURES = [
  {
    uid: 101,
    seen: false,
    size: 40960,
    structure: '("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" 1024 NIL '
      + '("ATTACHMENT" ("FILENAME" "report.pdf")) NIL NIL)',
    headers: makeHeaders([
      `From: ${utf8Word('张老师')} <zhang@ustc.edu.cn>`,
      `Subject: ${utf8Word('关于开题报告')}`,
      'Date: Tue, 6 Oct 2026 09:15:00 +0800',
      'Content-Type: application/pdf',
    ]),
  },
  {
    uid: 102,
    seen: true,
    size: 2048,
    structure: '("TEXT" "PLAIN" ("CHARSET" "GBK") NIL NIL "7BIT" 12 1 NIL NIL NIL NIL)',
    headers: makeHeaders([
      'From: Library <lib@ustc.edu.cn>',
      `Subject: =?gb2312?B?${GBK_SAMPLE.toString('base64')}?=`,
      'Date: Mon, 5 Oct 2026 22:03:00 +0800',
      'Content-Type: text/plain; charset="GBK"',
    ]),
  },
  {
    uid: 103,
    seen: false,
    size: 900,
    structure: '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 4 1 NIL NIL NIL NIL)',
    headers: makeHeaders([
      `From: =?utf-8?Q?=E7=8E=8B_=E5=90=8C=E5=AD=A6?= <wang@ustc.edu.cn>`,
      'Subject: plain ascii subject',
      'Date: not a date',
    ]),
  },
];

// ---------------------------------------------------------------- pure units

check('decodeWords: base64 utf-8', () => {
  assert.equal(decodeWords(utf8Word('关于开题报告')), '关于开题报告');
});

check('decodeWords: adjacent words drop separating whitespace', () => {
  assert.equal(decodeWords('=?utf-8?B?5byg?= =?utf-8?B?6ICB5biI?='), '张老师');
});

check('decodeWords: Q encoding with underscore and hex', () => {
  assert.equal(decodeWords('=?utf-8?Q?=E7=8E=8B_=E5=90=8C=E5=AD=A6?='), '王 同学');
});

check('decodeWords: GBK payload', () => {
  assert.equal(decodeWords(`=?gb2312?B?${GBK_SAMPLE.toString('base64')}?=`), '测试邮件');
});

check('decodeWords: unprefixed text passes through', () => {
  assert.equal(decodeWords('Look, no encoded words'), 'Look, no encoded words');
});

check('normalizeBytes: raw UTF-8 read as latin1 is repaired', () => {
  const mangled = Buffer.from('中文标题', 'utf8').toString('latin1');
  assert.equal(normalizeBytes(mangled), '中文标题');
});

check('normalizeBytes: genuine latin1 text is left alone', () => {
  assert.equal(normalizeBytes('caf\u00e9'), 'caf\u00e9');
});

check('parseHeaderBlock: folds continuation lines and lowercases names', () => {
  const headers = parseHeaderBlock('Subject: one\r\n two\r\nX-Y: 3\r\n');
  assert.equal(headers.get('subject'), 'one two');
  assert.equal(headers.get('x-y'), '3');
});

check('formatAddress: quoted display name loses its quotes', () => {
  assert.equal(formatAddress('"Zhang, Wei" <z@ustc.edu.cn>'), 'Zhang, Wei <z@ustc.edu.cn>');
});

check('formatAddress: bare address stays bare', () => {
  assert.equal(formatAddress('<z@ustc.edu.cn>'), 'z@ustc.edu.cn');
});

check('imapString: ASCII quotes, specials escape', () => {
  assert.equal(imapString('secret'), '"secret"');
  assert.equal(imapString('he"llo\\'), '"he\\"llo\\\\"');
});

check('imapString: non-ASCII becomes a literal', () => {
  const token = imapString('pw-测试');
  assert.ok(token !== null && typeof token === 'object');
  assert.equal(Buffer.from(token.literal).toString('utf8'), 'pw-测试');
});

check('encodeMailboxName: ASCII passes through, & escapes', () => {
  assert.equal(encodeMailboxName('INBOX'), 'INBOX');
  assert.equal(encodeMailboxName('A&B'), 'A&-B');
});

check('encodeMailboxName: CJK uses modified UTF-7', () => {
  assert.equal(encodeMailboxName('已发送'), '&XfJT0ZAB-');
});

check('balancedList: nested and quoted parentheses', () => {
  assert.equal(balancedList('x(a(b)c)y', 1), '(a(b)c)');
  assert.equal(balancedList('("a)b")', 0), '("a)b")');
  assert.equal(balancedList('oops', 0), undefined);
});

check('parseFetchLine: reads uid, flags, size, structure, headers', () => {
  const line = '* 1 FETCH (UID 101 FLAGS (\\Seen) RFC822.SIZE 100 '
    + 'BODYSTRUCTURE ("TEXT" "PLAIN" NIL NIL NIL "7BIT" 5 1 NIL NIL NIL NIL) '
    + 'BODY[HEADER.FIELDS (FROM)] From: a@b.c\r\n\r\n)';
  const parsed = parseFetchLine(line);
  assert.equal(parsed.uid, 101);
  assert.equal(parsed.seen, true);
  assert.equal(parsed.size, 100);
  assert.ok(parsed.structure.startsWith('("TEXT"'));
  assert.equal(parsed.headerBlock, 'From: a@b.c');
});

check('parseFetchLine: ignores non-fetch lines', () => {
  assert.equal(parseFetchLine('* OK [UIDVALIDITY 7] UIDs valid'), undefined);
  assert.equal(parseFetchLine('A0001 OK done'), undefined);
});

check('normalizeListArgs: defaults', () => {
  assert.deepEqual(normalizeListArgs(undefined), {
    folder: 'INBOX', limit: 20, unreadOnly: false, preview: 0,
  });
  assert.deepEqual(normalizeListArgs({}), {
    folder: 'INBOX', limit: 20, unreadOnly: false, preview: 0,
  });
});

check('normalizeListArgs: rejects out-of-range and mistyped values', () => {
  assert.throws(() => normalizeListArgs({ limit: 0 }));
  assert.throws(() => normalizeListArgs({ limit: 101 }));
  assert.throws(() => normalizeListArgs({ limit: 2.5 }));
  assert.throws(() => normalizeListArgs({ folder: '  ' }));
  assert.throws(() => normalizeListArgs({ unreadOnly: 'yes' }));
});

check('formatSize and formatDateTime', () => {
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(40960), '40.0 KB');
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB');
  assert.match(formatDateTime('2026-10-06T01:15:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatDateTime('not a date'), 'not a date');
  assert.equal(formatDateTime(''), 'unknown date');
});

// ---------------------------------------------------------- plugin entry

/** Capture the definitions the plugin registers, without the harness. */
function registeredTools(config) {
  const registered = [];
  const ctx = { tools: { register: (definition) => { registered.push(definition); return () => {}; } } };
  apply(ctx, config);
  assert.equal(registered.length, TOOLS.length);
  return registered;
}

/** @returns the registered definition for one tool name. */
function registeredTool(config, name) {
  const found = registeredTools(config).find((tool) => tool.name === name);
  assert.ok(found !== undefined, `no tool named ${name}`);
  return found;
}

check('plugin: registers exactly the documented tools', () => {
  const names = registeredTools({}).map((tool) => tool.name);
  assert.deepEqual(names, [LIST_TOOL_NAME, SEARCH_TOOL_NAME, READ_TOOL_NAME, READ_MANY_TOOL_NAME]);
  // Every tool carries a real description and an object-rooted output schema.
  for (const tool of registeredTools({})) {
    assert.ok(tool.description.length > 40);
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.isConcurrencySafe(), true);
  }
});

check('plugin: nothing in the tool set writes', () => {
  // Downloading attachments writes files, so it is deliberately CLI-only. If a
  // tool ever appears that can write, this is the assertion that must change
  // consciously rather than by accident.
  assert.equal(TOOLS.length, 4);
  assert.deepEqual(TOOLS.map((tool) => tool.operation), ['list', 'search', 'read', 'readMany']);
  for (const tool of TOOLS) {
    assert.equal(/attach|download|save|write/i.test(tool.name), false, `${tool.name} looks like a writer`);
  }
});

check('plugin: declares only the tools dependency and tolerates any config', () => {
  assert.deepEqual(inject, ['tools']);
  assert.equal(registeredTools(undefined).length, TOOLS.length);
  assert.equal(registeredTools('nonsense').length, TOOLS.length);
});

check('plugin: each tool exposes exactly the documented arguments', () => {
  assert.deepEqual(
    Object.keys(registeredTool({}, LIST_TOOL_NAME).parameters.properties).sort(),
    ['folder', 'limit', 'preview', 'unreadOnly'],
  );
  assert.deepEqual(
    Object.keys(registeredTool({}, SEARCH_TOOL_NAME).parameters.properties).sort(),
    ['before', 'folder', 'from', 'limit', 'preview', 'since', 'subject', 'to', 'unreadOnly'],
  );
  assert.deepEqual(
    Object.keys(registeredTool({}, READ_TOOL_NAME).parameters.properties).sort(),
    ['folder', 'maxChars', 'uid'],
  );
  assert.deepEqual(registeredTool({}, READ_TOOL_NAME).parameters.required, ['uid']);
  assert.deepEqual(
    Object.keys(registeredTool({}, READ_MANY_TOOL_NAME).parameters.properties).sort(),
    ['folder', 'maxChars', 'uids'],
  );
  assert.deepEqual(registeredTool({}, READ_MANY_TOOL_NAME).parameters.required, ['uids']);
});

check('plugin: output schemas required exactly what a result carries', () => {
  // A drift between a schema and the operation's real shape fails at call time,
  // so pin the two together here.
  const listKeys = Object.keys({
    mailbox: 1, exists: 1, matched: 1, returned: 1, messages: 1,
  }).sort();
  assert.deepEqual([...registeredTool({}, LIST_TOOL_NAME).output.schema.required].sort(), listKeys);

  const searchKeys = Object.keys({
    mailbox: 1, query: 1, exists: 1, matched: 1, returned: 1, messages: 1,
  }).sort();
  assert.deepEqual([...registeredTool({}, SEARCH_TOOL_NAME).output.schema.required].sort(), searchKeys);

  const readKeys = Object.keys({
    mailbox: 1, uid: 1, subject: 1, from: 1, to: 1, cc: 1, date: 1, messageId: 1,
    unread: 1, size: 1, bodyType: 1, bodyCharset: 1, bodyTruncated: 1, body: 1, attachments: 1,
  }).sort();
  assert.deepEqual([...registeredTool({}, READ_TOOL_NAME).output.schema.required].sort(), readKeys);
});

check('plugin: each render turns its own result into one text block', () => {
  const message = {
    uid: 7,
    subject: 'hello',
    from: 'a@b.c',
    date: '2026-10-06T01:15:00.000Z',
    unread: true,
    size: 2048,
    hasAttachments: false,
  };
  const listBlocks = registeredTool({}, LIST_TOOL_NAME).output.render({}, {
    mailbox: 'INBOX', exists: 1, matched: 1, returned: 1, messages: [message],
  });
  assert.equal(listBlocks.length, 1);
  assert.equal(listBlocks[0].type, 'text');
  assert.match(listBlocks[0].text, /uid=7/);
  assert.match(listBlocks[0].text, /hello/);

  const searchBlocks = registeredTool({}, SEARCH_TOOL_NAME).output.render({}, {
    mailbox: 'INBOX', query: 'subject contains "hello"', exists: 1, matched: 1, returned: 1, messages: [message],
  });
  assert.match(searchBlocks[0].text, /^Search: subject contains "hello"/);

  const readBlocks = registeredTool({}, READ_TOOL_NAME).output.render({}, {
    mailbox: 'INBOX',
    uid: 7,
    subject: 'hello',
    from: 'a@b.c',
    to: 'me@mail.ustc.edu.cn',
    cc: '',
    date: '2026-10-06T01:15:00.000Z',
    messageId: '<m@a.b>',
    unread: true,
    size: 2048,
    bodyType: 'text/plain',
    bodyCharset: 'UTF-8',
    bodyTruncated: false,
    body: 'body text',
    attachments: [],
  });
  assert.match(readBlocks[0].text, /--- body \(text\/plain\) ---/);
  assert.match(readBlocks[0].text, /Attachments: none/);
});

await checkAsync('plugin: every tool explains what to configure when credentials are absent', async () => {
  process.env.USTC_MAIL_USER = '';
  process.env.DSH_TEST_ABSENT_PASSWORD = '';
  // Every store must be pointed somewhere empty, or a real credential on this
  // machine would answer instead and the assertion would test the wrong thing.
  const config = {
    user: '',
    passwordEnv: 'DSH_TEST_ABSENT_PASSWORD',
    credentialsFile: path.join(os.tmpdir(), 'dsh-ustc-mail-does-not-exist.json'),
    dpapiFile: path.join(os.tmpdir(), 'dsh-ustc-mail-does-not-exist.dpapi'),
    credentialTarget: 'USTC-Mail-Test-Absent-Definitely',
  };
  const signal = new AbortController().signal;
  await assert.rejects(
    () => registeredTool(config, LIST_TOOL_NAME).execute({}, { signal }),
    /account name is not configured/,
  );
  await assert.rejects(
    () => registeredTool(config, SEARCH_TOOL_NAME).execute({ unreadOnly: true }, { signal }),
    /account name is not configured/,
  );
  await assert.rejects(
    () => registeredTool(config, READ_TOOL_NAME).execute({ uid: 1 }, { signal }),
    /account name is not configured/,
  );
});

await checkAsync('plugin: a tool rejects bad arguments before touching the network', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(
    () => registeredTool({}, SEARCH_TOOL_NAME).execute({}, { signal }),
    /at least one/,
  );
  await assert.rejects(
    () => registeredTool({}, READ_TOOL_NAME).execute({}, { signal }),
    /"uid" must be a positive integer/,
  );
  await assert.rejects(
    () => registeredTool({}, LIST_TOOL_NAME).execute({ limit: 0 }, { signal }),
    /"limit" must be an integer/,
  );
});

// -------------------------------------------------------- end-to-end listing

const PASSWORD = 'pw-测试';
const USER = 'me@mail.ustc.edu.cn';
const server = await startFakeServer({ user: USER, password: PASSWORD, messages: FIXTURES });
const socketFactory = ({ host, port }) => net.connect(port, host);
const base = {
  host: '127.0.0.1',
  port: server.port,
  timeoutMs: 5000,
  user: USER,
  password: PASSWORD,
  socketFactory,
};

await checkAsync('listMailbox: returns newest first with decoded metadata', async () => {
  const result = await listMailbox({ ...base, folder: 'INBOX', limit: 20, unreadOnly: false });
  assert.equal(result.mailbox, 'INBOX');
  assert.equal(result.exists, 3);
  assert.equal(result.matched, 3);
  assert.equal(result.returned, 3);
  assert.deepEqual(result.messages.map((message) => message.uid), [103, 102, 101]);

  const [newest, gbk, attachment] = result.messages;
  assert.equal(newest.subject, 'plain ascii subject');
  assert.equal(newest.from, '王 同学 <wang@ustc.edu.cn>');
  assert.equal(newest.unread, true);
  assert.equal(newest.date, 'not a date');
  assert.equal(newest.hasAttachments, false);

  assert.equal(gbk.subject, '测试邮件');
  assert.equal(gbk.unread, false);
  assert.equal(gbk.date, '2026-10-05T14:03:00.000Z');

  assert.equal(attachment.subject, '关于开题报告');
  assert.equal(attachment.from, '张老师 <zhang@ustc.edu.cn>');
  assert.equal(attachment.unread, true);
  assert.equal(attachment.size, 40960);
  assert.equal(attachment.hasAttachments, true);
  assert.equal(attachment.date, '2026-10-06T01:15:00.000Z');

  const text = renderMailboxList(result);
  assert.match(text, /INBOX: 3 message\(s\)/);
  assert.match(text, /1\. \[unread\] /);
  assert.match(text, /关于开题报告/);
  assert.match(text, /uid=101/);
});

await checkAsync('listMailbox: limit keeps only the newest matches', async () => {
  const result = await listMailbox({ ...base, folder: 'INBOX', limit: 2, unreadOnly: false });
  assert.equal(result.matched, 3);
  assert.equal(result.returned, 2);
  assert.deepEqual(result.messages.map((message) => message.uid), [103, 102]);
});

await checkAsync('listMailbox: unreadOnly filters the search', async () => {
  const result = await listMailbox({ ...base, folder: 'INBOX', limit: 20, unreadOnly: true });
  assert.equal(result.matched, 2);
  assert.deepEqual(result.messages.map((message) => message.uid), [103, 101]);
});

await checkAsync('listMailbox: empty mailbox renders without message lines', async () => {
  const empty = await startFakeServer({ user: USER, password: PASSWORD, messages: [] });
  try {
    const result = await listMailbox({ ...base, port: empty.port, folder: 'INBOX', limit: 20, unreadOnly: false });
    assert.equal(result.exists, 0);
    assert.equal(result.returned, 0);
    assert.match(renderMailboxList(result), /No messages matched\./);
  } finally {
    await empty.close();
  }
});

await checkAsync('listMailbox: a rejected login reports IMAP_AUTH_FAILED', async () => {
  await assert.rejects(
    () => listMailbox({ ...base, password: 'wrong-password', folder: 'INBOX', limit: 5, unreadOnly: false }),
    (error) => error.code === 'IMAP_AUTH_FAILED' && /rejected the login/.test(error.message),
  );
});

await checkAsync('listMailbox: an unreachable endpoint reports IMAP_CONNECT_FAILED', async () => {
  await assert.rejects(
    () => listMailbox({ ...base, port: 9, folder: 'INBOX', limit: 5, unreadOnly: false }),
    (error) => error.code === 'IMAP_CONNECT_FAILED',
  );
});

await checkAsync('listMailbox: leaves no abort listener on the caller signal', async () => {
  const controller = new AbortController();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await listMailbox({ ...base, folder: 'INBOX', limit: 2, unreadOnly: false, signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

await checkAsync('listMailbox: an already-aborted signal fails fast', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => listMailbox({ ...base, folder: 'INBOX', limit: 2, unreadOnly: false, signal: controller.signal }),
    (error) => error.code === 'IMAP_ABORTED' || error.code === 'IMAP_CONNECT_FAILED',
  );
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

// ------------------------------------------- body structure, decoding, reading

check('parseBodyStructure: multipart/alternative exposes both parts', () => {
  const structure = parseBodyStructure(
    '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 5 1 NIL NIL NIL NIL)'
    + '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 9 1 NIL NIL NIL NIL)'
    + ' "ALTERNATIVE" ("BOUNDARY" "b1") NIL NIL NIL)',
  );
  assert.equal(structure.kind, 'multipart');
  assert.equal(structure.subtype, 'alternative');
  assert.equal(structure.children.length, 2);
  assert.equal(structure.children[1].subtype, 'html');
  assert.equal(structure.params.BOUNDARY, 'b1');
});

check('findTextPart: prefers non-attachment text/plain over html', () => {
  const structure = parseBodyStructure(
    '(("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 9 1 NIL NIL NIL NIL)'
    + '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 5 1 NIL NIL NIL NIL)'
    + ' "ALTERNATIVE" ("BOUNDARY" "b1") NIL NIL NIL)',
  );
  assert.equal(findTextPart(structure).subtype, 'plain');
  assert.equal(findTextPart(structure).section, '2');
});

check('listAttachments: finds a PDF and decodes its literal filename', () => {
  const name = '中文.pdf';
  const latin1 = Buffer.from(name, 'utf8').toString('latin1');
  const structure = parseBodyStructure(
    '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 5 1 NIL NIL NIL NIL)'
    + `("APPLICATION" "PDF" ("NAME" {${latin1.length}}${latin1}) NIL NIL "BASE64" 20 NIL `
    + `("ATTACHMENT" ("FILENAME" {${latin1.length}}${latin1})) NIL NIL)`
    + ' "MIXED" ("BOUNDARY" "b2") NIL NIL NIL)',
  );
  assert.equal(findTextPart(structure).section, '1');
  const attachments = listAttachments(structure);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].filename, name);
  assert.equal(attachments[0].contentType, 'application/pdf');
  assert.equal(attachments[0].size, 20);
});

check('findTextPart: nested alternative inside mixed uses a dotted section', () => {
  const structure = parseBodyStructure(
    '((("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 5 1 NIL NIL NIL NIL)'
    + '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 9 1 NIL NIL NIL NIL)'
    + ' "ALTERNATIVE" ("BOUNDARY" "b1") NIL NIL NIL)'
    + '("APPLICATION" "PDF" ("NAME" "a.pdf") NIL NIL "BASE64" 20 NIL '
    + '("ATTACHMENT" ("FILENAME" "a.pdf")) NIL NIL)'
    + ' "MIXED" ("BOUNDARY" "b2") NIL NIL NIL)',
  );
  assert.equal(findTextPart(structure).section, '1.1');
});

check('findTextPart: an inline image is not chosen as the body', () => {
  const structure = parseBodyStructure(
    '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 5 1 NIL NIL NIL NIL)'
    + '("IMAGE" "PNG" ("NAME" "logo.png") NIL NIL "BASE64" 900 NIL ("INLINE" ("FILENAME" "logo.png")) NIL NIL)'
    + ' "RELATED" ("BOUNDARY" "b3") NIL NIL NIL)',
  );
  assert.equal(findTextPart(structure).section, '1');
  assert.equal(listAttachments(structure).length, 0);
});

check('parseSectionFetchLine: reads section, offset, and literal', () => {
  const parsed = parseSectionFetchLine('* 1 FETCH (UID 5 BODY[1]<0> {3}abc)');
  assert.equal(parsed.uid, 5);
  assert.equal(parsed.section, '1');
  assert.equal(parsed.offset, 0);
  assert.equal(parsed.value, 'abc');
});

check('parseSectionFetchLine: handles NIL, dotted sections, and no partial', () => {
  assert.equal(parseSectionFetchLine('* 1 FETCH (UID 5 BODY[2] NIL)').value, '');
  assert.equal(parseSectionFetchLine('* 1 FETCH (UID 5 BODY[1.2] {2}hi)').section, '1.2');
  assert.equal(parseSectionFetchLine('* 1 FETCH (UID 5 BODY[1.2] {2}hi)').offset, 0);
  assert.equal(parseSectionFetchLine('A0001 OK done'), undefined);
});

check('decodeQuotedPrintable: hex escapes and soft line breaks', () => {
  assert.equal(decodeQuotedPrintable(Buffer.from('a=3Db=\r\nc', 'latin1')).toString('latin1'), 'a=bc');
  assert.equal(decodeQuotedPrintable(Buffer.from('x=0Ay', 'latin1')).toString('latin1'), 'x\ny');
});

check('decodeBody: base64, quoted-printable, and GBK', () => {
  assert.equal(decodeBody(Buffer.from('中文', 'utf8').toString('base64'), 'BASE64', 'utf-8'), '中文');
  assert.equal(
    decodeBody(Buffer.from('b2e2cad4d3cabcfe', 'hex').toString('latin1'), '8BIT', 'GBK'),
    '测试邮件',
  );
  assert.equal(decodeBody('=E4=BD=A0=E5=A5=BD', 'QUOTED-PRINTABLE', 'utf-8'), '你好');
});

check('htmlToText: drops script and style, keeps readable structure', () => {
  const text = htmlToText(
    '<html><head><style>p{color:red}</style></head><body>'
    + '<p>Hello <b>world</b></p><script>track()</script>'
    + '<p>Second &amp; third</p><ul><li>one</li><li>two</li></ul></body></html>',
  );
  assert.match(text, /Hello world/);
  assert.match(text, /Second & third/);
  assert.doesNotMatch(text, /color:red|track\(\)|<p>/);
  assert.match(text, /- one/);
  assert.match(text, /- two/);
});

check('decodeEntities: named and numeric references', () => {
  assert.equal(decodeEntities('a&amp;b&#39;c&#x4e2d;'), "a&b'c中");
  assert.equal(decodeEntities('&unknown; stays'), '&unknown; stays');
});

check('normalizeReadArgs: defaults, validation, and bounds', () => {
  assert.deepEqual(normalizeReadArgs({ uid: 7 }), { uid: 7, folder: 'INBOX', maxChars: 20000 });
  assert.throws(() => normalizeReadArgs({}), /"uid" must be a positive integer/);
  assert.throws(() => normalizeReadArgs({ uid: -1 }), /"uid" must be a positive integer/);
  assert.throws(() => normalizeReadArgs({ uid: 1, maxChars: 10 }), /"maxChars" must be an integer/);
  assert.throws(() => normalizeReadArgs({ uid: 1, maxChars: 999999 }), /"maxChars" must be an integer/);
});

// -------------------------------------------------- end-to-end reading

const qp = (text) => [...Buffer.from(text, 'utf8')]
  .map((byte) => `=${byte.toString(16).padStart(2, '0').toUpperCase()}`)
  .join('');

const PLAIN_BODY = '你好，这是正文。第二行';
const HTML_SOURCE = '<html><body><p>Hello <b>world</b></p><p>Second &amp; third</p></body></html>';

const READ_FIXTURES = [
  {
    uid: 201,
    seen: false,
    size: 640,
    structure: '(("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "QUOTED-PRINTABLE" 60 2 NIL NIL NIL NIL)'
      + '("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "7BIT" 120 3 NIL NIL NIL NIL)'
      + ' "ALTERNATIVE" ("BOUNDARY" "b1") NIL NIL NIL)',
    headers: makeHeaders([
      `From: ${utf8Word('张老师')} <zhang@ustc.edu.cn>`,
      'To: me@mail.ustc.edu.cn',
      `Subject: ${utf8Word('关于开题报告')}`,
      'Date: Tue, 6 Oct 2026 09:15:00 +0800',
      'Message-ID: <m201@ustc.edu.cn>',
    ]),
    sections: {
      1: `${qp('你好，这是正文。')}=\r\n${qp('第二行')}`,
      2: '<html><body>the html alternative is not chosen</body></html>',
    },
  },
  {
    uid: 202,
    seen: true,
    size: 3000,
    structure: '(("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "BASE64" 100 3 NIL NIL NIL NIL)'
      + '("APPLICATION" "PDF" ("NAME" "report.pdf") NIL NIL "BASE64" 2048 NIL '
      + '("ATTACHMENT" ("FILENAME" "report.pdf")) NIL NIL)'
      + ' "MIXED" ("BOUNDARY" "b2") NIL NIL NIL)',
    headers: makeHeaders([
      'From: Library <lib@ustc.edu.cn>',
      'To: me@mail.ustc.edu.cn',
      'Subject: notice',
      'Date: Mon, 5 Oct 2026 22:03:00 +0800',
    ]),
    sections: { 1: Buffer.from(HTML_SOURCE, 'utf8').toString('base64') },
  },
  {
    uid: 203,
    seen: false,
    size: 8,
    structure: '("TEXT" "PLAIN" ("CHARSET" "GBK") NIL NIL "8BIT" 8 1 NIL NIL NIL NIL)',
    headers: makeHeaders([
      'From: Library <lib@ustc.edu.cn>',
      'Subject: gbk body',
      'Date: Mon, 5 Oct 2026 21:00:00 +0800',
    ]),
    sections: { 1: Buffer.from('b2e2cad4d3cabcfe', 'hex') },
  },
];

const readServer = await startFakeServer({ user: USER, password: PASSWORD, messages: READ_FIXTURES });
const readBase = { ...base, port: readServer.port };

// ---------------------------------------------------------------- attachments
//
// The filenames here are the attack surface: a message chooses its own, and this
// client is the only thing standing between that choice and the filesystem.

/**
 * Escape a value for an IMAP quoted string.
 *
 * Without this a backslash in a fixture is consumed as an escape by the parser,
 * so `C:\Windows\...` would reach the client as `C:Windows...` and the test
 * would prove nothing about backslash traversal.
 * @param value - the raw string.
 * @returns the value as it must appear inside quotes.
 */
function imapQuoted(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Build a one-part attachment message whose section content is `bytes`. */
function attachmentFixture(uid, filename, bytes, { encoding = 'BASE64' } = {}) {
  const payload = encoding === 'BASE64'
    ? Buffer.from(bytes).toString('base64')
    : Buffer.from(bytes).toString('latin1');
  const quoted = imapQuoted(filename);
  const structure = `("APPLICATION" "OCTET-STREAM" ("NAME" "${quoted}") NIL NIL "${encoding}" `
    + `${payload.length} NIL ("ATTACHMENT" ("FILENAME" "${quoted}")) NIL NIL)`;
  return {
    uid,
    seen: true,
    size: payload.length + 200,
    structure,
    headers: makeHeaders([
      'From: sender@example.edu.cn',
      `Subject: attachment ${uid}`,
      'Date: Tue, 6 Oct 2026 09:15:00 +0800',
    ]),
    sections: { 1: payload },
  };
}

const PDF_BYTES = Buffer.from('%PDF-1.4\nfake pdf payload\n%%EOF\n', 'latin1');
const HOSTILE_BYTES = Buffer.from('ssh-rsa AAAA hostile payload', 'latin1');

const ATTACH_FIXTURES = [
  attachmentFixture(301, 'report.pdf', PDF_BYTES),
  attachmentFixture(302, '../../.ssh/id_rsa', HOSTILE_BYTES),
  attachmentFixture(303, 'C:\\Windows\\System32\\evil.dll', HOSTILE_BYTES),
  attachmentFixture(304, 'CON.txt', HOSTILE_BYTES),
  attachmentFixture(305, `${'long'.repeat(60)}.pdf`, PDF_BYTES),
  {
    uid: 306,
    seen: true,
    size: 500,
    structure: '("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" 4 1 NIL NIL NIL NIL)',
    headers: makeHeaders([
      'From: sender@example.edu.cn',
      'Subject: no attachments',
      'Date: Tue, 6 Oct 2026 09:15:00 +0800',
    ]),
    sections: { 1: 'body text' },
  },
];

const attachServer = await startFakeServer({ user: USER, password: PASSWORD, messages: ATTACH_FIXTURES });
const attachBase = { ...base, port: attachServer.port };
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'ustc-attach-'));

await checkAsync('readMessage: picks the plain part and decodes quoted-printable', async () => {
  const value = await readMessage({ ...readBase, folder: 'INBOX', uid: 201 });
  assert.equal(value.uid, 201);
  assert.equal(value.bodyType, 'text/plain');
  assert.equal(value.body, PLAIN_BODY);
  assert.equal(value.subject, '关于开题报告');
  assert.equal(value.from, '张老师 <zhang@ustc.edu.cn>');
  assert.equal(value.to, 'me@mail.ustc.edu.cn');
  assert.equal(value.messageId, '<m201@ustc.edu.cn>');
  assert.equal(value.unread, true);
  assert.equal(value.bodyTruncated, false);
  assert.deepEqual(value.attachments, []);
  assert.equal(value.date, '2026-10-06T01:15:00.000Z');

  const text = renderMessage(value);
  assert.match(text, /Subject: 关于开题报告/);
  assert.match(text, /Attachments: none/);
  assert.match(text, /你好，这是正文。第二行/);
});

await checkAsync('readMessage: converts an HTML body and lists attachments', async () => {
  const value = await readMessage({ ...readBase, folder: 'INBOX', uid: 202 });
  assert.equal(value.bodyType, 'text/html');
  assert.match(value.body, /Hello world/);
  assert.match(value.body, /Second & third/);
  assert.doesNotMatch(value.body, /<p>|<b>/);
  assert.equal(value.unread, false);
  assert.deepEqual(value.attachments, [{
    filename: 'report.pdf',
    contentType: 'application/pdf',
    size: 2048,
  }]);
  const text = renderMessage(value);
  assert.match(text, /converted from HTML/);
  assert.match(text, /report\.pdf/);
  assert.match(text, /not downloaded/);
});

await checkAsync('readMessage: decodes a single-part GBK body', async () => {
  const value = await readMessage({ ...readBase, folder: 'INBOX', uid: 203 });
  assert.equal(value.body, '测试邮件');
  assert.equal(value.bodyType, 'text/plain');
  assert.equal(value.attachments.length, 0);
});

await checkAsync('readMessage: clips a long body and says so', async () => {
  const value = await readMessage({ ...readBase, folder: 'INBOX', uid: 201, maxChars: 5 });
  assert.equal(value.body.length, 5);
  assert.equal(value.bodyTruncated, true);
  assert.match(renderMessage(value), /\[body truncated\]/);
});

await checkAsync('readMessage: an unknown uid reports IMAP_NOT_FOUND', async () => {
  await assert.rejects(
    () => readMessage({ ...readBase, folder: 'INBOX', uid: 999999 }),
    (error) => error.code === 'IMAP_NOT_FOUND',
  );
});

// ------------------------------------------------------------------- previews

/** @returns how many connections the server has accepted so far. */
const logins = () => readServer.state.commands.filter((line) => /^[^\s]+ LOGIN/i.test(line)).length;

await checkAsync('listMailbox: preview reads every body over a single connection', async () => {
  const before = logins();
  const result = await listMailbox({ ...readBase, folder: 'INBOX', limit: 20, preview: 120 });

  assert.equal(result.preview, 120);
  assert.equal(logins() - before, 1, 'a preview listing must open exactly one connection');

  const [first, second, third] = result.messages;
  assert.equal(first.uid, 203);
  assert.equal(first.preview, '测试邮件');
  assert.equal(second.uid, 202);
  assert.match(second.preview, /Hello world/);
  assert.equal(third.uid, 201);
  assert.equal(third.preview, '你好，这是正文。第二行');
});

await checkAsync('listMailbox: preview is flattened to one line', async () => {
  const result = await listMailbox({ ...readBase, folder: 'INBOX', limit: 20, preview: 120 });
  for (const message of result.messages) {
    assert.equal(message.preview.includes('\n'), false);
  }
});

await checkAsync('listMailbox: preview 0 fetches no body and reports none', async () => {
  const commandsBefore = readServer.state.commands.length;
  const result = await listMailbox({ ...readBase, folder: 'INBOX', limit: 20, preview: 0 });
  assert.equal(result.preview, 0);
  assert.equal(result.messages.every((message) => message.preview === undefined), true);
  const issued = readServer.state.commands.slice(commandsBefore).join('\n');
  assert.equal(/BODY\.PEEK\[1\]/i.test(issued), false, 'no body section may be fetched without a preview');
});

await checkAsync('listMailbox: preview longer than the body returns the whole body', async () => {
  const result = await listMailbox({ ...readBase, folder: 'INBOX', limit: 20, preview: 600 });
  const short = result.messages.find((message) => message.uid === 203);
  assert.equal(short.preview, '测试邮件');
});

await checkAsync('listMailbox: a preview renders under its message line', async () => {
  const result = await listMailbox({ ...readBase, folder: 'INBOX', limit: 20, preview: 120 });
  const text = renderMailboxList(result);
  assert.match(text, /first 120 characters/);
  assert.match(text, /uid=201\n {3}你好，这是正文。第二行/);
});

await checkAsync('searchMailbox: preview works through the search path too', async () => {
  const before = logins();
  const result = await searchMailbox({ ...readBase, ...normalizeSearchArgs({ preview: 80, subject: 'body' }) });
  assert.equal(result.preview, 80);
  assert.equal(logins() - before, 1);
  assert.equal(result.messages[0].preview.startsWith('测试'), true);
});

check('preview argument: range and type are enforced', () => {
  assert.equal(normalizeListArgs({ preview: 0 }).preview, 0);
  assert.equal(normalizeListArgs({ preview: 600 }).preview, 600);
  assert.throws(() => normalizeListArgs({ preview: 601 }), /"preview" must be an integer/);
  assert.throws(() => normalizeListArgs({ preview: -1 }), /"preview" must be an integer/);
  assert.throws(() => normalizeListArgs({ preview: 1.5 }), /"preview" must be an integer/);
  assert.throws(() => normalizeSearchArgs({ unreadOnly: true, preview: 601 }));
});

await checkAsync('preview argument: a body that cannot be read does not lose the listing', async () => {
  // attachPreviews swallows a per-message failure; assert the contract directly.
  const records = [{ uid: 1 }, { uid: 2 }];
  const failing = {
    async uidFetchSection(uid) {
      if (uid === 1) throw new Error('boom');
      return { value: 'ok' };
    },
  };
  await attachPreviews(failing, records, 10);
  assert.equal(records[0].preview, '');
  assert.equal(records[1].preview, 'ok');
});

// ---------------------------------------------------------------- multi-read

/** @returns how many LOGIN commands the read server has seen. */
const readLogins = () => readServer.state.commands.filter((line) => /^[^\s]+ LOGIN/i.test(line)).length;

await checkAsync('readMessages: several uids over one connection, in the order asked', async () => {
  const before = readLogins();
  const value = await readMessages({ ...readBase, folder: 'INBOX', uids: [203, 201, 202] });
  assert.equal(readLogins() - before, 1, 'a batch read must open exactly one connection');
  assert.equal(value.requested, 3);
  assert.equal(value.returned, 3);
  assert.deepEqual(value.missing, []);
  assert.deepEqual(value.messages.map((message) => message.uid), [203, 201, 202]);
  assert.equal(value.messages[0].body, '测试邮件');
  assert.equal(value.messages[1].body, PLAIN_BODY);
  assert.match(value.messages[2].body, /Hello world/);
});

await checkAsync('readMessages: a uid that is not there does not lose the batch', async () => {
  const value = await readMessages({ ...readBase, folder: 'INBOX', uids: [201, 999999, 202] });
  assert.equal(value.requested, 3);
  assert.equal(value.returned, 2);
  assert.deepEqual(value.missing, [999999]);
  assert.deepEqual(value.messages.map((message) => message.uid), [201, 202]);
  assert.match(renderMessages(value), /Not in this mailbox: 999999/);
});

await checkAsync('readMessages: every message keeps the shape a single read produces', async () => {
  const value = await readMessages({ ...readBase, folder: 'INBOX', uids: [201] });
  const single = await readMessage({ ...readBase, folder: 'INBOX', uid: 201 });
  assert.deepEqual(value.messages[0], single);
});

check('normalizeReadManyArgs: bounds, types, and repeats', () => {
  const many = normalizeReadManyArgs({ uids: [5, 3, 5, 1] });
  assert.deepEqual(many.uids, [5, 3, 1], 'repeats are fetched once');
  assert.equal(many.maxChars, MULTI_DEFAULT_MAX_CHARS, 'a batch gets the smaller per-message budget');

  assert.equal(normalizeReadManyArgs({ uids: [5] }).maxChars, 20000, 'one uid keeps the full budget');
  assert.equal(normalizeReadManyArgs({ uids: [5, 6], maxChars: 4000 }).maxChars, 4000);

  assert.throws(() => normalizeReadManyArgs({}), /non-empty array/);
  assert.throws(() => normalizeReadManyArgs({ uids: [] }), /non-empty array/);
  assert.throws(() => normalizeReadManyArgs({ uids: [0] }), /positive integer/);
  assert.throws(() => normalizeReadManyArgs({ uids: [1.5] }), /positive integer/);
  assert.throws(() => normalizeReadManyArgs({ uids: ['1'] }), /positive integer/);
  assert.throws(() => normalizeReadManyArgs({ uids: Array.from({ length: 21 }, (_, i) => i + 1) }), /at most 20/);
  assert.throws(() => normalizeReadManyArgs({ uids: [1], maxChars: 100 }), /"maxChars" must be an integer/);
});

// ------------------------------------------------------------------ attach

await checkAsync('downloadAttachments: writes the attachment and reports it', async () => {
  const out = path.join(sandbox, 'plain');
  const value = await downloadAttachments({ ...attachBase, folder: 'INBOX', uid: 301, outDir: out });
  assert.equal(value.requested, 1);
  assert.equal(value.saved.length, 1);
  assert.equal(value.saved[0].filename, 'report.pdf');
  assert.equal(value.saved[0].bytes, PDF_BYTES.length);
  assert.deepEqual(readFileSync(path.join(out, 'report.pdf')), PDF_BYTES, 'bytes must survive the round trip');
});

await checkAsync('downloadAttachments: a filename cannot escape the directory', async () => {
  const out = path.join(sandbox, 'hostile');
  const value = await downloadAttachments({ ...attachBase, folder: 'INBOX', uid: 302, outDir: out });
  assert.equal(value.saved[0].filename, 'id_rsa', 'only the leaf name survives');
  assert.deepEqual(readFileSync(path.join(out, 'id_rsa')), HOSTILE_BYTES);

  // Nothing may land beside the directory either.
  assert.deepEqual(readdirSync(sandbox).sort(), ['hostile', 'plain'].sort());
  assert.equal(existsSync(path.join(sandbox, '.ssh')), false);
});

await checkAsync('downloadAttachments: a Windows path and a reserved name are defused', async () => {
  const out = path.join(sandbox, 'windows');
  const one = await downloadAttachments({ ...attachBase, folder: 'INBOX', uid: 303, outDir: out });
  assert.equal(one.saved[0].filename, 'evil.dll');

  const two = await downloadAttachments({ ...attachBase, folder: 'INBOX', uid: 304, outDir: out });
  assert.equal(two.saved[0].filename, '_CON.txt', 'a device name must not be created as-is');
});

await checkAsync('downloadAttachments: a very long name is truncated but keeps its extension', async () => {
  const out = path.join(sandbox, 'long');
  const value = await downloadAttachments({ ...attachBase, folder: 'INBOX', uid: 305, outDir: out });
  assert.ok(value.saved[0].filename.length <= 120, `name was ${value.saved[0].filename.length} characters`);
  assert.ok(value.saved[0].filename.endsWith('.pdf'), 'the extension must survive truncation');
});

await checkAsync('downloadAttachments: a second save does not overwrite the first', async () => {
  const out = path.join(sandbox, 'collide');
  await downloadAttachments({ ...attachBase, folder: 'INBOX', uid: 301, outDir: out });
  const again = await downloadAttachments({ ...attachBase, folder: 'INBOX', uid: 301, outDir: out });
  assert.equal(again.saved[0].filename, 'report-1.pdf');
  assert.deepEqual(readdirSync(out).sort(), ['report-1.pdf', 'report.pdf']);
});

await checkAsync('downloadAttachments: a message with no attachments saves nothing', async () => {
  const out = path.join(sandbox, 'none');
  const value = await downloadAttachments({ ...attachBase, folder: 'INBOX', uid: 306, outDir: out });
  assert.equal(value.requested, 0);
  assert.deepEqual(value.saved, []);
  assert.match(renderAttachmentSave(value), /no attachments/i);
});

await checkAsync('downloadAttachments: an unknown uid reports IMAP_NOT_FOUND', async () => {
  await assert.rejects(
    () => downloadAttachments({ ...attachBase, folder: 'INBOX', uid: 999999, outDir: path.join(sandbox, 'x') }),
    (error) => error.code === 'IMAP_NOT_FOUND',
  );
});

await checkAsync('downloadAttachments: --name and --index narrow the set', async () => {
  const out = path.join(sandbox, 'narrow');
  const none = await downloadAttachments({
    ...attachBase, folder: 'INBOX', uid: 301, outDir: out, name: 'not-there.pdf',
  });
  assert.equal(none.requested, 0);
  assert.deepEqual(none.saved, []);

  const byName = await downloadAttachments({
    ...attachBase, folder: 'INBOX', uid: 301, outDir: out, name: 'report.pdf',
  });
  assert.equal(byName.saved.length, 1);

  const byIndex = await downloadAttachments({
    ...attachBase, folder: 'INBOX', uid: 301, outDir: out, index: 1,
  });
  assert.equal(byIndex.saved.length, 1);

  const offTheEnd = await downloadAttachments({
    ...attachBase, folder: 'INBOX', uid: 301, outDir: out, index: 9,
  });
  assert.equal(offTheEnd.requested, 0);
});

// -------------------------------------------------- large and encoded parts
//
// A part is pulled in 1 MiB pieces, so anything above that exercises the join
// between pieces. Random bytes are what make the test worth running: repetitive
// content would hide an off-by-one in the offsets.

/** Bytes that look random but repeat for a given seed, so a failure reproduces. */
function pseudoRandom(length, seed) {
  const out = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[index] = (state >>> 24) & 0xff;
  }
  return out;
}

/** How many bytes one FETCH pulls; must track CHUNK_BYTES in lib/attach.js. */
const CHUNK = 1024 * 1024;

/** A fixture whose section content is given verbatim rather than derived. */
function rawFixture(uid, filename, payload, { encoding = 'BASE64', size } = {}) {
  const quoted = imapQuoted(filename);
  const structure = `("APPLICATION" "OCTET-STREAM" ("NAME" "${quoted}") NIL NIL "${encoding}" `
    + `${size ?? payload.length} NIL ("ATTACHMENT" ("FILENAME" "${quoted}")) NIL NIL)`;
  return {
    uid,
    seen: true,
    size: 4096,
    structure,
    headers: makeHeaders([
      'From: sender@example.edu.cn',
      `Subject: attachment ${uid}`,
      'Date: Tue, 6 Oct 2026 09:15:00 +0800',
    ]),
    sections: { 1: payload },
  };
}

// Deliberately not a round number of chunks, and odd, so the final piece is short.
const BIG_BYTES = pseudoRandom(3 * CHUNK + 12345, 20261006);

// A quoted-printable escape split across the boundary: '=' is the last byte of
// piece one, '4' and '1' are the first of piece two. Decoding piece by piece
// would leave a stray '=' followed by a literal '41'.
const QP_ESCAPE = `${'A'.repeat(CHUNK - 1)}=41${'B'.repeat(50)}`;
const QP_ESCAPE_BYTES = Buffer.concat([
  Buffer.from('A'.repeat(CHUNK - 1)),
  Buffer.from([0x41]),
  Buffer.from('B'.repeat(50)),
]);

// A soft line break split the same way: '=' then CR then LF. Decoding piece by
// piece would keep all three bytes instead of dropping them.
const QP_SOFT = `${'C'.repeat(CHUNK - 1)}=\r\n${'D'.repeat(50)}`;
const QP_SOFT_BYTES = Buffer.concat([
  Buffer.from('C'.repeat(CHUNK - 1)),
  Buffer.from('D'.repeat(50)),
]);

const bigServer = await startFakeServer({
  user: USER,
  password: PASSWORD,
  messages: [
    rawFixture(401, 'big.bin', BIG_BYTES.toString('base64')),
    rawFixture(402, 'escape.bin', QP_ESCAPE, { encoding: 'QUOTED-PRINTABLE' }),
    rawFixture(403, 'soft.bin', QP_SOFT, { encoding: 'QUOTED-PRINTABLE' }),
    // Declares more than the per-attachment cap, so it must be refused before a
    // single byte is fetched.
    rawFixture(404, 'huge.bin', '', { size: 200 * 1024 * 1024 }),
  ],
});
const bigBase = { ...base, port: bigServer.port };

await checkAsync('downloadAttachments: a part spanning several fetches is reassembled exactly', async () => {
  const out = path.join(sandbox, 'big');
  const value = await downloadAttachments({ ...bigBase, folder: 'INBOX', uid: 401, outDir: out });
  assert.equal(value.saved.length, 1, JSON.stringify(value.skipped));
  assert.equal(value.saved[0].bytes, BIG_BYTES.length);

  const written = readFileSync(path.join(out, 'big.bin'));
  assert.equal(written.length, BIG_BYTES.length);
  assert.ok(written.equals(BIG_BYTES), 'the bytes changed somewhere between the pieces');

  // Confirm the fixture really did cross a boundary, so this cannot pass by
  // accident on a single fetch. The wire form spells the peek, hence BODY.PEEK.
  const fetches = bigServer.state.commands.filter((line) => /BODY(?:\.PEEK)?\[1\]<\d+\.\d+>/.test(line));
  assert.ok(fetches.length >= 4, `expected several piece fetches, saw ${fetches.length}`);
  assert.ok(fetches.some((line) => /<0\.1048576>/.test(line)), 'first piece should start at 0');
  assert.ok(fetches.some((line) => /<1048576\./.test(line)), 'a second piece should start at 1048576');
});

await checkAsync('downloadAttachments: a quoted-printable escape split across pieces still decodes', async () => {
  const out = path.join(sandbox, 'qp');
  const value = await downloadAttachments({ ...bigBase, folder: 'INBOX', uid: 402, outDir: out });
  assert.equal(value.saved[0].bytes, QP_ESCAPE_BYTES.length);

  const written = readFileSync(path.join(out, 'escape.bin'));
  assert.ok(
    written.equals(QP_ESCAPE_BYTES),
    '=41 straddling the piece boundary was not decoded as one byte',
  );
  assert.equal(written[CHUNK - 1], 0x41, 'the escaped byte must land where the escape began');
});

await checkAsync('downloadAttachments: a soft line break split across pieces still collapses', async () => {
  const out = path.join(sandbox, 'qp-soft');
  const value = await downloadAttachments({ ...bigBase, folder: 'INBOX', uid: 403, outDir: out });
  assert.equal(value.saved[0].bytes, QP_SOFT_BYTES.length);

  const written = readFileSync(path.join(out, 'soft.bin'));
  assert.ok(
    written.equals(QP_SOFT_BYTES),
    'a soft break straddling the piece boundary was not collapsed',
  );
  assert.equal(written.includes(0x0d), false, 'no carriage return may survive the decode');
});

await checkAsync('downloadAttachments: a part over the cap is refused before it is fetched', async () => {
  const out = path.join(sandbox, 'over');
  const value = await downloadAttachments({ ...bigBase, folder: 'INBOX', uid: 404, outDir: out });
  assert.equal(value.saved.length, 0);
  assert.equal(value.skipped.length, 1);
  assert.match(value.skipped[0].reason, /larger than the 25 MiB limit/);

  // The refusal has to happen before the body is pulled, or a hostile message
  // could make the client download 200 MiB just to throw it away.
  const fetches = bigServer.state.commands.filter((line) => /UID FETCH 404/.test(line));
  assert.equal(fetches.length, 1, 'only the header fetch may touch this message');
  assert.match(fetches[0], /HEADER|RFC822|BODYSTRUCTURE/i);
  // The directory is created up front, so it exists but must stay empty.
  assert.deepEqual(readdirSync(out), [], 'a refused part must not leave a file behind');
});

check('normalizeAttachArgs: validates the request before anything connects', () => {
  assert.equal(normalizeAttachArgs({ uid: 7 }).outDir, 'ustc-mail-attachments');
  assert.equal(normalizeAttachArgs({ uid: 7, outDir: 'x' }).outDir, 'x');
  assert.throws(() => normalizeAttachArgs({}), /positive integer/);
  assert.throws(() => normalizeAttachArgs({ uid: 0 }), /positive integer/);
  assert.throws(() => normalizeAttachArgs({ uid: 7, name: '   ' }), /non-empty string/);
  assert.throws(() => normalizeAttachArgs({ uid: 7, index: 0 }), /"index" must be an integer/);
});

check('safeFileName: every hostile shape is defused', () => {
  assert.equal(safeFileName('report.pdf'), 'report.pdf');
  assert.equal(safeFileName('../../.ssh/id_rsa'), 'id_rsa');
  assert.equal(safeFileName('..\\..\\evil.exe'), 'evil.exe');
  assert.equal(safeFileName('/etc/passwd'), 'passwd');
  assert.equal(safeFileName('C:\\Windows\\System32\\evil.dll'), 'evil.dll');
  assert.equal(safeFileName('CON'), '_CON');
  assert.equal(safeFileName('nul.pdf'), '_nul.pdf');
  assert.equal(safeFileName('..'), 'attachment');
  assert.equal(safeFileName('.'), 'attachment');
  assert.equal(safeFileName('   '), 'attachment');
  assert.equal(safeFileName(''), 'attachment');
  assert.equal(safeFileName('....hidden'), 'hidden');
  assert.equal(safeFileName('trailing.   '), 'trailing');
  assert.equal(safeFileName('a<b>c:d"e|f?g*h.txt'), 'a_b_c_d_e_f_g_h.txt');
  assert.equal(safeFileName('a\u0000b\u001fc.txt'), 'a_b_c.txt');
  assert.ok(safeFileName(`${'x'.repeat(300)}.pdf`).length <= 120);

  for (const value of ['../x', '..\\x', 'CON', '.hidden', '', '   ']) {
    const name = safeFileName(value);
    assert.equal(/[/\\]/.test(name), false, `${value} produced a separator`);
    assert.equal(name.startsWith('.'), false, `${value} produced a hidden file`);
  }
});

check('formatImapDate: converts to dd-Mmm-yyyy and rejects nonsense', () => {
  assert.equal(formatImapDate('2026-10-01'), '01-Oct-2026');
  assert.equal(formatImapDate('2026-01-09'), '09-Jan-2026');
  assert.equal(formatImapDate('2026-12-31'), '31-Dec-2026');
  assert.equal(formatImapDate('2026-13-01'), undefined);
  assert.equal(formatImapDate('2026-10-32'), undefined);
  assert.equal(formatImapDate('01-Oct-2026'), undefined);
  assert.equal(formatImapDate(''), undefined);
});

check('buildSearchCommand: quotes ASCII terms, adds CHARSET only for non-ASCII', () => {
  assert.deepEqual(
    buildSearchCommand({ subject: 'report', unreadOnly: true }),
    ['SUBJECT', '"report"', 'UNSEEN'],
  );
  assert.deepEqual(
    buildSearchCommand({ since: '01-Oct-2026', before: '06-Oct-2026' }),
    ['SINCE', '01-Oct-2026', 'BEFORE', '06-Oct-2026'],
  );
  const tokens = buildSearchCommand({ subject: '开题' });
  assert.equal(tokens[0], 'CHARSET');
  assert.equal(tokens[1], 'UTF-8');
  assert.equal(tokens[2], 'SUBJECT');
  assert.equal(Buffer.from(tokens[3].literal).toString('utf8'), '开题');
  assert.deepEqual(buildSearchCommand({}), ['ALL']);
});

check('normalizeSearchArgs: requires a criterion and validates values', () => {
  assert.throws(() => normalizeSearchArgs({}), /at least one/);
  assert.throws(() => normalizeSearchArgs({ subject: '   ' }), /must be a non-empty string/);
  assert.throws(() => normalizeSearchArgs({ from: 'a\nb' }), /must not contain line breaks/);
  assert.throws(() => normalizeSearchArgs({ since: 'yesterday' }), /calendar date/);
  assert.throws(() => normalizeSearchArgs({ subject: 'x', limit: 101 }), /"limit" must be an integer/);
  assert.deepEqual(normalizeSearchArgs({ unreadOnly: true }), {
    folder: 'INBOX',
    limit: 20,
    preview: 0,
    subject: undefined,
    from: undefined,
    to: undefined,
    since: undefined,
    before: undefined,
    unreadOnly: true,
  });
});

check('describeQuery: reads like a sentence', () => {
  assert.equal(describeQuery({ subject: 'a', unreadOnly: true }), 'subject contains "a", unread only');
  assert.equal(
    describeQuery({ since: '01-Oct-2026', before: '06-Oct-2026' }),
    'received on or after 01-Oct-2026, received before 06-Oct-2026',
  );
  assert.equal(describeQuery({}), '');
});

// `searchMailbox` takes a normalized request, which is exactly what the CLI
// builds before connecting. This helper mirrors that contract.
const search = (args) => searchMailbox({ ...base, ...normalizeSearchArgs(args) });

await checkAsync('searchMailbox: subject search returns the matching message', async () => {
  const value = await search({ subject: 'plain ascii subject' });
  assert.equal(value.matched, 1);
  assert.deepEqual(value.messages.map((message) => message.uid), [103]);
  assert.match(server.state.lastSearch, /SUBJECT "plain ascii subject"/);
  assert.match(renderSearchResult(value), /Search: subject contains "plain ascii subject"/);
});

await checkAsync('searchMailbox: sender search and unread filter', async () => {
  const bySender = await search({ from: 'lib@ustc.edu.cn' });
  assert.deepEqual(bySender.messages.map((message) => message.uid), [102]);

  const unread = await search({ unreadOnly: true });
  assert.deepEqual(unread.messages.map((message) => message.uid), [103, 101]);
  assert.match(server.state.lastSearch, /UNSEEN/);
});

await checkAsync('searchMailbox: a Chinese term goes out as CHARSET UTF-8 plus a literal', async () => {
  const value = await search({ subject: '开题' });
  assert.match(server.state.lastSearch, /^CHARSET UTF-8 SUBJECT \{6\}/);
  // The fake server matches raw headers, so the encoded subject matches nothing.
  assert.equal(value.matched, 0);
  assert.match(renderSearchResult(value), /No messages matched\./);
});

await checkAsync('searchMailbox: date bounds are sent as IMAP dates', async () => {
  await search({ since: '2026-10-01', before: '2026-10-06' });
  assert.equal(server.state.lastSearch, 'SINCE 01-Oct-2026 BEFORE 06-Oct-2026');
});

await checkAsync('searchMailbox: limit keeps the newest matches', async () => {
  const value = await search({ unreadOnly: true, limit: 2 });
  assert.equal(value.matched, 2);
  assert.equal(value.returned, 2);
  assert.deepEqual(value.messages.map((message) => message.uid), [103, 101]);
});

// ----------------------------------------------------------------- hardening

check('hardening: control characters are rejected in every folder name', () => {
  const hostile = ['INBOX\r\nA9999 DELETE INBOX', 'INBOX\nX', 'INBOX\u0000X', 'INBOX\u001fX'];
  for (const folder of hostile) {
    assert.throws(() => normalizeListArgs({ folder }), /control characters/);
    assert.throws(() => normalizeSearchArgs({ folder, unreadOnly: true }), /control characters/);
    assert.throws(() => normalizeReadArgs({ uid: 1, folder }), /control characters/);
  }
});

check('hardening: no mailbox name can put a CR or LF on the wire', () => {
  const hostile = ['a"\r\nA1 DELETE INBOX', 'a\r\nb', 'a\nb', 'a\u0000b', '已发送\r\nLOGOUT'];
  for (const payload of hostile) {
    const encoded = encodeMailboxName(payload);
    assert.doesNotMatch(encoded, /[\r\n\u0000]/, `encodeMailboxName leaked a control character: ${JSON.stringify(payload)}`);
    const token = imapString(encoded);
    if (typeof token === 'string') {
      assert.doesNotMatch(token, /[\r\n\u0000]/);
      assert.doesNotMatch(token.slice(1, -1), /(?<!\\)"/, 'a bare quote survived escaping');
    }
  }
});

check('hardening: a search term can never break the command line', () => {
  for (const hostile of ['a\r\nb', 'a\nb', 'a\u0000b']) {
    assert.throws(() => normalizeSearchArgs({ subject: hostile }), /line breaks/);
  }
  // A non-ASCII term is length-prefixed, so even a CR/LF would stay inside it.
  const tokens = buildSearchCommand({ subject: '账单\r\nLOGOUT' });
  const literal = tokens.find((token) => typeof token === 'object');
  assert.ok(literal !== undefined);
  assert.match(Buffer.from(literal.literal).toString('utf8'), /\r\n/);
});

await checkAsync('hardening: a hostile folder name cannot inject a command', async () => {
  const target = await startFakeServer({ user: USER, password: PASSWORD, messages: FIXTURES });
  try {
    await listMailbox({
      ...base,
      port: target.port,
      folder: 'INBOX"\r\nA9999 DELETE INBOX',
      limit: 1,
      unreadOnly: false,
    });
    const commands = target.state.commands;
    // The decisive check: exactly the five commands one listing needs, in order.
    // An injected second command would appear here as a sixth line.
    const verbs = commands.map((line) => /^(\S+) (\S+)/.exec(line)?.[2]?.toUpperCase());
    assert.deepEqual(verbs, ['LOGIN', 'EXAMINE', 'UID', 'UID', 'LOGOUT']);

    // The payload stayed inside one quoted argument: the CR/LF became mUTF-7 and
    // the embedded quote was escaped, so the dangerous text is inert data.
    const examine = commands.find((line) => / EXAMINE /.test(line));
    assert.match(examine, /EXAMINE "INBOX\\"&AA0ACg-A9999 DELETE INBOX"$/);
  } finally {
    await target.close();
  }
});

await checkAsync('hardening: an oversized literal from the server is refused', async () => {
  const target = await startFakeServer({ user: USER, password: PASSWORD, messages: [], misbehave: 'huge-literal' });
  try {
    await assert.rejects(
      () => listMailbox({ ...base, port: target.port, folder: 'INBOX', limit: 1, unreadOnly: false }),
      (error) => error.code === 'IMAP_PROTOCOL' && /literal/.test(error.message),
    );
  } finally {
    await target.close();
  }
});

await checkAsync('hardening: an endless response line from the server is refused', async () => {
  const target = await startFakeServer({ user: USER, password: PASSWORD, messages: [], misbehave: 'long-line' });
  try {
    await assert.rejects(
      () => listMailbox({ ...base, port: target.port, folder: 'INBOX', limit: 1, unreadOnly: false }),
      (error) => error.code === 'IMAP_PROTOCOL' && /unterminated/.test(error.message),
    );
  } finally {
    await target.close();
  }
});

await checkAsync('hardening: the session gate never grants more than the cap', async () => {
  resetGateStats();
  const held = [];
  for (let index = 0; index < MAX_CONCURRENT_SESSIONS; index += 1) {
    held.push(await acquireSessionSlot());
  }
  assert.equal(activeSessionCount(), MAX_CONCURRENT_SESSIONS);

  let granted = false;
  const pending = acquireSessionSlot().then((release) => {
    granted = true;
    held.push(release);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(granted, false, 'a slot was granted while the cap was already full');

  held.shift()();
  await pending;
  assert.equal(granted, true);
  assert.equal(activeSessionCount(), MAX_CONCURRENT_SESSIONS);

  for (const release of held) release();
  assert.equal(activeSessionCount(), 0);
  // Releasing twice must not hand out extra capacity.
  for (const release of held) release();
  assert.equal(activeSessionCount(), 0);
});

await checkAsync('hardening: parallel calls cannot exceed the session cap', async () => {
  const target = await startFakeServer({ user: USER, password: PASSWORD, messages: FIXTURES });
  resetGateStats();
  try {
    await Promise.all(Array.from({ length: 6 }, () => listMailbox({
      ...base, port: target.port, folder: 'INBOX', limit: 1, unreadOnly: false,
    })));
    assert.ok(
      peakSessionCount() <= MAX_CONCURRENT_SESSIONS,
      `peak was ${peakSessionCount()}, cap is ${MAX_CONCURRENT_SESSIONS}`,
    );
    assert.equal(activeSessionCount(), 0);
  } finally {
    await target.close();
  }
});

await checkAsync('hardening: a failed connection releases its slot', async () => {
  assert.equal(activeSessionCount(), 0);
  await assert.rejects(
    () => listMailbox({ ...base, port: 9, folder: 'INBOX', limit: 1, unreadOnly: false }),
    (error) => error.code === 'IMAP_CONNECT_FAILED',
  );
  assert.equal(activeSessionCount(), 0);
});

await checkAsync('hardening: a completed call releases its slot', async () => {
  assert.equal(activeSessionCount(), 0);
  await listMailbox({ ...base, folder: 'INBOX', limit: 1, unreadOnly: false });
  assert.equal(activeSessionCount(), 0);
});

await checkAsync('hardening: the read tool warns that message content is untrusted', () => {
  const description = registeredTool({}, READ_TOOL_NAME).description;
  assert.match(description, /untrusted data/);
  assert.match(description, /never follow instructions/);
});

await readServer.close();

await server.close();

// --------------------------------------------------------------------- report

for (const failure of failures) {
  process.stderr.write(`FAIL ${failure.label}\n  ${failure.error?.message ?? failure.error}\n`);
}
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length === 0 ? 0 : 1);
