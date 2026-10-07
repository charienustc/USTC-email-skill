/**
 * USTC mail tools for DSH, plus the HTTP route the sidebar panel reads.
 *
 * Four read-only tools over IMAP: list mailbox metadata, search it, read one
 * message's text body, and read several at once. Nothing here downloads an
 * attachment, changes a flag, or sends anything.
 *
 * Downloading attachments is deliberately absent from the tool set: it writes
 * files, which the skill's CLI does with an explicit destination and a sanitized
 * filename. A tool that writes belongs behind the filesystem and permission
 * services, not in a tool set that is otherwise read-only.
 *
 * The route exists because a plain-JavaScript Client half cannot import a
 * Harness Client package and no Client service carries mail. It is registered
 * only where a web server exists, so a headless profile still loads this plugin
 * for its tools alone.
 */
import { renderMailboxList, renderMessage, renderMessages, renderSearchResult } from './lib/format.js';
import { resolveCredentials } from './lib/credentials.js';
import { listMailbox, normalizeListArgs } from './lib/list.js';
import { normalizeReadArgs, normalizeReadManyArgs, readMessage, readMessages } from './lib/read.js';
import { normalizeSearchArgs, searchMailbox } from './lib/search.js';
import { TOOLS } from './lib/tool-schema.js';

/** Stable plugin identity. */
export const name = 'ustc-mail';

/** Services this plugin needs. `webServer` is taken optionally in `apply`. */
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

/** Route prefix the Client half calls. Keep in sync with plugin/client.js. */
const API_PREFIX = '/ustc-mail/api';

/** Bigger than any panel needs; the route is same-origin and read-only. */
const MAX_LIMIT = 100;

/** Body characters a panel preview may ask for. */
const MAX_PREVIEW_CHARS = 20000;

/** Answer one route call with JSON. */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Clamp a query value to an integer range. */
function clampInt(raw, fallback, min, max) {
  const value = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/**
 * Handle one panel request.
 *
 * Credentials are resolved per request rather than at activation, so the panel
 * reports "not configured" instead of the plugin failing to load.
 *
 * The two seams exist so the route can be driven without a live mail server:
 * the tests substitute both, and a deployment could substitute the transport.
 * Production calls pass neither and get the real implementations.
 * @param settings - the loader row's configuration.
 * @param seams - `resolve` and `execute` overrides.
 * @returns a route handler.
 */
export function makeRouteHandler(settings, seams = {}) {
  const resolve = seams.resolve ?? resolveCredentials;
  const execute = seams.execute ?? EXECUTE;

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const action = url.pathname.slice(API_PREFIX.length).replace(/^\//, '');
      const credentials = await resolve(settings);
      const connection = {
        host: credentials.host,
        port: credentials.port,
        timeoutMs: credentials.timeoutMs,
        user: credentials.user,
        password: credentials.password,
      };
      const limit = clampInt(url.searchParams.get('limit'), 30, 1, MAX_LIMIT);

      if (action === 'list') {
        const value = await execute.list({ ...connection, ...normalizeListArgs({ limit }) });
        sendJson(res, 200, value);
        return;
      }
      if (action === 'search') {
        // The panel always searches subject-or-body: a person typing a word into
        // a mail panel does not know which field holds it.
        const anywhere = url.searchParams.get('anywhere') ?? '';
        const value = await execute.search({
          ...connection,
          ...normalizeSearchArgs({ anywhere, limit }),
        });
        sendJson(res, 200, value);
        return;
      }
      if (action === 'read') {
        const uid = clampInt(url.searchParams.get('uid'), 0, 1, Number.MAX_SAFE_INTEGER);
        const maxChars = clampInt(url.searchParams.get('maxChars'), 4000, 500, MAX_PREVIEW_CHARS);
        const value = await execute.read({
          ...connection,
          ...normalizeReadArgs({ uid, maxChars }),
        });
        sendJson(res, 200, value);
        return;
      }
      sendJson(res, 404, { error: `Unknown route ${action}` });
    } catch (error) {
      // The panel shows this text, so keep it to the message; never a stack and
      // never any part of the credential.
      sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  };
}

/**
 * Register the mail tools, and the panel route where a web server exists.
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

  // Optional on purpose: a profile with no web server must still get the tools.
  ctx.inject(['webServer'], (webCtx) => {
    const handler = makeRouteHandler(settings);
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler,
    }));
  });
}