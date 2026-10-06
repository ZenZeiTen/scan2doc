import createFullTesseract from 'tesseract.js-core/tesseract-core-simd.js';
import type { TessBaseAPI, TesseractModule } from 'tesseract.js-core/tesseract-core-simd-lstm.js';
import type { AssetSource } from './assets.js';
import type { GrayImage } from './image.js';

export interface OsdResult {
  /** Clockwise degrees to turn the page so its text is upright. */
  rotate: 0 | 90 | 180 | 270;
  orientationConfidence: number;
  /** OSD script name: "Latin", "Han", "Japanese", "Hangul", "Cyrillic", … */
  script: string;
  scriptConfidence: number;
}

/** Pages with fewer characters than this give OSD too little to go on. */
const MIN_CHARS_HINT = 'Too few characters';

/**
 * Orientation and script detection. Lives in Tesseract's full (legacy-engine)
 * build because the LSTM-only build used for recognition does not compile it.
 */
export class OsdEngine {
  private constructor(
    private readonly module: TesseractModule,
    private readonly api: TessBaseAPI,
  ) {}

  static async create(assets: AssetSource): Promise<OsdEngine> {
    const module = await createFullTesseract({ wasmBinary: await assets.read('tesseract-core-osd.wasm'), print() {}, printErr() {} });
    module.FS.writeFile('/osd.traineddata', await assets.read('osd.traineddata'));
    const api = new module.TessBaseAPI();
    if (api.Init('/', 'osd') !== 0) throw new Error('Tesseract could not load the orientation/script model');
    return new OsdEngine(module, api);
  }

  /** Undefined when the page has too little text to judge. */
  detect(img: GrayImage, dpi: number): OsdResult | undefined {
    const ptr = this.module._malloc(img.data.length);
    try {
      this.module.HEAPU8.set(img.data, ptr);
      this.api.SetImage(ptr, img.width, img.height, 1, img.width);
      this.api.SetSourceResolution(dpi);
      let text: string;
      try {
        text = this.api.GetOsdText(0);
      } catch {
        return undefined;
      }
      if (!text || text.includes(MIN_CHARS_HINT)) return undefined;
      const field = (name: string) => text.split('\n').find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? '';
      const rotate = Number(field('Rotate'));
      return {
        rotate: ([0, 90, 180, 270] as const).find((r) => r === rotate) ?? 0,
        orientationConfidence: Number(field('Orientation confidence')) || 0,
        script: field('Script') || 'Latin',
        scriptConfidence: Number(field('Script confidence')) || 0,
      };
    } finally {
      this.api.Clear();
      this.module._free(ptr);
    }
  }

  destroy(): void {
    this.api.End();
  }
}
