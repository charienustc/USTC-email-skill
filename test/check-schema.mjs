/**
 * Optional check: validate this plugin's schemas with the Harness's own
 * validator, which is exactly the code `ctx.tools.register` runs before
 * accepting a tool, and validate one sample result against each output schema.
 *
 *   node test/check-schema.mjs "G:/tokenwork/.../node_modules/@deepseek-ai/dsh-tools/lib/index.js"
 *
 * The bundle itself has no dependencies, so it cannot resolve `@deepseek-ai/*`
 * on its own; pass the path to the installed package. Without a path the check
 * reports that it was skipped and still exits successfully.
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { TOOLS } from '../lib/tool-schema.js';

/** One representative value per tool, shaped like the real result. */
const READ_MESSAGE = {
  mailbox: 'INBOX',
  uid: 12,
  subject: 'hello',
  from: 'a@b.c',
  to: 'me@mail.ustc.edu.cn',
  cc: '',
  date: '2026-10-06T01:15:00.000Z',
  messageId: '<m@ustc.edu.cn>',
  unread: true,
  size: 2048,
  bodyType: 'text/plain',
  bodyCharset: 'UTF-8',
  bodyTruncated: false,
  body: 'body text',
  attachments: [{ filename: 'a.pdf', contentType: 'application/pdf', size: 20 }],
};

const SAMPLES = {
  list: {
    mailbox: 'INBOX',
    exists: 2,
    matched: 2,
    returned: 1,
    preview: 0,
    messages: [{
      uid: 12,
      subject: 'hello',
      from: 'a@b.c',
      date: '2026-10-06T01:15:00.000Z',
      unread: true,
      size: 2048,
      hasAttachments: false,
    }],
  },
  search: {
    mailbox: 'INBOX',
    query: 'subject contains "hello"',
    exists: 2,
    matched: 1,
    returned: 1,
    preview: 200,
    messages: [{
      uid: 12,
      subject: 'hello',
      from: 'a@b.c',
      date: '2026-10-06T01:15:00.000Z',
      unread: false,
      size: 2048,
      hasAttachments: true,
      preview: 'the opening of the body',
    }],
  },
  read: READ_MESSAGE,
  readMany: {
    mailbox: 'INBOX',
    requested: 3,
    returned: 2,
    missing: [99],
    messages: [READ_MESSAGE, { ...READ_MESSAGE, uid: 13 }],
  },
};

const target = process.argv[2] ?? '@deepseek-ai/dsh-tools';

let tools;
try {
  tools = await import(target.startsWith('.') || /^[a-zA-Z]:/.test(target) ? pathToFileURL(target).href : target);
} catch (error) {
  process.stdout.write(`SKIPPED: cannot load ${target} (${error.message})\n`);
  process.exit(0);
}

let failed = false;

for (const tool of TOOLS) {
  for (const [label, schema] of [['parameters', tool.parameters], ['output', tool.outputSchema]]) {
    try {
      tools.assertSupportedJsonSchema(schema);
      process.stdout.write(`${tool.name} ${label}: supported\n`);
    } catch (error) {
      failed = true;
      process.stdout.write(`${tool.name} ${label}: REJECTED — ${error.message}\n`);
    }
  }
  try {
    tools.assertObjectJsonSchema(tool.parameters);
    process.stdout.write(`${tool.name} parameters: object root\n`);
  } catch (error) {
    failed = true;
    process.stdout.write(`${tool.name} parameters: REJECTED — ${error.message}\n`);
  }

  // The registered output schema must actually accept a real-shaped result,
  // otherwise the tool would fail at call time rather than at registration.
  const sample = SAMPLES[tool.operation];
  const violations = tools.validateJsonSchemaValue(tool.outputSchema, sample, '');
  if (violations.length === 0) {
    process.stdout.write(`${tool.name} sample result: accepted\n`);
  } else {
    failed = true;
    process.stdout.write(`${tool.name} sample result: REJECTED — ${violations.join('; ')}\n`);
  }
}

process.exit(failed ? 1 : 0);
