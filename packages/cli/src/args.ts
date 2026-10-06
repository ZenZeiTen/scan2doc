import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { DocumentCategory } from '@scan2doc/core';

export const FORMATS = ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'] as const;
export type OutputFormat = (typeof FORMATS)[number];

/** "auto" picks the Office format matching what the scan is. */
export const AUTO_FORMAT: Readonly<Record<DocumentCategory, OutputFormat>> = {
  document: 'docx',
  spreadsheet: 'xlsx',
  presentation: 'pptx',
};

export class UsageError extends Error {}

/** "1-3,5" → [0, 1, 2, 4] (1-based ranges in, 0-based pages out, sorted, deduplicated). */
export function parsePages(spec: string): number[] {
  const pages = new Set<number>();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new UsageError(`invalid page range "${part}" (use e.g. 1-3,5)`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (from < 1 || to < from) throw new UsageError(`invalid page range "${part}"`);
    for (let p = from; p <= to; p++) pages.add(p - 1);
  }
  if (pages.size === 0) throw new UsageError('no pages selected');
  return [...pages].sort((a, b) => a - b);
}

/** Comma- or space-separated formats; "auto" alone defers the choice to the document's category. */
export function parseFormats(values: readonly string[]): OutputFormat[] | 'auto' {
  const list = values.flatMap((v) => v.split(',')).map((v) => v.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
  if (list.length === 0 || (list.length === 1 && list[0] === 'auto')) return 'auto';
  for (const f of list) {
    if (!(FORMATS as readonly string[]).includes(f)) throw new UsageError(`unknown format "${f}" (choose from ${FORMATS.join(', ')}, or auto)`);
  }
  return [...new Set(list)] as OutputFormat[];
}

/** "auto" or Tesseract codes joined with + or commas ("jpn+eng"). */
export function parseLanguages(spec: string): 'auto' | string[] {
  if (spec === 'auto') return 'auto';
  const codes = spec.split(/[+,]/).map((s) => s.trim()).filter(Boolean);
  if (codes.length === 0 || codes.some((c) => !/^[a-z_]+$/.test(c))) throw new UsageError(`invalid language list "${spec}" (e.g. eng, jpn+eng)`);
  return codes;
}

/** Where a format's output goes: <out dir>/<input name>.<format>. */
export function outputPath(input: string, outDir: string | undefined, format: OutputFormat): string {
  const stem = basename(input, extname(input));
  return join(resolve(outDir ?? dirname(input)), `${stem}.${format}`);
}

/** Refuses to overwrite unless forced: a converter should never silently destroy a file. */
export function checkWritable(paths: readonly string[], force: boolean): void {
  const taken = paths.filter((p) => existsSync(p));
  if (taken.length && !force) throw new UsageError(`${taken.join(', ')} already exist${taken.length === 1 ? 's' : ''}; use --force to overwrite`);
}
