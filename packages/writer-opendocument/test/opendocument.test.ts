import { describe, expect, it } from 'vitest';
import { ODF_MIME_TYPES, writeOdp, writeOds, writeOdt, writeOpenDocument } from '../src/index.js';
import { odfLine, odfText } from '../src/xml.js';
import { all, attr, NS, odfRowWidths, openPackage, parseAllXmlParts } from '../../../test/support/package-inspect.js';
import { BELL, sampleDocument } from '../../../test/support/sample-doc.js';

const WRITERS = [
  ['odt', writeOdt],
  ['ods', writeOds],
  ['odp', writeOdp],
] as const;

/** Reads the first local file header straight from the bytes (ISO 26300-3 §3.3). */
function firstEntry(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  return {
    signature: view.getUint32(0, true),
    method: view.getUint16(8, true),
    name: new TextDecoder().decode(bytes.subarray(30, 30 + nameLen)),
    extraLen,
    data: new TextDecoder().decode(bytes.subarray(30 + nameLen + extraLen, 30 + nameLen + extraLen + view.getUint32(18, true))),
  };
}

describe.each(WRITERS)('%s package', (format, write) => {
  it('starts with an uncompressed mimetype entry and no extra field', async () => {
    const entry = firstEntry(await write(sampleDocument()));
    expect(entry).toEqual({ signature: 0x04034b50, method: 0, name: 'mimetype', extraLen: 0, data: ODF_MIME_TYPES[format] });
  });

  it('lists exactly the parts it contains in the manifest', async () => {
    const pkg = await openPackage(await write(sampleDocument()));
    const manifest = await pkg.xml('META-INF/manifest.xml');
    const entries = all(manifest, NS.manifest, 'file-entry').map((e) => attr(e, NS.manifest, 'full-path'));
    expect(entries[0]).toBe('/');
    const root = all(manifest, NS.manifest, 'file-entry')[0]!;
    expect(attr(root, NS.manifest, 'media-type')).toBe(ODF_MIME_TYPES[format]);
    const listed = entries.slice(1).sort();
    const present = pkg.names.filter((n) => n !== 'mimetype' && n !== 'META-INF/manifest.xml').sort();
    expect(listed).toEqual(present);
    expect(present.filter((n) => n.startsWith('Pictures/'))).toHaveLength(1);
  });

  it('has XML parts that all parse, escaped text and no control characters', async () => {
    const pkg = await openPackage(await write(sampleDocument()));
    expect(await parseAllXmlParts(pkg)).toBe(4);
    const content = await pkg.text('content.xml');
    expect(content).toContain('Annual Report 2026 &amp; &lt;Outlook&gt;');
    expect(content).not.toContain(BELL);
    expect(content).toContain('Quarterly figures');
    expect(content).toContain('Appendix');
  });

  it('fills every table row to the declared column count', async () => {
    const content = await (await openPackage(await write(sampleDocument()))).xml('content.xml');
    const tables = odfRowWidths(content);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) for (const w of t.rows) expect(w).toBe(t.declared);
  });

  it('writes both span attributes on every merged cell (Excel ignores a merge with only one)', async () => {
    const content = await (await openPackage(await write(sampleDocument()))).text('content.xml');
    expect(content).toContain('table:number-columns-spanned="3" table:number-rows-spanned="1"');
    expect(content).toContain('table:number-columns-spanned="1" table:number-rows-spanned="2"');
    // and never one without the other
    expect(content).not.toMatch(/number-columns-spanned="\d+"(?! table:number-rows-spanned)/);
    expect(content).not.toMatch(/(?<!number-columns-spanned="\d+" )table:number-rows-spanned/);
  });

  it('omits unresolvable images instead of failing', async () => {
    const pkg = await openPackage(await write(sampleDocument({ imageDataRef: 'asset://missing' })));
    expect(pkg.names.some((n) => n.startsWith('Pictures/'))).toBe(false);
    await parseAllXmlParts(pkg);
  });
});

describe('languages and fonts in ODF styles', () => {
  const japanese = () => {
    const doc = sampleDocument();
    return { ...doc, pages: doc.pages.map((p) => ({ ...p, language: 'ja', blocks: p.blocks.map((b) => (b.type === 'body' ? { ...b, font: { family: 'Yu Gothic', sizePt: 11, bold: false, italic: false, underline: false, color: '#000000' } } : b)) })) };
  };

  it.each(WRITERS)('%s tags East Asian text in the asian slot and declares its fonts', async (_f, write) => {
    const content = await (await openPackage(await write(japanese()))).text('content.xml');
    // Word otherwise reads Japanese in an .odt as Chinese; Excel ignores fonts that are not declared faces.
    expect(content).toContain('style:language-asian="ja" style:country-asian="JP"');
    expect(content).toMatch(/<office:font-face-decls>.*<style:font-face style:name="Yu Gothic" svg:font-family="'Yu Gothic'"\/>.*<\/office:font-face-decls><office:automatic-styles>/);
    expect(content).toContain('style:font-name="Yu Gothic" style:font-name-asian="Yu Gothic" style:font-name-complex="Yu Gothic"');
  });

  it('puts Western and complex-script languages in their own slots', async () => {
    const { languageAttributes } = await import('../src/xml.js');
    expect(languageAttributes('de')).toBe(' fo:language="de"');
    expect(languageAttributes('th')).toBe(' style:language-complex="th"');
    expect(languageAttributes('zh-Hant')).toBe(' style:language-asian="zh" style:country-asian="TW"');
    expect(languageAttributes(undefined)).toBe('');
  });
});

