import {
  bcp47For,
  classifyDocument,
  IDR_VERSION,
  IDRDocumentSchema,
  IDRPageSchema,
  readingOrder,
  type BackgroundCrop,
  type BBox,
  type IDRBlock,
  type IDRDocument,
  type IDRPage,
  type IDRTableBlock,
} from '@scan2doc/core';
import { nodeModulesAssets, type AssetSource } from './assets.js';
import { ESCALATION_IMAGE_MAX_SIDE, type EscalationOutcome, type EscalationRequest, type PageEscalator } from './escalation.js';
import { bgraToGray, cropToPng, despeckle, downscaleGray, eraseBoxes, grayToPng, inkMask, pngDataUri, rotateRaster, type GrayImage, type Rotation } from './image.js';
import { identifyLatin, SCRIPT_CANDIDATES, scriptFromOsd } from './languages.js';
import { detectImageRegions } from './layout/images.js';
import { detectTables, type TableGrid } from './layout/tables.js';
import { buildLines, buildParagraphs, textInside } from './layout/chars.js';
import { alignment, assignRoles, freeParagraphs, joinLines, toCandidate, toTextBlock, type TextCandidate } from './layout/text.js';
import { meanConfidence, OcrEngine, type OcrParagraph } from './ocr.js';
import { OsdEngine } from './osd.js';
import { PdfRasterizer, type RasterPage } from './pdf.js';
import { assessPage, QUALITY_THRESHOLDS, type PageQuality } from './quality.js';
import { languageFromText } from './script.js';
import type { PdfChar } from './textlayer.js';

export type RecognizeStage = 'render' | 'layout' | 'ocr' | 'tables' | 'escalate';

export interface RecognizeProgress {
  stage: RecognizeStage;
  /** 0-based page being processed. */
  page: number;
  pageCount: number;
}

export interface RecognizeOptions {
  /** Render resolution. 300 dpi suits OCR; lower is faster but loses small print. */
  dpi?: number;
  /**
   * "auto" (default): detect each page's script, then pick its language.
   * Or Tesseract codes to use on every page, e.g. ["jpn", "eng"].
   */
  languages?: 'auto' | string[];
  /**
   * Use the PDF's own text where it has one (default "auto"): exact characters and fonts, no OCR.
   * "include-hidden" also trusts invisible OCR layers other tools left; "ignore" always OCRs.
   */
  textLayer?: 'auto' | 'include-hidden' | 'ignore';
  /** Turn pages scanned sideways or upside down (default true). */
  detectOrientation?: boolean;
  assets?: AssetSource;
  /** 0-based pages to convert; default all. */
  pages?: number[];
  password?: string;
  /** Called for every page that fails the quality checks; see PageEscalator. */
  escalate?: PageEscalator;
  onProgress?: (p: RecognizeProgress) => void;
}

export interface PageReport {
  index: number;
  /** Tesseract language set used, e.g. "jpn+eng". */
  languages: string;
  /** Script reported by OSD, when it could tell. */
  script?: string;
  /** Clockwise degrees the page was turned before reading. */
  rotation: Rotation;
  textSource: TextSource;
  /** Why the PDF's own text layer was or was not used, when there is something to say. */
  textNote?: string;
  quality: PageQuality;
  escalation: EscalationOutcome;
  note?: string;
}

export interface RecognizeResult {
  pages: IDRPage[];
  reports: PageReport[];
  /** What read the text: the OCR engine, the PDF text layer, or both. */
  ocrEngine: string;
  /** Title and author from the PDF's document information. */
  metadata: { title?: string; author?: string };
}

const MM_PER_PT = 25.4 / 72;
/** Paragraphs below this OCR confidence with little text are speckle or picture texture, not words. */
const NOISE_CONFIDENCE = 40;
const NOISE_MAX_CHARS = 4;
/** OSD must be at least this sure before a page is turned (upright text measures 1–30). */
export const MIN_ORIENTATION_CONFIDENCE = 2;
/** A Latin rerun in the identified language is kept unless it scores this much lower than English. */
const RERUN_TOLERANCE = 5;
/** A later script candidate (chi_tra, ukr) must beat the first by this many confidence points. */
const CANDIDATE_MARGIN = 3;

