import { describe, expect, it } from 'vitest';
import type { IDRBlock } from '@scan2doc/core';
import { assessPage, QUALITY_THRESHOLDS, recognizePdf, type EscalationRequest, type InkMask } from '../src/index.js';
import { fontAvailable, makeLanguagePdf, SAMPLES } from '../../../test/support/multilingual.js';

const DPI = 100;
function mask(width = 400, height = 400): InkMask {
  return { width, height, data: new Uint8Array(width * height) };
}
const ink = (m: InkMask, x: number, y: number, w: number, h: number) => {
  for (let j = y; j < y + h; j++) m.data.fill(1, j * m.width + x, j * m.width + x + w);
};
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const body = (id: string): IDRBlock => ({ id, type: 'body', bbox: box(10, 10, 100, 20), text: 'words', align: 'left' });
const codes = (q: ReturnType<typeof assessPage>) => q.issues.map((i) => i.code);

describe('assessPage', () => {
  it('passes a page whose ink is all explained by words, tables and pictures', () => {
    const m = mask();
    ink(m, 10, 10, 100, 20); // a word
    ink(m, 200, 200, 80, 80); // a picture
    const q = assessPage({ mask: m, dpi: DPI, wordBoxes: [box(10, 10, 100, 20)], blocks: [body('t'), { id: 'i', type: 'image', bbox: box(200, 200, 80, 80), cropRef: 'c' }], wordConfidence: 92 });
    expect(q.issues).toEqual([]);
    expect(q.unreadInk).toBe(0);
  });

  it('flags confidence just below the threshold and not at it', () => {
    const m = mask();
    ink(m, 10, 10, 100, 20);
    const at = (c: number) => codes(assessPage({ mask: m, dpi: DPI, wordBoxes: [box(10, 10, 100, 20)], blocks: [body('t')], wordConfidence: c }));
    expect(at(QUALITY_THRESHOLDS.minWordConfidence)).toEqual([]);
    expect(at(QUALITY_THRESHOLDS.minWordConfidence - 0.1)).toEqual(['low-confidence']);
  });

  it('flags ink that nothing explains (handwriting, an unknown script, a missed table)', () => {
    const m = mask();
    ink(m, 10, 10, 100, 20);
    ink(m, 50, 100, 300, 120); // 36 000 px of unexplained ink vs 2 000 read
    const q = assessPage({ mask: m, dpi: DPI, wordBoxes: [box(10, 10, 100, 20)], blocks: [body('t')], wordConfidence: 90 });
    expect(codes(q)).toEqual(['unread-ink']);
    expect(q.unreadInk).toBeGreaterThan(0.9);
  });

  it('says "no text" rather than "unread ink" when nothing at all was read', () => {
    const m = mask();
    ink(m, 50, 100, 300, 120);
    expect(codes(assessPage({ mask: m, dpi: DPI, wordBoxes: [], blocks: [], wordConfidence: NaN }))).toEqual(['no-text']);
  });

  it('ignores a nearly blank page (a page number, a little speckle)', () => {
    const m = mask();
    ink(m, 190, 380, 10, 10); // 100 px of 160 000: below minInkForUnreadCheck
    expect(assessPage({ mask: m, dpi: DPI, wordBoxes: [], blocks: [], wordConfidence: NaN }).issues).toEqual([]);
  });

  it('flags a table whose cells mostly came back empty', () => {
    const m = mask();
    const cells = [0, 1, 2, 3].map((k) => ({ row: Math.floor(k / 2), col: k % 2, rowSpan: 1, colSpan: 1, text: k === 0 ? 'x' : ' ' }));
    const table: IDRBlock = { id: 'tb', type: 'table', bbox: box(0, 0, 100, 100), rows: 2, cols: 2, cells };
    expect(codes(assessPage({ mask: m, dpi: DPI, wordBoxes: [], blocks: [table], wordConfidence: NaN }))).toEqual(['empty-table-cells']);
  });

  it('reports an unsupported script', () => {
    expect(codes(assessPage({ mask: mask(), dpi: DPI, wordBoxes: [], blocks: [], wordConfidence: NaN, unsupportedScript: 'Arabic' }))).toEqual(['unsupported-script']);
  });
});

const KOREAN = SAMPLES.find((s) => s.code === 'kor')!;

describe.skipIf(!fontAvailable(KOREAN.font))('the escalation hook', () => {
  // Korean read with only English fails the checks every time: a reliable page to escalate.
  const failing = async (escalate: (r: EscalationRequest) => ReturnType<NonNullable<Parameters<typeof recognizePdf>[1]>['escalate'] & {}>) =>
    recognizePdf(await makeLanguagePdf(KOREAN), { languages: ['eng'], textLayer: 'ignore', escalate });

  it('applies a valid reply, with its language, and marks the page as AI-made', async () => {
    let seen: EscalationRequest | undefined;
    const { pages, reports } = await failing(async (req) => {
      seen = req;
      return { language: 'ko', blocks: [{ id: 'a', type: 'body', bbox: box(100, 100, 1500, 300), text: '올해 3분기 매출이 크게 증가했습니다.', align: 'left' }] };
    });
    expect(reports[0]!.escalation).toBe('applied');
    expect(pages[0]).toMatchObject({ source: 'ai', language: 'ko' });
    // The request carried a real PNG at most 1568 px on its long side, and the issues found.
    expect(Buffer.from(seen!.image.png.subarray(1, 4)).toString()).toBe('PNG');
    expect(Math.max(seen!.image.width, seen!.image.height)).toBeLessThanOrEqual(1568);
    expect(seen!.issues.length).toBeGreaterThan(0);
  });

  it('keeps the draft when the reply breaks the page schema', async () => {
    const { pages, reports } = await failing(async () => ({ blocks: [{ id: 'a', type: 'body', bbox: box(0, 0, 99999, 10), text: 'x', align: 'left' }] }));
    expect(reports[0]!.escalation).toBe('rejected');
    expect(reports[0]!.note).toMatch(/extends past the page/);
    expect(pages[0]!.source).toBe('ocr');
  });

  it('keeps the draft when the escalator fails or declines', async () => {
    const thrown = await failing(async () => {
      throw new Error('model unavailable');
    });
    expect([thrown.reports[0]!.escalation, thrown.reports[0]!.note]).toEqual(['failed', 'model unavailable']);
    const declined = await failing(async () => undefined);
    expect([declined.reports[0]!.escalation, declined.reports[0]!.note]).toEqual(['failed', 'the escalator declined the page']);
  });
});