describe('ODF text encoding', () => {
  it('keeps significant spaces, tabs and line breaks', () => {
    expect(odfLine('a  b')).toBe('a <text:s text:c="1"/>b');
    expect(odfLine('  lead')).toBe('<text:s text:c="2"/>lead');
    expect(odfLine('x\t y')).toBe('x<text:tab/> y');
    expect(odfText('one\ntwo & <three>')).toBe('one<text:line-break/>two &amp; &lt;three&gt;');
  });
});

describe('writeOdt', () => {
  it('writes headings with outline levels and the body text with its whitespace', async () => {
    const content = await (await openPackage(await writeOdt(sampleDocument()))).text('content.xml');
    expect(content).toMatch(/<text:h text:style-name="P\d+" text:outline-level="1">Revenue<\/text:h>/);
    expect(content).toMatch(/text:outline-level="3">Notes<\/text:h>/);
    expect(content).toContain('Revenue grew <text:s text:c="1"/>12%<text:line-break/>across all regions.<text:tab/>See table.');
    expect(content).toContain('table:number-columns-spanned="3"');
    expect(content).toContain('table:number-rows-spanned="2"');
  });

  it('declares column widths (Word calls column-spanning tables without them corrupted)', async () => {
    const content = await (await openPackage(await writeOdt(sampleDocument()))).text('content.xml');
    // Table 1040 px @150 dpi = 17.6107 cm wide, clamped to the 17 cm text width → 3 × 5.6667 cm.
    expect(content).toMatch(/<style:style style:name="(Tab\d+)" style:family="table-column"><style:table-column-properties style:column-width="5.6667cm"\/>/);
    expect(content).toMatch(/<table:table-column table:style-name="Tab\d+" table:number-columns-repeated="3"\/>/);
  });

  it('switches to a landscape master page for the landscape scan', async () => {
    const pkg = await openPackage(await writeOdt(sampleDocument()));
    const styles = await pkg.text('styles.xml');
    expect(styles).toMatch(/fo:page-width="21cm" fo:page-height="29.7cm" style:print-orientation="portrait"/);
    expect(styles).toMatch(/fo:page-width="29.7cm" fo:page-height="21cm" style:print-orientation="landscape"/);
    expect(styles).toContain('<style:master-page style:name="Page2" style:page-layout-name="pm2"/>');
    const content = await pkg.text('content.xml');
    expect(content).toMatch(/style:master-page-name="Page2"><style:paragraph-properties fo:break-before="page"\/>/);
  });
});

describe('writeOds', () => {
  it('stores plain decimals as floats and leading-zero codes as strings', async () => {
    const content = await (await openPackage(await writeOds(sampleDocument()))).text('content.xml');
    expect(content).toMatch(/office:value-type="float" office:value="12"><text:p>12<\/text:p>/);
    expect(content).toMatch(/office:value-type="string"><text:p>007<\/text:p>/);
    expect(content.match(/<table:table table:name="Page \d">/g)).toEqual(['<table:table table:name="Page 1">', '<table:table table:name="Page 2">']);
  });

  it('places the table where the shared sheet layout puts it (row 15)', async () => {
    const doc = await (await openPackage(await writeOds(sampleDocument()))).xml('content.xml');
    const [sheet] = all(doc, NS.table, 'table');
    const rows = all(sheet!, NS.table, 'table-row');
    expect(rows[14]!.textContent).toBe('Quarterly figures');
    expect(rows[15]!.textContent).toBe('2026Q112');
  });
});

describe('writeOdp', () => {
  it('writes one slide per page at the first page size', async () => {
    const pkg = await openPackage(await writeOdp(sampleDocument()));
    const content = await pkg.text('content.xml');
    expect(content.match(/<draw:page /g)).toHaveLength(2);
    expect(await pkg.text('styles.xml')).toContain('fo:page-width="21cm" fo:page-height="29.7cm"');
    // Title box: x 100 px of 1240 → 100/1240 × 21 cm = 1.6935 cm.
    expect(content).toContain('svg:x="1.6935cm"');
  });

  it('declares table columns one by one (PowerPoint drops the whole slide on a repeated column)', async () => {
    const content = await (await openPackage(await writeOdp(sampleDocument()))).text('content.xml');
    expect(content).not.toContain('number-columns-repeated');
    // Table 1040 px of 1240 → 17.6129 cm wide, 3 columns of 5.871 cm.
    expect(content).toMatch(/<table:table>(<table:table-column table:style-name="co\d+"\/>){3}<table:table-row>/);
    expect(content).toContain('style:column-width="5.871cm"');
  });
});

describe('writeOpenDocument', () => {
  it('dispatches by format', async () => {
    for (const format of ['odt', 'ods', 'odp'] as const) {
      expect(firstEntry(await writeOpenDocument(sampleDocument(), format)).data).toBe(ODF_MIME_TYPES[format]);
    }
  });
});
