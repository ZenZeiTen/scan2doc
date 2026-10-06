import { randomBytes } from 'node:crypto';
import jpeg from 'jpeg-js';
import { defaultAssets, PdfRasterizer, type AssetSource, type PdfChar } from '@scan2doc/vision-wasm';

/** An open document: its current bytes (edits replace them) and a renderer over them. */
export interface OpenDoc {
  id: string;
  name: string;
  /** Where it came from on disk, when opened from a file (not dropped into the window). */
  path?: string;
  bytes: Uint8Array;
  /** Changed since it was opened or saved. */
  dirty: boolean;
  /** Bumped on every edit, so the window refetches page images. */
  rev: number;
  password?: string;
  pages: { widthPt: number; heightPt: number }[];
  title?: string;
  raster: PdfRasterizer;
  images: Map<string, Uint8Array>;
  text: Map<number, PdfChar[]>;
}

/** What the window is told about a document. */
export interface DocView {
  id: string;
  name: string;
  path: string | null;
  dirty: boolean;
  rev: number;
  bytes: number;
  title: string | null;
  pages: { widthPt: number; heightPt: number }[];
}

/** A search hit: the page (0-based) and its highlight boxes as fractions of the page. */
export interface SearchHit {
  page: number;
  rects: { x: number; y: number; w: number; h: number }[];
  context: string;
}

const MAX_IMAGES = 160;

export const viewOf = (d: OpenDoc): DocView => ({
  id: d.id,
  name: d.name,
  path: d.path ?? null,
  dirty: d.dirty,
  rev: d.rev,
  bytes: d.bytes.length,
  title: d.title ?? null,
  pages: d.pages,
});

/** BGRA (as PDFium renders) to RGB, flattened onto white. */
export function bgraToRgb(bgra: Uint8Array, width: number, height: number): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const a = bgra[i * 4 + 3]! / 255;
    rgb[i * 3] = Math.round(bgra[i * 4 + 2]! * a + 255 * (1 - a));
    rgb[i * 3 + 1] = Math.round(bgra[i * 4 + 1]! * a + 255 * (1 - a));
    rgb[i * 3 + 2] = Math.round(bgra[i * 4]! * a + 255 * (1 - a));
  }
  return rgb;
}

/** BGRA (as PDFium renders) to a JPEG, flattened onto white. */
export function bgraToJpeg(bgra: Uint8Array, width: number, height: number, quality = 85): Uint8Array {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const a = bgra[i * 4 + 3]! / 255;
    rgba[i * 4] = Math.round(bgra[i * 4 + 2]! * a + 255 * (1 - a));
    rgba[i * 4 + 1] = Math.round(bgra[i * 4 + 1]! * a + 255 * (1 - a));
    rgba[i * 4 + 2] = Math.round(bgra[i * 4]! * a + 255 * (1 - a));
    rgba[i * 4 + 3] = 255;
  }
  return new Uint8Array(jpeg.encode({ data: rgba, width, height }, quality).data);
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > 0.5 * Math.min(a1 - a0, b1 - b0);

/**
 * Whether `b` carries on `a`'s line: side by side on a level (text across the
 * page) or stacked in a column (text running down a turned page).
 */
export function sameLine(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return overlap(a.y, a.y + a.height, b.y, b.y + b.height) || overlap(a.x, a.x + a.width, b.x, b.x + b.width);
}

/**
 * Finds `query` in a page's characters, ignoring case and runs of white space.
 * Each hit's boxes are merged per line, as fractions of the page size.
 */
