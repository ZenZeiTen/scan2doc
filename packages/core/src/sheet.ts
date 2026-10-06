import { effectiveFont } from './fonts.js';
import type { FontProps, IDRBlock, IDRImageBlock, IDRPage } from './schema.js';
import { pxToScreenPx } from './units.js';

export interface SheetCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  text: string;
  /** Number for plain decimal text, otherwise the text itself. */
  value: string | number;
  font?: FontProps;
  role: Exclude<IDRBlock['type'], 'image'>;
}

export interface SheetImage {
  row: number;
  col: number;
  block: IDRImageBlock;
  /** Display size in 96-dpi screen pixels. */
  widthPx: number;
  heightPx: number;
}

export interface SheetLayout {
  cells: SheetCell[];
  images: SheetImage[];
  rowCount: number;
  colCount: number;
}

/** Row height spreadsheet apps use by default (≈15 pt), in screen pixels. */
export const DEFAULT_ROW_HEIGHT_PX = 20;

/**
 * Plain decimals become numbers so formulas work on them; anything a number
 * would mangle stays text: leading zeros ("007"), thousands separators, units.
 */
export function parseCellValue(text: string): string | number {
  const t = text.trim();
  return /^-?(0|[1-9]\d*)(\.\d+)?$/.test(t) ? Number(t) : text;
}

/**
 * Lays one page out as a sheet, top to bottom in block order: each text block
 * takes one row in column A, each table its own rows (merges preserved), each
 * image enough rows to hold it. A blank row follows every table and image.
 */
export function layoutSheet(page: IDRPage): SheetLayout {
  const cells: SheetCell[] = [];
  const images: SheetImage[] = [];
  let row = 0;
  let colCount = 1;

  for (const block of page.blocks) {
    if (block.type === 'table') {
      for (const c of block.cells) {
        cells.push({
          row: row + c.row,
          col: c.col,
          rowSpan: c.rowSpan,
          colSpan: c.colSpan,
          text: c.text,
          value: parseCellValue(c.text),
          ...(c.font && { font: c.font }),
          role: 'table',
        });
      }
      colCount = Math.max(colCount, block.cols);
      row += block.rows + 1;
    } else if (block.type === 'image') {
      const widthPx = pxToScreenPx(block.bbox.width, page.dpi);
      const heightPx = pxToScreenPx(block.bbox.height, page.dpi);
      images.push({ row, col: 0, block, widthPx, heightPx });
      row += Math.ceil(heightPx / DEFAULT_ROW_HEIGHT_PX) + 1;
    } else {
      cells.push({ row, col: 0, rowSpan: 1, colSpan: 1, text: block.text, value: block.text, font: effectiveFont(block), role: block.type });
      row += 1;
    }
  }
  return { cells, images, rowCount: row, colCount };
}

/** Grid slots hidden under a merge, as "row,col" keys (anchor slots excluded). */
export function coveredSlots(cells: readonly { row: number; col: number; rowSpan: number; colSpan: number }[]): Set<string> {
  const covered = new Set<string>();
  for (const c of cells) {
    for (let r = c.row; r < c.row + c.rowSpan; r++) {
      for (let k = c.col; k < c.col + c.colSpan; k++) {
        if (r !== c.row || k !== c.col) covered.add(`${r},${k}`);
      }
    }
  }
  return covered;
}
