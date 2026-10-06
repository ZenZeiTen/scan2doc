import jpeg from 'jpeg-js';
import { PDFDocument, rgb, setTextRenderingMode, setWordSpacing, StandardFonts, TextRenderingMode, type PDFFont, type PDFPage } from 'pdf-lib';
import { nodeModulesAssets, PdfRasterizer } from '@scan2doc/vision-wasm';

export const A4 = { width: 595, height: 842 } as const;

/** What the fixture draws, in PDF points (origin bottom-left), so tests can check against it. */
export const FIXTURE = {
  title: { text: 'Quarterly Report', size: 28 },
  heading: { text: 'Regional Results', size: 18 },
  body: {
    size: 11,
    lines: [
      'Revenue grew across all regions in the third quarter, led by strong',
      'demand in the northern markets and steady growth in services. Costs',
      'remained flat compared with the previous quarter.',
    ],
  },
  /** 3 × 3 ruled table; the header row has no inner verticals, so it is one merged cell. */
  table: {
    x: 72,
    top: 600,
    colWidth: 100,
    rowHeight: 30,
    cells: [['Summary'], ['Region', 'Units', 'Revenue'], ['North', '120', '4500']],
  },
  image: { x: 400, y: 480, width: 120, height: 120 },
  after: { text: 'The table above lists the regional totals.', size: 11 },
  appendix: { heading: 'Appendix', body: 'Notes for the appendix follow here.' },
} as const;

/** Builds the two-page born-digital fixture PDF. */
export async function makeFixturePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('Quarterly Report 2026');
  pdf.setAuthor('Finance Team');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const p1 = pdf.addPage([A4.width, A4.height]);
  drawPageOneText(p1, font, bold);

  const tb = FIXTURE.table;
  const right = tb.x + 3 * tb.colWidth;
  const bottom = tb.top - 3 * tb.rowHeight;
  for (let r = 0; r <= 3; r++) p1.drawLine({ start: { x: tb.x, y: tb.top - r * tb.rowHeight }, end: { x: right, y: tb.top - r * tb.rowHeight }, thickness: 1 });
  for (let c = 0; c <= 3; c++) {
    const inner = c > 0 && c < 3;
    // Inner verticals stop below the header row: that row is one merged cell.
    p1.drawLine({ start: { x: tb.x + c * tb.colWidth, y: inner ? tb.top - tb.rowHeight : tb.top }, end: { x: tb.x + c * tb.colWidth, y: bottom }, thickness: 1 });
  }
  const im = FIXTURE.image;
  p1.drawRectangle({ ...im, color: rgb(0.32, 0.38, 0.45) });
  p1.drawEllipse({ x: im.x + 60, y: im.y + 60, xScale: 35, yScale: 35, color: rgb(0.75, 0.62, 0.3) });

  const p2 = pdf.addPage([A4.height, A4.width]);
  p2.drawText(FIXTURE.appendix.heading, { x: 72, y: 520, size: 18, font: bold });
  p2.drawText(FIXTURE.appendix.body, { x: 72, y: 490, size: 11, font });
  return pdf.save();
}

/** Every piece of text on fixture page 1, at its exact position (shared with the hidden-layer fixture). */
function drawPageOneText(page: PDFPage, font: PDFFont, bold: PDFFont): void {
  const t = FIXTURE.title;
  page.drawText(t.text, { x: (A4.width - bold.widthOfTextAtSize(t.text, t.size)) / 2, y: 770, size: t.size, font: bold });
  page.drawText(FIXTURE.heading.text, { x: 72, y: 715, size: FIXTURE.heading.size, font: bold });
  FIXTURE.body.lines.forEach((line, i) => page.drawText(line, { x: 72, y: 690 - i * 14, size: FIXTURE.body.size, font }));
  const tb = FIXTURE.table;
  tb.cells.forEach((row, r) =>
    row.forEach((text, c) => page.drawText(text, { x: tb.x + c * tb.colWidth + 8, y: tb.top - r * tb.rowHeight - 20, size: 11, font })),
  );
  page.drawText(FIXTURE.after.text, { x: 72, y: 440, size: FIXTURE.after.size, font });
}

