import {
  cm,
  coveredSlots,
  mmToCm,
  pxToCm,
  resolvePageImages,
  sanitizeDocument,
  type IDRDocument,
  type IDRPage,
  type IDRTableBlock,
  type IDRTextBlock,
  type ResolvedImage,
  type WriterOptions,
} from '@scan2doc/core';
import { metaXml, ODF_MIME_TYPES, packOdf, Pictures } from './package.js';
import { esc, fontKey, ODF_VERSION, odfText, FontFaces, languageAttributes, spanAttrs, StyleRegistry, textProperties, XML_DECL, xmlns } from './xml.js';

const MARGIN_CM = 2;

/** Named paragraph styles, as LibreOffice names them, so the user's style list makes sense. */
const PARENT_STYLE = {
  title: 'Title',
  heading_1: 'Heading_20_1',
  heading_2: 'Heading_20_2',
  heading_3: 'Heading_20_3',
  body: 'Text_20_body',
} as const;

const ALIGN = { left: 'start', center: 'center', right: 'end', justify: 'justify' } as const;

const NAMED_STYLES =
  `<style:default-style style:family="paragraph"><style:text-properties fo:font-family="Calibri" fo:font-size="11pt"/></style:default-style>` +
  `<style:style style:name="Standard" style:family="paragraph" style:class="text"/>` +
  `<style:style style:name="Text_20_body" style:display-name="Text body" style:family="paragraph" style:parent-style-name="Standard" style:class="text"><style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.25cm"/></style:style>` +
  `<style:style style:name="Title" style:family="paragraph" style:parent-style-name="Standard" style:class="chapter"><style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.3cm"/><style:text-properties fo:font-size="26pt" fo:font-weight="bold"/></style:style>` +
  [20, 16, 13]
    .map(
      (pt, i) =>
        `<style:style style:name="Heading_20_${i + 1}" style:display-name="Heading ${i + 1}" style:family="paragraph" style:parent-style-name="Standard" style:default-outline-level="${i + 1}" style:class="text"><style:paragraph-properties fo:margin-top="0.4cm" fo:margin-bottom="0.2cm" fo:keep-with-next="always"/><style:text-properties fo:font-size="${pt}pt" fo:font-weight="bold"/></style:style>`,
    )
    .join('');

interface Masters {
  /** Master page name per distinct paper size, keyed "w×h" in mm. */
  byKey: Map<string, { master: string; layout: string; page: IDRPage }>;
  nameFor(page: IDRPage): string;
}

function masters(pages: readonly IDRPage[]): Masters {
  const byKey = new Map<string, { master: string; layout: string; page: IDRPage }>();
  const key = (p: IDRPage) => `${p.sizeMm.width}x${p.sizeMm.height}`;
  for (const p of pages) {
    if (!byKey.has(key(p))) {
      const n = byKey.size + 1;
      byKey.set(key(p), { master: n === 1 ? 'Standard' : `Page${n}`, layout: `pm${n}`, page: p });
    }
  }
  return { byKey, nameFor: (p) => byKey.get(key(p))!.master };
}

function stylesXml(m: Masters): string {
  const layouts = [...m.byKey.values()]
    .map(({ layout, page }) => {
      const landscape = page.sizeMm.width > page.sizeMm.height;
      return (
        `<style:page-layout style:name="${layout}"><style:page-layout-properties fo:page-width="${cm(mmToCm(page.sizeMm.width))}"` +
        ` fo:page-height="${cm(mmToCm(page.sizeMm.height))}" style:print-orientation="${landscape ? 'landscape' : 'portrait'}"` +
        ` fo:margin-top="${cm(MARGIN_CM)}" fo:margin-bottom="${cm(MARGIN_CM)}" fo:margin-left="${cm(MARGIN_CM)}" fo:margin-right="${cm(MARGIN_CM)}"/></style:page-layout>`
      );
    })
    .join('');
  const masterPages = [...m.byKey.values()]
    .map(({ master, layout }) => `<style:master-page style:name="${master}" style:page-layout-name="${layout}"/>`)
    .join('');
  return (
    `${XML_DECL}<office:document-styles ${xmlns('office', 'style', 'text', 'fo', 'svg')} office:version="${ODF_VERSION}">` +
    `<office:styles>${NAMED_STYLES}</office:styles>` +
    `<office:automatic-styles>${layouts}</office:automatic-styles>` +
    `<office:master-styles>${masterPages}</office:master-styles>` +
    `</office:document-styles>`
  );
}

class Body {
  readonly paragraphStyles = new StyleRegistry('P');
  readonly tableStyles = new StyleRegistry('Tab');
  readonly frameStyle = 'fr1';
  readonly pictures = new Pictures();
  readonly faces = new FontFaces();
  /** BCP 47 language of the page being written; set before each page. */
  language: string | undefined;
  private tableCount = 0;

  /** Text properties for a paragraph style: the measured font, the page language, or both. */
  private props(font: IDRTextBlock['font']): string {
    if (font) return textProperties(font, { faces: this.faces, language: this.language });
    return this.language ? `<style:text-properties${languageAttributes(this.language)}/>` : '';
  }

  paragraph(block: IDRTextBlock): string {
    const parent = PARENT_STYLE[block.type];
    const style = this.paragraphStyles.get(`${parent}|${block.align}|${block.font ? fontKey(block.font) : ''}|${this.language ?? ''}`, (name) =>
      `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="${parent}">` +
      `<style:paragraph-properties fo:text-align="${ALIGN[block.align]}"/>${this.props(block.font)}</style:style>`,
    );
    const body = odfText(block.text);
    return block.type.startsWith('heading_')
      ? `<text:h text:style-name="${style}" text:outline-level="${block.type.slice(-1)}">${body}</text:h>`
      : `<text:p text:style-name="${style}">${body}</text:p>`;
  }

