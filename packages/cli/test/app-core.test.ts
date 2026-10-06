import { PDFDocument, degrees } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { scanToIdr, type PdfChar } from '@scan2doc/vision-wasm';
import { combine, everyN, rangeGroups, rebuild, split } from '../src/app/pdfops.js';
import { DocumentStore, findInChars, type SearchHit } from '../src/app/docs.js';
import { makeSearchable, toUserSpace, unturn } from '../src/app/searchable.js';
import { FIXTURE, makeFixturePdf, simulateScan, wordRecall } from '../../../test/support/make-pdf.js';
import { fontAvailable, makeLanguagePdf, makeRotatedPdf, SAMPLES } from '../../../test/support/multilingual.js';

/** A PDF of `n` pages, each a different size so pages can be told apart after edits. */
async function numbered(n: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < n; i++) pdf.addPage([300 + i * 10, 400]);
  pdf.setTitle('Numbered');
  return pdf.save();
}
const widths = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPages().map((p) => p.getWidth());
const rotations = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPages().map((p) => p.getRotation().angle);

describe('page operations', () => {
  it('reorders, drops, duplicates and turns pages', async () => {
    const src = await numbered(4);
    const out = await rebuild(src, [
      { source: 3, rotate: 0 },
      { source: 0, rotate: 90 },
      { source: 0, rotate: 270 },
    ]);
    expect(await widths(out)).toEqual([330, 300, 300]);
    expect(await rotations(out)).toEqual([0, 90, 270]);
    expect((await PDFDocument.load(out)).getTitle()).toBe('Numbered');
  });

  it('adds a turn to a page that was already turned', async () => {
    const doc = await PDFDocument.load(await numbered(1));
    doc.getPage(0).setRotation(degrees(270));
    const out = await rebuild(await doc.save(), [{ source: 0, rotate: 180 }]);
    expect(await rotations(out)).toEqual([90]);
  });

  it('refuses impossible edits with a reason', async () => {
    const src = await numbered(2);
    await expect(rebuild(src, [])).rejects.toThrow(/at least one page/);
    await expect(rebuild(src, [{ source: 2, rotate: 0 }])).rejects.toThrow(/page 3 does not exist \(the PDF has 2\)/);
    await expect(rebuild(src, [{ source: 0, rotate: 45 as 90 }])).rejects.toThrow(/90, 180 or 270/);
    await expect(rebuild(new TextEncoder().encode('not a pdf'), [{ source: 0, rotate: 0 }])).rejects.toThrow(/could not be read/);
  });

  it('combines files in order and splits them again', async () => {
    const joined = await combine([await numbered(2), await numbered(3)]);
    expect(await widths(joined)).toEqual([300, 310, 300, 310, 320]);
    await expect(combine([await numbered(1)])).rejects.toThrow(/at least two/);
    const parts = await split(joined, everyN(5, 2));
    expect(await Promise.all(parts.map(widths))).toEqual([[300, 310], [300, 310], [320]]);
  });

  it('reads split ranges', () => {
    expect(rangeGroups('1-2, 4 ,5-5', 5)).toEqual([[0, 1], [3], [4]]);
    expect(everyN(3, 5)).toEqual([[0, 1, 2]]);
    for (const bad of ['', '0', '2-1', '1-6', 'a']) expect(() => rangeGroups(bad, 5), bad).toThrow();
    expect(() => everyN(4, 0)).toThrow(/1 or more/);
  });
});

