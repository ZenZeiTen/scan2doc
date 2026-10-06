import { describe, expect, it } from 'vitest';
import type { IDRBlock } from '@scan2doc/core';
import { buildLines, buildParagraphs, familyFromFontName, judgeTextLayer, languageFromText, recognizePdf, type PdfChar } from '../src/index.js';
import { makeBoldHeadingPdf, makeHiddenLayerPdf, makeMixedPdf, makeSparseScanPdf, makeTightJustifiedPdf, TIGHT_LINES } from '../../../test/support/make-pdf.js';

const DPI = 300;
const PT = DPI / 72;

/** A character of `sizePt` text whose left edge is at x px, baseline row at y px. */
const ch = (text: string, x: number, y: number, sizePt = 11, extra: Partial<PdfChar> = {}): PdfChar => ({
  text,
  box: { x, y, width: 0.5 * sizePt * PT, height: 0.7 * sizePt * PT },
  sizePt,
  family: 'Arial',
  bold: false,
  italic: false,
  color: '#000000',
  invisible: false,
  unmapped: false,
  angle: 0,
  spaceBefore: false,
  ...extra,
});

/** Lays a string out left to right as characters; spaces become gaps, not characters. */
function word(s: string, x: number, y: number, sizePt = 11, extra: Partial<PdfChar> = {}): PdfChar[] {
  const out: PdfChar[] = [];
  const advance = 0.55 * sizePt * PT;
  [...s].forEach((c, i) => {
    if (c !== ' ') out.push(ch(c, x + i * advance, y, sizePt, extra));
  });
  return out;
}

const text = (blocks: readonly IDRBlock[]) => blocks.map((b) => ('text' in b ? b.text : '')).join(' ');

describe('familyFromFontName', () => {
  it.each([
    ['ABCDEF+TimesNewRomanPS-BoldItalicMT', 'Times New Roman'],
    ['ArialMT', 'Arial'],
    ['Arial,Bold', 'Arial'],
    ['Helvetica-Bold', 'Helvetica'],
    ['QWERTY+MicrosoftYaHei', 'Microsoft YaHei'],
    ['Calibri-Light', 'Calibri'],
  ])('%s → %s', (raw, family) => expect(familyFromFontName(raw)).toBe(family));
});

