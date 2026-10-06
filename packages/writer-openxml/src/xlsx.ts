import ExcelJS from 'exceljs';
import {
  layoutSheet,
  pxToScreenPx,
  resolvePageImages,
  sanitizeDocument,
  type FontProps,
  type IDRDocument,
  type WriterOptions,
} from '@scan2doc/core';

/** Excel column width unit ≈ one '0' of the default font ≈ 7 screen px. */
const PX_PER_CHAR = 7;
/** Column A carries free text (titles, paragraphs), so give it room to read. */
const TEXT_COLUMN_CHARS = 60;

const excelFont = (f: FontProps): Partial<ExcelJS.Font> => ({
  name: f.family,
  size: f.sizePt,
  bold: f.bold,
  italic: f.italic,
  underline: f.underline,
  color: { argb: `FF${f.color.slice(1).toUpperCase()}` },
});

/**
 * Writes an .xlsx: one worksheet per scanned page, laid out by core's
 * layoutSheet (shared with the .ods writer so both spreadsheets match).
 */
export async function writeXlsx(input: IDRDocument, options: WriterOptions = {}): Promise<Uint8Array> {
  const doc = sanitizeDocument(input);
  const wb = new ExcelJS.Workbook();
  wb.creator = doc.metadata.author ?? 'scan2doc';
  if (doc.metadata.title) wb.title = doc.metadata.title;
  wb.created = new Date(doc.metadata.createdAt);

  for (const [i, page] of doc.pages.entries()) {
    const ws = wb.addWorksheet(`Page ${i + 1}`);
    const layout = layoutSheet(page);
    const images = await resolvePageImages(page, options.resolveImage);

    for (const cell of layout.cells) {
      const c = ws.getCell(cell.row + 1, cell.col + 1);
      c.value = cell.value;
      if (cell.font) c.font = excelFont(cell.font);
      if (typeof cell.value === 'string') c.alignment = { wrapText: true, vertical: 'top' };
      if (cell.rowSpan > 1 || cell.colSpan > 1) {
        ws.mergeCells(cell.row + 1, cell.col + 1, cell.row + cell.rowSpan, cell.col + cell.colSpan);
      }
    }

    // Size table columns from the scanned table widths; column A also fits free text.
    const widths = new Array<number>(layout.colCount).fill(10);
    for (const block of page.blocks) {
      if (block.type !== 'table') continue;
      const chars = pxToScreenPx(block.bbox.width / block.cols, page.dpi) / PX_PER_CHAR;
      for (let c = 0; c < block.cols; c++) widths[c] = Math.max(widths[c]!, Math.round(chars));
    }
    if (layout.cells.some((c) => c.role !== 'table')) widths[0] = Math.max(widths[0]!, TEXT_COLUMN_CHARS);
    widths.forEach((w, c) => (ws.getColumn(c + 1).width = w));

    for (const placed of layout.images) {
      const img = images.get(placed.block.id);
      if (!img) continue;
      const id = wb.addImage({ buffer: Buffer.from(img.data) as unknown as ExcelJS.Buffer, extension: img.extension });
      ws.addImage(id, { tl: { col: placed.col, row: placed.row }, ext: { width: placed.widthPx, height: placed.heightPx } });
    }
  }

  return new Uint8Array(await wb.xlsx.writeBuffer());
}