/** Text-only page at a given size, for font-size calibration. */
export async function makeSizedTextPdf(sizePt: number, lines = 3): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([A4.width, A4.height]);
  // Drop words until the line fits inside the margins: clipped text would mis-measure.
  const words = 'The quick brown fox jumps over the lazy dog'.split(' ');
  while (words.length > 2 && font.widthOfTextAtSize(words.join(' '), sizePt) > A4.width - 100) words.pop();
  for (let i = 0; i < lines; i++) {
    page.drawText(words.join(' '), { x: 50, y: 760 - i * sizePt * 1.5, size: sizePt, font });
  }
  return pdf.save();
}

/**
 * Turns a PDF into what a scanner produces: every page rendered at `dpi`,
 * sensor noise and dust added (deterministically), JPEG-compressed, and placed
 * as the only content of an image-only PDF page of the same size.
 */
export async function simulateScan(pdfBytes: Uint8Array, dpi = 200, quality = 75, dust = 0.0004): Promise<Uint8Array> {
  const raster = await PdfRasterizer.open(pdfBytes, nodeModulesAssets());
  const out = await PDFDocument.create();
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  try {
    for (let i = 0; i < raster.pageCount; i++) {
      const page = await raster.render(i, dpi);
      const rgba = new Uint8Array(page.width * page.height * 4);
      for (let p = 0; p < page.gray.data.length; p++) {
        let v = page.gray.data[p]! + (rand() - 0.5) * 24;
        if (rand() < dust) v = 40; // dust speck
        const g = Math.max(0, Math.min(255, Math.round(v)));
        rgba[p * 4] = g;
        rgba[p * 4 + 1] = g;
        rgba[p * 4 + 2] = Math.max(0, g - 4); // slight paper tint
        rgba[p * 4 + 3] = 255;
      }
      const jpg = jpeg.encode({ width: page.width, height: page.height, data: rgba }, quality).data;
      const img = await out.embedJpg(jpg);
      const pg = out.addPage([page.widthPt, page.heightPt]);
      pg.drawImage(img, { x: 0, y: 0, width: page.widthPt, height: page.heightPt });
    }
  } finally {
    raster.close();
  }
  return out.save();
}

/**
 * A "searchable" scan as other tools make it: the image-only scan of the
 * fixture with an invisible (render mode 3) text layer laid over it.
 */
export async function makeHiddenLayerPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(await simulateScan(await makeFixturePdf()));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.getPage(0);
  // Like a real searchable scan, the hidden text sits exactly over every line of the image.
  page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
  drawPageOneText(page, font, bold);
  page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
  return pdf.save();
}

/** Part digital, part scan: a typed cover note above an embedded scanned page. */
export async function makeMixedPdf(): Promise<Uint8Array> {
  const raster = await PdfRasterizer.open(await makeFixturePdf(), nodeModulesAssets());
  let jpg: Uint8Array;
  try {
    const page = await raster.render(0, 150);
    const rgba = new Uint8Array(page.width * page.height * 4);
    for (let p = 0; p < page.gray.data.length; p++) rgba.fill(page.gray.data[p]!, p * 4, p * 4 + 3), (rgba[p * 4 + 3] = 255);
    jpg = jpeg.encode({ width: page.width, height: page.height, data: rgba }, 85).data;
  } finally {
    raster.close();
  }
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([A4.width, A4.height]);
  page.drawText('Cover note: scanned copy of the quarterly report follows.', { x: 50, y: 800, size: 12, font });
  const img = await pdf.embedJpg(jpg);
  page.drawImage(img, { x: 50, y: 30, width: A4.width - 100, height: (A4.width - 100) * (A4.height / A4.width) * 0.92 });
  return pdf.save();
}