/** Shrinks a box so it stays inside the page (detectors round outward). */
function clampTo(b: BBox, w: number, h: number): BBox {
  const x = Math.max(0, Math.min(b.x, w - 1));
  const y = Math.max(0, Math.min(b.y, h - 1));
  return { x, y, width: Math.max(1, Math.min(b.width, w - x)), height: Math.max(1, Math.min(b.height, h - y)) };
}

/** Builds a table block; `cellText` reads one cell interior (OCR, or the PDF text layer). */
async function tableBlock(grid: TableGrid, cellText: (inner: BBox) => Promise<string>, id: string): Promise<IDRTableBlock> {
  const inset = grid.lineThickness + 2;
  const cells = [];
  for (const c of grid.cells) {
    const inner = { x: c.bbox.x + inset, y: c.bbox.y + inset, width: c.bbox.width - 2 * inset, height: c.bbox.height - 2 * inset };
    const text = inner.width > 4 && inner.height > 4 ? await cellText(inner) : '';
    cells.push({ row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan, text, bbox: c.bbox });
  }
  return { id, type: 'table', bbox: grid.bbox, rows: grid.rows, cols: grid.cols, cells };
}

/** Picks the language set for a page and returns its OCR result. */
async function readPage(
  ocr: OcrEngine,
  option: RecognizeOptions['languages'],
  script: string | undefined,
): Promise<{ languages: string; paragraphs: OcrParagraph[]; unsupportedScript?: string }> {
  if (option && option !== 'auto') {
    const languages = option.join('+');
    return { languages, paragraphs: await ocr.recognizePage(languages) };
  }
  const known = script === undefined ? 'Latin' : scriptFromOsd(script);
  if (known === undefined) {
    // A script no shipped model reads: the English pass is a placeholder for escalation.
    return { languages: 'eng', paragraphs: await ocr.recognizePage('eng'), unsupportedScript: script };
  }
  if (known === 'Latin') {
    const first = await ocr.recognizePage('eng');
    const guess = identifyLatin(first.map((p) => joinLines(p.lines.map((l) => l.text))).join(' '));
    if (guess.code === 'eng') return { languages: 'eng', paragraphs: first };
    const languages = `${guess.code}+eng`;
    const second = await ocr.recognizePage(languages);
    return meanConfidence(second) >= meanConfidence(first) - RERUN_TOLERANCE ? { languages, paragraphs: second } : { languages: 'eng', paragraphs: first };
  }
  // Each model rewrites what it reads into its own character set (chi_tra turns
  // 增长 into 增長 at full confidence), so the wrong pick silently converts the
  // text. The first candidate wins unless another is clearly more confident:
  // a model reading the other variant's text loses ~13 points, reading its own
  // gains under 1 (measured on both Chinese samples).
  let best: { languages: string; paragraphs: OcrParagraph[]; conf: number } | undefined;
  for (const languages of SCRIPT_CANDIDATES[known]) {
    const paragraphs = await ocr.recognizePage(languages);
    const conf = meanConfidence(paragraphs);
    if (!best || Number.isNaN(best.conf) || conf > best.conf + CANDIDATE_MARGIN) best = { languages, paragraphs, conf };
  }
  return best!;
}

/** Confidently read characters inside picture regions that mean "this picture is text". */
const TEXT_IN_PICTURE_MIN_CHARS = 40;

/**
 * Do any picture regions hold real text? Counts characters in words OCR reads
 * with high confidence (photos yield only scattered low-confidence fragments).
 */
async function textInRegions(ocr: OcrEngine, gray: GrayImage, dpi: number, regions: readonly BBox[], languages: string): Promise<boolean> {
  ocr.setImage(gray, dpi);
  const langs = languages.includes('eng') ? languages : `${languages}+eng`;
  let chars = 0;
  for (const r of regions) {
    for (const p of await ocr.recognizeArea(langs, r)) {
      for (const l of p.lines) for (const w of l.words) if (w.confidence >= 75 && [...w.text].length >= 2) chars += [...w.text].length;
    }
    if (chars >= TEXT_IN_PICTURE_MIN_CHARS) return true;
  }
  return false;
}

