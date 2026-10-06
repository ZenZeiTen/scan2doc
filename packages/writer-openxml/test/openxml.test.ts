import { describe, expect, it } from 'vitest';
import { writeDocx, writeOpenXml, writePptx, writeXlsx } from '../src/index.js';
import { all, attr, kids, NS, openPackage, parseAllXmlParts } from '../../../test/support/package-inspect.js';
import { BELL, sampleDocument } from '../../../test/support/sample-doc.js';

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

async function contentTypesCoverEveryPart(bytes: Uint8Array) {
  const pkg = await openPackage(bytes);
  const ct = await pkg.xml('[Content_Types].xml');
  const ns = 'http://schemas.openxmlformats.org/package/2006/content-types';
  const defaults = new Set(all(ct, ns, 'Default').map((d) => d.getAttribute('Extension')!.toLowerCase()));
  const overrides = new Set(all(ct, ns, 'Override').map((o) => o.getAttribute('PartName')!.slice(1)));
  return pkg.names.filter((n) => n !== '[Content_Types].xml' && !overrides.has(n) && !defaults.has(n.split('.').pop()!.toLowerCase()));
}

describe('writeDocx', () => {
  it('produces a package whose XML parts all parse and are all typed', async () => {
    const bytes = await writeDocx(sampleDocument());
    const pkg = await openPackage(bytes);
    expect(await parseAllXmlParts(pkg)).toBeGreaterThanOrEqual(5);
    expect(await contentTypesCoverEveryPart(bytes)).toEqual([]);
    expect(pkg.names.some((n) => /^word\/media\/.+\.png$/.test(n))).toBe(true);
  });

  it('writes escaped text, line breaks, heading styles, and no control characters', async () => {
    const xml = await (await openPackage(await writeDocx(sampleDocument()))).text('word/document.xml');
    expect(xml).toContain('Annual Report 2026 &amp; &lt;Outlook&gt;');
    expect(xml).not.toContain(BELL);
    expect(xml).toContain('Revenue grew  12%');
    expect(xml).toMatch(/<w:pStyle w:val="Title"\/>/);
    expect(xml).toMatch(/<w:pStyle w:val="Heading1"\/>/);
    expect(xml).toMatch(/<w:pStyle w:val="Heading3"\/>/);
    expect(xml).toMatch(/<w:br\/>/);
  });

  it('gives each page its own section and paper size', async () => {
    const doc = await (await openPackage(await writeDocx(sampleDocument()))).xml('word/document.xml');
    const sizes = all(doc, NS.w, 'pgSz').map((s) => [attr(s, NS.w, 'w'), attr(s, NS.w, 'h'), attr(s, NS.w, 'orient')]);
    // Word takes orientation from w:orient, not from w > h (found by opening the file in Word).
    expect(sizes).toEqual([
      ['11906', '16838', 'portrait'],
      ['16838', '11906', 'landscape'],
    ]);
  });

  it('writes merged table cells so every row fills the grid', async () => {
    const doc = await (await openPackage(await writeDocx(sampleDocument()))).xml('word/document.xml');
    const [tbl] = all(doc, NS.w, 'tbl');
    const grid = all(tbl!, NS.w, 'gridCol').length;
    const widths = kids(tbl!, NS.w, 'tr').map((tr) =>
      kids(tr, NS.w, 'tc').reduce((n, tc) => {
        const span = all(tc, NS.w, 'gridSpan')[0];
        return n + (span ? Number(attr(span, NS.w, 'val')) : 1);
      }, 0),
    );
    expect(grid).toBe(3);
    expect(widths).toEqual([3, 3, 3]);
    const vMerges = all(tbl!, NS.w, 'vMerge').map((v) => attr(v, NS.w, 'val') || 'continue');
    expect(vMerges).toEqual(['restart', 'continue']);
  });

  it('leaves out images it cannot resolve instead of failing', async () => {
    const pkg = await openPackage(await writeDocx(sampleDocument({ imageDataRef: 'asset://missing' })));
    expect(pkg.names.some((n) => n.startsWith('word/media/'))).toBe(false);
    await parseAllXmlParts(pkg);
  });
});

