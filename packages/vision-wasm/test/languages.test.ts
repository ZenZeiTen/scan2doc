import { describe, expect, it } from 'vitest';
import type { IDRBlock } from '@scan2doc/core';
import { identifyLatin, joinLines, recognizePdf, tidyCjkSpacing } from '../src/index.js';
import { simulateScan } from '../../../test/support/make-pdf.js';
import { charRecall, fontAvailable, makeLanguagePdf, makeRotatedPdf, SAMPLES } from '../../../test/support/multilingual.js';

const textOf = (blocks: readonly IDRBlock[]) =>
  blocks.map((b) => (b.type === 'table' ? b.cells.map((c) => c.text).join(' ') : b.type === 'image' ? '' : b.text)).join(' ');

describe('automatic language detection and OCR of scanned pages', () => {
  // System fonts render the samples; on a machine without them the test fails visibly, not silently.
  it.each(SAMPLES.map((s) => [s.code, s] as const))('%s', async (code, sample) => {
    if (!fontAvailable(sample.font)) return expect.soft(`font ${sample.font} missing`).toBe('present');
    // Image-only at 300 dpi, as a scanner delivers it: no text layer, so this is OCR.
    const { pages, reports } = await recognizePdf(await simulateScan(await makeLanguagePdf(sample), 300, 85, 0));
    expect(reports[0]!.textSource).toBe('ocr');
    expect(reports[0]!.languages.split('+')[0]).toBe(code);
    const recall = charRecall([...sample.lines, ...sample.lines].join(''), textOf(pages[0]!.blocks));
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(reports[0]!.escalation).toBe('not-needed');
  });
});

describe('language of digital PDFs, from their text layer', () => {
  it.each(SAMPLES.map((s) => [s.code, s] as const))('%s', async (code, sample) => {
    if (!fontAvailable(sample.font)) return expect.soft(`font ${sample.font} missing`).toBe('present');
    const { pages, reports } = await recognizePdf(await makeLanguagePdf(sample));
    expect(reports[0]!.textSource).toBe('pdf');
    expect(reports[0]!.languages).toBe(code);
    // The text is the PDF's own: every character comes back.
    expect(charRecall([...sample.lines, ...sample.lines].join(''), textOf(pages[0]!.blocks))).toBeGreaterThanOrEqual(0.99);
  });
});

describe('page orientation', () => {
  // `turn` is how far the content is turned clockwise; the fix turns it back, i.e. (360 − turn)° clockwise.
  it.each([180, 90, 270] as const)('reads a page whose content is turned %i° clockwise', async (turn) => {
    const { pages, reports } = await recognizePdf(await makeRotatedPdf(turn));
    // The text layer is set at an angle, so the page goes to OCR, which turns it upright first.
    if (turn !== 180) expect(reports[0]!.textNote).toMatch(/rotated on the page/);
    expect(reports[0]!.textSource).toBe('ocr');
    expect(reports[0]!.rotation).toBe((360 - turn) % 360);
    expect(textOf(pages[0]!.blocks)).toContain('approved the annual budget');
    const portrait = turn === 180;
    expect(pages[0]!.sizeMm.width < pages[0]!.sizeMm.height).toBe(portrait);
  });
});

describe('explicit languages', () => {
  it('reads with the languages given and skips detection', async () => {
    const kor = SAMPLES.find((s) => s.code === 'kor')!;
    if (!fontAvailable(kor.font)) return;
    const { reports } = await recognizePdf(await makeLanguagePdf(kor), { languages: ['kor'] });
    expect(reports[0]!.languages).toBe('kor');
  });

  it('flags a page read with the wrong language instead of passing it', async () => {
    const kor = SAMPLES.find((s) => s.code === 'kor')!;
    if (!fontAvailable(kor.font)) return;
    const { reports } = await recognizePdf(await makeLanguagePdf(kor), { languages: ['eng'], textLayer: 'ignore' });
    expect(reports[0]!.quality.issues.length).toBeGreaterThan(0);
    expect(reports[0]!.escalation).toBe('unavailable');
  });

  it('fails clearly when a language has no model', async () => {
    const kor = SAMPLES.find((s) => s.code === 'kor')!;
    if (!fontAvailable(kor.font)) return;
    await expect(recognizePdf(await makeLanguagePdf(kor), { languages: ['xyz'] })).rejects.toThrow('no model installed for language "xyz"');
  });
});

describe('identifyLatin', () => {
  it.each([
    ['deu', 'Die Mitarbeiter haben im letzten Quartal sehr gute Ergebnisse erzielt und der Umsatz ist gestiegen'],
    ['fra', 'Les ventes ont augmente dans toutes les regions et nous avons reduit les couts pour le service'],
    ['nld', 'De verkoop is in alle regio gestegen en het bedrijf heeft de kosten voor de klanten verlaagd'],
    ['ind', 'Penjualan yang meningkat di semua wilayah dan biaya untuk pelanggan telah turun pada tahun ini'],
    ['eng', 'The sales grew in all of the regions and the company has reduced the costs for this year'],
  ])('recognises %s from function words, accents or not', (code, text) => {
    expect(identifyLatin(text).code).toBe(code);
  });

  it('falls back to English for short or unidentifiable text', () => {
    expect(identifyLatin('Invoice 2026-118').code).toBe('eng');
    expect(identifyLatin('ACME GmbH Zentrale Berlin Hamburg Muenchen Koeln Frankfurt Stuttgart').code).toBe('eng');
  });
});

describe('text joining across scripts', () => {
  it('joins CJK and Thai lines without spaces, others with one', () => {
    expect(joinLines(['今年第三季度', '公司收入增长。'])).toBe('今年第三季度公司收入增长。');
    expect(joinLines(['ยอดขาย', 'เพิ่มขึ้น'])).toBe('ยอดขายเพิ่มขึ้น');
    expect(joinLines(['올해 3분기 매출이', '크게 증가했습니다.'])).toBe('올해 3분기 매출이 크게 증가했습니다.');
    expect(joinLines(['Zusammen-', 'arbeit über Grenzen'])).toBe('Zusammenarbeit über Grenzen');
  });

  it('removes spaces OCR puts between Han or kana, keeps Hangul word spaces', () => {
    expect(tidyCjkSpacing('今年 第三 季度')).toBe('今年第三季度');
    expect(tidyCjkSpacing('すべての 地域で')).toBe('すべての地域で');
    expect(tidyCjkSpacing('모든 지역에서')).toBe('모든 지역에서');
    expect(tidyCjkSpacing('Q3 増収 report')).toBe('Q3 増収 report');
  });
});