/** Where a page's text came from: the PDF's own text layer, or OCR of the rendered page. */
export type TextSource = 'pdf' | 'ocr';

/** A text layer needs this many readable characters before it is worth using. */
const MIN_LAYER_CHARS = 20;
/** More than this share of unmappable glyphs means a broken font encoding: OCR instead. */
const MAX_UNMAPPED_SHARE = 0.05;
/** Characters more than 3° from upright count as rotated text. */
const MIN_UPRIGHT_COS = Math.cos((3 * Math.PI) / 180);

/** Decides whether a page's own text layer can replace OCR. */
export function judgeTextLayer(chars: readonly PdfChar[], includeHidden: boolean): { usable: boolean; chars: PdfChar[]; note?: string } {
  const hidden = chars.filter((c) => c.invisible);
  const candidates = includeHidden ? [...chars] : chars.filter((c) => !c.invisible);
  const unmapped = candidates.filter((c) => c.unmapped).length;
  if (candidates.length >= MIN_LAYER_CHARS && unmapped / candidates.length > MAX_UNMAPPED_SHARE) {
    return { usable: false, chars: [], note: `the PDF text layer has a broken font encoding (${unmapped} of ${candidates.length} glyphs unmapped); read by OCR instead` };
  }
  const usable = candidates.filter((c) => !c.unmapped);
  // Lines are rebuilt left to right; text set at an angle (a landscape table on a portrait
  // page) goes to OCR, which turns the page upright first.
  // cos, not sin: upside-down text (180°) has no sine but is just as unreadable left to right.
  const tilted = usable.filter((c) => Math.cos(c.angle) < MIN_UPRIGHT_COS).length;
  if (usable.length >= MIN_LAYER_CHARS && tilted / usable.length > 0.3) {
    return { usable: false, chars: [], note: 'the PDF text is rotated on the page; read by OCR after turning the page upright' };
  }
  if (usable.length >= MIN_LAYER_CHARS) return { usable: true, chars: usable };
  if (hidden.length >= MIN_LAYER_CHARS) {
    return { usable: false, chars: [], note: 'the PDF carries a hidden OCR text layer from another tool; it was re-read with Scan2Doc OCR' };
  }
  return { usable: false, chars: [] };
}

interface PageDraft {
  raster: Pick<RasterPage, 'dpi' | 'width' | 'height' | 'widthPt' | 'heightPt'>;
  textSource: TextSource;
  note?: string;
  languages: string;
  fixed: IDRBlock[];
  crops: BackgroundCrop[];
  texts: TextCandidate[];
  wordBoxes: BBox[];
  wordConfidence: number;
  unsupportedScript?: string;
  script?: string;
  rotation: Rotation;
  /** Kept only for pages that may be escalated. */
  mask?: ReturnType<typeof inkMask>;
  preview?: EscalationRequest['image'];
}

/**
 * Converts a PDF (scanned or born-digital) to IDR pages: renders each page,
 * turns it upright, detects its script and language, finds ruled tables and
 * pictures, OCRs the text and each table cell, assigns heading roles across
 * the whole document, sorts each page into reading order, checks quality,
 * and hands pages that fail to `escalate` when one is given.
 */
