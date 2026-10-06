import { degrees, PDFDocument } from 'pdf-lib';

/** One page of a rebuilt document: which source page, and how much to turn it (clockwise). */
export interface PageEdit {
  source: number;
  rotate: 0 | 90 | 180 | 270;
}

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    const message = (err as Error).message;
    if (/encrypt/i.test(message)) throw new Error('This PDF is password-protected, so its pages cannot be rearranged.');
    throw new Error(`This PDF could not be read for editing: ${message}`);
  }
}

/**
 * A new PDF made of the given pages in the given order, each turned by its
 * extra rotation. Covers reorder, delete (leave a page out), rotate, extract
 * and duplicate. The title and author carry over.
 */
export async function rebuild(bytes: Uint8Array, pages: readonly PageEdit[]): Promise<Uint8Array> {
  if (pages.length === 0) throw new Error('A PDF needs at least one page.');
  const source = await load(bytes);
  const count = source.getPageCount();
  for (const p of pages) {
    if (!Number.isInteger(p.source) || p.source < 0 || p.source >= count) throw new Error(`page ${p.source + 1} does not exist (the PDF has ${count})`);
    if (![0, 90, 180, 270].includes(p.rotate)) throw new Error(`a page can only be turned by 90, 180 or 270 degrees, not ${p.rotate}`);
  }
  const out = await PDFDocument.create();
  const copied = await out.copyPages(
    source,
    pages.map((p) => p.source),
  );
  copied.forEach((page, i) => {
    const turn = pages[i]!.rotate;
    if (turn) page.setRotation(degrees((page.getRotation().angle + turn) % 360));
    out.addPage(page);
  });
  const title = source.getTitle();
  const author = source.getAuthor();
  if (title) out.setTitle(title);
  if (author) out.setAuthor(author);
  out.setProducer('Scan2Doc');
  return out.save();
}

/** All pages of each PDF, one after another. */
export async function combine(files: readonly Uint8Array[]): Promise<Uint8Array> {
  if (files.length < 2) throw new Error('Choose at least two PDFs to combine.');
  const out = await PDFDocument.create();
  for (const bytes of files) {
    const doc = await load(bytes);
    for (const page of await out.copyPages(doc, doc.getPageIndices())) out.addPage(page);
  }
  out.setProducer('Scan2Doc');
  return out.save();
}

/** One PDF per group of (0-based) pages. */
export async function split(bytes: Uint8Array, groups: readonly (readonly number[])[]): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  for (const group of groups) parts.push(await rebuild(bytes, group.map((source) => ({ source, rotate: 0 }))));
  return parts;
}

/** Groups of `size` consecutive pages: 0-based, the last group possibly shorter. */
export function everyN(pageCount: number, size: number): number[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('the number of pages per file must be 1 or more');
  const groups: number[][] = [];
  for (let start = 0; start < pageCount; start += size) groups.push(Array.from({ length: Math.min(size, pageCount - start) }, (_, i) => start + i));
  return groups;
}

/**
 * "1-3, 4, 5-9" → one group per comma-separated item, 1-based in, 0-based out,
 * checked against the page count.
 */
export function rangeGroups(spec: string, pageCount: number): number[][] {
  const items = spec.split(',').map((s) => s.trim()).filter(Boolean);
  if (items.length === 0) throw new Error('enter the page ranges to split into, e.g. 1-3, 4-6');
  return items.map((item) => {
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(item);
    if (!m) throw new Error(`"${item}" is not a page range (use e.g. 1-3)`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1 || to < from || to > pageCount) throw new Error(`"${item}" is outside pages 1–${pageCount}`);
    return Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
  });
}