describe('judgeTextLayer', () => {
  const many = (n: number, extra: Partial<PdfChar> = {}) => Array.from({ length: n }, (_, i) => ch('a', i * 30, 100, 11, extra));

  it('uses a visible, readable layer', () => {
    expect(judgeTextLayer(many(40), false)).toMatchObject({ usable: true });
  });

  it('ignores a few stray characters (a page number on a scan)', () => {
    expect(judgeTextLayer(many(5), false)).toEqual({ usable: false, chars: [] });
  });

  it('does not trust a hidden OCR layer unless asked to', () => {
    const hidden = many(40, { invisible: true });
    expect(judgeTextLayer(hidden, false).note).toMatch(/hidden OCR text layer/);
    expect(judgeTextLayer(hidden, true).usable).toBe(true);
  });

  it('rejects a broken font encoding above 5% unmapped glyphs', () => {
    const chars = [...many(94), ...many(6, { unmapped: true })];
    expect(judgeTextLayer(chars, false).note).toMatch(/broken font encoding \(6 of 100/);
    expect(judgeTextLayer([...many(96), ...many(4, { unmapped: true })], false).usable).toBe(true);
  });

  it('sends text set at an angle to OCR', () => {
    expect(judgeTextLayer(many(40, { angle: Math.PI / 2 }), false).note).toMatch(/rotated on the page/);
    expect(judgeTextLayer(many(40, { angle: 0.02 }), false).usable).toBe(true); // ~1°: a slightly skewed digital page
  });
});

describe('buildLines and buildParagraphs', () => {
  it('restores word spaces and keeps two columns apart', () => {
    const chars = [...word('Left column text', 100, 200), ...word('Right column', 1400, 200)];
    expect(buildLines(chars, DPI).map((l) => l.text)).toEqual(['Left column text', 'Right column']);
  });

  it('joins a paragraph, splits at blank space, and keeps a bold heading on its own', () => {
    const line = 13 * PT;
    const chars = [
      ...word('Heading', 100, 100, 11, { bold: true }),
      ...word('First line of the body', 100, 100 + 1.4 * line),
      ...word('second line of the body', 100, 100 + 2.4 * line),
      ...word('Another paragraph', 100, 100 + 5 * line),
    ];
    expect(buildParagraphs(buildLines(chars, DPI)).map((p) => [p.text, p.font.bold])).toEqual([
      ['Heading', true],
      ['First line of the body second line of the body', false],
      ['Another paragraph', false],
    ]);
  });
});

describe('languageFromText', () => {
  it.each([
    ['明年我们将在上海开设新的办公室，各个地区的销售都表现良好。', 'chi_sim'],
    ['明年我們將在台北開設新的辦公室，各個地區的銷售都表現良好。', 'chi_tra'],
    ['来年は東京に新しい事務所を開設します。', 'jpn'],
    ['내년에는 서울에 새 사무실을 엽니다.', 'kor'],
    ['Наступного року ми відкриємо нові офіси у Києві.', 'ukr'],
    ['В следующем году мы откроем новые офисы в Москве.', 'rus'],
    ['Tahun depan kami akan membuka kantor baru di Jakarta dan di Surabaya untuk pelanggan.', 'ind'],
  ])('%s → %s', (t, code) => expect(languageFromText(t)).toEqual({ code }));

  it('reports a script no model covers', () => {
    expect(languageFromText('هذا نص عربي طويل بما يكفي ليتم اكتشافه')).toEqual({ unsupported: 'non-Latin' });
  });
});

describe('text layer in whole documents', () => {
  it('re-reads a scan whose hidden OCR layer came from another tool, and trusts it only when asked', async () => {
    const pdf = await makeHiddenLayerPdf();
    const ours = await recognizePdf(pdf, { pages: [0] });
    expect(ours.reports[0]).toMatchObject({ textSource: 'ocr', textNote: expect.stringMatching(/hidden OCR text layer/) });
    expect(text(ours.pages[0]!.blocks)).toContain('Quarterly Report');
    const theirs = await recognizePdf(pdf, { pages: [0], textLayer: 'include-hidden' });
    expect(theirs.reports[0]!.textSource).toBe('pdf');
    // Taken from the hidden layer verbatim, fonts included (OCR cannot know the family).
    expect(text(theirs.pages[0]!.blocks)).toContain('Revenue grew across all regions');
    expect(theirs.pages[0]!.blocks.find((b) => b.type === 'body')).toMatchObject({ font: { family: 'Helvetica', sizePt: 11 } });
  });

  it('OCRs a page that is only partly digital instead of losing the scanned part', async () => {
    const { pages, reports } = await recognizePdf(await makeMixedPdf());
    expect(reports[0]!.textSource).toBe('ocr');
    expect(reports[0]!.textNote).toMatch(/covers only part of the page/);
    const t = text(pages[0]!.blocks);
    expect(t).toContain('Cover note');
    expect(t).toContain('Quarterly Report');
  });

  it('OCRs a digital page whose scanned stamps are too thin to count as pictures', async () => {
    const { pages, reports } = await recognizePdf(await makeSparseScanPdf());
    // Caught by ink coverage, not by the picture check: no strip is a picture region.
    expect(reports[0]!.textNote).toMatch(/covers only part of the page \(\d+% of the ink is outside it\)/);
    expect(reports[0]!.textSource).toBe('ocr');
    expect(pages[0]!.blocks.filter((b) => b.type === 'image')).toEqual([]);
    const t = text(pages[0]!.blocks);
    expect(t).toContain('Cover note for the attached statement.');
    expect(t).toContain('APPROVED FOR PAYMENT');
  });

  it('keeps word spaces in tightly justified text, where the gaps alone are too narrow to show them', async () => {
    const { pages, reports } = await recognizePdf(await makeTightJustifiedPdf());
    expect(reports[0]!.textSource).toBe('pdf');
    expect(text(pages[0]!.blocks)).toBe(TIGHT_LINES.join(' '));
  });

  it('turns a bold line at body size into a heading (weight is known only from the text layer)', async () => {
    const { pages } = await recognizePdf(await makeBoldHeadingPdf());
    expect(pages[0]!.blocks.map((b) => [b.type, 'text' in b ? b.text.slice(0, 13) : ''])).toEqual([
      ['heading_3', 'Payment Terms'],
      ['body', 'This agreemen'],
      ['heading_3', 'Termination'],
      ['body', 'This agreemen'],
    ]);
  });
});