  cellParagraph(text: string, font: IDRTextBlock['font']): string {
    if (!font && !this.language) return `<text:p text:style-name="Standard">${odfText(text)}</text:p>`;
    const style = this.paragraphStyles.get(`Standard|left|${font ? fontKey(font) : ''}|${this.language ?? ''}`, (name) =>
      `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="Standard">${this.props(font)}</style:style>`,
    );
    return `<text:p text:style-name="${style}">${odfText(text)}</text:p>`;
  }

  table(block: IDRTableBlock, page: IDRPage, contentWidthCm: number): string {
    const width = Math.min(pxToCm(block.bbox.width, page.dpi), contentWidthCm);
    const style = this.tableStyles.get(cm(width), (name) =>
      `<style:style style:name="${name}" style:family="table"><style:table-properties style:width="${cm(width)}" table:align="left"/></style:style>`,
    );
    // Word rejects a table with column-spanning cells as "corrupted" unless its
    // columns declare widths (found by opening the output in Word).
    const colWidth = cm(width / block.cols);
    const colStyle = this.tableStyles.get(`col|${colWidth}`, (name) =>
      `<style:style style:name="${name}" style:family="table-column"><style:table-column-properties style:column-width="${colWidth}"/></style:style>`,
    );
    const anchors = new Map(block.cells.map((c) => [`${c.row},${c.col}`, c]));
    const covered = coveredSlots(block.cells);
    let rows = '';
    for (let r = 0; r < block.rows; r++) {
      rows += '<table:table-row>';
      for (let c = 0; c < block.cols; c++) {
        if (covered.has(`${r},${c}`)) {
          rows += '<table:covered-table-cell/>';
          continue;
        }
        const cell = anchors.get(`${r},${c}`);
        rows += `<table:table-cell office:value-type="string"${spanAttrs(cell)}>${this.cellParagraph(cell?.text ?? '', cell?.font)}</table:table-cell>`;
      }
      rows += '</table:table-row>';
    }
    this.tableCount++;
    return (
      `<table:table table:name="Table${this.tableCount}" table:style-name="${style}">` +
      `<table:table-column table:style-name="${colStyle}" table:number-columns-repeated="${block.cols}"/>${rows}</table:table>`
    );
  }

  image(img: ResolvedImage, page: IDRPage, contentWidthCm: number): string {
    let w = pxToCm(img.block.bbox.width, page.dpi);
    let h = pxToCm(img.block.bbox.height, page.dpi);
    if (w > contentWidthCm) {
      h *= contentWidthCm / w;
      w = contentWidthCm;
    }
    const href = this.pictures.add(img);
    const alt = img.block.altText ? `<svg:desc>${esc(img.block.altText)}</svg:desc>` : '';
    return (
      `<text:p text:style-name="Standard"><draw:frame draw:style-name="${this.frameStyle}" draw:name="${esc(img.block.id)}" text:anchor-type="as-char"` +
      ` svg:width="${cm(w)}" svg:height="${cm(h)}" draw:z-index="0">` +
      `<draw:image xlink:href="${href}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/>${alt}</draw:frame></text:p>`
    );
  }
}

/**
 * Writes an .odt (ISO 26300 text document): blocks flow in IDR order, headings
 * carry outline levels, and each scanned page starts on a new page whose
 * master page matches the scan's paper size.
 */
export async function writeOdt(input: IDRDocument, options: WriterOptions = {}): Promise<Uint8Array> {
  const doc = sanitizeDocument(input);
  const m = masters(doc.pages);
  const body = new Body();
  const breakStyles = new StyleRegistry('PB');
  let text = '';

  for (const [i, page] of doc.pages.entries()) {
    body.language = page.language;
    if (i > 0) {
      const master = m.nameFor(page);
      const style = breakStyles.get(master, (name) =>
        `<style:style style:name="${name}" style:family="paragraph" style:parent-style-name="Standard" style:master-page-name="${master}">` +
        `<style:paragraph-properties fo:break-before="page"/></style:style>`,
      );
      text += `<text:p text:style-name="${style}"/>`;
    }
    const contentWidthCm = mmToCm(page.sizeMm.width) - 2 * MARGIN_CM;
    const images = await resolvePageImages(page, options.resolveImage);
    for (const block of page.blocks) {
      if (block.type === 'table') text += body.table(block, page, contentWidthCm);
      else if (block.type === 'image') {
        const img = images.get(block.id);
        if (img) text += body.image(img, page, contentWidthCm);
      } else text += body.paragraph(block);
    }
  }
  if (text === '') text = '<text:p text:style-name="Standard"/>';

  const frameStyle =
    `<style:style style:name="${body.frameStyle}" style:family="graphic"><style:graphic-properties style:wrap="none"` +
    ` style:vertical-pos="top" style:vertical-rel="baseline" draw:stroke="none" draw:fill="none"/></style:style>`;
  const content =
    `${XML_DECL}<office:document-content ${xmlns('office', 'style', 'text', 'table', 'draw', 'fo', 'xlink', 'svg')} office:version="${ODF_VERSION}">` +
    body.faces.toXml() +
    `<office:automatic-styles>${body.paragraphStyles.toXml()}${breakStyles.toXml()}${body.tableStyles.toXml()}${frameStyle}</office:automatic-styles>` +
    `<office:body><office:text>${text}</office:text></office:body></office:document-content>`;

  return packOdf(ODF_MIME_TYPES.odt, { content, styles: stylesXml(m), meta: metaXml(doc) }, body.pictures.list);
}
