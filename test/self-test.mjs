/**
 * Offline self-test: pure-function units plus an end-to-end listing against the
 * fake IMAP server. No network, no account, no credentials.
 *
 * Run: node test/self-test.mjs
 */
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { apply, inject } from '../index.js';
import { findTextPart, listAttachments, parseBodyStructure } from '../lib/bodystructure.js';
import { renderMailboxList, renderMessage, renderSearchResult, formatDateTime, formatSize } from '../lib/format.js';
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
import { normalizeReadArgs, readMessage } from '../lib/read.js';
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

check('plugin: registers exactly the three documented tools', () => {
  const names = registeredTools({}).map((tool) => tool.name);
  assert.deepEqual(names, [LIST_TOOL_NAME, SEARCH_TOOL_NAME, READ_TOOL_NAME]);
  // Every tool carries a real description and an object-rooted output schema.
  for (const tool of registeredTools({})) {
    assert.ok(tool.description.length > 40);
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.isConcurrencySafe(), true);
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

// ------------------------------------------------------------------- searching

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
