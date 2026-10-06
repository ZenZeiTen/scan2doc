import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { IDRDocument } from '@scan2doc/core';
import { defaultAssets, PdfRasterizer, scanToIdr, type AssetSource, type PageReport, type RecognizeStage } from '@scan2doc/vision-wasm';
import { writeOpenDocument, type OpenDocumentFormat } from '@scan2doc/writer-opendocument';
import { writeOpenXml, type OpenXmlFormat } from '@scan2doc/writer-openxml';
import { AUTO_FORMAT, checkWritable, outputPath, type OutputFormat } from './args.js';

export interface ConvertOptions {
  input: string;
  formats: OutputFormat[] | 'auto';
  outDir?: string;
  languages: 'auto' | string[];
  /** 0-based pages; all when absent. */
  pages?: number[];
  dpi?: number;
  textLayer?: 'auto' | 'include-hidden' | 'ignore';
  password?: string;
  force?: boolean;
  assets?: AssetSource;
}

export type ConvertEvent =
  | { type: 'start'; file: string; pageCount: number; dpi: number }
  | { type: 'page'; page: number; sourcePage: number; stage: RecognizeStage }
  | { type: 'recognized'; document: IDRDocument; reports: PageReport[] }
  | { type: 'write'; format: OutputFormat; path: string }
  | { type: 'written'; format: OutputFormat; path: string; bytes: number };

export interface ConvertResult {
  document: IDRDocument;
  reports: PageReport[];
  outputs: { format: OutputFormat; path: string; bytes: number }[];
  seconds: number;
}

const OPENXML = new Set<OutputFormat>(['docx', 'xlsx', 'pptx']);

export async function writeFormat(doc: IDRDocument, format: OutputFormat): Promise<Uint8Array> {
  return OPENXML.has(format) ? writeOpenXml(doc, format as OpenXmlFormat) : writeOpenDocument(doc, format as OpenDocumentFormat);
}

/**
 * Converts one PDF: recognises it, then writes each requested format next to
 * it (or into outDir). Checks that outputs may be written before the slow part,
 * when the formats are known up front.
 */
export async function runConvert(options: ConvertOptions, onEvent: (e: ConvertEvent) => void = () => {}): Promise<ConvertResult> {
  const started = performance.now();
  const assets = options.assets ?? defaultAssets();
  const dpi = options.dpi ?? 300;
  if (options.formats !== 'auto') checkWritable(options.formats.map((f) => outputPath(options.input, options.outDir, f)), options.force ?? false);

  const pdf = await readFile(options.input);
  const raster = await PdfRasterizer.open(pdf, assets, options.password);
  const total = raster.pageCount;
  raster.close();
  onEvent({ type: 'start', file: basename(options.input), pageCount: options.pages?.length ?? total, dpi });

  const { document, reports } = await scanToIdr(pdf, {
    sourceFile: basename(options.input),
    assets,
    dpi,
    languages: options.languages,
    ...(options.pages && { pages: options.pages }),
    ...(options.textLayer && { textLayer: options.textLayer }),
    ...(options.password && { password: options.password }),
    onProgress: (p) => onEvent({ type: 'page', page: p.page, sourcePage: p.sourcePage, stage: p.stage }),
  });
  onEvent({ type: 'recognized', document, reports });

  const formats = options.formats === 'auto' ? [AUTO_FORMAT[document.category]] : options.formats;
  const paths = formats.map((f) => outputPath(options.input, options.outDir, f));
  if (options.formats === 'auto') checkWritable(paths, options.force ?? false);
  if (options.outDir) await mkdir(options.outDir, { recursive: true });

  const outputs: ConvertResult['outputs'] = [];
  for (const [i, format] of formats.entries()) {
    onEvent({ type: 'write', format, path: paths[i]! });
    const bytes = await writeFormat(document, format);
    await writeFile(paths[i]!, bytes);
    outputs.push({ format, path: paths[i]!, bytes: bytes.length });
    onEvent({ type: 'written', format, path: paths[i]!, bytes: bytes.length });
  }
  return { document, reports, outputs, seconds: (performance.now() - started) / 1000 };
}

/** Pages a person (or an AI host, through `scan2doc mcp`) should look at. */
export const pagesNeedingReview = (reports: readonly PageReport[]) => reports.filter((r) => r.quality.issues.length > 0);
