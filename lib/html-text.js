/**
 * A deliberately small HTML-to-text conversion.
 *
 * This is not a browser and not a full HTML parser: it exists so that an
 * HTML-only notification mail is readable in a terminal instead of arriving as a
 * wall of tags. Structure is approximated, and the caller is told so.
 */

/** Named entities worth handling; the rest fall through to the numeric forms. */
const NAMED_ENTITIES = new Map([
  ['nbsp', ' '],
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['#39', "'"],
  ['ldquo', '\u201c'],
  ['rdquo', '\u201d'],
  ['lsquo', '\u2018'],
  ['rsquo', '\u2019'],
  ['hellip', '\u2026'],
  ['mdash', '\u2014'],
  ['ndash', '\u2013'],
  ['middot', '\u00b7'],
  ['copy', '\u00a9'],
  ['reg', '\u00ae'],
  ['trade', '\u2122'],
  ['times', '\u00d7'],
  ['yen', '\u00a5'],
  ['euro', '\u20ac'],
  ['deg', '\u00b0'],
]);

/**
 * Decode character references.
 * @param text - text containing `&...;` references.
 * @returns the decoded text.
 */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    const key = body.toLowerCase();
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES.get(key) ?? whole;
  });
}

/** Elements whose end implies a line break. */
const BLOCK_END = /<\/(p|div|section|article|header|footer|tr|table|blockquote|pre|h[1-6]|ul|ol|dl|li|dd|dt)\s*>/gi;

/**
 * Convert HTML to readable plain text.
 *
 * Script and style content is dropped, block boundaries become newlines, list
 * items gain a bullet, and runs of blank lines collapse.
 * @param html - the HTML source.
 * @returns plain text.
 */
export function htmlToText(html) {
  let text = String(html ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(td|th)\b[^>]*>/gi, '\t')
    .replace(BLOCK_END, '\n')
    .replace(/<[^>]*>/g, '');

  text = decodeEntities(text);
  text = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}