/** One line of text as a JPEG strip, rendered and scanned on its own (no surrounding page). */
async function scannedStrip(text: string, sizePt: number, dpi = 200): Promise<{ jpg: Uint8Array; widthPt: number; heightPt: number }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const widthPt = font.widthOfTextAtSize(text, sizePt) + 8;
  const heightPt = sizePt * 1.6;
  doc.addPage([widthPt, heightPt]).drawText(text, { x: 4, y: sizePt * 0.45, size: sizePt, font });
  const raster = await PdfRasterizer.open(await doc.save(), nodeModulesAssets());
  try {
    const page = await raster.render(0, dpi);
    const rgba = new Uint8Array(page.width * page.height * 4);
    for (let p = 0; p < page.gray.data.length; p++) rgba.fill(page.gray.data[p]!, p * 4, p * 4 + 3), (rgba[p * 4 + 3] = 255);
    return { jpg: jpeg.encode({ width: page.width, height: page.height, data: rgba }, 85).data, widthPt, heightPt };
  } finally {
    raster.close();
  }
}

/**
 * A digital note with typed stamps scanned in as single-line strips. Each strip
 * is too thin to count as a picture (under 0.4 in), so only the ink-coverage
 * check can tell that most of the page's text is not in the text layer.
 */
export async function makeSparseScanPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([A4.width, A4.height]);
  page.drawText('Cover note for the attached statement.', { x: 60, y: 780, size: 12, font });
  const stamps = [
    'RECEIVED BY THE FINANCE DEPARTMENT ON 6 OCTOBER 2026',
    'APPROVED FOR PAYMENT AFTER REVIEW BY THE CONTROLLER',
    'POSTED TO THE GENERAL LEDGER UNDER ACCOUNT 4100',
  ];
  for (const [i, line] of stamps.entries()) {
    const strip = await scannedStrip(line, 16);
    const img = await pdf.embedJpg(strip.jpg);
    page.drawImage(img, { x: 50, y: 640 - i * 160, width: strip.widthPt, height: strip.heightPt });
  }
  return pdf.save();
}

/**
 * Tightly justified text: real space characters, but negative word spacing
 * closes the gaps to ~0.08 em, so measuring gaps alone runs words together.
 */
export async function makeTightJustifiedPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([A4.width, A4.height]);
  const size = 12;
  // Helvetica's space is 0.278 em; cancelling 0.2 em of it leaves a 0.078 em gap.
  page.pushOperators(setWordSpacing(-0.2 * size));
  TIGHT_LINES.forEach((line, i) => page.drawText(line, { x: 60, y: 760 - i * 16, size, font }));
  page.pushOperators(setWordSpacing(0));
  return pdf.save();
}

export const TIGHT_LINES = [
  'Tightly justified columns squeeze the space between words',
  'until the gaps are narrower than the space inside some letters.',
] as const;

/** A digital page whose section headings are bold at body size: only weight marks them. */
export async function makeBoldHeadingPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([A4.width, A4.height]);
  const body = [
    'This agreement sets out the terms under which services are provided to the client,',
    'including scope, schedule, fees and the obligations of both parties in full detail.',
  ];
  page.drawText('Payment Terms', { x: 72, y: 760, size: 11, font: bold });
  body.forEach((l, i) => page.drawText(l, { x: 72, y: 740 - i * 14, size: 11, font }));
  page.drawText('Termination', { x: 72, y: 680, size: 11, font: bold });
  body.forEach((l, i) => page.drawText(l, { x: 72, y: 660 - i * 14, size: 11, font }));
  return pdf.save();
}

/** Share of the expected words found in the recognised text (case-insensitive, punctuation ignored). */
export function wordRecall(expected: string, actual: string): number {
  const words = (s: string) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const pool = new Map<string, number>();
  for (const w of words(actual)) pool.set(w, (pool.get(w) ?? 0) + 1);
  const want = words(expected);
  let hit = 0;
  for (const w of want) {
    const n = pool.get(w) ?? 0;
    if (n > 0) {
      hit++;
      pool.set(w, n - 1);
    }
  }
  return want.length ? hit / want.length : 1;
}
