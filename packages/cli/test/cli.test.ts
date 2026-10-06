import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToString } from 'ink';
import { createElement } from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IDRDocument } from '@scan2doc/core';
import type { PageReport } from '@scan2doc/vision-wasm';
import {
  AUTO_FORMAT,
  checkWritable,
  EXIT,
  initialProgress,
  main,
  outputPath,
  parseFormats,
  parseLanguages,
  parsePages,
  Progress,
  progressReducer,
  runConvert,
  UsageError,
  VERSION,
  type ConvertEvent,
  type Io,
} from '../src/index.js';
import { makeFixturePdf, simulateScan } from '../../../test/support/make-pdf.js';
import { fontAvailable, makeLanguagePdf, SAMPLES } from '../../../test/support/multilingual.js';

const KOREAN = SAMPLES.find((s) => s.code === 'kor')!;

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scan2doc-cli-'));
  writeFileSync(join(dir, 'report.pdf'), await makeFixturePdf());
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Captures what the CLI writes; neither stream is a terminal, as under a pipe or CI. */
function fakeIo(env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const stream = (sink: string[]) => ({ isTTY: false, write: (s: string) => (sink.push(s), true) }) as unknown as NodeJS.WriteStream;
  const io: Io = { stdout: stream(out), stderr: stream(err), env };
  return { io, stdout: () => out.join(''), stderr: () => err.join('') };
}

describe('argument parsing', () => {
  it('turns 1-based page ranges into sorted, unique 0-based pages', () => {
    expect(parsePages('1-3,5')).toEqual([0, 1, 2, 4]);
    expect(parsePages(' 4, 2-3 ,3')).toEqual([1, 2, 3]);
    for (const bad of ['0', '3-1', 'a', '1-', '', ',']) expect(() => parsePages(bad), bad).toThrow(UsageError);
  });

  it('accepts formats separated by commas or spaces, any case, with or without a dot', () => {
    expect(parseFormats(['auto'])).toBe('auto');
    expect(parseFormats([])).toBe('auto');
    expect(parseFormats(['docx,ODT', '.xlsx', 'docx'])).toEqual(['docx', 'odt', 'xlsx']);
    expect(() => parseFormats(['doc'])).toThrow(/unknown format "doc"/);
    // "auto" mixed with real formats is ambiguous, not a format.
    expect(() => parseFormats(['auto', 'docx'])).toThrow(UsageError);
  });

  it('reads Tesseract language lists', () => {
    expect(parseLanguages('auto')).toBe('auto');
    expect(parseLanguages('jpn+eng')).toEqual(['jpn', 'eng']);
    expect(parseLanguages('chi_sim,eng')).toEqual(['chi_sim', 'eng']);
    for (const bad of ['', 'JPN', 'en-US', '+']) expect(() => parseLanguages(bad), bad).toThrow(UsageError);
  });

  it('puts outputs next to the PDF unless an output directory is given', () => {
    expect(outputPath(join(dir, 'scan.pdf'), undefined, 'docx')).toBe(join(dir, 'scan.docx'));
    expect(outputPath(join(dir, 'scan.v2.PDF'), join(dir, 'out'), 'ods')).toBe(join(dir, 'out', 'scan.v2.ods'));
  });

  it('refuses to overwrite an existing file unless forced', () => {
    const taken = join(dir, 'taken.docx');
    writeFileSync(taken, 'keep me');
    expect(() => checkWritable([taken, join(dir, 'free.odt')], false)).toThrow(/taken\.docx already exists; use --force/);
    expect(() => checkWritable([taken], true)).not.toThrow();
    expect(() => checkWritable([join(dir, 'free.odt')], false)).not.toThrow();
  });
});

