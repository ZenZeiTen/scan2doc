import type { BBox } from '@scan2doc/core';

/** One character of a PDF's own text layer, in rendered page pixels. */
export interface PdfChar {
  text: string;
  box: BBox;
  sizePt: number;
  /** Base font family, subset prefix and style suffix removed ("Times New Roman"). */
  family: string;
  bold: boolean;
  italic: boolean;
  color: string;
  /** Text render mode 3: invisible, as OCR tools lay it under a scanned image. */
  invisible: boolean;
  /** PDFium could not map the glyph to Unicode (broken font encoding). */
  unmapped: boolean;
  /** Rotation of the glyph on the page, radians (0 = upright). */
  angle: number;
  /** A space (written in the PDF, or inferred by PDFium) came right before this character. */
  spaceBefore: boolean;
}

/** Subset of the PDFium WASM module the text layer uses (exports checked against @hyzyla/pdfium 2.1). */
interface PdfiumModule {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  HEAPF64: Float64Array;
  wasmExports: { malloc(n: number): number; free(p: number): void };
  _FPDF_LoadPage(doc: number, index: number): number;
  _FPDF_ClosePage(page: number): void;
  _FPDFPage_GetRotation(page: number): number;
  _FPDF_PageToDevice(page: number, sx: number, sy: number, w: number, h: number, rot: number, px: number, py: number, dx: number, dy: number): number;
  _FPDF_GetMetaText(doc: number, tag: number, buf: number, len: number): number;
  _FPDFText_LoadPage(page: number): number;
  _FPDFText_ClosePage(text: number): void;
  _FPDFText_CountChars(text: number): number;
  _FPDFText_GetUnicode(text: number, i: number): number;
  _FPDFText_GetCharBox(text: number, i: number, l: number, r: number, b: number, t: number): number;
  _FPDFText_GetFontSize(text: number, i: number): number;
  _FPDFText_GetFontWeight(text: number, i: number): number;
  _FPDFText_GetFontInfo(text: number, i: number, buf: number, len: number, flags: number): number;
  _FPDFText_GetFillColor(text: number, i: number, r: number, g: number, b: number, a: number): number;
  _FPDFText_GetTextObject(text: number, i: number): number;
  _FPDFText_HasUnicodeMapError(text: number, i: number): number;
  _FPDFText_IsGenerated(text: number, i: number): number;
  _FPDFText_GetCharAngle(text: number, i: number): number;
  _FPDFText_GetLooseCharBox(text: number, i: number, rect: number): number;
  HEAPF32: Float32Array;
  _FPDFTextObj_GetTextRenderMode(obj: number): number;
}

/** PDF font descriptor flags. */
const FLAG_ITALIC = 1 << 6;
const FLAG_FORCE_BOLD = 1 << 18;
const TEXT_RENDER_INVISIBLE = 3;

/** PostScript names → the family names Office knows. */
const KNOWN_FAMILIES: Readonly<Record<string, string>> = {
  arialmt: 'Arial',
  arial: 'Arial',
  timesnewromanpsmt: 'Times New Roman',
  timesnewromanps: 'Times New Roman',
  timesnewroman: 'Times New Roman',
  'times-roman': 'Times New Roman',
  times: 'Times New Roman',
  couriernewpsmt: 'Courier New',
  couriernew: 'Courier New',
  courier: 'Courier New',
  segoeui: 'Segoe UI',
  microsoftyahei: 'Microsoft YaHei',
  microsoftjhenghei: 'Microsoft JhengHei',
  malgungothic: 'Malgun Gothic',
  yugothic: 'Yu Gothic',
  msgothic: 'MS Gothic',
  msmincho: 'MS Mincho',
};

/** "ABCDEF+TimesNewRomanPS-BoldItalicMT" → "Times New Roman". */
export function familyFromFontName(raw: string): string {
  const base = raw.replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0]!.trim();
  return KNOWN_FAMILIES[base.toLowerCase()] ?? KNOWN_FAMILIES[base.toLowerCase().replace(/(ps)?mt$/, '')] ?? base;
}

const hex = (v: number) => v.toString(16).padStart(2, '0');

/**
 * Reads a page's text layer straight from the PDF through PDFium: every
 * character with its box (mapped to the rendered page, rotation included),
 * font, size, weight, colour and render mode. Characters PDFium inserts
 * itself (spaces it infers, line ends) are left out; layout rebuilds them.
 */
