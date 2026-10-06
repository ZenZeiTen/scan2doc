import { decode } from 'fast-png';
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeDataUri, IDRDocumentSchema, type BBox, type IDRBlock, type IDRDocument } from '@scan2doc/core';
import { writeDocx } from '@scan2doc/writer-openxml';
import { recognizePdf, scanToIdr, type PageReport, type RecognizeProgress } from '../src/index.js';
import { A4, FIXTURE, makeFixturePdf, makeSizedTextPdf, simulateScan, wordRecall } from '../../../test/support/make-pdf.js';

const DPI = 300;
const PX_PER_PT = DPI / 72;

/** A box drawn in PDF points (origin bottom-left) → page pixels at 300 dpi (origin top-left). */
const ptBox = (x: number, y: number, w: number, h: number, pageHeight: number = A4.height): BBox => ({
  x: x * PX_PER_PT,
  y: (pageHeight - y - h) * PX_PER_PT,
  width: w * PX_PER_PT,
  height: h * PX_PER_PT,
});

function iou(a: BBox, b: BBox): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

const textOf = (b: IDRBlock) => (b.type === 'table' ? b.cells.map((c) => c.text).join(' ') : b.type === 'image' ? '' : b.text);
const EXPECTED_TEXT = [
  FIXTURE.title.text,
  FIXTURE.heading.text,
  ...FIXTURE.body.lines,
  ...FIXTURE.table.cells.flat(),
  FIXTURE.after.text,
  FIXTURE.appendix.heading,
  FIXTURE.appendix.body,
].join(' ');

/** Checks shared by the born-digital and the scanned run; `minRecall` differs. */
function checkFixture(doc: IDRDocument, minRecall: number) {
  expect(() => IDRDocumentSchema.parse(doc)).not.toThrow();
  expect(doc.category).toBe('document');
  expect(doc.pages).toHaveLength(2);

  const [p1, p2] = doc.pages as [IDRDocument['pages'][0], IDRDocument['pages'][0]];
  expect(p1.sizeMm.width).toBeCloseTo(210, 0);
  expect(p1.sizeMm.height).toBeCloseTo(297, 0);
  expect(p2.sizeMm.width).toBeCloseTo(297, 0);

  const all = doc.pages.flatMap((p) => p.blocks);
  expect(wordRecall(EXPECTED_TEXT, all.map(textOf).join(' '))).toBeGreaterThanOrEqual(minRecall);

  // Roles and reading order on page 1: title, heading, body, …, closing paragraph last.
  const types = p1.blocks.map((b) => b.type);
  expect(types[0]).toBe('title');
  expect(types[1]).toBe('heading_1');
  expect(types[2]).toBe('body');
  const title = p1.blocks[0]!;
  if (title.type !== 'title') throw new Error('unreachable');
  expect(title.text).toBe(FIXTURE.title.text);
  expect(title.align).toBe('center');
  expect(title.font!.sizePt).toBeGreaterThan(FIXTURE.title.size * 0.9);
  expect(title.font!.sizePt).toBeLessThan(FIXTURE.title.size * 1.1);
  const body = p1.blocks[2]!;
  if (body.type !== 'body') throw new Error('unreachable');
  expect(body.font!.sizePt).toBeGreaterThanOrEqual(FIXTURE.body.size - 1);
  expect(body.font!.sizePt).toBeLessThanOrEqual(FIXTURE.body.size + 1);
  expect(wordRecall(FIXTURE.body.lines.join(' '), body.text)).toBeGreaterThanOrEqual(minRecall);
  expect(textOf(p1.blocks.at(-1)!)).toContain('regional totals');
  expect(p2.blocks.map((b) => b.type)).toEqual(['heading_1', 'body']);

  // The ruled table: 3 × 3, merged header, cell text.
  const tables = p1.blocks.filter((b) => b.type === 'table');
  expect(tables).toHaveLength(1);
  const table = tables[0]!;
  if (table.type !== 'table') throw new Error('unreachable');
  expect([table.rows, table.cols]).toEqual([3, 3]);
  expect(table.cells.map((c) => [c.row, c.col, c.rowSpan, c.colSpan])).toEqual([
    [0, 0, 1, 3], [1, 0, 1, 1], [1, 1, 1, 1], [1, 2, 1, 1], [2, 0, 1, 1], [2, 1, 1, 1], [2, 2, 1, 1],
  ]);
  expect(table.cells.map((c) => c.text)).toEqual(FIXTURE.table.cells.flat());
  const tb = FIXTURE.table;
  expect(iou(table.bbox, ptBox(tb.x, tb.top - 3 * tb.rowHeight, 3 * tb.colWidth, 3 * tb.rowHeight))).toBeGreaterThan(0.95);

  // The picture: one image block where it was drawn, with a decodable PNG crop.
  const images = p1.blocks.filter((b) => b.type === 'image');
  expect(images).toHaveLength(1);
  const im = images[0]!;
  if (im.type !== 'image') throw new Error('unreachable');
  expect(iou(im.bbox, ptBox(FIXTURE.image.x, FIXTURE.image.y, FIXTURE.image.width, FIXTURE.image.height))).toBeGreaterThan(0.85);
  const crop = p1.backgroundCrops.find((c) => c.id === im.cropRef)!;
  const png = decode(decodeDataUri(crop.dataRef)!);
  expect([png.width, png.height]).toEqual([Math.round(crop.bbox.width), Math.round(crop.bbox.height)]);
  expect(png.channels).toBe(3);
}

