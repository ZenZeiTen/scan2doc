import { LANGUAGES, type Script } from '@scan2doc/core';

/**
 * Which models to try for a script OSD reports. Each entry is one candidate
 * language set; when there are several, every one is run and the most
 * confident wins. Non-Latin scripts add English, which business documents
 * mix in constantly. Latin is resolved separately by identifyLatin.
 */
export const SCRIPT_CANDIDATES: Readonly<Record<Exclude<Script, 'Latin'>, readonly string[]>> = {
  Han: ['chi_sim+eng', 'chi_tra+eng'],
  Japanese: ['jpn+eng'],
  Hangul: ['kor+eng'],
  Thai: ['tha+eng'],
  Cyrillic: ['rus+eng', 'ukr+eng'],
  Greek: ['ell+eng'],
  Devanagari: ['hin+eng'],
};

/** OSD names some scripts more finely than the model set needs. */
const OSD_SCRIPT_ALIASES: Readonly<Record<string, Script>> = {
  Latin: 'Latin',
  Han: 'Han',
  Japanese: 'Japanese',
  Hiragana: 'Japanese',
  Katakana: 'Japanese',
  Hangul: 'Hangul',
  Korean: 'Hangul',
  Thai: 'Thai',
  Cyrillic: 'Cyrillic',
  Greek: 'Greek',
  Devanagari: 'Devanagari',
};

export const scriptFromOsd = (name: string): Script | undefined => OSD_SCRIPT_ALIASES[name];

/**
 * Frequent function words per Latin-script language, accents folded away:
 * the first OCR pass runs in English, which drops or misreads diacritics, so
 * matching must not depend on them.
 */
const FUNCTION_WORDS: Readonly<Record<string, string>> = {
  eng: 'the and of to in is that for it with as was on are this be by from have not',
  deu: 'der die und das ist nicht ein eine mit den von zu sich auf dem des fur ich sie wir auch im',
  fra: 'le la les et des est une un pour dans que qui sur pas au du avec ce il elle nous sont aux',
  spa: 'el la los las de que y en un una es por con para del al se no lo como mas pero',
  ita: 'il lo la gli le di che e un una per con non sono del della nel alla si anche',
  por: 'o a os as de que e um uma para com nao do da em no na se por mais dos',
  nld: 'de het een en van is dat niet op te zijn met voor die er ook aan wordt naar',
  pol: 'i w na z do nie jest sie to ze jak dla oraz przez od czy ale po',
  ces: 'a je v na se ze to s z do jako pro ale tak by ve podle jsou',
  swe: 'och att det som en ar av for med till den har inte pa om var',
  dan: 'og at det er en af til for med den som har ikke pa de blev',
  nor: 'og at det er en av til for med den som har ikke pa de ble',
  fin: 'ja on ei se etta han oli ovat kun mutta myos tai joka sen',
  hun: 'a az es egy hogy nem van meg is de mint csak ezt volt',
  ron: 'si in de la cu o un este care pe din pentru nu sunt mai',
  tur: 've bir bu da de icin ile ne gibi daha cok olan ama',
  ind: 'yang dan di ke dari ini itu untuk dengan pada adalah dalam tidak akan juga atau ada oleh kami kita mereka sudah telah bisa karena sebagai',
  // Vietnamese words are single syllables; the frequent ones are mostly short.
  vie: 'va cua co cac trong la mot nhung duoc cho khong voi nay de da se toi chung tai nam moi tat ca khi nguoi nhieu ve theo dang phai cung ra thi lai nhu',
};

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const LISTS = Object.entries(FUNCTION_WORDS).map(([code, words]) => [code, new Set(words.split(' '))] as const);

/** Text with fewer words than this is too short to identify; English is assumed. */
const MIN_WORDS = 8;

export interface LanguageGuess {
  code: string;
  /** Share of words that are function words of the winning language. */
  score: number;
}

/**
 * Identifies a Latin-script language from its function words. Returns English
 * when the text is short or no language clearly leads.
 */
export function identifyLatin(text: string): LanguageGuess {
  const words = fold(text).match(/\p{L}+/gu) ?? [];
  if (words.length < MIN_WORDS) return { code: 'eng', score: 0 };
  const scores = LISTS.map(([code, list]) => ({ code, score: words.filter((w) => list.has(w)).length / words.length }));
  scores.sort((a, b) => b.score - a.score);
  const [best, second] = scores as [LanguageGuess, LanguageGuess];
  if (best.score < MIN_SCORE) return { code: 'eng', score: best.score };
  // A tie with English stays English; a tie between two others (Danish and
  // Norwegian share most function words) keeps the first, as they OCR alike.
  if (best.score === second.score && second.code === 'eng') return second;
  return best;
}

/** Below this share of function words the text is not identified (lists, numbers, names). */
const MIN_SCORE = 0.1;

export const ALL_LANGUAGE_CODES = LANGUAGES.map((l) => l.code);