export function readTextLayer(module: PdfiumModule, doc: number, pageIndex: number, width: number, height: number): PdfChar[] {
  const page = module._FPDF_LoadPage(doc, pageIndex);
  if (!page) return [];
  const text = module._FPDFText_LoadPage(page);
  const m = module.wasmExports;
  const scratch = m.malloc(64);
  const name = m.malloc(256);
  const chars: PdfChar[] = [];
  try {
    if (!text) return [];
    const rotation = module._FPDFPage_GetRotation(page);
    const toDevice = (x: number, y: number) => {
      module._FPDF_PageToDevice(page, 0, 0, width, height, rotation, x, y, scratch + 32, scratch + 36);
      return [module.HEAP32[(scratch + 32) >> 2]!, module.HEAP32[(scratch + 36) >> 2]!] as const;
    };
    const count = module._FPDFText_CountChars(text);
    let pendingSpace = false;
    for (let i = 0; i < count; i++) {
      // Characters PDFium infers (spaces, line ends) are kept only as word boundaries.
      if (module._FPDFText_IsGenerated(text, i) === 1) {
        pendingSpace = true;
        continue;
      }
      let code = module._FPDFText_GetUnicode(text, i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < count) {
        const low = module._FPDFText_GetUnicode(text, i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
          i++;
        }
      }
      const ch = String.fromCodePoint(code);
      if (/^\s$/u.test(ch)) {
        pendingSpace = true;
        continue;
      }
      // The loose box spans the glyph's advance width, not just its ink: adjacent letters touch,
      // so a gap means a word break (tight ink boxes made "120" read as "1 20").
      if (!module._FPDFText_GetLooseCharBox(text, i, scratch)) continue;
      const f = module.HEAPF32.subarray(scratch >> 2, (scratch >> 2) + 4);
      const [l, t, r, b] = [f[0]!, f[1]!, f[2]!, f[3]!];
      const [x1, y1] = toDevice(l, t);
      const [x2, y2] = toDevice(r, b);
      const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.max(1, Math.abs(x2 - x1)), height: Math.max(1, Math.abs(y2 - y1)) };

      const len = module._FPDFText_GetFontInfo(text, i, name, 256, scratch + 40);
      const fontName = len > 1 ? new TextDecoder().decode(module.HEAPU8.subarray(name, name + Math.min(len, 256) - 1)) : '';
      const flags = module.HEAP32[(scratch + 40) >> 2]!;
      const weight = module._FPDFText_GetFontWeight(text, i);
      let color = '#000000';
      if (module._FPDFText_GetFillColor(text, i, scratch + 44, scratch + 48, scratch + 52, scratch + 56)) {
        const u = module.HEAPU32;
        color = `#${hex(u[(scratch + 44) >> 2]!)}${hex(u[(scratch + 48) >> 2]!)}${hex(u[(scratch + 52) >> 2]!)}`;
      }
      const obj = module._FPDFText_GetTextObject(text, i);
      const spaceBefore = pendingSpace;
      pendingSpace = false;
      chars.push({
        text: ch,
        box,
        sizePt: module._FPDFText_GetFontSize(text, i),
        family: familyFromFontName(fontName),
        bold: weight >= 600 || (flags & FLAG_FORCE_BOLD) !== 0 || /bold|black|heavy|semibold|demi/i.test(fontName),
        italic: (flags & FLAG_ITALIC) !== 0 || /italic|oblique/i.test(fontName),
        color,
        invisible: obj !== 0 && module._FPDFTextObj_GetTextRenderMode(obj) === TEXT_RENDER_INVISIBLE,
        // Private-use code points are glyph ids leaking through a font with no Unicode map.
        unmapped: module._FPDFText_HasUnicodeMapError(text, i) === 1 || (code >= 0xe000 && code <= 0xf8ff),
        angle: module._FPDFText_GetCharAngle(text, i),
        spaceBefore,
      });
    }
    return chars;
  } finally {
    m.free(scratch);
    m.free(name);
    if (text) module._FPDFText_ClosePage(text);
    module._FPDF_ClosePage(page);
  }
}

/** Document Info entries ("Title", "Author", …); undefined when absent or empty. */
export function readMetaText(module: PdfiumModule, doc: number, tag: string): string | undefined {
  const key = new TextEncoder().encode(`${tag}\0`);
  const m = module.wasmExports;
  const k = m.malloc(key.length);
  const buf = m.malloc(2048);
  try {
    module.HEAPU8.set(key, k);
    const n = module._FPDF_GetMetaText(doc, k, buf, 2048);
    const value = n > 2 ? new TextDecoder('utf-16le').decode(module.HEAPU8.subarray(buf, buf + Math.min(n, 2048) - 2)).trim() : '';
    return value || undefined;
  } finally {
    m.free(k);
    m.free(buf);
  }
}

export type { PdfiumModule };