describe('scanToIdr on a born-digital PDF', () => {
  let doc: IDRDocument;
  let reports: PageReport[];
  const progress: RecognizeProgress[] = [];
  beforeAll(async () => {
    ({ document: doc, reports } = await scanToIdr(await makeFixturePdf(), { sourceFile: 'fixture.pdf', onProgress: (p) => progress.push(p) }));
  });

  it('recovers text, roles, reading order, the merged table and the picture', () => checkFixture(doc, 0.97));

  it("reads the PDF's own text layer instead of running OCR, and reports progress page by page", () => {
    // A digital PDF needs no Tesseract at all: no ocr stage, and the engine says where the text came from.
    expect(doc.metadata.ocrEngine).toBe('PDF text layer');
    expect(reports.map((r) => r.textSource)).toEqual(['pdf', 'pdf']);
    expect(progress.map((p) => `${p.page}:${p.stage}`)).toEqual([
      '0:render', '0:layout', '0:tables', '1:render', '1:layout', '1:tables',
    ]);
    expect(progress.every((p) => p.pageCount === 2)).toBe(true);
  });

  it('passes every quality check, so nothing is escalated', () => {
    expect(reports.map((r) => [r.languages, r.rotation, r.escalation, r.quality.issues])).toEqual([
      ['eng', 0, 'not-needed', []],
      ['eng', 0, 'not-needed', []],
    ]);
    expect(reports[0]!.quality.wordConfidence).toBe(100);
    expect(reports[0]!.quality.unreadInk).toBeLessThan(0.1);
    expect(doc.pages.map((p) => [p.language, p.source])).toEqual([['en', 'ocr'], ['en', 'ocr']]);
  });

  it('keeps the exact fonts and the document information from the PDF', () => {
    const [title, heading, body] = doc.pages[0]!.blocks as { font?: object }[];
    expect(title!.font).toEqual({ family: 'Helvetica', sizePt: 28, bold: true, italic: false, underline: false, color: '#000000' });
    expect(heading!.font).toMatchObject({ family: 'Helvetica', sizePt: 18, bold: true });
    expect(body!.font).toMatchObject({ family: 'Helvetica', sizePt: 11, bold: false });
    expect(doc.metadata).toMatchObject({ title: 'Quarterly Report 2026', author: 'Finance Team' });
  });

  it('produces IDR the Stage 2 writers accept', async () => {
    const docx = await writeDocx(doc);
    expect(docx.length).toBeGreaterThan(1000);
  });
});

describe('scanToIdr on a simulated scan (200 dpi, noise, JPEG)', () => {
  it('still recovers the same structure from an image-only PDF', async () => {
    const scan = await simulateScan(await makeFixturePdf());
    const { document, reports } = await scanToIdr(scan, { sourceFile: 'scan.pdf' });
    checkFixture(document, 0.95);
    expect(reports.map((r) => r.escalation)).toEqual(['not-needed', 'not-needed']);
    expect(reports.map((r) => r.textSource)).toEqual(['ocr', 'ocr']);
  });
});

describe('font size estimate', () => {
  // Calibrates ROW_HEIGHT_PER_EM: rendered Helvetica at known sizes must read back within 8%.
  it.each([9, 11, 14, 20, 32])('reads %ipt text back within 8%', async (size) => {
    // OCR forced: this calibrates the OCR size estimate, which a text layer would bypass.
    const { pages } = await recognizePdf(await makeSizedTextPdf(size), { textLayer: 'ignore' });
    const sizes = pages[0]!.blocks.map((b) => (b.type === 'body' || b.type.startsWith('heading') ? (b as { font?: { sizePt: number } }).font!.sizePt : NaN));
    expect(sizes.length).toBeGreaterThan(0);
    for (const s of sizes) expect(Math.abs(s - size) / size).toBeLessThanOrEqual(0.08);
  });
});

describe('input handling', () => {
  it('converts only the requested pages', async () => {
    const { pages } = await recognizePdf(await makeFixturePdf(), { pages: [1] });
    expect(pages).toHaveLength(1);
    expect(pages[0]!.sizeMm.width).toBeCloseTo(297, 0);
  });

  it('rejects a page that does not exist and bytes that are not a PDF', async () => {
    await expect(recognizePdf(await makeFixturePdf(), { pages: [5] })).rejects.toThrow('page 6 does not exist (document has 2)');
    await expect(recognizePdf(new TextEncoder().encode('not a pdf'))).rejects.toThrow(/^Not a readable PDF/);
  });
});
