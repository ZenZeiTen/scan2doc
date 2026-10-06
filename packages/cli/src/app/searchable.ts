import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { degrees, PDFDocument, setTextRenderingMode, StandardFonts, TextRenderingMode, type PDFFont, type PDFPage } from 'pdf-lib';
import type { IDRDocument } from '@scan2doc/core';
import type { PageReport } from '@scan2doc/vision-wasm';

type Point = { x: number; y: number };
type Rotation = 0 | 90 | 180 | 270;

/**
 * Where a point of the image OCR read lands on the rendered page: OCR may have
 * turned the page clockwise by `turn` first (to stand the text upright), so
 * undo that. `w`/`h` are the turned image's size.
 */
export function unturn(p: Point, turn: Rotation, w: number, h: number): Point {
  if (turn === 90) return { x: p.y, y: w - p.x };
  if (turn === 180) return { x: w - p.x, y: h - p.y };
  if (turn === 270) return { x: h - p.y, y: p.x };
  return p;
}

/**
 * A point of the rendered page (points, y down, as displayed) in the PDF's own
 * coordinates (y up, before the page's /Rotate). `width`/`height` are the
 * unrotated page size.
 */
export function toUserSpace(p: Point, rotate: Rotation, width: number, height: number): Point {
  if (rotate === 90) return { x: p.y, y: p.x };
  if (rotate === 180) return { x: width - p.x, y: p.y };
  if (rotate === 270) return { x: width - p.y, y: height - p.x };
  return { x: p.x, y: height - p.y };
}

/** Fonts that can carry each script's text, in the order they are tried. */
const SYSTEM_FONTS = ['arial.ttf', 'segoeui.ttf', 'msyh.ttc', 'msjh.ttc', 'YuGothM.ttc', 'malgun.ttf', 'LeelawUI.ttf', 'tahoma.ttf', 'Nirmala.ttc'];

/** pdf-lib cannot open TrueType collections (.ttc); hand it the first face. */
const collectionAwareFontkit = {
  create(data: Uint8Array) {
    const font = fontkit.create(data as unknown as Buffer) as unknown as { fonts?: unknown[] };
    return font.fonts ? font.fonts[0] : font;
  },
} as unknown as typeof fontkit;

interface FontChoice {
  file: string;
  covers(text: string): boolean;
  embedded?: PDFFont;
}

function systemFonts(dir = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')): FontChoice[] {
  return SYSTEM_FONTS.map((file) => join(dir, file))
    .filter((path) => existsSync(path))
    .map((path) => {
      let face: { hasGlyphForCodePoint(c: number): boolean } | undefined;
      return {
        file: path,
        covers(text: string) {
          face ??= collectionAwareFontkit.create(readFileSync(path)) as unknown as { hasGlyphForCodePoint(c: number): boolean };
          return [...text].every((ch) => /\s/.test(ch) || face!.hasGlyphForCodePoint(ch.codePointAt(0)!));
        },
      };
    });
}

/** One line of text to hide under the image, in the turned image's pixels. */
interface HiddenLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The recognised font size, when known. */
  sizePt?: number;
  /** A paragraph's last line ends short: don't stretch it to the box. */
  isLast: boolean;
}

/** Words split into `n` lines of about equal length (a paragraph as it was set on the page). */
export function wrapInto(text: string, n: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (n <= 1 || words.length <= 1) return [words.join(' ')];
  const total = words.join(' ').length;
  const lines: string[] = [];
  let line: string[] = [];
  let used = 0;
  for (const [i, word] of words.entries()) {
    line.push(word);
    used += word.length + 1;
    const left = words.length - i - 1;
    const linesLeft = n - lines.length - 1;
    // Close the line once it reaches its share, keeping a word for each line still to come.
    if (linesLeft > 0 && left >= linesLeft && used >= (total * (lines.length + 1)) / n) {
      lines.push(line.join(' '));
      line = [];
    }
  }
  if (line.length) lines.push(line.join(' '));
  return lines;
}

