import {
  cm,
  coveredSlots,
  effectiveFont,
  mmToCm,
  resolvePageImages,
  sanitizeDocument,
  type BBox,
  type FontProps,
  type IDRDocument,
  type IDRPage,
  type IDRTableBlock,
  type WriterOptions,
} from '@scan2doc/core';
import { metaXml, ODF_MIME_TYPES, packOdf, Pictures } from './package.js';
import { esc, fontKey, ODF_VERSION, odfLine, FontFaces, spanAttrs, StyleRegistry, textProperties, XML_DECL, xmlns } from './xml.js';

const DEFAULT_TABLE_PT = 12;
const ALIGN = { left: 'start', center: 'center', right: 'end', justify: 'justify' } as const;

function stylesXml(slideW: number, slideH: number): string {
  return (
    `${XML_DECL}<office:document-styles ${xmlns('office', 'style', 'text', 'draw', 'fo', 'svg', 'presentation')} office:version="${ODF_VERSION}">` +
    `<office:styles><style:default-style style:family="graphic"><style:text-properties fo:font-family="Calibri" fo:font-size="18pt"/></style:default-style></office:styles>` +
    `<office:automatic-styles>` +
    `<style:page-layout style:name="PM1"><style:page-layout-properties fo:margin-top="0cm" fo:margin-bottom="0cm" fo:margin-left="0cm" fo:margin-right="0cm"` +
    ` fo:page-width="${cm(slideW)}" fo:page-height="${cm(slideH)}" style:print-orientation="${slideW > slideH ? 'landscape' : 'portrait'}"/></style:page-layout>` +
    `<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties draw:fill="none"/></style:style>` +
    `</office:automatic-styles>` +
    `<office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1" draw:style-name="dp1"/></office:master-styles>` +
    `</office:document-styles>`
  );
}

/**
 * Writes an .odp: one slide per scanned page, every block an absolutely
 * positioned frame. Like .pptx, a presentation has one slide size, so every
 * page is mapped onto the first page's size.
 */
