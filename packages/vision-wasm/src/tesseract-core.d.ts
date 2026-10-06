// Minimal types for the parts of tesseract.js-core (Emscripten + WebIDL) the engine uses,
// checked against the module's exported TessBaseAPI prototype.
declare module 'tesseract.js-core/tesseract-core-simd-lstm.js' {
  export interface TessBaseAPI {
    Init(dataPath: string, language: string): number;
    SetImage(pixels: number, width: number, height: number, bytesPerPixel: number, bytesPerLine: number): void;
    SetSourceResolution(ppi: number): void;
    SetPageSegMode(mode: number): void;
    SetRectangle(left: number, top: number, width: number, height: number): void;
    SetVariable(name: string, value: string): boolean;
    Recognize(monitor: null): number;
    GetJSONText(page: number): string;
    GetUTF8Text(): string;
    /** Full build only: aborts the module in the LSTM-only build. */
    GetOsdText(page: number): string;
    Version(): string;
    Clear(): void;
    End(): void;
  }

  export interface TesseractModule {
    TessBaseAPI: new () => TessBaseAPI;
    FS: { writeFile(path: string, data: Uint8Array): void };
    HEAPU8: Uint8Array;
    _malloc(size: number): number;
    _free(ptr: number): void;
  }

  export type TesseractFactory = (options: {
    wasmBinary: ArrayBuffer | Uint8Array;
    print?: (s: string) => void;
    printErr?: (s: string) => void;
  }) => Promise<TesseractModule>;

  const factory: TesseractFactory;
  export default factory;
}

declare module 'tesseract.js-core/tesseract-core-simd.js' {
  import type { TesseractFactory } from 'tesseract.js-core/tesseract-core-simd-lstm.js';
  const factory: TesseractFactory;
  export default factory;
}
