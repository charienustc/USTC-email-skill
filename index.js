/**
 * USTC mail tools for DSH.
 *
 * Four read-only tools over IMAP: list mailbox metadata, search it, read one
 * message's text body, and read several at once. Nothing here downloads an
 * attachment, changes a flag, or sends anything.
 *
 * Downloading attachments is deliberately absent: it writes files, which the
 * skill's CLI does with an explicit destination and a sanitized filename. A tool
 * that writes belongs behind the filesystem and permission services, not in a
 * tool set that is otherwise read-only.
 */
import { resolveCredentials } from './lib/credentials.js';
import { renderMailboxList, renderMessage, renderMessages, renderSearchResult } from './lib/format.js';
import { listMailbox, normalizeListArgs } from './lib/list.js';
import { normalizeReadArgs, normalizeReadManyArgs, readMessage, readMessages } from './lib/read.js';
import { normalizeSearchArgs, searchMailbox } from './lib/search.js';
import { TOOLS } from './lib/tool-schema.js';

/** Stable plugin identity. */
export const name = 'ustc-mail';

/** Services this plugin needs. */
export const inject = ['tools'];

/** Argument validation per operation. */
const NORMALIZE = {
  list: normalizeListArgs,
  search: normalizeSearchArgs,
  read: normalizeReadArgs,
  readMany: normalizeReadManyArgs,
};

/** Model-facing text rendering per operation. */
const RENDER = {
  list: renderMailboxList,
  search: renderSearchResult,
  read: renderMessage,
  readMany: renderMessages,
};

/** The operation that actually runs for each tool. */
const EXECUTE = {
  list: listMailbox,
  search: searchMailbox,
  read: readMessage,
  readMany: readMessages,
};

/**
 * Build the executor for one operation.
 * @param operation - `list`, `search`, `read`, or `readMany`.
 * @param settings - the loader row's configuration.
 * @returns an execute function bound to that operation.
 */
function makeExecute(operation, settings) {
  return async (args, exec) => {
    const request = NORMALIZE[operation](args);
    const credentials = await resolveCredentials(settings);
    const connection = {
      host: credentials.host,
      port: credentials.port,
      timeoutMs: credentials.timeoutMs,
      user: credentials.user,
      password: credentials.password,
      signal: exec.signal,
    };
    return EXECUTE[operation]({ ...connection, ...request });
  };
}

/**
 * Register the mail tools.
 * @param ctx - the plugin context; `tools` is injected.
 * @param config - the loader row's configuration.
 */
export function apply(ctx, config) {
  const settings = config === undefined || config === null || typeof config !== 'object' ? {} : config;

  for (const tool of TOOLS) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: {
        schema: tool.outputSchema,
        render: (_args, value) => [{ type: 'text', text: RENDER[tool.operation](value) }],
      },
      isConcurrencySafe: () => true,
      execute: makeExecute(tool.operation, settings),
    });
  }
}
