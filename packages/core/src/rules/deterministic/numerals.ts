/** Chinese numeral handling, shared by the counting and reference rules. */

const DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  壹: 1,
  二: 2,
  两: 2,
  贰: 2,
  三: 3,
  叁: 3,
  四: 4,
  肆: 4,
  五: 5,
  伍: 5,
  六: 6,
  陆: 6,
  七: 7,
  柒: 7,
  八: 8,
  捌: 8,
  九: 9,
  玖: 9,
};

export const CHINESE_DIGIT_CHARS = Object.keys(DIGITS).join('') + '十拾';

/**
 * Parses a Chinese numeral up to 99, or an Arabic one.
 *
 * Returns null for anything it is not sure about. Counting rules act on the
 * result, so "probably 20-something" is worse than no answer at all.
 */
export function parseNumeral(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;

  if (/^\d+$/u.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  }

  const TEN = /[十拾]/u;
  if (!TEN.test(s)) {
    // A run of single digits: 三 -> 3. Multi-digit runs like 一二 are
    // ambiguous (twelve? one-two?), so refuse them.
    if (s.length !== 1) return null;
    const d = DIGITS[s];
    return d ?? null;
  }

  const idx = s.search(TEN);
  const headRaw = s.slice(0, idx);
  const tailRaw = s.slice(idx + 1);

  let tens = 1;
  if (headRaw !== '') {
    if (headRaw.length !== 1) return null;
    const h = DIGITS[headRaw];
    if (h === undefined || h === 0) return null;
    tens = h;
  }

  let ones = 0;
  if (tailRaw !== '') {
    if (tailRaw.length !== 1) return null;
    const t = DIGITS[tailRaw];
    if (t === undefined) return null;
    ones = t;
  }

  return tens * 10 + ones;
}
