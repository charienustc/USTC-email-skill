/**
 * The projection from a parsed FETCH response to the message metadata both the
 * list and the search operations report.
 */
import { listAttachments, parseBodyStructure } from './bodystructure.js';
import { readMessageHeaders } from './mime.js';

/**
 * Decide whether a message carries an attachment.
 *
 * The parsed body structure is authoritative; the raw text scan is only a
 * fallback for a structure this client could not parse.
 * @param structure - the raw BODYSTRUCTURE text.
 * @param contentDisposition - the decoded top-level Content-Disposition.
 * @returns true when the message carries at least one attachment.
 */
function detectsAttachment(structure, contentDisposition) {
  if (/^attachment\b/i.test(contentDisposition.trim())) return true;
  if (structure === '') return false;
  const tree = parseBodyStructure(structure);
  if (tree === undefined) return /"ATTACHMENT"/i.test(structure);
  return listAttachments(tree).length > 0;
}

/**
 * Turn one fetched message into the metadata the operations report.
 * @param message - a parsed FETCH response.
 * @returns the reported record.
 */
export function toMessage(message) {
  const headers = readMessageHeaders(message.headerBlock);
  const record = {
    uid: message.uid,
    subject: headers.subject,
    from: headers.from,
    date: headers.date,
    unread: !message.seen,
    size: message.size,
    hasAttachments: detectsAttachment(message.structure, headers.contentDisposition),
  };
  if (typeof message.preview === 'string') record.preview = message.preview;
  return record;
}
