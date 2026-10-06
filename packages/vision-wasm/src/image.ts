import { encode } from 'fast-png';
import type { BBox } from '@scan2doc/core';

/** 8-bit grayscale bitmap, row-major, one byte per pixel (0 = black). */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** 1 where a pixel is ink, 0 where it is paper. */
export interface InkMask {
  width: number;
  height: number;
  data: Uint8Array;
}

/** PDFium renders BGRA; ITU-R BT.601 luma, which is what OCR thresholds assume. */
export function bgraToGray(bgra: Uint8Array, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = (bgra[p + 2]! * 299 + bgra[p + 1]! * 587 + bgra[p]! * 114 + 500) / 1000;
  }
  return { width, height, data };
}

/** Otsu's method: the gray level that best separates ink from paper. */
export function otsuThreshold(img: GrayImage): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of img.data) hist[v]!++;
  const total = img.data.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i]!;
  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    weightB += hist[t]!;
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += t * hist[t]!;
    const meanB = sumB / weightB;
    const meanF = (sumAll - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Ink mask at the Otsu threshold. On a blank page Otsu splits paper noise, so
 * the threshold is capped well below white.
 */
export function inkMask(img: GrayImage, threshold = Math.min(otsuThreshold(img), 200)): InkMask {
  const data = new Uint8Array(img.data.length);
  for (let i = 0; i < data.length; i++) data[i] = img.data[i]! <= threshold ? 1 : 0;
  return { width: img.width, height: img.height, data };
}

/**
 * Removes scanner dust: 8-connected ink blobs of at most `maxArea` pixels become
 * paper in both the image and the mask. Default (dpi/150)² — 4 px at 300 dpi —
 * keeps the full stop of 6 pt text (≈ 9 px). Without this a speck next to a
 * line stretches Tesseract's row height and inflates the font-size estimate.
 */
export function despeckle(img: GrayImage, mask: InkMask, dpi: number, maxArea = Math.max(1, Math.round((dpi / 150) ** 2))): { gray: GrayImage; mask: InkMask; removed: number } {
  const { width, height } = mask;
  const ink = mask.data.slice();
  const gray = img.data.slice();
  const seen = new Uint8Array(ink.length);
  const blob: number[] = [];
  let removed = 0;
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || seen[start]) continue;
    blob.length = 0;
    const stack = [start];
    seen[start] = 1;
    let big = false;
    while (stack.length) {
      const p = stack.pop()!;
      if (!big) {
        blob.push(p);
        if (blob.length > maxArea) big = true; // keep walking to mark the blob seen, stop recording
      }
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          const q = yy * width + xx;
          if (ink[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    if (!big) {
      for (const p of blob) {
        ink[p] = 0;
        gray[p] = 255;
      }
      removed++;
    }
  }
  return { gray: { width, height, data: gray }, mask: { width, height, data: ink }, removed };
}

/** Copy of the mask with every box set to paper. */
export function eraseBoxes(mask: InkMask, boxes: readonly BBox[], pad = 0): InkMask {
  const data = mask.data.slice();
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x - pad));
    const y0 = Math.max(0, Math.floor(b.y - pad));
    const x1 = Math.min(mask.width, Math.ceil(b.x + b.width + pad));
    const y1 = Math.min(mask.height, Math.ceil(b.y + b.height + pad));
    for (let y = y0; y < y1; y++) data.fill(0, y * mask.width + x0, y * mask.width + x1);
  }
  return { ...mask, data };
}

/** Crops a BGRA bitmap to an RGB PNG. */
export function cropToPng(bgra: Uint8Array, width: number, box: BBox): Uint8Array {
  const x0 = Math.round(box.x);
  const y0 = Math.round(box.y);
  const w = Math.round(box.width);
  const h = Math.round(box.height);
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * width + (x0 + x)) * 4;
      const d = (y * w + x) * 3;
      rgb[d] = bgra[s + 2]!;
      rgb[d + 1] = bgra[s + 1]!;
      rgb[d + 2] = bgra[s]!;
    }
  }
  return encode({ width: w, height: h, data: rgb, channels: 3, depth: 8 });
}

/** Clockwise quarter turns. */
export type Rotation = 0 | 90 | 180 | 270;

/**
 * Rotates a raster clockwise by `deg`; `channels` bytes per pixel (1 gray, 4 BGRA).
 * Returns the new width and height (swapped for 90 / 270).
 */
export function rotateRaster(data: Uint8Array, width: number, height: number, channels: number, deg: Rotation) {
  if (deg === 0) return { data, width, height };
  const [w2, h2] = deg === 180 ? [width, height] : [height, width];
  const out = new Uint8Array(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [x2, y2] = deg === 90 ? [height - 1 - y, x] : deg === 180 ? [width - 1 - x, height - 1 - y] : [y, width - 1 - x];
      const s = (y * width + x) * channels;
      const d = (y2 * w2 + x2) * channels;
      for (let c = 0; c < channels; c++) out[d + c] = data[s + c]!;
    }
  }
  return { data: out, width: w2, height: h2 };
}

/**
 * Box-filter downscale so the longer side is at most `maxSide` (never upscales).
 * `scale` is output pixels per input pixel.
 */
export function downscaleGray(img: GrayImage, maxSide: number): { image: GrayImage; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (scale === 1) return { image: img, scale };
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y / scale);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) / scale)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / scale);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) / scale)));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) sum += img.data[yy * img.width + xx]!;
      out[y * w + x] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return { image: { width: w, height: h, data: out }, scale: w / img.width };
}

export const grayToPng = (img: GrayImage) => encode({ width: img.width, height: img.height, data: img.data, channels: 1, depth: 8 });

export const pngDataUri =(png: Uint8Array) => `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
