import createTesseractCore, { type TessBaseAPI, type TesseractModule } from 'tesseract.js-core/tesseract-core-simd-lstm.js';
import type { BBox } from '@scan2doc/core';
import type { AssetSource } from './assets.js';
import type { GrayImage } from './image.js';

export interface OcrWord {
  bbox: BBox;
  text: string;
  confidence: number;
}

export interface OcrLine {
  bbox: BBox;
  text: string;
  /** Tesseract's measured row height (ascender to descender) in pixels. */
  rowHeight: number;
  words: OcrWord[];
}

export interface OcrParagraph {
  bbox: BBox;
  confidence: number;
  lines: OcrLine[];
}

/** Tesseract page segmentation modes used here. */
export const PSM = { AUTO: 3, SINGLE_BLOCK: 6 } as const;

interface JsonBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
interface JsonWord {
  bbox: JsonBox;
  text: string;
  confidence: number;
}
interface JsonLine {
  bbox: JsonBox;
  text: string;
  rowAttributes?: { rowHeight: number };
  words?: JsonWord[];
}
interface JsonParagraph {
  bbox: JsonBox;
  confidence: number;
  lines?: JsonLine[];
}
interface JsonPage {
  blocks?: { paragraphs?: JsonParagraph[] }[];
}

const box = (b: JsonBox): BBox => ({ x: b.x0, y: b.y0, width: Math.max(1, b.x1 - b.x0), height: Math.max(1, b.y1 - b.y0) });

/** Character-weighted mean word confidence (0–100) of recognised text; NaN when there is none. */
export function meanConfidence(paragraphs: readonly OcrParagraph[]): number {
  let sum = 0;
  let chars = 0;
  for (const p of paragraphs) {
    for (const l of p.lines) {
      for (const w of l.words) {
        const n = [...w.text.trim()].length;
        sum += w.confidence * n;
        chars += n;
      }
    }
  }
  return chars ? sum / chars : NaN;
}

/**
 * Tesseract LSTM compiled to WASM, driven directly through its TessBaseAPI
 * (no worker threads, so it can live inside a single-file executable).
 * Holds one page image; keeps one initialised API per language combination
 * ("jpn+eng") so switching languages between pages costs nothing after the
 * first use.
 */
export class OcrEngine {
  private pixels = 0;
  private image?: { width: number; height: number; dpi: number; version: number };
  private imageVersion = 0;
  private readonly apis = new Map<string, { api: TessBaseAPI; imageVersion: number }>();
  private readonly loaded = new Set<string>();

  private constructor(
    private readonly module: TesseractModule,
    private readonly assets: AssetSource,
  ) {}

  static async create(assets: AssetSource): Promise<OcrEngine> {
    const module = await createTesseractCore({ wasmBinary: await assets.read('tesseract-core.wasm'), print() {}, printErr() {} });
    return new OcrEngine(module, assets);
  }

  /** "kor+eng" → an initialised API; loads each model file once. Throws when a model is missing. */
  private async apiFor(languages: string): Promise<TessBaseAPI> {
    const cached = this.apis.get(languages);
    if (cached) return this.withImage(cached);
    for (const code of languages.split('+')) {
      if (this.loaded.has(code)) continue;
      this.module.FS.writeFile(`/${code}.traineddata`, await this.assets.read(`${code}.traineddata`));
      this.loaded.add(code);
    }
    const api = new this.module.TessBaseAPI();
    if (api.Init('/', languages) !== 0) {
      api.End();
      throw new Error(`Tesseract could not load the "${languages}" language model`);
    }
    // Keeps CJK text free of spurious spaces and inter-word spacing as written.
    api.SetVariable('preserve_interword_spaces', '1');
    const entry = { api, imageVersion: -1 };
    this.apis.set(languages, entry);
    return this.withImage(entry);
  }

  private withImage(entry: { api: TessBaseAPI; imageVersion: number }): TessBaseAPI {
    if (!this.image) throw new Error('setImage() must be called before recognition');
    if (entry.imageVersion !== this.image.version) {
      entry.api.SetImage(this.pixels, this.image.width, this.image.height, 1, this.image.width);
      entry.api.SetSourceResolution(this.image.dpi);
      entry.imageVersion = this.image.version;
    }
    return entry.api;
  }

  async version(): Promise<string> {
    return this.apis.values().next().value?.api.Version() ?? 'unknown';
  }

  /** Loads a page; replaces any previous one. */
  setImage(img: GrayImage, dpi: number): void {
    this.releaseImage();
    this.pixels = this.module._malloc(img.data.length);
    this.module.HEAPU8.set(img.data, this.pixels);
    this.image = { width: img.width, height: img.height, dpi, version: ++this.imageVersion };
  }

  /** Full-page recognition with automatic layout analysis. */
  async recognizePage(languages: string): Promise<OcrParagraph[]> {
    return this.recognizeArea(languages, { x: 0, y: 0, width: this.image!.width, height: this.image!.height });
  }

  /** Like recognizePage, limited to one area of the loaded page (layout analysis still runs inside it). */
  async recognizeArea(languages: string, area: BBox): Promise<OcrParagraph[]> {
    const api = await this.apiFor(languages);
    api.SetPageSegMode(PSM.AUTO);
    api.SetRectangle(Math.round(area.x), Math.round(area.y), Math.round(area.width), Math.round(area.height));
    api.Recognize(null);
    const json = JSON.parse(api.GetJSONText(0)) as JsonPage;
    const out: OcrParagraph[] = [];
    for (const block of json.blocks ?? []) {
      for (const p of block.paragraphs ?? []) {
        const lines = (p.lines ?? [])
          .map((l) => ({
            bbox: box(l.bbox),
            text: l.text.replace(/\s+$/, ''),
            rowHeight: l.rowAttributes?.rowHeight ?? 0,
            words: (l.words ?? []).map((w) => ({ bbox: box(w.bbox), text: w.text, confidence: w.confidence })),
          }))
          .filter((l) => l.text.trim() !== '');
        if (lines.length > 0) out.push({ bbox: box(p.bbox), confidence: p.confidence, lines });
      }
    }
    return out;
  }

  /** Recognizes one rectangle of the loaded page as a single block of text (table cells). */
  async recognizeRegion(languages: string, region: BBox): Promise<string> {
    const api = await this.apiFor(languages);
    api.SetPageSegMode(PSM.SINGLE_BLOCK);
    api.SetRectangle(Math.round(region.x), Math.round(region.y), Math.round(region.width), Math.round(region.height));
    api.Recognize(null);
    return api.GetUTF8Text();
  }

  private releaseImage(): void {
    if (this.pixels) {
      for (const e of this.apis.values()) {
        e.api.Clear();
        e.imageVersion = -1;
      }
      this.module._free(this.pixels);
      this.pixels = 0;
      this.image = undefined;
    }
  }

  destroy(): void {
    this.releaseImage();
    for (const e of this.apis.values()) e.api.End();
    this.apis.clear();
  }
}