export async function writeOdp(input: IDRDocument, options: WriterOptions = {}): Promise<Uint8Array> {
  const doc = sanitizeDocument(input);
  const first = doc.pages[0]!;
  const slideW = mmToCm(first.sizeMm.width);
  const slideH = mmToCm(first.sizeMm.height);
  const paraStyles = new StyleRegistry('P');
  const colStyles = new StyleRegistry('co');
  const pictures = new Pictures();
  const faces = new FontFaces();
  let language: string | undefined;

  const paragraphStyle = (font: FontProps, align: keyof typeof ALIGN) =>
    paraStyles.get(`${fontKey(font)}|${align}|${language ?? ''}`, (name) =>
      `<style:style style:name="${name}" style:family="paragraph"><style:paragraph-properties fo:text-align="${ALIGN[align]}"/>${textProperties(font, { faces, language })}</style:style>`,
    );
  const paragraphs = (text: string, style: string) =>
    text.split('\n').map((line) => `<text:p text:style-name="${style}">${odfLine(line)}</text:p>`).join('');

  let slides = '';
  for (const [i, page] of doc.pages.entries()) {
    language = page.language;
    const sx = slideW / page.sizePx.width;
    const sy = slideH / page.sizePx.height;
    const fontScale = Math.min(slideW / mmToCm(page.sizeMm.width), slideH / mmToCm(page.sizeMm.height));
    const scaled = (f: FontProps): FontProps => ({ ...f, sizePt: Math.max(1, Math.round(f.sizePt * fontScale * 10) / 10) });
    const frame = (b: BBox) =>
      `svg:x="${cm(b.x * sx)}" svg:y="${cm(b.y * sy)}" svg:width="${cm(b.width * sx)}" svg:height="${cm(b.height * sy)}"`;
    const images = await resolvePageImages(page, options.resolveImage);

    let shapes = '';
    for (const block of page.blocks) {
      if (block.type === 'table') {
        const colWidth = cm((block.bbox.width * sx) / block.cols);
        const colStyle = colStyles.get(colWidth, (name) =>
          `<style:style style:name="${name}" style:family="table-column"><style:table-column-properties style:column-width="${colWidth}"/></style:style>`,
        );
        shapes += `<draw:frame draw:style-name="gr1" ${frame(block.bbox)}>${tableXml(block, colStyle, scaled, paragraphStyle, paragraphs)}</draw:frame>`;
      } else if (block.type === 'image') {
        const img = images.get(block.id);
        if (!img) continue;
        const alt = block.altText ? `<svg:desc>${esc(block.altText)}</svg:desc>` : '';
        shapes +=
          `<draw:frame draw:style-name="gr1" draw:name="${esc(block.id)}" ${frame(block.bbox)}>` +
          `<draw:image xlink:href="${pictures.add(img)}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>${alt}</draw:frame>`;
      } else {
        const style = paragraphStyle(scaled(effectiveFont(block)), block.align);
        shapes += `<draw:frame draw:style-name="gr1" ${frame(block.bbox)}><draw:text-box>${paragraphs(block.text, style)}</draw:text-box></draw:frame>`;
      }
    }
    slides += `<draw:page draw:name="page${i + 1}" draw:style-name="dp1" draw:master-page-name="Default">${shapes}</draw:page>`;
  }

  const graphic =
    `<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:stroke="none" draw:fill="none"` +
    ` fo:padding-top="0cm" fo:padding-bottom="0cm" fo:padding-left="0cm" fo:padding-right="0cm"` +
    ` draw:auto-grow-height="false" draw:textarea-vertical-align="top"/></style:style>` +
    `<style:style style:name="dp1" style:family="drawing-page"/>`;
  const content =
    `${XML_DECL}<office:document-content ${xmlns('office', 'style', 'text', 'table', 'draw', 'fo', 'xlink', 'svg', 'presentation')} office:version="${ODF_VERSION}">` +
    faces.toXml() +
    `<office:automatic-styles>${graphic}${colStyles.toXml()}${paraStyles.toXml()}</office:automatic-styles>` +
    `<office:body><office:presentation>${slides}</office:presentation></office:body></office:document-content>`;

  return packOdf(ODF_MIME_TYPES.odp, { content, styles: stylesXml(slideW, slideH), meta: metaXml(doc) }, pictures.list);
}

function tableXml(
  block: IDRTableBlock,
  columnStyle: string,
  scaled: (f: FontProps) => FontProps,
  paragraphStyle: (f: FontProps, align: keyof typeof ALIGN) => string,
  paragraphs: (text: string, style: string) => string,
): string {
  const anchors = new Map(block.cells.map((c) => [`${c.row},${c.col}`, c]));
  const covered = coveredSlots(block.cells);
  const fallback: FontProps = { family: 'Calibri', sizePt: DEFAULT_TABLE_PT, bold: false, italic: false, underline: false, color: '#000000' };
  let rows = '';
  for (let r = 0; r < block.rows; r++) {
    rows += '<table:table-row>';
    for (let c = 0; c < block.cols; c++) {
      if (covered.has(`${r},${c}`)) {
        rows += '<table:covered-table-cell/>';
        continue;
      }
      const cell = anchors.get(`${r},${c}`);
      const style = paragraphStyle(scaled(cell?.font ?? fallback), 'left');
      rows += `<table:table-cell${spanAttrs(cell)}>${paragraphs(cell?.text ?? '', style)}</table:table-cell>`;
    }
    rows += '</table:table-row>';
  }
  // One element per column: PowerPoint rejects table:number-columns-repeated here
  // and then drops every shape on the slide (found by opening the output in PowerPoint).
  const columns = `<table:table-column table:style-name="${columnStyle}"/>`.repeat(block.cols);
  return `<table:table>${columns}${rows}</table:table>`;
}
