/**
 * Shared argument validation for the mailbox operations.
 *
 * One place decides what a mailbox name may contain, so the list, search, and
 * read paths cannot drift apart on the rule that matters most for wire safety.
 */

/** Control characters, which must never reach the IMAP wire or a stored value. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Validate a mailbox name.
 *
 * The IMAP layer independently encodes every control character into modified
 * UTF-7, so this is defence in depth rather than the only barrier.
 * @param value - the caller's value, or undefined to take the default.
 * @param fallback - the name to use when the caller did not choose one.
 * @returns the trimmed mailbox name.
 */
export function normalizeFolder(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('"folder" must be a non-empty mailbox name such as "INBOX".');
  }
  const folder = value.trim();
  if (CONTROL_CHARACTERS.test(folder)) {
    throw new Error('"folder" must not contain control characters.');
  }
  return folder;
}

/**
 * Validate an optional bounded integer.
 * @param value - the caller's value, or undefined to take the default.
 * @param name - the argument name, used in the failure message.
 * @param min - smallest accepted value.
 * @param max - largest accepted value.
 * @param fallback - the value to use when the caller did not choose one.
 * @returns the integer, defaulted.
 */
export function normalizeCount(value, name, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`"${name}" must be an integer from ${min} to ${max}.`);
  }
  return value;
}

/**
 * Validate an optional boolean.
 * @param value - the caller's value, or undefined.
 * @param name - the argument name, used in the failure message.
 * @returns the boolean, or undefined when the caller did not choose one.
 */
export function normalizeFlag(value, name) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`"${name}" must be a boolean.`);
  return value;
}
