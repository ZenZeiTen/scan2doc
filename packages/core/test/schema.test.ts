import { describe, expect, it } from 'vitest';
import { IDRDocumentSchema } from '@scan2doc/core';
import { validDocument } from './fixtures.js';

const issues = (input: unknown) => {
  const r = IDRDocumentSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('IDRDocumentSchema', () => {
  it('accepts a well-formed document and fills defaults', () => {
    const doc = IDRDocumentSchema.parse(validDocument());
    const title = doc.pages[0]!.blocks[0]!;
    expect(title.type).toBe('title');
    if (title.type === 'title') {
      expect(title.align).toBe('left');
      expect(title.font).toEqual({ family: 'Times New Roman', sizePt: 24, bold: true, italic: false, underline: false, color: '#000000' });
    }
    const table = doc.pages[0]!.blocks[3]!;
    if (table.type !== 'table') throw new Error('expected table');
    expect(table.cells[0]).toMatchObject({ rowSpan: 1, colSpan: 3 });
  });

  it('rejects an unknown block type', () => {
    const d = validDocument();
    (d.pages[0]!.blocks[1] as { type: string }).type = 'heading_4';
    expect(IDRDocumentSchema.safeParse(d).success).toBe(false);
  });

  it('rejects an unknown category', () => {
    const d = validDocument() as { category: string };
    d.category = 'spreadsheets';
    expect(IDRDocumentSchema.safeParse(d).success).toBe(false);
  });

  it('rejects a document with no pages', () => {
    expect(IDRDocumentSchema.safeParse({ ...validDocument(), pages: [] }).success).toBe(false);
  });

  it('rejects out-of-sequence page indexes', () => {
    const d = validDocument();
    d.pages[0]!.index = 1;
    expect(issues(d)).toContain('page index 1 at position 0');
  });

  it('rejects duplicate block ids on a page', () => {
    const d = validDocument();
    d.pages[0]!.blocks[1]!.id = 'b1';
    expect(issues(d)).toContain('duplicate block id "b1"');
  });

  it('rejects an image block whose crop does not exist', () => {
    const d = validDocument();
    (d.pages[0]!.blocks[2] as { cropRef: string }).cropRef = 'crop-9';
    expect(issues(d)).toContain('image block "b3" references unknown crop "crop-9"');
  });

  it('rejects a block that runs off the page', () => {
    const d = validDocument();
    d.pages[0]!.blocks[1]!.bbox = { x: 1000, y: 300, width: 500, height: 100 };
    expect(issues(d)).toContain('block "b2" extends past the page');
  });

  it('rejects pixel dimensions that contradict mm × dpi', () => {
    const d = validDocument();
    d.pages[0]!.sizePx = { width: 2480, height: 1754 }; // 300-dpi width on a 150-dpi page
    expect(issues(d).some((m) => m.startsWith('sizePx.width=2480'))).toBe(true);
  });

  it('rejects a table cell whose span leaves the grid', () => {
    const d = validDocument();
    const table = d.pages[0]!.blocks[3] as { cells: { colSpan?: number }[] };
    table.cells[0]!.colSpan = 4;
    expect(issues(d)).toContain('cell (0,0) span 1x4 exceeds 2x3 grid');
  });

  it('rejects table cells that overlap through a merge', () => {
    const d = validDocument();
    const table = d.pages[0]!.blocks[3] as { cells: { row: number; col: number; text: string }[] };
    table.cells.push({ row: 0, col: 2, text: 'clash' });
    expect(issues(d)).toContain('grid slot (0,2) already covered by cells[0]');
  });

  it('rejects a malformed font colour and an out-of-range confidence', () => {
    const d = validDocument();
    (d.pages[0]!.blocks[0] as { font: { color?: string } }).font.color = 'red';
    (d.pages[0]!.blocks[1] as { confidence?: number }).confidence = 1.2;
    const r = IDRDocumentSchema.safeParse(d);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues).toHaveLength(2);
  });
});