export async function recognizePdf(pdf: Uint8Array, options: RecognizeOptions = {}): Promise<RecognizeResult> {
  const dpi = options.dpi ?? 300;
  const assets = options.assets ?? nodeModulesAssets();
  const auto = !options.languages || options.languages === 'auto';
  if (!auto) {
    // Fail before any work when a requested model is missing, not only on the first page that needs OCR.
    for (const code of options.languages as string[]) await assets.read(`${code}.traineddata`);
  }
  const raster = await PdfRasterizer.open(pdf, assets, options.password);
  let ocr: OcrEngine | undefined;
  let osd: OsdEngine | undefined;
  // Loaded on first use: a fully digital PDF never needs Tesseract.
  const getOcr = async () => (ocr ??= await OcrEngine.create(assets));
  const getOsd = async () => (auto || options.detectOrientation !== false ? (osd ??= await OsdEngine.create(assets)) : undefined);
  try {
    const indices = options.pages ?? Array.from({ length: raster.pageCount }, (_, i) => i);
    const report = (stage: RecognizeStage, page: number) => options.onProgress?.({ stage, page, pageCount: indices.length });
    const drafts: PageDraft[] = [];

    for (const [n, index] of indices.entries()) {
      if (index < 0 || index >= raster.pageCount) throw new RangeError(`page ${index + 1} does not exist (document has ${raster.pageCount})`);
      report('render', n);
      let page = await raster.render(index, dpi);
      const tag = `p${n + 1}`;

      report('layout', n);
      // A PDF that carries its own visible, readable text needs no OCR: its characters, fonts and
      // positions are exact. Hidden layers (another tool's OCR) and broken encodings are not trusted.
      const layer = options.textLayer === 'ignore' ? undefined : judgeTextLayer(raster.textLayer(index, page.width, page.height), options.textLayer === 'include-hidden');
      let rotation: Rotation = 0;
      let script: string | undefined;
      if (!layer?.usable) {
        const detected = (await getOsd())?.detect(page.gray, dpi);
        script = detected?.script;
        if (options.detectOrientation !== false && detected && detected.rotate !== 0 && detected.orientationConfidence >= MIN_ORIENTATION_CONFIDENCE) {
          rotation = detected.rotate;
          const bgra = rotateRaster(page.bgra, page.width, page.height, 4, rotation);
          const turned = rotation === 180 ? { widthPt: page.widthPt, heightPt: page.heightPt } : { widthPt: page.heightPt, heightPt: page.widthPt };
          page = { ...page, ...turned, width: bgra.width, height: bgra.height, bgra: bgra.data, gray: bgraToGray(bgra.data, bgra.width, bgra.height) };
        }
      }
      const { gray, mask } = despeckle(page.gray, inkMask(page.gray), dpi);
      const grids = detectTables(mask, dpi);
      const pad = Math.round(dpi / 100);

      let read: { languages: string; texts: TextCandidate[]; wordBoxes: BBox[]; wordConfidence: number; unsupportedScript?: string; cellText: (b: BBox) => Promise<string> } | undefined;
      let regions: BBox[] = [];
      let note = layer?.note;
      let fromLayer = false;

      if (layer?.usable) {
        const charBoxes = layer.chars.map((c) => c.box);
        regions = detectImageRegions(eraseBoxes(mask, [...grids.map((g) => g.bbox), ...charBoxes], pad), dpi);
        // Ink the layer does not explain (a scanned picture of text, a stamp) means the page is
        // part scan: OCR the whole page instead of trusting half of it.
        const rest = eraseBoxes(mask, [...grids.map((g) => g.bbox), ...charBoxes, ...regions], pad).data.reduce((s, v) => s + v, 0);
        const ink = mask.data.reduce((s, v) => s + v, 0);
        const allParagraphs = buildParagraphs(buildLines(layer.chars, dpi));
        // Identified from rebuilt paragraphs: function-word matching needs the word spaces.
        const language = languageFromText(allParagraphs.map((p) => p.text).join(' '));
        const pageLanguages = !auto ? (options.languages as string[]).join('+') : 'code' in language ? language.code : 'eng';
        if (ink > 0 && rest / ink > QUALITY_THRESHOLDS.maxUnreadInk) {
          note = `text layer covers only part of the page (${Math.round((rest / ink) * 100)}% of the ink is outside it); read by OCR instead`;
        } else if (regions.length && (await textInRegions(await getOcr(), gray, dpi, regions, pageLanguages))) {
          // A "picture" full of confident words is a scanned page pasted into a digital one.
          note = 'text layer covers only part of the page (a picture on it is a scan of text); read by OCR instead';
        } else {
          fromLayer = true;
          const paragraphs = freeParagraphs(allParagraphs, [...grids.map((g) => g.bbox), ...regions]);
          read = {
            // Languages the caller named win; otherwise the characters say which language this is.
            languages: pageLanguages,
            ...('unsupported' in language && { unsupportedScript: language.unsupported }),
            texts: paragraphs.map((p) => ({
              pageIndex: n,
              bbox: clampTo(p.bbox, page.width, page.height),
              text: p.text,
              lineCount: p.lines.length,
              sizePt: p.font.sizePt,
              confidence: 1,
              align: alignment(p.bbox, page.width),
              font: p.font,
            })),
            wordBoxes: charBoxes,
            wordConfidence: 100,
            cellText: async (b) => textInside(layer.chars, b, dpi),
          };
        }
      }

      if (!read) {
        report('ocr', n);
        const ocr = await getOcr();
        ocr.setImage(gray, dpi);
        const result = await readPage(ocr, options.languages, auto ? script : undefined);
        const paragraphs = freeParagraphs(result.paragraphs, grids.map((g) => g.bbox)).filter(
          (p) => !(p.confidence < NOISE_CONFIDENCE && joinLines(p.lines.map((l) => l.text)).length <= NOISE_MAX_CHARS),
        );
        const wordBoxes = paragraphs.flatMap((p) => p.lines.flatMap((l) => l.words.map((w) => w.bbox)));
        regions = detectImageRegions(eraseBoxes(mask, [...grids.map((g) => g.bbox), ...wordBoxes], pad), dpi);
        read = {
          languages: result.languages,
          ...(result.unsupportedScript && { unsupportedScript: result.unsupportedScript }),
          texts: freeParagraphs(paragraphs, regions)
            .map((p) => ({ ...toCandidate(p, n, page.width, dpi), bbox: clampTo(p.bbox, page.width, page.height) }))
            .filter((c) => c.text !== ''),
          wordBoxes,
          wordConfidence: meanConfidence(paragraphs),
          cellText: async (b) => joinLines((await ocr.recognizeRegion(result.languages, b)).split('\n')),
        };
      }

      const fixed: IDRBlock[] = [];
      const crops: BackgroundCrop[] = [];
      regions.forEach((r, i) => {
        const bbox = clampTo(r, page.width, page.height);
        const cropId = `${tag}-crop${i + 1}`;
        crops.push({ id: cropId, bbox, mimeType: 'image/png', dataRef: pngDataUri(cropToPng(page.bgra, page.width, bbox)) });
        fixed.push({ id: `${tag}-img${i + 1}`, type: 'image', bbox, cropRef: cropId });
      });

      report('tables', n);
      for (const [i, g] of grids.entries()) fixed.push(await tableBlock(g, read.cellText, `${tag}-tbl${i + 1}`));

      const preview = downscaleGray(gray, ESCALATION_IMAGE_MAX_SIDE);
      drafts.push({
        raster: page,
        languages: read.languages,
        fixed,
        crops,
        texts: read.texts,
        wordBoxes: read.wordBoxes,
        wordConfidence: read.wordConfidence,
        ...(read.unsupportedScript && { unsupportedScript: read.unsupportedScript }),
        ...(script && { script }),
        rotation,
        textSource: fromLayer ? 'pdf' : 'ocr',
        ...(note && { note }),
        mask,
        preview: { png: grayToPng(preview.image), width: preview.image.width, height: preview.image.height, scale: preview.scale },
      });
    }

    const roles = assignRoles(drafts.flatMap((d) => d.texts));
    let k = 0;
    const pages: IDRPage[] = [];
    const reports: PageReport[] = [];
    for (const [n, d] of drafts.entries()) {
      const textBlocks = d.texts.map((c, i) => toTextBlock(c, roles[k++]!, `p${n + 1}-t${i + 1}`, d.languages));
      let page: IDRPage = {
        index: n,
        dpi,
        sizeMm: { width: d.raster.widthPt * MM_PER_PT, height: d.raster.heightPt * MM_PER_PT },
        sizePx: { width: d.raster.width, height: d.raster.height },
        backgroundCrops: d.crops,
        blocks: readingOrder([...textBlocks, ...d.fixed]),
        language: bcp47For(d.languages),
        source: 'ocr',
      };
      const quality = assessPage({
        mask: d.mask!,
        dpi,
        wordBoxes: d.wordBoxes,
        blocks: page.blocks,
        wordConfidence: d.wordConfidence,
        ...(d.unsupportedScript && { unsupportedScript: d.unsupportedScript }),
      });
      d.mask = undefined; // free the full-resolution mask as soon as the page is assessed

      let escalation: EscalationOutcome = quality.issues.length === 0 ? 'not-needed' : options.escalate ? 'failed' : 'unavailable';
      let note: string | undefined;
      if (quality.issues.length > 0 && options.escalate) {
        report('escalate', n);
        try {
          const reply = await options.escalate({
            pageIndex: n,
            pageCount: drafts.length,
            image: d.preview!,
            page: { sizePx: page.sizePx, dpi, ...(page.language && { language: page.language }) },
            draft: page.blocks,
            crops: page.backgroundCrops.map(({ id, bbox }) => ({ id, bbox })),
            issues: quality.issues,
          });
          if (reply === undefined) {
            note = 'the escalator declined the page';
          } else {
            const checked = IDRPageSchema.safeParse({ ...page, blocks: reply.blocks, source: 'ai', ...(reply.language && { language: reply.language }) });
            if (checked.success) {
              page = checked.data;
              escalation = 'applied';
            } else {
              escalation = 'rejected';
              note = checked.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
            }
          }
        } catch (err) {
          note = (err as Error).message;
        }
      }
      d.preview = undefined;
      pages.push(page);
      reports.push({
        index: n,
        languages: d.languages,
        ...(d.script && { script: d.script }),
        rotation: d.rotation,
        textSource: d.textSource,
        ...(d.note && { textNote: d.note }),
        quality,
        escalation,
        ...(note && { note }),
      });
    }
    // Names what read the text, not what was loaded: OCR may run only to check that a picture holds no text.
    const usedLayer = drafts.some((d) => d.textSource === 'pdf');
    const usedOcr = drafts.some((d) => d.textSource === 'ocr');
    const tesseract = usedOcr && ocr ? `tesseract ${await (ocr as OcrEngine).version()}` : '';
    const engine = [tesseract, usedLayer ? 'PDF text layer' : ''].filter(Boolean).join(' + ') || 'none';
    return { pages, reports, ocrEngine: engine, metadata: raster.metadata() };
  } finally {
    ocr?.destroy();
    osd?.destroy();
    raster.close();
  }
}