function linesOf(document: IDRDocument, pageIndex: number): HiddenLine[] {
  const page = document.pages[pageIndex]!;
  const lines: HiddenLine[] = [];
  const add = (text: string, box: { x: number; y: number; width: number; height: number }, sizePt?: number) => {
    let rows = text.split('\n').map((t) => t.trim()).filter(Boolean);
    // Recognised paragraphs are one string: re-wrap into as many lines as the box holds.
    if (sizePt) {
      const lineHeight = ((sizePt * page.dpi) / 72) * 1.2;
      const fit = Math.max(1, Math.round(box.height / lineHeight));
      if (rows.length < fit) rows = wrapInto(rows.join(' '), fit);
    }
    const h = box.height / rows.length;
    rows.forEach((t, i) => lines.push({ text: t, x: box.x, y: box.y + i * h, width: box.width, height: h, ...(sizePt && { sizePt }), isLast: i === rows.length - 1 }));
  };
  for (const block of page.blocks) {
    if (block.type === 'image') continue;
    if (block.type === 'table') {
      for (const cell of block.cells) if (cell.text && cell.bbox) add(cell.text, cell.bbox, cell.font?.sizePt);
    } else add(block.text, block.bbox, block.font?.sizePt);
  }
  return lines;
}

export interface SearchableResult {
  bytes: Uint8Array;
  /** Pages (1-based) that got a hidden text layer. */
  pagesAdded: number[];
  /** Pages skipped because the PDF already had their text. */
  pagesWithText: number[];
  /** Lines left out because no installed font has their characters. */
  linesWithoutFont: number;
}

/**
 * Lays OCR's text, invisibly, over each scanned page of `pdf` so the PDF can
 * be searched and copied from, as "Recognize Text" in Acrobat does. Pages
 * whose text came from the PDF itself are left as they are.
 */
export async function makeSearchable(pdf: Uint8Array, document: IDRDocument, reports: readonly PageReport[], fontDir?: string): Promise<SearchableResult> {
  const out = await PDFDocument.load(pdf, { updateMetadata: false });
  out.registerFontkit(collectionAwareFontkit);
  const fonts = systemFonts(fontDir);
  let fallback: PDFFont | undefined;
  const result: SearchableResult = { bytes: new Uint8Array(), pagesAdded: [], pagesWithText: [], linesWithoutFont: 0 };

  async function fontFor(text: string): Promise<PDFFont | undefined> {
    const choice = fonts.find((f) => f.covers(text));
    if (choice) return (choice.embedded ??= await out.embedFont(readFileSync(choice.file), { subset: true }));
    // Without system fonts (not Windows), plain Latin text still fits the built-in Helvetica.
    if (/^[\x20-\x7e\u00a0-\u00ff]*$/.test(text)) return (fallback ??= await out.embedFont(StandardFonts.Helvetica));
    return undefined;
  }

  for (const report of reports) {
    if (report.textSource === 'pdf') {
      result.pagesWithText.push(report.sourcePage + 1);
      continue;
    }
    const idr = document.pages[report.index]!;
    const page: PDFPage = out.getPage(report.sourcePage);
    const { width, height } = page.getSize();
    const rotate = (((page.getRotation().angle % 360) + 360) % 360) as Rotation;
    const pt = 72 / idr.dpi;
    const turn = report.rotation as Rotation;
    // A point of the OCR image → the PDF's own coordinates.
    const map = (p: Point) => {
      const r = unturn(p, turn, idr.sizePx.width, idr.sizePx.height);
      return toUserSpace({ x: r.x * pt, y: r.y * pt }, rotate, width, height);
    };
    let drew = false;
    page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
    for (const line of linesOf(document, report.index)) {
      const font = await fontFor(line.text);
      if (!font) {
        result.linesWithoutFont++;
        continue;
      }
      // Baseline a fifth of the line height above its bottom; size fits both height and width.
      const start = map({ x: line.x, y: line.y + line.height * 0.8 });
      const end = map({ x: line.x + line.width, y: line.y + line.height * 0.8 });
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      const unit = font.widthOfTextAtSize(line.text, 1);
      const widthFit = unit > 0 ? length / unit : Infinity;
      // Full lines span the box; a short last line (or a table cell) keeps the recognised size.
      const size = line.sizePt
        ? Math.min(widthFit, line.isLast ? line.sizePt : line.sizePt * 1.25)
        : Math.min(line.height * pt * 0.9, widthFit);
      if (!(size > 0.5)) continue;
      const angle = (Math.atan2(end.y - start.y, end.x - start.x) * 180) / Math.PI;
      page.drawText(line.text, { x: start.x, y: start.y, size, font, rotate: degrees(angle) });
      drew = true;
    }
    page.pushOperators(setTextRenderingMode(TextRenderingMode.Fill));
    if (drew) result.pagesAdded.push(report.sourcePage + 1);
  }
  out.setProducer('Scan2Doc');
  result.bytes = await out.save();
  return result;
}
