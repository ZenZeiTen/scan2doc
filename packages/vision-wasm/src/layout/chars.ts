import type { BBox, FontProps } from '@scan2doc/core';
import type { PdfChar } from '../textlayer.js';
import { joinLines, median } from './text.js';

export interface CharLine {
  bbox: BBox;
  text: string;
  chars: PdfChar[];
  sizePt: number;
}

export interface CharParagraph {
  bbox: BBox;
  lines: CharLine[];
  text: string;
  font: FontProps;
}

/** Word gap: a horizontal gap wider than this share of the font's pixel size is a space. */
const WORD_GAP_EM = 0.22;
/** Column gutter: a gap wider than this many ems splits a row into separate lines. */
const COLUMN_GAP_EM = 1.8;
/** Lines this close (in line heights) and of matching style form one paragraph. */
const PARAGRAPH_GAP_LINES = 0.75;

const union = (boxes: readonly BBox[]): BBox => {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
};

/** Most common value (by character count) — the paragraph's dominant style. */
function majority<T>(values: readonly T[]): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/**
 * Rebuilds text lines from positioned characters: rows of vertically
 * overlapping characters, split at column gutters, with spaces restored
 * where the gap between letters is a word break.
 */
export function buildLines(chars: readonly PdfChar[], dpi: number): CharLine[] {
  const pxPerPt = dpi / 72;
  const sorted = [...chars].sort((a, b) => a.box.y + a.box.height / 2 - (b.box.y + b.box.height / 2));
  const rows: PdfChar[][] = [];
  for (const c of sorted) {
    const cy = c.box.y + c.box.height / 2;
    const row = rows.at(-1);
    const first = row?.[0];
    const rowCy = first ? first.box.y + first.box.height / 2 : 0;
    // Same row when centres are within 40% of the smaller font's pixel size.
    if (row && first && Math.abs(cy - rowCy) <= 0.4 * Math.min(c.sizePt, first.sizePt) * pxPerPt) row.push(c);
    else rows.push([c]);
  }
  const lines: CharLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.box.x - b.box.x);
    let current: PdfChar[] = [];
    let text = '';
    const flush = () => {
      if (current.length) lines.push({ bbox: union(current.map((c) => c.box)), text, chars: current, sizePt: median(current.map((c) => c.sizePt)) });
      current = [];
      text = '';
    };
    for (const c of row) {
      const prev = current.at(-1);
      if (prev) {
        const gap = c.box.x - (prev.box.x + prev.box.width);
        const em = Math.max(prev.sizePt, c.sizePt) * pxPerPt;
        if (gap > COLUMN_GAP_EM * em) flush();
        else if (gap > WORD_GAP_EM * em || c.spaceBefore) text += ' ';
      }
      current.push(c);
      text += c.text;
    }
    flush();
  }
  return lines;
}

const styleOf = (l: CharLine) => {
  const c = l.chars;
  return { family: majority(c.map((x) => x.family)), bold: majority(c.map((x) => x.bold)), italic: majority(c.map((x) => x.italic)) };
};

/**
 * Groups lines into paragraphs: consecutive lines (top to bottom) of the
 * same size and weight, closely spaced, and overlapping horizontally — the
 * last condition keeps neighbouring columns apart.
 */
export function buildParagraphs(lines: readonly CharLine[]): CharParagraph[] {
  const open: { lines: CharLine[]; bbox: BBox; size: number; bold: boolean }[] = [];
  const done: typeof open = [];
  for (const line of [...lines].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)) {
    const style = styleOf(line);
    const target = open.find((p) => {
      const last = p.lines.at(-1)!;
      const gap = line.bbox.y - (last.bbox.y + last.bbox.height);
      const overlap = Math.min(p.bbox.x + p.bbox.width, line.bbox.x + line.bbox.width) - Math.max(p.bbox.x, line.bbox.x);
      return (
        Math.abs(line.sizePt - p.size) <= 0.1 * p.size &&
        style.bold === p.bold &&
        gap >= -0.2 * last.bbox.height &&
        gap <= PARAGRAPH_GAP_LINES * last.bbox.height &&
        overlap > 0
      );
    });
    if (target) {
      target.lines.push(line);
      target.bbox = union([target.bbox, line.bbox]);
    } else {
      open.push({ lines: [line], bbox: line.bbox, size: line.sizePt, bold: style.bold });
    }
    // Paragraphs whose last line is well above this one can no longer grow.
    for (let i = open.length - 1; i >= 0; i--) {
      const p = open[i]!;
      const last = p.lines.at(-1)!;
      if (line.bbox.y - (last.bbox.y + last.bbox.height) > 2 * last.bbox.height) done.push(...open.splice(i, 1));
    }
  }
  return [...done, ...open].map((p) => {
    const chars = p.lines.flatMap((l) => l.chars);
    return {
      bbox: p.bbox,
      lines: p.lines,
      text: joinLines(p.lines.map((l) => l.text)),
      font: {
        family: majority(chars.map((c) => c.family)) || 'Calibri',
        sizePt: Math.round(median(chars.map((c) => c.sizePt)) * 2) / 2,
        bold: majority(chars.map((c) => c.bold)),
        italic: majority(chars.map((c) => c.italic)),
        underline: false,
        color: majority(chars.map((c) => c.color)),
      },
    };
  });
}

/** Text of the characters whose centres fall inside a box (a table cell). */
export function textInside(chars: readonly PdfChar[], box: BBox, dpi: number): string {
  const inside = chars.filter((c) => {
    const cx = c.box.x + c.box.width / 2;
    const cy = c.box.y + c.box.height / 2;
    return cx >= box.x && cx <= box.x + box.width && cy >= box.y && cy <= box.y + box.height;
  });
  return joinLines(buildLines(inside, dpi).map((l) => l.text));
}