describe('search', () => {
  const char = (text: string, x: number, y: number, spaceBefore = false): PdfChar =>
    ({ text, box: { x, y, width: 10, height: 12 }, spaceBefore, sizePt: 12, family: 'Arial', bold: false, italic: false, color: '#000000', invisible: false, unmapped: false, angle: 0 }) as PdfChar;

  it('finds words across spaces and lines, ignoring case', () => {
    // "Total due" on one line, "Due" again on the next.
    const chars = [...'Total'].map((c, i) => char(c, 10 + i * 10, 100)).concat([...'due'].map((c, i) => char(c, 70 + i * 10, 100, i === 0)), [...'Due'].map((c, i) => char(c, 10 + i * 10, 130)));
    const hits = findInChars(chars, '  DUE ', 200, 400);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.rects).toEqual([{ x: 70 / 200, y: 100 / 400, w: 30 / 200, h: 12 / 400 }]);
    const phrase = findInChars(chars, 'total due', 200, 400);
    expect(phrase).toHaveLength(1);
    expect(phrase[0]!.rects).toEqual([{ x: 10 / 200, y: 100 / 400, w: 90 / 200, h: 12 / 400 }]);
    expect(findInChars(chars, 'due due', 200, 400)[0]!.rects).toHaveLength(2);
    expect(findInChars(chars, '', 200, 400)).toEqual([]);
  });

  it('opens a PDF, renders pages and searches its own text', async () => {
    const store = new DocumentStore();
    const doc = await store.open(await makeFixturePdf(), 'report.pdf');
    expect(doc.pages).toHaveLength(2);
    expect(doc.pages[0]).toEqual({ widthPt: 595, heightPt: 842 });
    expect(doc.title).toBe('Quarterly Report 2026');
    const image = await store.pageImage(doc.id, 0, 300);
    expect([...image.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(await store.pageImage(doc.id, 0, 301)).toBe(image); // 16-px steps share a render
    const hits = store.search(doc.id, 'regional');
    expect(hits.map((h) => h.page)).toEqual([0, 0]);
    expect(hits[0]!.rects[0]!.y).toBeGreaterThan(0.1);
    expect(store.search(doc.id, 'appendix').map((h) => h.page)).toEqual([1, 1]);
    expect(await inkUnder(store, doc.id, hits[0]!)).toBeGreaterThan(0.05);
    store.closeAll();
    expect(() => store.get(doc.id)).toThrow(/no longer open/);
  });

  // PDFium turned /Rotate pages twice when mapping text to the screen, so highlights (and the
  // text-layer checks) landed on blank paper.
  it('highlights the words on a page with /Rotate', async () => {
    const pdf = await PDFDocument.load(await makeFixturePdf());
    pdf.getPage(0).setRotation(degrees(90));
    const store = new DocumentStore();
    const doc = await store.open(await pdf.save(), 'rotated.pdf');
    expect(doc.pages[0]).toEqual({ widthPt: 842, heightPt: 595 });
    const hits = store.search(doc.id, 'northern markets');
    expect(hits).toHaveLength(1);
    // Text running down the turned page: the highlight is a tall, narrow box.
    expect(hits[0]!.rects).toHaveLength(1);
    expect(hits[0]!.rects[0]!.h * 595).toBeGreaterThan(hits[0]!.rects[0]!.w * 842);
    expect(await inkUnder(store, doc.id, hits[0]!)).toBeGreaterThan(0.05);
    store.closeAll();
  });

  it('reports a digital /Rotate page as turned, not as half-covered', async () => {
    const pdf = await PDFDocument.load(await makeFixturePdf());
    pdf.getPage(0).setRotation(degrees(90));
    const { reports } = await scanToIdr(await pdf.save(), { sourceFile: 'test.pdf', languages: 'auto', pages: [0] });
    expect(reports[0]!.textNote).toMatch(/rotated/);
  });

  it('keeps sideways text together when searching', () => {
    // "due" running down a turned page: each letter below the last.
    const chars = [...'due'].map((c, i) => char(c, 50, 100 + i * 10));
    const hits = findInChars(chars, 'due', 200, 400);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rects).toEqual([{ x: 50 / 200, y: 100 / 400, w: 10 / 200, h: 32 / 400 }]);
  });
});

/** Share of dark pixels under a hit's first highlight, on the page as displayed. */
async function inkUnder(store: DocumentStore, id: string, hit: SearchHit): Promise<number> {
  const doc = store.get(id);
  const page = await doc.raster.render(hit.page, 72);
  const r = hit.rects[0]!;
  let dark = 0;
  let all = 0;
  for (let y = Math.floor(r.y * page.height); y < (r.y + r.h) * page.height; y++) {
    for (let x = Math.floor(r.x * page.width); x < (r.x + r.w) * page.width; x++) {
      all++;
      if (page.gray.data[y * page.width + x]! < 128) dark++;
    }
  }
  return all ? dark / all : 0;
}

