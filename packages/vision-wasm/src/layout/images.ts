import type { BBox } from '@scan2doc/core';
import type { InkMask } from '../image.js';

export interface ImageRegionOptions {
  /** Tile edge in pixels; default dpi / 25 (≈ 1 mm). */
  tilePx?: number;
  /** A tile is inked when at least this share of its pixels is ink. Default 0.08. */
  tileInk?: number;
  /** Smallest picture edge, in inches. Default 0.4. */
  minSizeIn?: number;
  /** Inked tiles must fill at least this share of the region's box. Default 0.3. */
  minFill?: number;
}

/**
 * Finds pictures: dense areas of ink left after text and tables are erased
 * from the mask. Works on a coarse tile grid so photos with light patches and
 * halftone dots still hold together; scanner speckle stays below tileInk.
 */
export function detectImageRegions(mask: InkMask, dpi: number, options: ImageRegionOptions = {}): BBox[] {
  const tile = options.tilePx ?? Math.max(4, Math.round(dpi / 25));
  const tileInk = options.tileInk ?? 0.08;
  const minSize = (options.minSizeIn ?? 0.4) * dpi;
  const minFill = options.minFill ?? 0.3;

  const tx = Math.ceil(mask.width / tile);
  const ty = Math.ceil(mask.height / tile);
  const inked = new Uint8Array(tx * ty);
  for (let j = 0; j < ty; j++) {
    for (let i = 0; i < tx; i++) {
      const x0 = i * tile;
      const y0 = j * tile;
      const x1 = Math.min(mask.width, x0 + tile);
      const y1 = Math.min(mask.height, y0 + tile);
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) n += mask.data[y * mask.width + x]!;
      if (n >= tileInk * (x1 - x0) * (y1 - y0)) inked[j * tx + i] = 1;
    }
  }

  // Bridge one-tile gaps (light patches inside a photo) before grouping.
  const grown = new Uint8Array(inked.length);
  for (let j = 0; j < ty; j++) {
    for (let i = 0; i < tx; i++) {
      if (!inked[j * tx + i]) continue;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const a = i + di;
          const b = j + dj;
          if (a >= 0 && b >= 0 && a < tx && b < ty) grown[b * tx + a] = 1;
        }
      }
    }
  }

  const seen = new Uint8Array(grown.length);
  const regions: BBox[] = [];
  for (let start = 0; start < grown.length; start++) {
    if (!grown[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let [i0, j0, i1, j1, count] = [Infinity, Infinity, -Infinity, -Infinity, 0];
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % tx;
      const j = Math.floor(k / tx);
      if (inked[k]) {
        // The box is measured on real ink only, not on the bridging margin.
        [i0, j0, i1, j1] = [Math.min(i0, i), Math.min(j0, j), Math.max(i1, i), Math.max(j1, j)];
        count++;
      }
      for (const [a, b] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]] as const) {
        const n = b * tx + a;
        if (a >= 0 && b >= 0 && a < tx && b < ty && grown[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (count === 0) continue;
    const box = {
      x: i0 * tile,
      y: j0 * tile,
      width: Math.min(mask.width, (i1 + 1) * tile) - i0 * tile,
      height: Math.min(mask.height, (j1 + 1) * tile) - j0 * tile,
    };
    const fill = count / ((i1 - i0 + 1) * (j1 - j0 + 1));
    if (box.width >= minSize && box.height >= minSize && fill >= minFill) regions.push(box);
  }
  return regions.sort((a, b) => a.y - b.y || a.x - b.x);
}
