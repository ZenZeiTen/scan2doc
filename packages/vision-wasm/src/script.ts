import { identifyLatin } from './languages.js';

/**
 * Frequent characters that differ between Simplified and Traditional Chinese
 * (same position in both strings). A digital text layer says exactly which
 * forms the author used, so counting them decides the variant.
 */
const SIMPLIFIED = '们这个来会时为说对学发经长区销现开设将务业产东车见门问间么过动还进关从实体应点机当无头种样电话报认记让总计员国书买卖写华页网线级';
const TRADITIONAL = '們這個來會時為說對學發經長區銷現開設將務業產東車見門問間麼過動還進關從實體應點機當無頭種樣電話報認記讓總計員國書買賣寫華頁網線級';

const count = (text: string, set: string) => [...text].filter((c) => set.includes(c)).length;

/** Share of letters in each script. */
function scripts(text: string) {
  const tally = { latin: 0, han: 0, kana: 0, hangul: 0, thai: 0, cyrillic: 0, greek: 0, devanagari: 0, other: 0 };
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    if (/\p{Script=Latin}/u.test(ch)) tally.latin++;
    else if (/\p{Script=Han}/u.test(ch)) tally.han++;
    else if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(ch)) tally.kana++;
    else if (/\p{Script=Hangul}/u.test(ch)) tally.hangul++;
    else if (/\p{Script=Thai}/u.test(ch)) tally.thai++;
    else if (/\p{Script=Cyrillic}/u.test(ch)) tally.cyrillic++;
    else if (/\p{Script=Greek}/u.test(ch)) tally.greek++;
    else if (/\p{Script=Devanagari}/u.test(ch)) tally.devanagari++;
    else tally.other++;
  }
  return tally;
}

/**
 * The Tesseract code for a page's text, judged from the characters
 * themselves (no OCR involved). `unsupported` when the page is mostly in a
 * script no shipped model covers, so the caller can report it.
 */
export function languageFromText(text: string): { code: string } | { unsupported: string } {
  const t = scripts(text);
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  if (total === 0) return { code: 'eng' };
  if (t.other / total > 0.5) return { unsupported: 'non-Latin' };
  // Japanese mixes kana with Han; any real share of kana settles it.
  if (t.kana > 0.05 * (t.kana + t.han) && t.kana + t.han > 0.3 * total) return { code: 'jpn' };
  const [top] = (Object.entries(t) as [keyof typeof t, number][]).filter(([k]) => k !== 'other').sort((a, b) => b[1] - a[1]);
  switch (top![0]) {
    case 'han':
      return { code: count(text, TRADITIONAL) > count(text, SIMPLIFIED) ? 'chi_tra' : 'chi_sim' };
    case 'hangul':
      return { code: 'kor' };
    case 'thai':
      return { code: 'tha' };
    case 'greek':
      return { code: 'ell' };
    case 'devanagari':
      return { code: 'hin' };
    case 'cyrillic':
      // і ї є ґ are Ukrainian letters Russian does not use.
      return { code: /[іїєґІЇЄҐ]/u.test(text) ? 'ukr' : 'rus' };
    default:
      return { code: identifyLatin(text).code };
  }
}
