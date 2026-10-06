import type { BBox } from './schema.js';

export interface SortOptions {
  /** A whitespace band must be strictly wider than this (px) to count as a cut. Default 0. */
  minGap?: number;
}

interface Gap {
  /** Cut coordinate: anything starting at or after it lies on the far side. */
  at: number;
  size: number;
}

type Axis = 'x' | 'y';

const span = (b: BBox, axis: Axis): [number, number] =>
  axis === 'y' ? [b.y, b.y + b.height] : [b.x, b.x + b.width];

/** Whitespace bands between the projections of `items` onto `axis`. */
function gaps<T extends { bbox: BBox }>(items: readonly T[], axis: Axis, minGap: number): Gap[] {
  const intervals = items.map((it) => span(it.bbox, axis)).sort((a, b) => a[0] - b[0]);
  const out: Gap[] = [];
  let end = intervals[0]![1];
  for (const [s, e] of intervals.slice(1)) {
    if (s - end > minGap) out.push({ at: s, size: s - end });
    end = Math.max(end, e);
  }
  return out;
}

function splitAt<T extends { bbox: BBox }>(items: readonly T[], axis: Axis, cuts: readonly Gap[]): T[][] {
  const groups: T[][] = cuts.map(() => []).concat([[]]);
  for (const it of items) {
    const start = span(it.bbox, axis)[0];
    let g = 0;
    while (g < cuts.length && start >= cuts[g]!.at) g++;
    groups[g]!.push(it);
  }
  return groups;
}

/**
 * Orders items for reading with a recursive XY-cut.
 *
 * At each level the region is cut along whichever axis has the widest empty band
 * (ties go to the horizontal cut, so text above is read before text below). A
 * full-width title blocks every vertical cut through it, so it is peeled off the
 * top first; below it the column gutter normally wins, so each column is read
 * completely before the next even when paragraph gaps line up across columns.
 * Regions with no empty band at all (overlapping boxes) fall back to top-then-left.
 */
export function readingOrder<T extends { bbox: BBox }>(items: readonly T[], options: SortOptions = {}): T[] {
  const minGap = options.minGap ?? 0;
  if (items.length <= 1) return [...items];

  const h = gaps(items, 'y', minGap);
  const v = gaps(items, 'x', minGap);
  const widest = (gs: Gap[]) => gs.reduce((m, g) => Math.max(m, g.size), 0);

  if (h.length === 0 && v.length === 0) {
    return [...items].sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  }

  const axis: Axis = widest(h) >= widest(v) ? 'y' : 'x';
  return splitAt(items, axis, axis === 'y' ? h : v).flatMap((g) => readingOrder(g, options));
}

/** Returns a copy of the page with its blocks in reading order. */
export function sortPageBlocks<P extends { blocks: readonly { bbox: BBox }[] }>(page: P, options?: SortOptions): P {
  return { ...page, blocks: readingOrder(page.blocks, options) };
}
