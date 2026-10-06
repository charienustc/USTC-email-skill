/**
 * Attaching a short body preview to each message of a listing.
 *
 * This is what makes a digest affordable: the listing has already fetched every
 * message's BODYSTRUCTURE, so a preview costs one section fetch per message over
 * the session that is already open, instead of one full connection per message.
 *
 * Read-only, like everything else here: the section fetch uses `BODY.PEEK`.
 */
import { extractTextBody } from './read.js';

/** Largest preview a caller may ask for. */
export const MAX_PREVIEW_CHARS = 600;

/** Most bytes ever pulled per message to build a preview. */
const PREVIEW_BYTE_BUDGET = 64 * 1024;

/**
 * Bytes worth fetching to produce `chars` of readable text.
 *
 * Markup and transfer encoding both inflate the payload, so this asks for
 * several times the character count and caps the result.
 * @param chars - the requested preview length in characters.
 * @returns the fetch cap in bytes.
 */
function byteBudget(chars) {
  return Math.min(PREVIEW_BYTE_BUDGET, Math.max(4096, chars * 6 + 1024));
}

/**
 * Attach a flat, single-paragraph `preview` to each record.
 *
 * A body that cannot be read leaves that message's preview empty rather than
 * failing the listing: one broken message must not hide the other nineteen.
 * @param session - a session with the mailbox already selected.
 * @param records - parsed FETCH records, in the order the caller wants them.
 * @param chars - preview length in characters; 0 or less does nothing.
 * @returns the same records, each carrying `preview` when `chars` is positive.
 */
export async function attachPreviews(session, records, chars) {
  if (!Number.isInteger(chars) || chars <= 0) return records;

  const maxBytes = byteBudget(chars);
  for (const record of records) {
    try {
      const text = await extractTextBody(session, record, { maxChars: chars, maxBytes });
      record.preview = text.body.replace(/\s+/g, ' ').trim();
    } catch {
      record.preview = '';
    }
  }
  return records;
}
