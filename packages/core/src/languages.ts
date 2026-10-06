/** Writing systems as Tesseract's orientation-and-script detection (OSD) names them. */
export type Script = 'Latin' | 'Han' | 'Japanese' | 'Hangul' | 'Thai' | 'Cyrillic' | 'Greek' | 'Devanagari';

export interface LanguageInfo {
  /** Tesseract model code, e.g. "chi_sim". */
  code: string;
  /** BCP 47 tag written into documents, e.g. "zh-Hans". */
  bcp47: string;
  name: string;
  script: Script;
  /** Font used for this language's text in the output documents (ships with Windows / Office). */
  font: string;
  /** Word processors keep East Asian text in a separate font and language slot. */
  eastAsian: boolean;
  /** Lines join without a space (no spaces between words in the script). */
  unspaced: boolean;
}

const lang = (
  code: string, bcp47: string, name: string, script: Script, font = 'Calibri', eastAsian = false, unspaced = false,
): LanguageInfo => ({ code, bcp47, name, script, font, eastAsian, unspaced });

/** Every language Scan2Doc ships a model for. */
export const LANGUAGES: readonly LanguageInfo[] = [
  // Asian
  lang('chi_sim', 'zh-Hans', 'Chinese (Simplified)', 'Han', 'Microsoft YaHei', true, true),
  lang('chi_tra', 'zh-Hant', 'Chinese (Traditional)', 'Han', 'Microsoft JhengHei', true, true),
  lang('jpn', 'ja', 'Japanese', 'Japanese', 'Yu Gothic', true, true),
  lang('kor', 'ko', 'Korean', 'Hangul', 'Malgun Gothic', true),
  lang('tha', 'th', 'Thai', 'Thai', 'Leelawadee UI', false, true),
  lang('vie', 'vi', 'Vietnamese', 'Latin'),
  lang('ind', 'id', 'Indonesian', 'Latin'),
  lang('hin', 'hi', 'Hindi', 'Devanagari', 'Nirmala UI'),
  // European
  lang('eng', 'en', 'English', 'Latin'),
  lang('deu', 'de', 'German', 'Latin'),
  lang('fra', 'fr', 'French', 'Latin'),
  lang('spa', 'es', 'Spanish', 'Latin'),
  lang('ita', 'it', 'Italian', 'Latin'),
  lang('por', 'pt', 'Portuguese', 'Latin'),
  lang('nld', 'nl', 'Dutch', 'Latin'),
  lang('pol', 'pl', 'Polish', 'Latin'),
  lang('ces', 'cs', 'Czech', 'Latin'),
  lang('swe', 'sv', 'Swedish', 'Latin'),
  lang('dan', 'da', 'Danish', 'Latin'),
  lang('nor', 'nb', 'Norwegian', 'Latin'),
  lang('fin', 'fi', 'Finnish', 'Latin'),
  lang('hun', 'hu', 'Hungarian', 'Latin'),
  lang('ron', 'ro', 'Romanian', 'Latin'),
  lang('tur', 'tr', 'Turkish', 'Latin'),
  lang('rus', 'ru', 'Russian', 'Cyrillic'),
  lang('ukr', 'uk', 'Ukrainian', 'Cyrillic'),
  lang('ell', 'el', 'Greek', 'Greek'),
];

const byCode = new Map(LANGUAGES.map((l) => [l.code, l]));
const byTag = new Map(LANGUAGES.map((l) => [l.bcp47.toLowerCase(), l]));

export const languageInfo = (code: string): LanguageInfo | undefined => byCode.get(code);

/** Looks a language up by BCP 47 tag ("ja", "zh-Hant"); a bare "zh" means Simplified. */
export function languageForTag(tag: string): LanguageInfo | undefined {
  const t = tag.toLowerCase();
  return byTag.get(t) ?? (t === 'zh' ? byCode.get('chi_sim') : byTag.get(t.split('-')[0]!));
}

/** Regions Office expects with East Asian languages: a bare "ja" maps to Word's region-neutral id (17), not Japanese (1041). */
const EAST_ASIAN_REGION: Readonly<Record<string, string>> = { ja: 'ja-JP', ko: 'ko-KR', 'zh-hans': 'zh-CN', 'zh-hant': 'zh-TW', zh: 'zh-CN' };

/** The tag to write into Office documents: region-qualified for CJK, unchanged otherwise. */
export const officeLanguageTag = (tag: string) => EAST_ASIAN_REGION[tag.toLowerCase()] ?? tag;

/** "eng+deu" → "en"; the first (primary) language names the text. */
export function bcp47For(tesseractLangs: string): string {
  return languageInfo(tesseractLangs.split('+')[0]!)?.bcp47 ?? 'und';
}