describe('progress screen', () => {
  const doc = { category: 'spreadsheet' } as IDRDocument;
  // Converted with --pages 3-5: the screen should speak of PDF pages, not positions in the output.
  const report = (index: number, issues: PageReport['quality']['issues'] = []) =>
    ({ index, sourcePage: index + 2, textSource: index === 0 ? 'pdf' : 'ocr', rotation: 0, quality: { wordConfidence: 90, issues } }) as unknown as PageReport;

  it('folds conversion events into what the screen shows', () => {
    const events: ConvertEvent[] = [
      { type: 'start', file: 'scan.pdf', pageCount: 3, dpi: 200 },
      { type: 'page', page: 0, sourcePage: 4, stage: 'render' },
      { type: 'page', page: 0, sourcePage: 4, stage: 'ocr' },
      { type: 'page', page: 1, sourcePage: 5, stage: 'render' },
      { type: 'page', page: 1, sourcePage: 5, stage: 'tables' },
    ];
    let s = events.reduce(progressReducer, initialProgress());
    expect(s).toMatchObject({ file: 'scan.pdf', pageCount: 3, dpi: 200, pagesDone: 1, current: { page: 1, sourcePage: 5, stage: 'tables' } });

    s = progressReducer(s, { type: 'recognized', document: doc, reports: [report(0), report(1), report(2)] });
    expect(s).toMatchObject({ pagesDone: 3, current: undefined, category: 'spreadsheet' });

    s = progressReducer(s, { type: 'write', format: 'xlsx', path: 'scan.xlsx' });
    s = progressReducer(s, { type: 'write', format: 'ods', path: 'scan.ods' });
    s = progressReducer(s, { type: 'written', format: 'xlsx', path: 'scan.xlsx', bytes: 5000 });
    expect(s.writes).toEqual([
      { format: 'xlsx', path: 'scan.xlsx', bytes: 5000 },
      { format: 'ods', path: 'scan.ods' },
    ]);
  });

  it('renders progress mid-conversion', () => {
    let s = progressReducer(initialProgress(), { type: 'start', file: 'scan.pdf', pageCount: 4, dpi: 300 });
    s = progressReducer(s, { type: 'page', page: 2, sourcePage: 6, stage: 'ocr' });
    s = progressReducer(s, { type: 'page', page: 2, sourcePage: 6, stage: 'render' });
    const text = renderToString(createElement(Progress, { s }), { columns: 120 });
    expect(text).toContain(`scan2doc ${VERSION} · scan.pdf · 4 pages · 300 dpi`);
    // The bar counts positions (2 of 4 done); the label names the PDF page.
    expect(text).toMatch(/Recognise pages\s+█{12}░{12} 2\/4 · page 7: rendering/);
    expect(text).not.toContain('Classify');
  });

  it('renders the finished screen with review notes and the elapsed time', () => {
    let s = progressReducer(initialProgress(), { type: 'start', file: 'scan.pdf', pageCount: 2, dpi: 300 });
    s = progressReducer(s, {
      type: 'recognized',
      document: doc,
      reports: [report(0), report(1, [{ code: 'low-confidence', detail: 'words were read with 41% confidence' }])],
    });
    s = progressReducer(s, { type: 'write', format: 'xlsx', path: 'scan.xlsx' });
    s = progressReducer(s, { type: 'written', format: 'xlsx', path: 'scan.xlsx', bytes: 3 * 1048576 });
    const text = renderToString(createElement(Progress, { s: { ...s, seconds: 4.26 } }), { columns: 120 });
    expect(text).toContain("2/2 · 1 from the PDF's text, 1 by OCR");
    expect(text).toMatch(/Classify\s+spreadsheet/);
    expect(text).toMatch(/Write \.xlsx\s+scan\.xlsx · 3\.0 MB/);
    expect(text).toContain('1 page needs review:');
    expect(text).toContain('page 4: words were read with 41% confidence');
    expect(text).toContain('Done in 4.3 s.');
  });

  it('shows the error when a conversion fails', () => {
    const text = renderToString(createElement(Progress, { s: { ...initialProgress(), error: 'file is encrypted' } }));
    expect(text).toContain('Error: file is encrypted');
  });
});

