import { PDFiumLibrary } from '@hyzyla/pdfium';
import type { AssetSource } from './assets.js';
import { bgraToGray, type GrayImage } from './image.js';
import { readMetaText, readPageSize, readTextLayer, type PdfChar, type PdfiumModule } from './textlayer.js';

export interface RasterPage {
  index: number;
  dpi: number;
  /** Page size in PDF points (1/72 in), after the page's /Rotate is applied. */
  widthPt: number;
  heightPt: number;
  width: number;
  height: number;
  /** BGRA pixels: kept for colour image crops. */
  bgra: Uint8Array;
  gray: GrayImage;
}

type PdfLibrary = Awaited<ReturnType<typeof PDFiumLibrary.init>>;
type PdfDocument = Awaited<ReturnType<PdfLibrary['loadDocument']>>;

/** Renders PDF pages to bitmaps with PDFium compiled to WASM. */
export class PdfRasterizer {
  private constructor(
    private readonly lib: PdfLibrary,
    private readonly doc: PdfDocument,
  ) {}

  static async open(pdf: Uint8Array, assets: AssetSource, password?: string): Promise<PdfRasterizer> {
    const wasm = await assets.read('pdfium.wasm');
    const lib = await PDFiumLibrary.init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
    try {
      return new PdfRasterizer(lib, await lib.loadDocument(pdf, password));
    } catch (err) {
      lib.destroy();
      throw new Error(`Not a readable PDF: ${(err as Error).message}`);
    }
  }

  get pageCount(): number {
    return this.doc.getPageCount();
  }

  /** The wrapper keeps the WASM module and document pointer private; the text layer needs both. */
  private get native(): { module: PdfiumModule; doc: number } {
    const d = this.doc as unknown as { module: PdfiumModule; documentIdx: number };
    return { module: d.module, doc: d.documentIdx };
  }

  /** The PDF's own characters on a page, mapped onto a render of the given size. */
  textLayer(index: number, width: number, height: number): PdfChar[] {
    const { module, doc } = this.native;
    return readTextLayer(module, doc, index, width, height);
  }

  /** A page's displayed size in points, without rendering it. */
  pageSize(index: number): { widthPt: number; heightPt: number } {
    const { module, doc } = this.native;
    return readPageSize(module, doc, index);
  }

  /** Title and author from the PDF's document information, when set. */
  metadata(): { title?: string; author?: string } {
    const { module, doc } = this.native;
    const title = readMetaText(module, doc, 'Title');
    const author = readMetaText(module, doc, 'Author');
    return { ...(title && { title }), ...(author && { author }) };
  }

  async render(index: number, dpi: number): Promise<RasterPage> {
    const page = this.doc.getPage(index);
    const r = await page.render({ scale: dpi / 72, colorSpace: 'BGRA', render: 'bitmap' });
    return {
      index,
      dpi,
      widthPt: r.originalWidth,
      heightPt: r.originalHeight,
      width: r.width,
      height: r.height,
      bgra: r.data,
      gray: bgraToGray(r.data, r.width, r.height),
    };
  }

  close(): void {
    this.doc.destroy();
    this.lib.destroy();
  }
}