export function findInChars(chars: readonly PdfChar[], query: string, pageWidth: number, pageHeight: number): Omit<SearchHit, 'page'>[] {
  const needle = query.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!needle) return [];
  // The page as one string; every position remembers which character drew it (spaces: none),
  // and every character which line it is on.
  let text = '';
  const owner: number[] = [];
  const lineOf: number[] = [];
  chars.forEach((c, i) => {
    const prev = chars[i - 1]?.box;
    const newLine = prev !== undefined && !sameLine(prev, c.box);
    lineOf.push((lineOf[i - 1] ?? 0) + (newLine ? 1 : 0));
    // A new line counts as a space even when the PDF has no line-break character.
    if ((c.spaceBefore || newLine) && text && !text.endsWith(' ')) {
      text += ' ';
      owner.push(-1);
    }
    for (const ch of c.text.replace(/\s+/g, ' ')) {
      if (ch === ' ' && text.endsWith(' ')) continue;
      text += ch.toLowerCase();
      owner.push(ch === ' ' ? -1 : i);
    }
  });
  const hits: Omit<SearchHit, 'page'>[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + Math.max(1, needle.length))) {
    const used = [...new Set(owner.slice(at, at + needle.length).filter((i) => i >= 0))];
    const byLine = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
    for (const i of used) {
      const b = chars[i]!.box;
      const line = byLine.get(lineOf[i]!);
      if (line) {
        line.x0 = Math.min(line.x0, b.x);
        line.x1 = Math.max(line.x1, b.x + b.width);
        line.y0 = Math.min(line.y0, b.y);
        line.y1 = Math.max(line.y1, b.y + b.height);
      } else byLine.set(lineOf[i]!, { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height });
    }
    const lines = [...byLine.values()];
    const from = Math.max(0, at - 30);
    hits.push({
      rects: lines.map((l) => ({ x: l.x0 / pageWidth, y: l.y0 / pageHeight, w: (l.x1 - l.x0) / pageWidth, h: (l.y1 - l.y0) / pageHeight })),
      context: `${from > 0 ? '…' : ''}${text.slice(from, at + needle.length + 30).trim()}${at + needle.length + 30 < text.length ? '…' : ''}`,
    });
  }
  return hits;
}

/** The documents open in the window. */
export class DocumentStore {
  private readonly docs = new Map<string, OpenDoc>();

  constructor(private readonly assets: AssetSource = defaultAssets()) {}

  async open(bytes: Uint8Array, name: string, path?: string, password?: string): Promise<OpenDoc> {
    const raster = await PdfRasterizer.open(bytes, this.assets, password);
    const doc: OpenDoc = {
      id: randomBytes(6).toString('hex'),
      name,
      ...(path && { path }),
      ...(password && { password }),
      bytes,
      dirty: false,
      rev: 1,
      pages: Array.from({ length: raster.pageCount }, (_, i) => raster.pageSize(i)),
      ...(raster.metadata().title && { title: raster.metadata().title }),
      raster,
      images: new Map(),
      text: new Map(),
    };
    this.docs.set(doc.id, doc);
    return doc;
  }

  get(id: string): OpenDoc {
    const doc = this.docs.get(id);
    if (!doc) throw new Error('That document is no longer open.');
    return doc;
  }

  list(): OpenDoc[] {
    return [...this.docs.values()];
  }

  /** Swaps in new bytes (after an edit), rebuilding the renderer. */
  async replace(id: string, bytes: Uint8Array, changes: { dirty: boolean; name?: string; path?: string }): Promise<OpenDoc> {
    const doc = this.get(id);
    const raster = await PdfRasterizer.open(bytes, this.assets);
    doc.raster.close();
    doc.raster = raster;
    doc.bytes = bytes;
    doc.dirty = changes.dirty;
    doc.rev++;
    if (changes.name) doc.name = changes.name;
    if (changes.path) doc.path = changes.path;
    delete doc.password;
    doc.pages = Array.from({ length: raster.pageCount }, (_, i) => raster.pageSize(i));
    doc.images.clear();
    doc.text.clear();
    return doc;
  }

  close(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    doc.raster.close();
    this.docs.delete(id);
  }

  closeAll(): void {
    for (const id of [...this.docs.keys()]) this.close(id);
  }

  /** A page as a JPEG `width` pixels wide (rounded to 16 px steps so zooming reuses renders). */
  async pageImage(id: string, page: number, width: number): Promise<Uint8Array> {
    const doc = this.get(id);
    const size = doc.pages[page];
    if (!size) throw new Error(`page ${page + 1} does not exist`);
    const w = Math.min(4000, Math.max(32, Math.round(width / 16) * 16));
    const key = `${page}:${w}`;
    const cached = doc.images.get(key);
    if (cached) return cached;
    const rendered = await doc.raster.render(page, (w / size.widthPt) * 72);
    const image = bgraToJpeg(rendered.bgra, rendered.width, rendered.height);
    if (doc.images.size >= MAX_IMAGES) doc.images.delete(doc.images.keys().next().value!);
    doc.images.set(key, image);
    return image;
  }

  /** Every place `query` occurs in the document's own text (scans have none until OCR'd). */
  search(id: string, query: string): SearchHit[] {
    const doc = this.get(id);
    const hits: SearchHit[] = [];
    doc.pages.forEach((size, page) => {
      let chars = doc.text.get(page);
      if (!chars) {
        chars = doc.raster.textLayer(page, size.widthPt, size.heightPt);
        doc.text.set(page, chars);
      }
      for (const hit of findInChars(chars, query, size.widthPt, size.heightPt)) hits.push({ page, ...hit });
    });
    return hits;
  }
}
