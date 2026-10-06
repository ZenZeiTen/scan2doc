import {
  AlignmentType,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type FileChild,
} from 'docx';
import {
  coveredSlots,
  languageForTag,
  officeLanguageTag,
  mmToTwips,
  pxToScreenPx,
  pxToTwips,
  resolvePageImages,
  sanitizeDocument,
  TWIPS_PER_INCH,
  type FontProps,
  type IDRDocument,
  type IDRPage,
  type IDRTableBlock,
  type IDRTextBlock,
  type ResolvedImage,
  type WriterOptions,
} from '@scan2doc/core';

/** 0.5 in page margins: scans are usually tight to the edge. */
const MARGIN_TWIPS = 720;

const HEADING = {
  title: HeadingLevel.TITLE,
  heading_1: HeadingLevel.HEADING_1,
  heading_2: HeadingLevel.HEADING_2,
  heading_3: HeadingLevel.HEADING_3,
} as const;

const ALIGN = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
} as const;

/** w:lang for a page: East Asian text goes in its own slot so Word proofs it in that language. */
function languageProps(tag: string | undefined) {
  if (!tag) return {};
  const info = languageForTag(tag);
  return { language: info?.eastAsian ? { eastAsia: officeLanguageTag(tag) } : { value: tag } };
}

function runProps(font: FontProps | undefined, lang?: string) {
  if (!font) return languageProps(lang);
  return {
    ...languageProps(lang),
    // Word picks a font per character class; naming all four keeps CJK, Thai and Latin in the measured font.
    font: { ascii: font.family, hAnsi: font.family, eastAsia: font.family, cs: font.family },
    size: Math.round(font.sizePt * 2), // half-points
    bold: font.bold,
    italics: font.italic,
    ...(font.underline && { underline: {} }),
    color: font.color.slice(1),
  };
}

/** One run per line; LF becomes a line break inside the paragraph. */
const runs = (text: string, font: FontProps | undefined, lang?: string) =>
  text.split('\n').map((line, i) => new TextRun({ text: line, ...(i > 0 && { break: 1 }), ...runProps(font, lang) }));

function textParagraph(block: IDRTextBlock, lang?: string): Paragraph {
  // Without a measured font the heading style decides the look, so Word's
  // navigation pane and outline still work and the user can restyle globally.
  return new Paragraph({
    ...(block.type !== 'body' && { heading: HEADING[block.type] }),
    alignment: ALIGN[block.align],
    children: runs(block.text, block.font, lang),
  });
}

function table(block: IDRTableBlock, page: IDRPage, contentWidth: number): Table {
  const width = Math.min(pxToTwips(block.bbox.width, page.dpi), contentWidth);
  const colWidth = Math.floor(width / block.cols);
  const anchors = new Map(block.cells.map((c) => [`${c.row},${c.col}`, c]));
  const covered = coveredSlots(block.cells);

  const rows: TableRow[] = [];
  for (let r = 0; r < block.rows; r++) {
    const children: TableCell[] = [];
    for (let c = 0; c < block.cols; c++) {
      const key = `${r},${c}`;
      if (covered.has(key)) continue; // docx re-inserts row-merge continuations itself
      const cell = anchors.get(key);
      children.push(
        new TableCell({
          children: [new Paragraph({ children: cell ? runs(cell.text, cell.font, page.language) : [] })],
          ...(cell && cell.colSpan > 1 && { columnSpan: cell.colSpan }),
          ...(cell && cell.rowSpan > 1 && { rowSpan: cell.rowSpan }),
          width: { size: colWidth * (cell?.colSpan ?? 1), type: WidthType.DXA },
        }),
      );
    }
    rows.push(new TableRow({ children }));
  }
  return new Table({
    rows,
    width: { size: colWidth * block.cols, type: WidthType.DXA },
    columnWidths: Array.from({ length: block.cols }, () => colWidth),
  });
}

function image(img: ResolvedImage, page: IDRPage, contentWidth: number): Paragraph {
  const maxWidthPx = (contentWidth / TWIPS_PER_INCH) * 96;
  let width = pxToScreenPx(img.block.bbox.width, page.dpi);
  let height = pxToScreenPx(img.block.bbox.height, page.dpi);
  if (width > maxWidthPx) {
    height *= maxWidthPx / width;
    width = maxWidthPx;
  }
  return new Paragraph({
    children: [
      new ImageRun({
        type: img.extension === 'png' ? 'png' : 'jpg',
        data: img.data,
        transformation: { width: Math.round(width), height: Math.round(height) },
        ...(img.block.altText && { altText: { name: img.block.id, description: img.block.altText } }),
      }),
    ],
  });
}

/**
 * Writes a .docx: one section per scanned page (so each keeps its own paper
 * size and orientation), blocks in their IDR order, headings as Word heading
 * styles, tables as real tables with merges.
 */
export async function writeDocx(input: IDRDocument, options: WriterOptions = {}): Promise<Uint8Array> {
  const doc = sanitizeDocument(input);
  const sections = [];
  for (const page of doc.pages) {
    const pageWidth = mmToTwips(page.sizeMm.width);
    const contentWidth = pageWidth - 2 * MARGIN_TWIPS;
    const images = await resolvePageImages(page, options.resolveImage);
    const children: FileChild[] = [];
    for (const block of page.blocks) {
      if (block.type === 'table') {
        children.push(table(block, page, contentWidth));
      } else if (block.type === 'image') {
        const img = images.get(block.id);
        if (img) children.push(image(img, page, contentWidth));
      } else {
        children.push(textParagraph(block, page.language));
      }
    }
    if (children.length === 0) children.push(new Paragraph({}));
    // Word reads orientation from w:orient, not from the size, so landscape scans
    // must say so. docx swaps width/height for LANDSCAPE: pass them portrait-wise.
    const pageHeight = mmToTwips(page.sizeMm.height);
    const landscape = pageWidth > pageHeight;
    sections.push({
      properties: {
        page: {
          size: landscape
            ? { width: pageHeight, height: pageWidth, orientation: PageOrientation.LANDSCAPE }
            : { width: pageWidth, height: pageHeight, orientation: PageOrientation.PORTRAIT },
          margin: { top: MARGIN_TWIPS, right: MARGIN_TWIPS, bottom: MARGIN_TWIPS, left: MARGIN_TWIPS },
        },
      },
      children,
    });
  }

  const document = new Document({
    creator: doc.metadata.author ?? 'scan2doc',
    ...(doc.metadata.title && { title: doc.metadata.title }),
    sections,
  });
  return new Uint8Array(await Packer.toBuffer(document));
}
