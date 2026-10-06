import {
  cm,
  coveredSlots,
  layoutSheet,
  pxToCm,
  resolvePageImages,
  sanitizeDocument,
  SCREEN_DPI,
  type FontProps,
  type IDRDocument,
  type SheetCell,
  type WriterOptions,
} from '@scan2doc/core';
import { metaXml, ODF_MIME_TYPES, packOdf, Pictures } from './package.js';
import { esc, fontKey, ODF_VERSION, odfLine, FontFaces, languageAttributes, spanAttrs, StyleRegistry, textProperties, XML_DECL, xmlns } from './xml.js';

/** Column widths matching the .xlsx writer: wide column A for free text, 2.5 cm otherwise. */
const TEXT_COLUMN_CM = 11;
const DEFAULT_COLUMN_CM = 2.5;

const STYLES =
  `${XML_DECL}<office:document-styles ${xmlns('office', 'style', 'fo')} office:version="${ODF_VERSION}"><office:styles>` +
  `<style:default-style style:family="table-cell"><style:text-properties fo:font-family="Calibri" fo:font-size="11pt"/></style:default-style>` +
  `</office:styles></office:document-styles>`;

const cellBody = (text: string) => text.split('\n').map((line) => `<text:p>${odfLine(line)}</text:p>`).join('');

/**
 * Writes an .ods: one sheet per scanned page, laid out by core's layoutSheet
 * (shared with the .xlsx writer). Plain decimals are stored as numbers.
 */
export async function writeOds(input: IDRDocument, options: WriterOptions = {}): Promise<Uint8Array> {
  const doc = sanitizeDocument(input);
  const cellStyles = new StyleRegistry('ce');
  const pictures = new Pictures();
  const faces = new FontFaces();
  let language: string | undefined;
  const styleFor = (font: FontProps | undefined, wrap: boolean) =>
    cellStyles.get(`${font ? fontKey(font) : ''}|${wrap}|${language ?? ''}`, (name) =>
      `<style:style style:name="${name}" style:family="table-cell">` +
      (wrap ? '<style:table-cell-properties fo:wrap-option="wrap" style:vertical-align="top"/>' : '') +
      (font ? textProperties(font, { faces, language }) : language ? `<style:text-properties${languageAttributes(language)}/>` : '') +
      `</style:style>`,
    );

  let tables = '';
  for (const [i, page] of doc.pages.entries()) {
    language = page.language;
    const layout = layoutSheet(page);
    const images = await resolvePageImages(page, options.resolveImage);
    const anchors = new Map<string, SheetCell>(layout.cells.map((c) => [`${c.row},${c.col}`, c]));
    const covered = coveredSlots(layout.cells);
    const imagesAt = new Map(layout.images.map((im) => [`${im.row},${im.col}`, im]));
    const hasText = layout.cells.some((c) => c.role !== 'table');

    let rows = '';
    for (let r = 0; r < Math.max(layout.rowCount, 1); r++) {
      rows += '<table:table-row>';
      for (let c = 0; c < layout.colCount; c++) {
        const key = `${r},${c}`;
        if (covered.has(key)) {
          rows += '<table:covered-table-cell/>';
          continue;
        }
        const cell = anchors.get(key);
        if (cell) {
          const spans = spanAttrs(cell);
          const isNumber = typeof cell.value === 'number';
          const value = isNumber ? ` office:value-type="float" office:value="${cell.value}"` : ' office:value-type="string"';
          rows += `<table:table-cell table:style-name="${styleFor(cell.font, !isNumber)}"${value}${spans}>${cellBody(cell.text)}</table:table-cell>`;
          continue;
        }
        const placed = imagesAt.get(key);
        const img = placed && images.get(placed.block.id);
        if (placed && img) {
          const alt = placed.block.altText ? `<svg:desc>${esc(placed.block.altText)}</svg:desc>` : '';
          rows +=
            `<table:table-cell><draw:frame draw:name="${esc(placed.block.id)}" draw:z-index="0" svg:x="0cm" svg:y="0cm"` +
            ` svg:width="${cm(pxToCm(placed.widthPx, SCREEN_DPI))}" svg:height="${cm(pxToCm(placed.heightPx, SCREEN_DPI))}">` +
            `<draw:image xlink:href="${pictures.add(img)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>${alt}</draw:frame></table:table-cell>`;
          continue;
        }
        rows += '<table:table-cell/>';
      }
      rows += '</table:table-row>';
    }

    const columns =
      (hasText ? `<table:table-column table:style-name="coText"/>` : `<table:table-column table:style-name="co1"/>`) +
      (layout.colCount > 1 ? `<table:table-column table:style-name="co1" table:number-columns-repeated="${layout.colCount - 1}"/>` : '');
    tables += `<table:table table:name="Page ${i + 1}">${columns}${rows}</table:table>`;
  }

  const columnStyles =
    `<style:style style:name="coText" style:family="table-column"><style:table-column-properties style:column-width="${cm(TEXT_COLUMN_CM)}"/></style:style>` +
    `<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="${cm(DEFAULT_COLUMN_CM)}"/></style:style>`;
  const content =
    `${XML_DECL}<office:document-content ${xmlns('office', 'style', 'text', 'table', 'draw', 'fo', 'xlink', 'svg')} office:version="${ODF_VERSION}">` +
    faces.toXml() +
    `<office:automatic-styles>${columnStyles}${cellStyles.toXml()}</office:automatic-styles>` +
    `<office:body><office:spreadsheet>${tables}</office:spreadsheet></office:body></office:document-content>`;

  return packOdf(ODF_MIME_TYPES.ods, { content, styles: STYLES, meta: metaXml(doc) }, pictures.list);
}
