/**
 * A tiny fake IMAP server for local tests.
 *
 * It speaks just enough of the protocol for the client's read path, on plain TCP,
 * so the tests can exercise the real client code without TLS or a live account.
 */
import net from 'node:net';

const CRLF = Buffer.from('\r\n', 'latin1');

/**
 * Split an IMAP search key into tokens, handling quoted strings and the `{n}`
 * literals the client sends for non-ASCII terms.
 * @param text - the raw search key after the command.
 * @returns the token list.
 */
function tokenizeSearch(text) {
  const tokens = [];
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === ' ' || char === '\t') {
      index += 1;
      continue;
    }
    if (char === '"') {
      let out = '';
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          out += text[index + 1];
          index += 2;
          continue;
        }
        if (text[index] === '"') {
          index += 1;
          break;
        }
        out += text[index];
        index += 1;
      }
      tokens.push(out);
      continue;
    }
    if (char === '{') {
      const marker = /^\{(\d+)\}/.exec(text.slice(index));
      if (marker !== null) {
        const start = index + marker[0].length;
        const length = Number.parseInt(marker[1], 10);
        tokens.push(text.slice(start, start + length));
        index = start + length;
        continue;
      }
    }
    const start = index;
    while (index < text.length && text[index] !== ' ' && text[index] !== '(' && text[index] !== ')') {
      index += 1;
    }
    tokens.push(text.slice(start, index));
  }
  return tokens.filter((token) => token.length > 0);
}

/**
 * Evaluate the subset of search keys the tests use.
 * @param message - the fixture.
 * @param tokens - the tokenized search key.
 * @returns whether the fixture matches.
 */
function matchesSearch(message, tokens) {
  const headers = String(message.headers ?? '');
  let matched = true;
  let index = 0;
  while (index < tokens.length) {
    const key = String(tokens[index]).toUpperCase();
    if (key === 'CHARSET') {
      index += 2;
      continue;
    }
    if (key === 'ALL') {
      index += 1;
      continue;
    }
    if (key === 'UNSEEN') {
      if (message.seen === true) matched = false;
      index += 1;
      continue;
    }
    if (key === 'SUBJECT' || key === 'FROM' || key === 'TO') {
      const value = String(tokens[index + 1] ?? '');
      const re = new RegExp(`^${key.toLowerCase()}:([\\s\\S]*?)(?=\\r\\n\\S|\\r\\n\\r\\n|$)`, 'im');
      const found = re.exec(headers);
      if (found === null || !found[1].includes(value)) matched = false;
      index += 2;
      continue;
    }
    // SINCE/BEFORE and anything else the fixtures do not model: ignore.
    index += /^[A-Za-z]+$/.test(String(tokens[index])) && index + 1 < tokens.length ? 2 : 1;
  }
  return matched;
}

/**
 * Start the fake server on an ephemeral loopback port.
 * @param options - credentials, mailbox size, and message fixtures.
 * @returns the port, a close function, and the last search key seen.
 */