describe('runConvert', () => {
  it('reports events in order and writes each requested format', async () => {
    const events: ConvertEvent[] = [];
    const out = join(dir, 'run');
    const result = await runConvert({ input: join(dir, 'report.pdf'), formats: ['docx', 'ods'], outDir: out, languages: 'auto' }, (e) => events.push(e));

    const kinds = events.map((e) => e.type);
    expect(kinds[0]).toBe('start');
    expect(kinds.indexOf('recognized')).toBeGreaterThan(kinds.lastIndexOf('page'));
    expect(kinds.slice(-4)).toEqual(['write', 'written', 'write', 'written']);
    expect(events[0]).toMatchObject({ file: 'report.pdf', pageCount: 2, dpi: 300 });

    expect(result.outputs.map((o) => [o.format, o.path])).toEqual([
      ['docx', join(out, 'report.docx')],
      ['ods', join(out, 'report.ods')],
    ]);
    for (const o of result.outputs) {
      const bytes = readFileSync(o.path);
      expect(bytes.length).toBe(o.bytes);
      expect(bytes.subarray(0, 2).toString()).toBe('PK');
    }
  });

  it('converts only the selected pages and picks the format by document type', async () => {
    const out = join(dir, 'auto');
    const result = await runConvert({ input: join(dir, 'report.pdf'), formats: 'auto', outDir: out, languages: 'auto', pages: [1] });
    // index is the page's place in the output; sourcePage is where it came from in the PDF.
    expect(result.reports.map((r) => [r.index, r.sourcePage])).toEqual([[0, 1]]);
    expect(result.document.pages).toHaveLength(1);
    // Page 2 alone (a heading and one line) reads as a slide; auto follows whatever the category is.
    const format = AUTO_FORMAT[result.document.category];
    expect(result.outputs).toEqual([expect.objectContaining({ format, path: join(out, `report.${format}`) })]);
  });

  it('checks the outputs before recognising anything', async () => {
    const out = join(dir, 'blocked');
    await runConvert({ input: join(dir, 'report.pdf'), formats: ['odt'], outDir: out, languages: 'auto', pages: [0] });
    const events: ConvertEvent[] = [];
    await expect(runConvert({ input: join(dir, 'report.pdf'), formats: ['odt'], outDir: out, languages: 'auto' }, (e) => events.push(e))).rejects.toThrow(
      UsageError,
    );
    expect(events).toEqual([]);
  });
});

