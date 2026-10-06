import PptxGenJS from 'pptxgenjs';
import {
  coveredSlots,
  effectiveFont,
  mmToInches,
  resolvePageImages,
  sanitizeDocument,
  type BBox,
  type FontProps,
  type IDRDocument,
  type IDRPage,
  type IDRTableBlock,
  type WriterOptions,
} from '@scan2doc/core';

/** Table text size when the vision engine did not measure one. */
const DEFAULT_TABLE_PT = 12;

/**
 * Maps page-pixel boxes onto the deck's slide size. A deck has a single slide
 * size, so every page is stretched to the first page's size; for scanned slide
 * decks the pages share one size anyway.
 */
function slideFrame(page: IDRPage, slideW: number, slideH: number) {
  const sx = slideW / page.sizePx.width;
  const sy = slideH / page.sizePx.height;
  // Fonts scale with the slide, by the smaller axis so text never outgrows its box.
  const fontScale = Math.min(slideW / mmToInches(page.sizeMm.width), slideH / mmToInches(page.sizeMm.height));
  return {
    pos: (b: BBox) => ({ x: b.x * sx, y: b.y * sy, w: b.width * sx, h: b.height * sy }),
    pt: (sizePt: number) => Math.max(1, Math.round(sizePt * fontScale * 10) / 10),
  };
}

function textProps(font: FontProps, pt: (n: number) => number) {
  return {
    fontFace: font.family,
    fontSize: pt(font.sizePt),
    bold: font.bold,
    italic: font.italic,
    ...(font.underline && { underline: { style: 'sng' as const } }),
    color: font.color.slice(1),
  };
}

function tableRows(block: IDRTableBlock, pt: (n: number) => number): PptxGenJS.TableRow[] {
  const anchors = new Map(block.cells.map((c) => [`${c.row},${c.col}`, c]));
  const covered = coveredSlots(block.cells);
  const rows: PptxGenJS.TableRow[] = [];
  for (let r = 0; r < block.rows; r++) {
    const row: PptxGenJS.TableCell[] = [];
    for (let c = 0; c < block.cols; c++) {
      if (covered.has(`${r},${c}`)) continue; // pptxgenjs expects merged-over slots omitted
      const cell = anchors.get(`${r},${c}`);
      row.push({
        text: cell?.text ?? '',
        options: {
          ...(cell && cell.colSpan > 1 && { colspan: cell.colSpan }),
          ...(cell && cell.rowSpan > 1 && { rowspan: cell.rowSpan }),
          ...(cell?.font ? textProps(cell.font, pt) : { fontSize: pt(DEFAULT_TABLE_PT) }),
          valign: 'top',
        },
      });
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Writes a .pptx: one slide per scanned page, every block an absolutely
 * positioned shape at its scanned position.
 */
export async function writePptx(input: IDRDocument, options: WriterOptions = {}): Promise<Uint8Array> {
  const doc = sanitizeDocument(input);
  const first = doc.pages[0]!;
  const slideW = mmToInches(first.sizeMm.width);
  const slideH = mmToInches(first.sizeMm.height);

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'SCAN2DOC', width: slideW, height: slideH });
  pptx.layout = 'SCAN2DOC';
  pptx.author = doc.metadata.author ?? 'scan2doc';
  if (doc.metadata.title) pptx.title = doc.metadata.title;

  for (const page of doc.pages) {
    const slide = pptx.addSlide();
    const { pos, pt } = slideFrame(page, slideW, slideH);
    const images = await resolvePageImages(page, options.resolveImage);

    for (const block of page.blocks) {
      if (block.type === 'table') {
        const p = pos(block.bbox);
        slide.addTable(tableRows(block, pt), {
          ...p,
          colW: Array.from({ length: block.cols }, () => p.w / block.cols),
          rowH: Array.from({ length: block.rows }, () => p.h / block.rows),
          border: { type: 'solid', pt: 0.75, color: '808080' },
        });
      } else if (block.type === 'image') {
        const img = images.get(block.id);
        if (!img) continue;
        slide.addImage({
          data: `image/${img.extension};base64,${Buffer.from(img.data).toString('base64')}`,
          ...pos(block.bbox),
          ...(block.altText && { altText: block.altText }),
        });
      } else {
        slide.addText(block.text, {
          ...pos(block.bbox),
          ...textProps(effectiveFont(block), pt),
          align: block.align,
          valign: 'top',
          margin: 0,
        });
      }
    }
  }

  return (await pptx.write({ outputType: 'uint8array' })) as Uint8Array;
}