export interface ScanOptions extends RecognizeOptions {
  sourceFile: string;
  title?: string;
  author?: string;
}

export interface ScanResult {
  document: IDRDocument;
  reports: PageReport[];
}

/** The most common page language names the document. */
function documentLanguage(pages: readonly IDRPage[]): string {
  const counts = new Map<string, number>();
  for (const p of pages) if (p.language) counts.set(p.language, (counts.get(p.language) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'en';
}

/** recognizePdf plus classification: a complete, schema-validated IDR document and per-page reports. */
export async function scanToIdr(pdf: Uint8Array, options: ScanOptions): Promise<ScanResult> {
  const { pages, reports, ocrEngine, metadata } = await recognizePdf(pdf, options);
  if (pages.length === 0) throw new Error('The PDF has no pages to convert');
  // Explicit options win over the PDF's own document information.
  const title = options.title ?? metadata.title;
  const author = options.author ?? metadata.author;
  const document = IDRDocumentSchema.parse({
    version: IDR_VERSION,
    metadata: {
      sourceFile: options.sourceFile,
      createdAt: new Date().toISOString(),
      language: documentLanguage(pages),
      ocrEngine,
      ...(title && { title }),
      ...(author && { author }),
    },
    category: classifyDocument(pages).category,
    pages,
  });
  return { document, reports };
}
