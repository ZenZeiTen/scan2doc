import { DEFAULT_FONT_FAMILY, languageInfo, type BBox, type FontProps, type IDRTextBlock, type TextBlockType } from '@scan2doc/core';
import type { OcrParagraph } from '../ocr.js';

/**
 * Tesseract's rowHeight (ascender to descender) as a share of the font's em
 * size, measured on Helvetica rendered at known sizes (see text.test.ts).
 */
export const ROW_HEIGHT_PER_EM = 0.97;

/** Size ratios to the document's body text that promote a paragraph to a heading. */
export const ROLE_RATIOS = { title: 1.8, heading_1: 1.4, heading_2: 1.18, heading_3: 1.08 } as const;
/** Headings are short: longer paragraphs stay body text whatever their size. */
const MAX_HEADING_LINES = 3;
const MAX_HEADING_CHARS = 200;

/**
 * Joins OCR lines into one reflowable paragraph: soft line breaks become
 * spaces, and a word hyphenated across a line break is rejoined.
 */
export function joinLines(lines: readonly string[]): string {
  let out = '';
  for (const raw of lines) {
    const line = tidyCjkSpacing(raw.trim());
    if (!line) continue;
    if (!out) out = line;
    else if (/\p{L}-$/u.test(out) && /^\p{Ll}/u.test(line)) out = out.slice(0, -1) + line;
    else if (UNSPACED_END.test(out) && UNSPACED_START.test(line)) out += line;
    else out += ` ${line}`;
  }
  return out;
}

/** Scripts written without spaces between words: a line break there is not a word break. */
const UNSPACED = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}　-〿＀-￯';
const UNSPACED_END = new RegExp(`[${UNSPACED}]$`, 'u');
const UNSPACED_START = new RegExp(`^[${UNSPACED}]`, 'u');
/** Han and kana never have spaces between them; OCR sometimes inserts some. Hangul does use spaces. */
const CJK_GAP = /(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯])[ \t]+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯])/gu;

export const tidyCjkSpacing = (s: string) => s.replace(CJK_GAP, '');

export const median = (xs: readonly number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Font size in points from the paragraph's median line height. */
export function estimateFontPt(p: OcrParagraph, dpi: number): number {
  const heights = p.lines.map((l) => (l.rowHeight > 0 ? l.rowHeight : l.bbox.height * 0.8));
  return (median(heights) / dpi) * 72 / ROW_HEIGHT_PER_EM;
}

const centreInside = (b: BBox, r: BBox) => {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return cx >= r.x && cx <= r.x + r.width && cy >= r.y && cy <= r.y + r.height;
};

/**
 * Drops paragraphs that belong to something else: their centre lies in a
 * table (its cells are read separately) or a picture (text there is the
 * picture's texture or its own lettering).
 */
export function freeParagraphs<P extends { bbox: BBox }>(paragraphs: readonly P[], occupied: readonly BBox[]): P[] {
  return paragraphs.filter((p) => !occupied.some((r) => centreInside(p.bbox, r)));
}

/** A recognised paragraph before document-wide role assignment. */
export interface TextCandidate {
  pageIndex: number;
  bbox: BBox;
  text: string;
  lineCount: number;
  sizePt: number;
  confidence: number;
  align: IDRTextBlock['align'];
  /** Exact font from a PDF text layer; absent for OCR, which can only estimate size. */
  font?: FontProps;
}

/** Centred when the box's middle is within 4% of the page middle and it is clearly narrower than the text column. */
export function alignment(bbox: BBox, pageWidthPx: number): IDRTextBlock['align'] {
  const cx = bbox.x + bbox.width / 2;
  return Math.abs(cx - pageWidthPx / 2) <= 0.04 * pageWidthPx && bbox.width <= 0.75 * pageWidthPx ? 'center' : 'left';
}

export function toCandidate(p: OcrParagraph, pageIndex: number, pageWidthPx: number, dpi: number): TextCandidate {
  return {
    pageIndex,
    bbox: p.bbox,
    text: joinLines(p.lines.map((l) => l.text)),
    lineCount: p.lines.length,
    sizePt: estimateFontPt(p, dpi),
    confidence: Math.max(0, Math.min(1, p.confidence / 100)),
    align: alignment(p.bbox, pageWidthPx),
  };
}

/** Body size: the median size weighted by characters, so long paragraphs dominate. */
export function bodySizePt(candidates: readonly TextCandidate[]): number {
  const weighted = candidates.flatMap((c) => Array<number>(Math.min(c.text.length, 2000)).fill(c.sizePt));
  return weighted.length ? median(weighted) : 11;
}

/**
 * Assigns roles from size relative to body text. Only the largest qualifying
 * paragraph on the first page becomes the title; other very large ones are
 * heading 1. Bold-only headings at body size cannot be told apart from body
 * text without a layout model and stay body.
 */
export function assignRoles(candidates: readonly TextCandidate[]): TextBlockType[] {
  const body = bodySizePt(candidates);
  const short = (c: TextCandidate) => c.lineCount <= MAX_HEADING_LINES && c.text.length <= MAX_HEADING_CHARS;
  // Weight is known only from a text layer; there a short bold paragraph at body
  // size is a heading, unless the body text itself is set bold.
  const bodyIsBold = candidates.filter((c) => c.font && !short(c)).some((c) => c.font!.bold);
  const roles = candidates.map((c): TextBlockType => {
    const r = c.sizePt / body;
    if (!short(c)) return 'body';
    if (r >= ROLE_RATIOS.heading_1) return 'heading_1';
    if (r >= ROLE_RATIOS.heading_2) return 'heading_2';
    if (r >= ROLE_RATIOS.heading_3) return 'heading_3';
    if (c.font?.bold && !bodyIsBold && r >= 0.95) return 'heading_3';
    return 'body';
  });
  let title = -1;
  candidates.forEach((c, i) => {
    if (c.pageIndex === 0 && short(c) && c.sizePt / body >= ROLE_RATIOS.title && (title < 0 || c.sizePt > candidates[title]!.sizePt)) title = i;
  });
  if (title >= 0) roles[title] = 'title';
  return roles;
}

/** Rounds to the half point, as type sizes are set. */
export const roundPt = (pt: number) => Math.max(1, Math.round(pt * 2) / 2);

/** `languages` is the Tesseract set the page was read with ("jpn+eng"); its first entry picks the font. */
export function toTextBlock(c: TextCandidate, role: TextBlockType, id: string, languages = 'eng'): IDRTextBlock {
  const family = languageInfo(languages.split('+')[0]!)?.font ?? DEFAULT_FONT_FAMILY;
  return {
    id,
    type: role,
    bbox: c.bbox,
    confidence: c.confidence,
    text: c.text,
    align: c.align,
    // A text layer's font is the truth; OCR gets the language's font, a measured size, and bold for headings.
    font: c.font ?? { family, sizePt: roundPt(c.sizePt), bold: role !== 'body', italic: false, underline: false, color: '#000000' },
  };
}
