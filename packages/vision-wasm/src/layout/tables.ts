import type { BBox } from '@scan2doc/core';
import type { InkMask } from '../image.js';

/** A straight ruling line: horizontal (pos = y) or vertical (pos = x), spanning [start, end]. */
export interface Ruling {
  pos: number;
  start: number;
  end: number;
  thickness: number;
}

export interface GridCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  /** Cell interior in page pixels, between its ruling lines. */
  bbox: BBox;
}

export interface TableGrid {
  bbox: BBox;
  rows: number;
  cols: number;
  cells: GridCell[];
  /** Thickest ruling in the table; cell interiors are inset by this before OCR. */
  lineThickness: number;
}

export interface TableOptions {
  /** Shortest run of ink, in inches, that counts as a ruling line. Default 0.4. */
  minLengthIn?: number;
  /** Thickest run, in inches, still counted as a line (filled shapes are thicker). Default 0.04. */
  maxThicknessIn?: number;
  /** Gaps in a scanned line up to this many pixels are bridged. Default dpi / 100. */
  gapPx?: number;
}

/** Share of a grid boundary that a ruling must cover for the boundary to count as drawn. */
const BOUNDARY_COVERAGE = 0.6;

/**
 * Finds straight runs of ink along one axis. `horizontal` scans rows; otherwise
 * columns. Runs on consecutive scanlines that overlap are merged into one
 * ruling; anything thicker than maxThickness (a filled box, a photo) is dropped.
 */
export function findRulings(mask: InkMask, horizontal: boolean, minLength: number, maxThickness: number, gap: number): Ruling[] {
  const outer = horizontal ? mask.height : mask.width;
  const inner = horizontal ? mask.width : mask.height;
  const ink = horizontal ? (o: number, i: number) => mask.data[o * mask.width + i] : (o: number, i: number) => mask.data[i * mask.width + o];

  interface Open { first: number; last: number; start: number; end: number }
  let open: Open[] = [];
  const done: Open[] = [];

  for (let o = 0; o < outer; o++) {
    const runs: [number, number][] = [];
    let s = -1;
    let lastInk = -1;
    for (let i = 0; i <= inner; i++) {
      const on = i < inner && ink(o, i) === 1;
      if (on) {
        if (s < 0) s = i;
        lastInk = i;
      } else if (s >= 0 && (i === inner || i - lastInk > gap)) {
        if (lastInk - s + 1 >= minLength) runs.push([s, lastInk]);
        s = -1;
      }
    }
    const next: Open[] = [];
    for (const [a, b] of runs) {
      const hit = open.find((r) => r.last === o - 1 && Math.min(r.end, b) - Math.max(r.start, a) >= 0.5 * Math.min(r.end - r.start, b - a));
      if (hit) {
        hit.last = o;
        hit.start = Math.min(hit.start, a);
        hit.end = Math.max(hit.end, b);
        next.push(hit);
      } else {
        next.push({ first: o, last: o, start: a, end: b });
      }
    }
    for (const r of open) if (!next.includes(r)) done.push(r);
    open = next;
  }
  done.push(...open);

  return done
    .filter((r) => r.last - r.first + 1 <= maxThickness)
    .map((r) => ({ pos: (r.first + r.last) / 2, start: r.start, end: r.end, thickness: r.last - r.first + 1 }));
}

/** Sorted distinct positions, merging those within `tol` of each other. */
function cluster(values: number[], tol: number): number[] {
  const out: number[][] = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (last && v - last.at(-1)! <= tol) last.push(v);
    else out.push([v]);
  }
  return out.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

/** Does any ruling near `pos` cover enough of [from, to]? */
function drawn(rulings: Ruling[], pos: number, from: number, to: number, tol: number): boolean {
  const need = BOUNDARY_COVERAGE * (to - from);
  let covered = 0;
  for (const r of rulings) {
    if (Math.abs(r.pos - pos) > tol) continue;
    covered += Math.max(0, Math.min(r.end, to) - Math.max(r.start, from));
  }
  return covered >= need;
}

