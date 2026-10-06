import { describe, expect, it } from 'vitest';
import {
  cm,
  coveredSlots,
  decodeDataUri,
  layoutSheet,
  mmToTwips,
  parseCellValue,
  pxToEmu,
  resolvePageImages,
  sanitizeDocument,
  sanitizeXmlText,
} from '@scan2doc/core';
import { BELL, PNG_1PX, sampleDocument } from '../../../test/support/sample-doc.js';

describe('sanitizeXmlText', () => {
  it('drops characters XML 1.0 forbids and keeps everything else', () => {
    expect(sanitizeXmlText(`a${BELL}b\u000Cc￾d\uD800e`)).toBe('abcde');
    expect(sanitizeXmlText('tab\there\nnew é 漢字 😀')).toBe('tab\there\nnew é 漢字 😀');
  });

  it('folds CRLF and CR to LF', () => {
    expect(sanitizeXmlText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('sanitizeDocument cleans text blocks, table cells and metadata without mutating the input', () => {
    const doc = sampleDocument();
    const clean = sanitizeDocument(doc);
    const title = clean.pages[0]!.blocks[0]!;
    expect(title.type === 'title' && title.text).toBe('Annual Report 2026 & <Outlook>');
    const original = doc.pages[0]!.blocks[0]!;
    expect(original.type === 'title' && original.text.endsWith(BELL)).toBe(true);
  });
});

describe('units', () => {
  it('converts A4 and scan pixels to format units', () => {
    expect(mmToTwips(210)).toBe(11906);
    expect(mmToTwips(297)).toBe(16838);
    expect(pxToEmu(150, 150)).toBe(914400);
    expect(cm(2.54)).toBe('2.54cm');
    expect(cm(1 / 3)).toBe('0.3333cm');
  });
});

describe('images', () => {
  it('decodes base64 PNG data URIs and rejects anything else', () => {
    const bytes = decodeDataUri(`data:image/png;base64,${PNG_1PX}`)!;
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(decodeDataUri('asset://p0/crop.png')).toBeUndefined();
    expect(decodeDataUri('data:image/gif;base64,R0lG')).toBeUndefined();
  });

  it('resolves image blocks by id and leaves out the ones it cannot load', async () => {
    const page = sampleDocument().pages[0]!;
    expect([...(await resolvePageImages(page)).keys()]).toEqual(['logo']);
    const missing = sampleDocument({ imageDataRef: 'asset://missing' }).pages[0]!;
    expect((await resolvePageImages(missing)).size).toBe(0);
    const custom = await resolvePageImages(missing, () => new Uint8Array([1, 2, 3]));
    expect(custom.get('logo')?.extension).toBe('png');
  });
});

describe('parseCellValue', () => {
  it('turns plain decimals into numbers and keeps everything else as text', () => {
    expect(parseCellValue('12')).toBe(12);
    expect(parseCellValue('-3.5')).toBe(-3.5);
    expect(parseCellValue('0')).toBe(0);
    expect(parseCellValue('0.25')).toBe(0.25);
    for (const s of ['007', '1,000', '12%', '1e3', '', 'Q1', '.5', '12.']) expect(parseCellValue(s)).toBe(s);
  });
});

describe('layoutSheet', () => {
  it('stacks text, image and table rows and keeps merges', () => {
    const layout = layoutSheet(sampleDocument().pages[0]!);
    // title r0, heading r1, body r2, image r3: 300 px @150 dpi = 192 screen px = 10 rows, +1 spacer → table at r14.
    expect(layout.images).toMatchObject([{ row: 3, col: 0, widthPx: 243.2, heightPx: 192 }]);
    const at = (r: number, c: number) => layout.cells.find((x) => x.row === r && x.col === c);
    expect(at(0, 0)).toMatchObject({ role: 'title', text: 'Annual Report 2026 & <Outlook>\u0007' });
    expect(at(14, 0)).toMatchObject({ text: 'Quarterly figures', colSpan: 3 });
    expect(at(15, 0)).toMatchObject({ text: '2026', rowSpan: 2 });
    expect(at(15, 2)!.value).toBe(12);
    expect(at(16, 2)!.value).toBe('007');
    expect(layout.rowCount).toBe(18);
    expect(layout.colCount).toBe(3);
  });

  it('marks merged-over slots, never the anchors', () => {
    const covered = coveredSlots([
      { row: 0, col: 0, rowSpan: 1, colSpan: 3 },
      { row: 1, col: 0, rowSpan: 2, colSpan: 1 },
    ]);
    expect([...covered].sort()).toEqual(['0,1', '0,2', '2,0']);
  });
});