describe('main (exit codes and output)', () => {
  it('prints the version', async () => {
    const t = fakeIo();
    expect(await main(['--version'], t.io)).toBe(EXIT.OK);
    expect(t.stdout().trim()).toBe(VERSION);
  });

  it('lists the 27 languages', async () => {
    const t = fakeIo();
    expect(await main(['languages'], t.io)).toBe(EXIT.OK);
    const lines = t.stdout().trim().split('\n');
    expect(lines).toHaveLength(27);
    expect(lines).toContainEqual(expect.stringMatching(/^ind\s+Indonesian \(id\)$/));
  });

  it('exits 2 on bad usage, with the reason on stderr', async () => {
    const cases: [string[], RegExp][] = [
      [['frobnicate'], /unknown command/],
      [['convert'], /missing required argument/],
      [['convert', 'x.pdf', '-f', 'doc'], /unknown format "doc"/],
      [['convert', 'x.pdf', '--dpi', '50'], /--dpi must be a whole number from 100 to 600/],
      [['convert', 'x.pdf', '--pages', '0'], /invalid page range "0"/],
      [['convert', 'x.pdf', '--text-layer', 'maybe'], /invalid/i],
    ];
    for (const [argv, message] of cases) {
      const t = fakeIo();
      expect(await main(argv, t.io), argv.join(' ')).toBe(EXIT.USAGE);
      expect(t.stderr(), argv.join(' ')).toMatch(message);
      expect(t.stdout(), argv.join(' ')).toBe('');
    }
  });

  it('exits 1 when the input cannot be read', async () => {
    const t = fakeIo();
    expect(await main(['convert', join(dir, 'missing.pdf'), '-f', 'docx', '-q'], t.io)).toBe(EXIT.FAILED);
    expect(t.stderr()).toMatch(/^scan2doc: .*missing\.pdf/);
  });

  it('prints a JSON summary on stdout and nothing else there', async () => {
    const out = join(dir, 'json');
    const t = fakeIo();
    expect(await main(['convert', join(dir, 'report.pdf'), '-f', 'docx,xlsx', '-o', out, '--json'], t.io)).toBe(EXIT.OK);
    const summary = JSON.parse(t.stdout());
    expect(summary).toMatchObject({ input: join(dir, 'report.pdf'), category: 'document', language: 'en' });
    expect(summary.outputs.map((o: { format: string }) => o.format)).toEqual(['docx', 'xlsx']);
    expect(summary.pages).toEqual([
      expect.objectContaining({ page: 1, textSource: 'pdf', issues: [] }),
      expect.objectContaining({ page: 2, textSource: 'pdf', issues: [] }),
    ]);
    for (const o of summary.outputs) expect(existsSync(o.path)).toBe(true);
    expect(t.stderr()).toBe('');
  });

  it('numbers pages as in the PDF when only some are converted', async () => {
    const t = fakeIo();
    expect(await main(['convert', join(dir, 'report.pdf'), '-p', '2', '-f', 'docx', '-o', join(dir, 'p2'), '--json'], t.io)).toBe(EXIT.OK);
    expect(JSON.parse(t.stdout()).pages).toEqual([expect.objectContaining({ page: 2 })]);
  });

  it('refuses to overwrite without --force and overwrites with it', async () => {
    const out = join(dir, 'force');
    expect(await main(['convert', join(dir, 'report.pdf'), '-f', 'odt', '-o', out, '-q'], fakeIo().io)).toBe(EXIT.OK);
    const target = join(out, 'report.odt');
    writeFileSync(target, 'stale');

    const refused = fakeIo();
    expect(await main(['convert', join(dir, 'report.pdf'), '-f', 'odt', '-o', out], refused.io)).toBe(EXIT.USAGE);
    expect(refused.stderr()).toMatch(/report\.odt already exists; use --force to overwrite/);
    expect(readFileSync(target, 'utf8')).toBe('stale');

    const forced = fakeIo();
    expect(await main(['convert', join(dir, 'report.pdf'), '-f', 'odt', '-o', out, '--force'], forced.io)).toBe(EXIT.OK);
    expect(readFileSync(target).subarray(0, 2).toString()).toBe('PK');
    // Not a terminal: a plain line per file instead of the live screen.
    expect(forced.stderr()).toBe(`wrote ${target}\n`);
  });

  describe.skipIf(!fontAvailable(KOREAN.font))('pages needing review', () => {
    beforeAll(async () => {
      // A Korean scan read as English fails the quality gates (unsupported script), and the CLI has no AI to escalate to.
      writeFileSync(join(dir, 'korean.pdf'), await simulateScan(await makeLanguagePdf(KOREAN), 300, 85, 0));
    });

    it('converts anyway and names the pages, exiting 0', async () => {
      const t = fakeIo();
      expect(await main(['convert', join(dir, 'korean.pdf'), '-l', 'eng', '-f', 'docx', '-o', join(dir, 'review')], t.io)).toBe(EXIT.OK);
      expect(t.stderr()).toMatch(/page 1 needs review: /);
    });

    it('exits 3 with --strict', async () => {
      const t = fakeIo();
      expect(await main(['convert', join(dir, 'korean.pdf'), '-l', 'eng', '-f', 'docx', '-o', join(dir, 'strict'), '--strict', '--json'], t.io)).toBe(
        EXIT.NEEDS_REVIEW,
      );
      const summary = JSON.parse(t.stdout());
      expect(summary.pages[0].issues.length).toBeGreaterThan(0);
      expect(existsSync(join(dir, 'strict', 'korean.docx'))).toBe(true);
    });
  });
});