function gridFrom(h: Ruling[], v: Ruling[], tol: number): TableGrid | undefined {
  const ys = cluster(h.map((r) => r.pos), tol);
  const xs = cluster(v.map((r) => r.pos), tol);
  if (ys.length < 2 || xs.length < 2) return undefined;
  const rows = ys.length - 1;
  const cols = xs.length - 1;

  // Union slots across every boundary that has no ruling drawn on it.
  const parent = Array.from({ length: rows * cols }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (a: number, b: number) => (parent[find(a)] = find(b));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols && !drawn(v, xs[c + 1]!, ys[r]!, ys[r + 1]!, tol)) union(r * cols + c, r * cols + c + 1);
      if (r + 1 < rows && !drawn(h, ys[r + 1]!, xs[c]!, xs[c + 1]!, tol)) union(r * cols + c, (r + 1) * cols + c);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < rows * cols; i++) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);

  const cells: GridCell[] = [];
  for (const slots of groups.values()) {
    const rs = slots.map((s) => Math.floor(s / cols));
    const cs = slots.map((s) => s % cols);
    const [r0, r1, c0, c1] = [Math.min(...rs), Math.max(...rs), Math.min(...cs), Math.max(...cs)];
    // A merge must be a rectangle; anything else (a broken ruling) falls back to single cells.
    const rect = slots.length === (r1 - r0 + 1) * (c1 - c0 + 1) ? [[r0, c0, r1 - r0 + 1, c1 - c0 + 1] as const] : slots.map((s) => [Math.floor(s / cols), s % cols, 1, 1] as const);
    for (const [row, col, rowSpan, colSpan] of rect) {
      cells.push({
        row,
        col,
        rowSpan,
        colSpan,
        bbox: { x: xs[col]!, y: ys[row]!, width: xs[col + colSpan]! - xs[col]!, height: ys[row + rowSpan]! - ys[row]! },
      });
    }
  }
  cells.sort((a, b) => a.row - b.row || a.col - b.col);
  return {
    bbox: { x: xs[0]!, y: ys[0]!, width: xs.at(-1)! - xs[0]!, height: ys.at(-1)! - ys[0]! },
    rows,
    cols,
    cells,
    lineThickness: Math.max(...h.map((r) => r.thickness), ...v.map((r) => r.thickness)),
  };
}

/**
 * Detects ruled tables: horizontal and vertical rulings that cross each other
 * form a grid; a missing ruling between two slots means the cells are merged.
 */
export function detectTables(mask: InkMask, dpi: number, options: TableOptions = {}): TableGrid[] {
  const minLength = Math.round((options.minLengthIn ?? 0.4) * dpi);
  const maxThickness = Math.max(2, Math.round((options.maxThicknessIn ?? 0.04) * dpi));
  const gap = options.gapPx ?? Math.max(1, Math.round(dpi / 100));
  const tol = maxThickness + gap;

  const h = findRulings(mask, true, minLength, maxThickness, gap);
  const v = findRulings(mask, false, minLength, maxThickness, gap);

  // Connected components of crossing rulings; gridFrom keeps those with ≥ 2 lines each way.
  const all = [...h.map((r) => ({ r, horizontal: true })), ...v.map((r) => ({ r, horizontal: false }))];
  const parent = all.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < h.length; i++) {
    for (let j = 0; j < v.length; j++) {
      const a = h[i]!;
      const b = v[j]!;
      if (b.pos >= a.start - tol && b.pos <= a.end + tol && a.pos >= b.start - tol && a.pos <= b.end + tol) {
        parent[find(i)] = find(h.length + j);
      }
    }
  }
  const comps = new Map<number, { h: Ruling[]; v: Ruling[] }>();
  all.forEach(({ r, horizontal }, i) => {
    const c = comps.get(find(i)) ?? { h: [], v: [] };
    (horizontal ? c.h : c.v).push(r);
    comps.set(find(i), c);
  });

  return [...comps.values()]
    .map((c) => gridFrom(c.h, c.v, tol))
    .filter((t): t is TableGrid => t !== undefined)
    .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
}