describe('writeXlsx', () => {
  it('produces a package whose XML parts all parse and are all typed', async () => {
    const bytes = await writeXlsx(sampleDocument());
    expect(await parseAllXmlParts(await openPackage(bytes))).toBeGreaterThanOrEqual(5);
    expect(await contentTypesCoverEveryPart(bytes)).toEqual([]);
  });

  it('writes one sheet per page with merges, numbers and leading-zero text', async () => {
    const pkg = await openPackage(await writeXlsx(sampleDocument()));
    const wb = await pkg.text('xl/workbook.xml');
    expect(wb.match(/<sheet /g)).toHaveLength(2);
    const sheet = await pkg.text('xl/worksheets/sheet1.xml');
    // Hand-computed from layoutSheet: table header at row 15, the "2026" merge at A16:A17.
    expect(sheet).toContain('ref="A15:C15"');
    expect(sheet).toContain('ref="A16:A17"');
    expect(sheet).toMatch(/<c r="C16"[^>]*><v>12<\/v><\/c>/);
    expect(sheet).not.toMatch(/<c r="C16"[^>]*t="s"/);
    const shared = await pkg.text('xl/sharedStrings.xml');
    expect(shared).toContain('<t>007</t>');
    expect(shared).toContain('Annual Report 2026 &amp; &lt;Outlook&gt;');
    expect(shared).not.toContain(BELL);
    expect(pkg.names.some((n) => /^xl\/media\/.+\.png$/.test(n))).toBe(true);
  });
});

describe('writePptx', () => {
  it('produces a package whose XML parts all parse and are all typed', async () => {
    const bytes = await writePptx(sampleDocument());
    expect(await parseAllXmlParts(await openPackage(bytes))).toBeGreaterThanOrEqual(10);
    expect(await contentTypesCoverEveryPart(bytes)).toEqual([]);
  });

  it('sizes the deck to the first page and writes one slide per page', async () => {
    const pkg = await openPackage(await writePptx(sampleDocument()));
    const pres = await pkg.xml('ppt/presentation.xml');
    const p = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    const size = all(pres, p, 'sldSz')[0]!;
    expect(Math.abs(Number(size.getAttribute('cx')) - 7_560_000)).toBeLessThan(1000); // 210 mm
    expect(Math.abs(Number(size.getAttribute('cy')) - 10_692_000)).toBeLessThan(1000); // 297 mm
    expect(all(pres, p, 'sldId')).toHaveLength(2);
    expect(all(pres, p, 'sldId').every((s) => s.getAttributeNS(R, 'id'))).toBe(true);
  });

  it('writes text and a merged table whose rows each hold one cell per grid column', async () => {
    const pkg = await openPackage(await writePptx(sampleDocument()));
    const raw = await pkg.text('ppt/slides/slide1.xml');
    expect(raw).toContain('Annual Report 2026 &amp; &lt;Outlook&gt;');
    expect(raw).not.toContain(BELL);
    const slide = await pkg.xml('ppt/slides/slide1.xml');
    const [tbl] = all(slide, NS.a, 'tbl');
    const grid = all(tbl!, NS.a, 'gridCol').length;
    expect(grid).toBe(3);
    expect(kids(tbl!, NS.a, 'tr').map((tr) => kids(tr, NS.a, 'tc').length)).toEqual([3, 3, 3]);
    expect(raw).toContain('gridSpan="3"');
    expect(raw).toContain('rowSpan="2"');
    expect(pkg.names.some((n) => /^ppt\/media\/.+\.png$/.test(n))).toBe(true);
  });
});

describe('writeOpenXml', () => {
  it('dispatches by format', async () => {
    const doc = sampleDocument();
    for (const [format, part] of [['docx', 'word/document.xml'], ['xlsx', 'xl/workbook.xml'], ['pptx', 'ppt/presentation.xml']] as const) {
      const pkg = await openPackage(await writeOpenXml(doc, format));
      expect(pkg.names).toContain(part);
    }
  });
});
