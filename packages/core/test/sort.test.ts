import { describe, expect, it } from 'vitest';
import { readingOrder, sortPageBlocks } from '@scan2doc/core';
import { box } from './fixtures.js';

const b = (id: string, x: number, y: number, w: number, h: number) => ({ id, bbox: box(x, y, w, h) });
const ids = (items: { id: string }[]) => items.map((i) => i.id);
/** Deterministic shuffle so input order never matches the expected order by accident. */
const scramble = <T>(xs: T[]) => xs.map((x, i) => [((i * 7919) % 101) / 101, x] as const).sort((a, c) => a[0] - c[0]).map(([, x]) => x);

describe('readingOrder (XY-cut)', () => {
  it('returns empty and single inputs unchanged', () => {
    expect(readingOrder([])).toEqual([]);
    expect(ids(readingOrder([b('a', 0, 0, 10, 10)]))).toEqual(['a']);
  });

  it('reads a single column top to bottom', () => {
    const page = [b('p3', 100, 500, 800, 100), b('p1', 100, 100, 800, 100), b('p2', 100, 300, 800, 100)];
    expect(ids(readingOrder(page))).toEqual(['p1', 'p2', 'p3']);
  });

  // The page drawn on the canvas IDR artboard: title, then column 1 fully, then column 2.
  it('reads a full-width title, then each column completely', () => {
    const page = [
      b('title', 36, 34, 388, 44),
      b('h1', 36, 98, 182, 30),
      b('body-a', 36, 140, 182, 190),
      b('body-b', 36, 342, 182, 220),
      b('image', 242, 98, 182, 150),
      b('body-c', 242, 260, 182, 302),
    ];
    expect(ids(readingOrder(scramble(page)))).toEqual(['title', 'h1', 'body-a', 'body-b', 'image', 'body-c']);
  });

  it('keeps columns intact when paragraph gaps line up across them', () => {
    // Both columns break at y 300–320 (20 px); the gutter is 60 px wide.
    const page = [
      b('L1', 100, 100, 400, 200),
      b('L2', 100, 320, 400, 200),
      b('R1', 560, 100, 400, 200),
      b('R2', 560, 320, 400, 200),
    ];
    expect(ids(readingOrder(scramble(page)))).toEqual(['L1', 'L2', 'R1', 'R2']);
  });

  it('reads a full-width footer after the columns', () => {
    const page = [
      b('L', 100, 100, 400, 600),
      b('R', 560, 100, 400, 600),
      b('footer', 100, 760, 860, 40),
    ];
    expect(ids(readingOrder(scramble(page)))).toEqual(['L', 'R', 'footer']);
  });

  it('handles three columns', () => {
    const page = [b('c3', 700, 100, 250, 500), b('c1', 100, 100, 250, 500), b('c2', 400, 100, 250, 500)];
    expect(ids(readingOrder(page))).toEqual(['c1', 'c2', 'c3']);
  });

  it('handles a two-column section followed by a full-width section and a second two-column section', () => {
    const page = [
      b('A-L', 100, 100, 400, 300),
      b('A-R', 560, 100, 400, 300),
      b('band', 100, 440, 860, 60),
      b('B-L', 100, 540, 400, 300),
      b('B-R', 560, 540, 400, 300),
    ];
    expect(ids(readingOrder(scramble(page)))).toEqual(['A-L', 'A-R', 'band', 'B-L', 'B-R']);
  });

  it('falls back to top-then-left when boxes overlap on both axes', () => {
    const page = [b('lower', 50, 60, 100, 100), b('upper-right', 80, 0, 100, 100), b('upper-left', 0, 0, 100, 100)];
    expect(ids(readingOrder(page))).toEqual(['upper-left', 'upper-right', 'lower']);
  });

  it('ignores whitespace narrower than minGap', () => {
    // Two lines 4 px apart are one paragraph band; with minGap 5 the 30 px gutter still splits columns.
    const page = [b('L-1', 0, 0, 100, 20), b('L-2', 0, 24, 100, 20), b('R-1', 130, 0, 100, 20), b('R-2', 130, 24, 100, 20)];
    expect(ids(readingOrder(page, { minGap: 5 }))).toEqual(['L-1', 'L-2', 'R-1', 'R-2']);
  });

  it('does not mutate its input', () => {
    const page = [b('second', 0, 100, 10, 10), b('first', 0, 0, 10, 10)];
    const before = ids(page);
    readingOrder(page);
    expect(ids(page)).toEqual(before);
  });

  it('sortPageBlocks returns a reordered copy of the page', () => {
    const page = { index: 0, blocks: [b('second', 0, 100, 10, 10), b('first', 0, 0, 10, 10)] };
    const sorted = sortPageBlocks(page);
    expect(ids(sorted.blocks)).toEqual(['first', 'second']);
    expect(ids(page.blocks)).toEqual(['second', 'first']);
    expect(sorted.index).toBe(0);
  });
});
