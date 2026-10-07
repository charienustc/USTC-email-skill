/**
 * Rendering for the mailbox listing: the model-facing text a call produces.
 * Kept separate from the tool definition so it can be exercised directly.
 */

/** @returns a `YYYY-MM-DD HH:mm` local timestamp, or the input when unparseable. */
export function formatDateTime(value) {
  const text = String(value ?? '').trim();
  const parsed = Date.parse(text);
  if (text.length === 0) return 'unknown date';
  if (Number.isNaN(parsed)) return text;
  const date = new Date(parsed);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** @returns a compact byte count such as `12.4 KB`. */
export function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'unknown size';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Render a search result as plain text.
 * @param value - the value returned by the search operation.
 * @returns the text a caller reads.
 */
export function renderSearchResult(value) {
  return `Search: ${value.query.length === 0 ? '(everything)' : value.query}\n${renderMailboxList(value)}`;
}

/**
 * Render a listing result as plain text.
 * @param value - the value returned by the list operation.
 * @returns the text a caller reads.
 */
export function renderMailboxList(value) {
  const scope = value.mailbox === 'INBOX' ? 'INBOX' : `mailbox "${value.mailbox}"`;
  const lines = [
    `${scope}: ${value.exists} message(s) in the mailbox; ${value.matched} matched, newest ${value.returned} returned.`,
  ];
  if (value.messages.length === 0) {
    lines.push('No messages matched.');
    return lines.join('\n');
  }
  const unread = value.messages.filter((message) => message.unread).length;
  lines.push(`${unread} of the returned messages are unread.`);
  const wantsPreview = Number.isInteger(value.preview) && value.preview > 0;
  if (wantsPreview) {
    lines.push(`Each message is followed by the first ${value.preview} characters of its text body.`);
  }
  value.messages.forEach((message, index) => {
    const marks = [message.unread ? 'unread' : 'read'];
    if (message.hasAttachments) marks.push('has attachment');
    lines.push(
      `${index + 1}. [${marks.join(', ')}] ${formatDateTime(message.date)} `
      + `| ${message.from.length === 0 ? 'unknown sender' : message.from} `
      + `| ${message.subject.length === 0 ? '(no subject)' : message.subject} `
      + `| ${formatSize(message.size)} | uid=${message.uid}`,
    );
    if (wantsPreview) {
      const preview = typeof message.preview === 'string' ? message.preview : '';
      lines.push(`   ${preview.length === 0 ? '(no text body)' : preview}`);
    }
  });
  return lines.join('\n');
}

/**
 * Render one read message as plain text.
 * @param value - the value returned by the read operation.
 * @returns the text a caller reads.
 */
export function renderMessage(value) {  const lines = [
    `${value.mailbox} · uid=${value.uid} · ${value.unread ? 'unread' : 'read'} · ${formatSize(value.size)}`,
    `Date: ${formatDateTime(value.date)}`,
    `From: ${value.from.length === 0 ? '(unknown sender)' : value.from}`,
  ];
  if (value.to.length > 0) lines.push(`To: ${value.to}`);
  if (value.cc.length > 0) lines.push(`Cc: ${value.cc}`);
  lines.push(`Subject: ${value.subject.length === 0 ? '(no subject)' : value.subject}`);
  if (value.messageId.length > 0) lines.push(`Message-ID: ${value.messageId}`);

  if (value.attachments.length === 0) {
    lines.push('Attachments: none');
  } else {
    const names = value.attachments
      .map((attachment) => `${attachment.filename.length === 0 ? '(unnamed)' : attachment.filename} `
        + `[${attachment.contentType}, ${formatSize(attachment.size)}]`);
    lines.push(`Attachments (${value.attachments.length}, not downloaded): ${names.join('; ')}`);
  }

  const conversion = value.bodyType === 'text/html'
    ? 'body (converted from HTML)'
    : `body${value.bodyType.length > 0 ? ` (${value.bodyType})` : ''}`;
  lines.push('', `--- ${conversion} ---`, value.body.length === 0 ? '(no text body)' : value.body);
  if (value.bodyTruncated) lines.push('', '[body truncated]');
  return lines.join('\n');
}

/**
 * Render a multi-message read as plain text.
 *
 * Each message keeps the exact shape {@link renderMessage} produces, so a caller
 * that can read one can read the whole batch.
 * @param value - the value returned by the multi-read operation.
 * @returns the text a caller reads.
 */
export function renderMessages(value) {
  const scope = value.mailbox === 'INBOX' ? 'INBOX' : `mailbox "${value.mailbox}"`;
  const lines = [`${scope}: ${value.requested} requested, ${value.returned} returned.`];
  if (value.missing.length > 0) {
    lines.push(`Not in this mailbox: ${value.missing.join(', ')}`);
  }
  if (value.messages.length === 0) {
    lines.push('No messages matched.');
    return lines.join('\n');
  }
  value.messages.forEach((message, index) => {
    lines.push('', `===== ${index + 1} of ${value.messages.length} =====`, renderMessage(message));
  });
  return lines.join('\n');
}

/**
 * Render the result of saving a message's attachments.
 * @param value - the value returned by the attach operation.
 * @returns the text a caller reads.
 */
export function renderAttachmentSave(value) {
  const scope = value.mailbox === 'INBOX' ? 'INBOX' : `mailbox "${value.mailbox}"`;
  const lines = [
    `${scope} · uid=${value.uid}`,
    `Subject: ${value.subject.length === 0 ? '(no subject)' : value.subject}`,
    `Directory: ${value.outDir}`,
  ];

  if (value.requested === 0) {
    lines.push('This message carries no attachments, or none matched the request.');
    return lines.join('\n');
  }

  lines.push(`Saved ${value.saved.length} of ${value.requested} (the mailbox is unchanged):`);
  for (const file of value.saved) {
    lines.push(`  ${file.filename} [${file.contentType}, ${formatSize(file.bytes)}]`);
  }
  for (const skip of value.skipped) {
    lines.push(`  skipped: ${skip.filename} — ${skip.reason}`);
  }
  return lines.join('\n');
}