export async function startFakeServer(options) {
  const {
    user,
    password,
    messages,
    exists = messages.length,
    misbehave = '',
  } = options;
  const state = { lastSearch: '', commands: [], openConnections: 0, maxConcurrentConnections: 0 };

  const server = net.createServer((socket) => {
    state.openConnections += 1;
    state.maxConcurrentConnections = Math.max(state.maxConcurrentConnections, state.openConnections);
    socket.on('close', () => {
      state.openConnections -= 1;
    });
    socket.write('* OK [CAPABILITY IMAP4rev1] fake Coremail ready\r\n');

    // A server that tries to make the client buffer without bound.
    if (misbehave === 'long-line') socket.write('x'.repeat(2 * 1024 * 1024));
    if (misbehave === 'huge-literal') socket.write('{999999999}\r\n');

    let buffer = Buffer.alloc(0);
    let lineBuffer = Buffer.alloc(0);
    let literalRemaining = 0;

    const handle = (text) => {
      state.commands.push(text);
      const match = /^(\S+) (\S+)(?: (.*))?$/.exec(text);
      if (match === null) return;
      const [, tag, rawCommand, rawRest] = match;
      const command = rawCommand.toUpperCase();
      const rest = rawRest ?? '';

      if (command === 'LOGIN') {
        if (rest.includes(user) && rest.includes(password)) {
          socket.write(`${tag} OK LOGIN completed\r\n`);
        } else {
          socket.write(`${tag} NO LOGIN failed: authentication rejected\r\n`);
        }
        return;
      }
      if (command === 'SELECT' || command === 'EXAMINE') {
        const mode = command === 'EXAMINE' ? '[READ-ONLY]' : '[READ-WRITE]';
        socket.write(`* ${exists} EXISTS\r\n`);
        socket.write('* 0 RECENT\r\n');
        socket.write('* FLAGS (\\Seen \\Answered \\Flagged)\r\n');
        socket.write(`* OK [PERMANENTFLAGS (${command === 'EXAMINE' ? '' : '\\Seen \\Answered'})] flags\r\n`);
        socket.write('* OK [UIDVALIDITY 7] UIDs valid\r\n');
        socket.write(`${tag} OK ${mode} ${command} completed\r\n`);
        return;
      }
      if (command === 'UID') {
        const sub = rest.split(' ')[0].toUpperCase();
        if (sub === 'SEARCH') {
          const criteria = rest.slice(rest.indexOf(' ') + 1);
          state.lastSearch = criteria;
          const tokens = tokenizeSearch(criteria);
          const uids = messages
            .filter((message) => matchesSearch(message, tokens))
            .map((message) => message.uid);
          socket.write(`* SEARCH ${uids.join(' ')}\r\n`);
          socket.write(`${tag} OK SEARCH completed\r\n`);
          return;
        }
        if (sub === 'FETCH') {
          const query = rest.slice(rest.indexOf(' ') + 1);
          const splitAt = query.indexOf(' ');
          const uidList = (splitAt < 0 ? query : query.slice(0, splitAt))
            .split(',')
            .map((entry) => Number.parseInt(entry, 10))
            .filter((entry) => Number.isInteger(entry));
          const items = splitAt < 0 ? '' : query.slice(splitAt + 1);
          const requested = /BODY(?:\.PEEK)?\[([^\]]*)\](?:<0\.(\d+)>)?/i.exec(items);
          const section = requested === null ? '' : requested[1];

          // A non-header section means a body-part fetch, one message at a time.
          if (section !== '' && !/^HEADER/i.test(section)) {
            const message = messages.find((candidate) => candidate.uid === uidList[0]);
            if (message === undefined) {
              socket.write(`${tag} OK FETCH completed\r\n`);
              return;
            }
            const source = message.sections?.[section] ?? '';
            const full = Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8');
            const limit = requested[2] === undefined ? 0 : Number.parseInt(requested[2], 10);
            const body = limit > 0 && limit < full.length ? full.subarray(0, limit) : full;
            const partial = limit > 0 ? '<0>' : '';
            socket.write(
              `* 1 FETCH (UID ${message.uid} BODY[${section}]${partial} {${body.length}}\r\n`,
            );
            socket.write(body);
            socket.write(')\r\n');
            socket.write(`${tag} OK FETCH completed\r\n`);
            return;
          }

          uidList.forEach((uid, index) => {
            const message = messages.find((candidate) => candidate.uid === uid);
            if (message === undefined) return;
            const flags = message.seen ? '\\Seen' : '';
            const headerBytes = Buffer.from(message.headers, 'utf8');
            const headerItem = /^HEADER$/i.test(section)
              ? 'BODY[HEADER]'
              : 'BODY[HEADER.FIELDS (FROM SUBJECT DATE CONTENT-DISPOSITION)]';
            socket.write(
              `* ${index + 1} FETCH (UID ${message.uid} FLAGS (${flags}) RFC822.SIZE ${message.size} `
              + `BODYSTRUCTURE ${message.structure} ${headerItem} `
              + `{${headerBytes.length}}\r\n`,
            );
            socket.write(headerBytes);
            socket.write(')\r\n');
          });
          socket.write(`${tag} OK FETCH completed\r\n`);
          return;
        }
      }
      if (command === 'LOGOUT') {
        socket.write(`* BYE\r\n${tag} OK LOGOUT completed\r\n`);
        socket.end();
        return;
      }
      socket.write(`${tag} BAD unknown command\r\n`);
    };

    const pump = () => {
      for (;;) {
        if (literalRemaining > 0) {
          if (buffer.length === 0) return;
          const take = Math.min(literalRemaining, buffer.length);
          lineBuffer = Buffer.concat([lineBuffer, buffer.subarray(0, take)]);
          buffer = buffer.subarray(take);
          literalRemaining -= take;
          continue;
        }
        const end = buffer.indexOf(CRLF);
        if (end < 0) return;
        lineBuffer = Buffer.concat([lineBuffer, buffer.subarray(0, end)]);
        buffer = buffer.subarray(end + 2);
        const text = lineBuffer.toString('utf8');
        const announcement = /\{(\d+)\}$/.exec(text);
        if (announcement !== null) {
          literalRemaining = Number.parseInt(announcement[1], 10);
          // A real server invites the literal before the client sends it.
          socket.write('+ Ready for literal data\r\n');
          continue;
        }
        lineBuffer = Buffer.alloc(0);
        if (text.trim().length > 0) handle(text);
      }
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });
    socket.on('error', () => {
      /* the test tears the connection down. */
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    port,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
