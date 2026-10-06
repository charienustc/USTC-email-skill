/**
 * USTC mail tools for DSH.
 *
 * Three read-only tools over IMAP: list mailbox metadata, search it, and read one
 * message's text body. Nothing here downloads an attachment, changes a flag, or
 * sends anything.
 */
import { resolveCredentials } from './lib/credentials.js';
import { renderMailboxList, renderMessage, renderSearchResult } from './lib/format.js';
import { listMailbox, normalizeListArgs } from './lib/list.js';
import { normalizeReadArgs, readMessage } from './lib/read.js';
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
};

/** Model-facing text rendering per operation. */
const RENDER = {
  list: renderMailboxList,
  search: renderSearchResult,
  read: renderMessage,
};

/**
 * Build the executor for one operation.
 * @param operation - `list`, `search`, or `read`.
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
    if (operation === 'read') return readMessage({ ...connection, ...request });
    if (operation === 'search') return searchMailbox({ ...connection, ...request });
    return listMailbox({ ...connection, ...request });
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
