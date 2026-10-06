import { describe, expect, it } from 'vitest';
import { classifyDocument, extractFeatures, IDRPageSchema, type IDRPage } from '@scan2doc/core';
import { A4_150, SLIDE_96, box } from './fixtures.js';

const page = (size: typeof A4_150, blocks: unknown[], index = 0): IDRPage =>
  IDRPageSchema.parse({ index, ...size, blocks });

const prose = (id: string, chars: number, y = 100) => ({ id, type: 'body', bbox: box(100, y, 1000, 400), text: 'x'.repeat(chars) });

const table = (id: string, w: number, h: number) => ({
  id,
  type: 'table',
  bbox: box(50, 50, w, h),
  rows: 2,
  cols: 2,
  cells: [
    { row: 0, col: 0, text: 'Item' },
    { row: 0, col: 1, text: 'Qty' },
    { row: 1, col: 0, text: 'Bolt' },
    { row: 1, col: 1, text: '12' },
  ],
});

describe('extractFeatures', () => {
  it('measures table area, landscape share and text per page', () => {
    // Table 1000×800 = 800 000 px²; prose 1000×400 = 400 000 px² → ratio 2/3.
    const f = extractFeatures([page(A4_150, [table('t', 1000, 800), prose('p', 300, 900)])]);
    expect(f.tableAreaRatio).toBeCloseTo(2 / 3, 6);
    expect(f.landscapeRatio).toBe(0);
    expect(f.charsPerPage).toBe(300 + 4 + 3 + 4 + 2);
  });

  it('reports zeros for pages without blocks', () => {
    expect(extractFeatures([page(A4_150, [])])).toEqual({ tableAreaRatio: 0, landscapeRatio: 0, charsPerPage: 0 });
  });
});

describe('classifyDocument', () => {
  it('classifies text-heavy portrait pages as a document', () => {
    const r = classifyDocument([page(A4_150, [prose('a', 2500)]), page(A4_150, [prose('b', 2200)], 1)]);
    expect(r.category).toBe('document');
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('classifies table-dominated pages as a spreadsheet', () => {
    const r = classifyDocument([page(A4_150, [table('t', 1100, 1500), prose('caption', 40, 1300)])]);
    expect(r.category).toBe('spreadsheet');
  });

  it('prefers spreadsheet over presentation for a landscape ledger', () => {
    const r = classifyDocument([page(SLIDE_96, [table('t', 850, 450)])]);
    expect(r.category).toBe('spreadsheet');
  });

  it('classifies sparse landscape pages as a presentation', () => {
    const slide = (i: number) =>
      page(SLIDE_96, [
        { id: `t${i}`, type: 'title', bbox: box(60, 40, 840, 80), text: 'Quarterly results' },
        { id: `b${i}`, type: 'body', bbox: box(60, 160, 840, 300), text: 'Revenue up 12%. Margin flat. Two new regions.' },
      ], i);
    const r = classifyDocument([slide(0), slide(1), slide(2)]);
    expect(r.category).toBe('presentation');
  });

  it('keeps a portrait report with a landscape appendix a document', () => {
    // Found by the Stage 3 end-to-end test: one of two pages landscape is not "mostly landscape".
    const r = classifyDocument([
      page(A4_150, [prose('a', 300)]),
      page(SLIDE_96, [{ id: 'b', type: 'body', bbox: box(60, 160, 840, 300), text: 'Appendix notes.' }], 1),
    ]);
    expect(r.features.landscapeRatio).toBe(0.5);
    expect(r.category).toBe('document');
  });

  it('keeps dense landscape pages as a document', () => {
    const r = classifyDocument([page(SLIDE_96, [{ id: 'b', type: 'body', bbox: box(20, 20, 920, 500), text: 'x'.repeat(3000) }])]);
    expect(r.category).toBe('document');
  });

  it('is more confident the further a scan sits from a threshold', () => {
    const borderline = classifyDocument([page(A4_150, [table('t', 1000, 420), prose('p', 100, 900)])]); // ratio ≈ 0.51
    const clear = classifyDocument([page(A4_150, [table('t', 1100, 1600)])]); // ratio 1
    expect(borderline.category).toBe('spreadsheet');
    expect(clear.category).toBe('spreadsheet');
    expect(clear.confidence).toBe(1);
    expect(borderline.confidence).toBeLessThan(0.6);
  });
});