describe('coordinate mapping', () => {
  // Hand-derived: corners of a 100 × 50 image turned clockwise, and of a 200 × 300 pt page under /Rotate.
  it('undoes the OCR turn', () => {
    expect(unturn({ x: 0, y: 0 }, 0, 100, 50)).toEqual({ x: 0, y: 0 });
    // Turned 90° clockwise, the image's top-right came from the original's top-left.
    expect(unturn({ x: 100, y: 0 }, 90, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(unturn({ x: 100, y: 50 }, 180, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(unturn({ x: 0, y: 50 }, 270, 100, 50)).toEqual({ x: 0, y: 0 });
  });

  it('maps displayed points into the page’s own coordinates', () => {
    // The displayed top-left corner, for each /Rotate of a 200 × 300 page.
    expect(toUserSpace({ x: 0, y: 0 }, 0, 200, 300)).toEqual({ x: 0, y: 300 });
    expect(toUserSpace({ x: 0, y: 0 }, 90, 200, 300)).toEqual({ x: 0, y: 0 });
    expect(toUserSpace({ x: 0, y: 0 }, 180, 200, 300)).toEqual({ x: 200, y: 0 });
    expect(toUserSpace({ x: 0, y: 0 }, 270, 200, 300)).toEqual({ x: 200, y: 300 });
  });
});

describe('searchable PDF', () => {
  let scan: Uint8Array;
  beforeAll(async () => {
    scan = await simulateScan(await makeFixturePdf(), 300, 85, 0);
  });

  /** Reads `pdf` back trusting hidden text: it is only used when it covers the ink and stands upright. */
  async function readBack(pdf: Uint8Array) {
    const { document, reports } = await scanToIdr(pdf, { sourceFile: 'test.pdf', textLayer: 'include-hidden', languages: 'auto' });
    const text = document.pages.flatMap((p) => p.blocks.flatMap((b) => (b.type === 'table' ? b.cells.map((c) => c.text) : b.type === 'image' ? [] : [b.text]))).join(' ');
    return { sources: reports.map((r) => r.textSource), text };
  }

  it('lays OCR text under a scan where the words are', async () => {
    const { document, reports } = await scanToIdr(scan, { sourceFile: 'test.pdf', languages: 'auto' });
    expect(reports.map((r) => r.textSource)).toEqual(['ocr', 'ocr']);
    const result = await makeSearchable(scan, document, reports);
    expect(result).toMatchObject({ pagesAdded: [1, 2], pagesWithText: [], linesWithoutFont: 0 });
    const back = await readBack(result.bytes);
    expect(back.sources).toEqual(['pdf', 'pdf']);
    expect(wordRecall([...FIXTURE.body.lines, FIXTURE.heading.text, FIXTURE.appendix.body].join(' '), back.text)).toBeGreaterThan(0.9);

    const store = new DocumentStore();
    const doc = await store.open(result.bytes, 'scan.pdf');
    expect(store.search(doc.id, 'northern markets').map((h) => h.page)).toEqual([0]);
    store.closeAll();
  });

  // Hidden text on a turned page reads sideways, which the reader rightly refuses to trust;
  // what matters is that searching for a phrase highlights the printed words.
  it('follows a page OCR had to turn, and a page with /Rotate', async () => {
    const sideways = await simulateScan(await makeRotatedPdf(90), 300, 85, 0);
    const turned = await PDFDocument.load(await simulateScan(await makeFixturePdf(), 300, 85, 0));
    turned.getPage(0).setRotation(degrees(90));
    const cases: [Uint8Array, string][] = [
      [sideways, 'committee approved the annual budget'],
      [await turned.save(), 'northern markets'],
    ];
    for (const [pdf, phrase] of cases) {
      const { document, reports } = await scanToIdr(pdf, { sourceFile: 'test.pdf', languages: 'auto', pages: [0] });
      expect(reports[0]!.rotation).not.toBe(0);
      const result = await makeSearchable(pdf, document, reports);
      expect(result.pagesAdded).toEqual([1]);
      const store = new DocumentStore();
      const doc = await store.open(result.bytes, 'turned.pdf');
      const hits = store.search(doc.id, phrase);
      expect(hits.length, phrase).toBeGreaterThan(0);
      expect(await inkUnder(store, doc.id, hits[0]!), phrase).toBeGreaterThan(0.05);
      store.closeAll();
    }
  });

  it('leaves pages that already have text alone', async () => {
    const digital = await makeFixturePdf();
    const { document, reports } = await scanToIdr(digital, { sourceFile: 'test.pdf', languages: 'auto' });
    const result = await makeSearchable(digital, document, reports);
    expect(result).toMatchObject({ pagesAdded: [], pagesWithText: [1, 2] });
  });

  it.skipIf(!fontAvailable('msyh.ttc'))('embeds a system font for Chinese and Japanese text', async () => {
    const sample = SAMPLES.find((s) => s.code === 'jpn')!;
    const pdf = await simulateScan(await makeLanguagePdf(sample), 300, 85, 0);
    const { document, reports } = await scanToIdr(pdf, { sourceFile: 'test.pdf', languages: 'auto' });
    const result = await makeSearchable(pdf, document, reports);
    expect(result.linesWithoutFont).toBe(0);
    const store = new DocumentStore();
    const doc = await store.open(result.bytes, 'jp.pdf');
    expect(store.search(doc.id, '販売が好調').length).toBeGreaterThan(0);
    store.closeAll();
  });
});
