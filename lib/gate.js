/**
 * A process-wide cap on simultaneous IMAP sessions.
 *
 * Every session is its own TLS connection and its own login. Tool calls are
 * declared concurrency-safe, so a model that batches several calls would
 * otherwise open an unbounded number of logins against one mailbox account —
 * which is both a resource problem and exactly the pattern a mail provider
 * treats as abuse.
 */

/** Sessions allowed to exist at once. */
export const MAX_CONCURRENT_SESSIONS = 3;

let active = 0;
let peak = 0;
const waiting = [];

/**
 * Wait for a free session slot.
 * @returns an idempotent release function.
 */
export async function acquireSessionSlot() {
  while (active >= MAX_CONCURRENT_SESSIONS) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  active += 1;
  if (active > peak) peak = active;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
    const next = waiting.shift();
    if (next !== undefined) next();
  };
}

/**
 * @returns how many slots are currently held; used by tests.
 */
export function activeSessionCount() {
  return active;
}

/**
 * @returns the highest number of slots ever held at once; used by tests to
 * prove the cap holds without depending on socket-close timing.
 */
export function peakSessionCount() {
  return peak;
}

/** Forget the observed peak, so one test cannot see another's. */
export function resetGateStats() {
  peak = active;
}
