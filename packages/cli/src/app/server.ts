import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { encode as encodePng } from 'fast-png';
import { LANGUAGES } from '@scan2doc/core';
import { scanToIdr, type AssetSource } from '@scan2doc/vision-wasm';
import { FORMATS, parseFormats, parseLanguages, parsePages, type OutputFormat } from '../args.js';
import { runConvert, type ConvertEvent, type ConvertOptions, type ConvertResult } from '../convert.js';
import { VERSION } from '../version.js';
import { noDialogs, type Dialogs } from './dialogs.js';
import { bgraToJpeg, bgraToRgb, DocumentStore, viewOf, type OpenDoc } from './docs.js';
import { combine, everyN, rangeGroups, rebuild, split, type PageEdit } from './pdfops.js';
import { RecentFiles } from './recent.js';
import { makeSearchable } from './searchable.js';
import { renderApp } from './ui/page.js';

export type JobKind = 'export' | 'ocr' | 'split' | 'images';

/** A background task, as the window sees it. */
export interface JobView {
  id: string;
  kind: JobKind;
  docId: string;
  title: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress?: { done: number; total: number; text: string };
  outputs: { name: string; path: string; bytes: number }[];
  /** A document the job opened (the searchable PDF). */
  resultDocId?: string;
  notes: string[];
  error?: string;
  seconds?: number;
}

export interface AppOptions {
  /** Where files go when a document has no folder of its own (dropped into the window). */
  outDir: string;
  port?: number;
  dialogs?: Dialogs;
  recent?: RecentFiles;
  assets?: AssetSource;
  /** Replaced in tests. */
  convert?: (options: ConvertOptions, onEvent: (e: ConvertEvent) => void) => Promise<ConvertResult>;
  reveal?: (path: string) => void;
  onQuit?: () => void;
  /** Quit this long after the last window closed (no open event stream); off when absent. */
  idleQuitMs?: number;
}

export interface App {
  url: string;
  token: string;
  store: DocumentStore;
  close(): Promise<void>;
}

const MAX_UPLOAD = 512 * 1024 * 1024;
const MAX_JSON = 1024 * 1024;
const STAGES: Record<string, string> = { render: 'rendering', layout: 'analysing layout', ocr: 'reading text', tables: 'reading tables', escalate: 'checking' };

/** `stem`, or `stem (2)`, `stem (3)`… : the first whose files would all be new. */
export function freeStem(folder: string, stem: string, extensions: readonly string[]): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? stem : `${stem} (${n})`;
    if (extensions.every((ext) => !existsSync(join(folder, `${candidate}.${ext}`)))) return candidate;
  }
}

/** A file name made safe to write: no folders, no characters Windows refuses. */
export function safeName(raw: string, fallback = 'document'): string {
  const base = basename(raw.replace(/\\/g, '/'))
    // basename() has already dropped any folders; these are the characters Windows refuses in a name.
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .trim()
    .replace(/^\.+/, '');
  return base.slice(0, 140) || fallback;
}

const stemOf = (name: string) => safeName(name).replace(/\.pdf$/i, '') || 'document';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Writes beside the target, then swaps it in: a failed save never leaves half a file. */
async function writeAtomic(path: string, bytes: Uint8Array): Promise<void> {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(temp, bytes);
  try {
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(code === 'EBUSY' || code === 'EPERM' ? `${basename(path)} is open in another program; close it there and save again.` : (err as Error).message);
  }
}

/**
 * The Scan2Doc app: its page and a JSON API on 127.0.0.1. Every request must
 * carry the per-run token and a loopback Host header, so neither other web
 * pages nor other programs can drive it.
 */
export async function startApp(options: AppOptions): Promise<App> {
  const token = randomBytes(18).toString('base64url');
  const dialogs = options.dialogs ?? noDialogs;
  const recent = options.recent ?? new RecentFiles();
  const store = new DocumentStore(options.assets);
  const convert = options.convert ?? runConvert;
  const work = await mkdtemp(join(tmpdir(), 'scan2doc-app-'));
  const jobs = new Map<string, JobView>();
  /** Files the app wrote or opened: the only ones "Show in folder" may point at. */
  const known = new Set<string>();
  const listeners = new Set<ServerResponse>();
  let queue: Promise<void> = Promise.resolve();
  let idleTimer: NodeJS.Timeout | undefined;
  let port = 0;

  const emit = (event: unknown) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of listeners) res.write(line);
  };
  const emitDocs = () => emit({ type: 'docs', docs: store.list().map(viewOf) });
  const emitJob = (job: JobView) => emit({ type: 'job', job });
  const emitRecent = () => emit({ type: 'recent', recent: recent.list() });

  /** Default folder for a document's outputs: its own folder, else the app's. */
  const folderOf = (doc: OpenDoc) => (doc.path ? dirname(doc.path) : options.outDir);

  async function openPath(path: string, password?: string) {
    if (!/\.pdf$/i.test(path)) throw new HttpError(400, `${basename(path)} is not a PDF.`);
    const already = store.list().find((d) => d.path && d.path.toLowerCase() === path.toLowerCase());
    if (already) return already;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path));
    } catch (err) {
      recent.remove(path);
      emitRecent();
      throw new HttpError(404, `${basename(path)} could not be opened: ${(err as NodeJS.ErrnoException).code === 'ENOENT' ? 'it no longer exists' : (err as Error).message}`);
    }
    const doc = await openBytes(bytes, basename(path), path, password);
    recent.add(path);
    known.add(path);
    emitRecent();
    return doc;
  }

  async function openBytes(bytes: Uint8Array, name: string, path?: string, password?: string) {
    if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') throw new HttpError(400, `${name} is not a PDF.`);
    try {
      const doc = await store.open(bytes, name, path, password);
      emitDocs();
      return doc;
    } catch (err) {
      const message = (err as Error).message;
      if (/password/i.test(message)) throw new HttpError(401, password ? 'That password is not right.' : `${name} is protected by a password.`);
      throw new HttpError(400, message);
    }
  }

  function addJob(kind: JobKind, doc: OpenDoc, title: string, work: (job: JobView) => Promise<void>): JobView {
    const job: JobView = { id: randomBytes(6).toString('hex'), kind, docId: doc.id, title, status: 'queued', outputs: [], notes: [] };
    jobs.set(job.id, job);
    emitJob(job);
    queue = queue.then(async () => {
      const started = performance.now();
      job.status = 'running';
      emitJob(job);
      try {
        await work(job);
        job.status = 'done';
      } catch (err) {
        job.status = 'failed';
        job.error = (err as Error).message;
      }
      job.progress = undefined;
      job.seconds = Number(((performance.now() - started) / 1000).toFixed(1));
      emitJob(job);
    });
    return job;
  }

  function output(job: JobView, path: string, bytes: number) {
    known.add(path);
    job.outputs.push({ name: basename(path), path, bytes });
    emitJob(job);
  }

  /** The folder a request asked for, or the document's own; created if missing. */
  async function folderFor(doc: OpenDoc, asked: unknown): Promise<string> {
    const folder = typeof asked === 'string' && asked.trim() ? asked.trim() : folderOf(doc);
    await mkdir(folder, { recursive: true });
    return folder;
  }

  // ---------- jobs ----------

  function exportJob(doc: OpenDoc, body: Record<string, unknown>) {
    const formats = parseFormats([String(body.formats ?? 'auto')]);
    const languages = parseLanguages(String(body.lang ?? 'auto'));
    const pages = typeof body.pages === 'string' && body.pages.trim() ? parsePages(body.pages) : undefined;
    return addJob('export', doc, `Export ${doc.name}`, async (job) => {
      const folder = await folderFor(doc, body.folder);
      const stem = freeStem(folder, stemOf(doc.name), formats === 'auto' ? FORMATS : formats);
      const dir = await mkdtemp(join(work, 'export-'));
      const input = join(dir, `${stem}.pdf`);
      await writeFile(input, doc.bytes);
      try {
        await convert({ input, formats, outDir: folder, languages, ...(pages && { pages }), ...(doc.password && { password: doc.password }) }, (e) => {
          if (e.type === 'start') job.progress = { done: 0, total: e.pageCount, text: 'Starting' };
          else if (e.type === 'page' && job.progress) {
            job.progress = { done: e.stage === 'render' ? e.page : job.progress.done, total: job.progress.total, text: `Page ${e.sourcePage + 1}: ${STAGES[e.stage] ?? e.stage}` };
          } else if (e.type === 'recognized') {
            job.progress = { done: job.progress?.total ?? 0, total: job.progress?.total ?? 0, text: 'Writing files' };
            for (const r of e.reports) if (r.quality.issues.length) job.notes.push(`Page ${r.sourcePage + 1} may need a check: ${r.quality.issues.map((i) => i.detail).join('; ')}`);
          } else if (e.type === 'written') return output(job, e.path, e.bytes);
          emitJob(job);
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  function ocrJob(doc: OpenDoc, body: Record<string, unknown>) {
    const languages = parseLanguages(String(body.lang ?? 'auto'));
    return addJob('ocr', doc, `Recognise text in ${doc.name}`, async (job) => {
      job.progress = { done: 0, total: doc.pages.length, text: 'Starting' };
      const { document, reports } = await scanToIdr(doc.bytes, {
        sourceFile: doc.name,
        languages,
        ...(options.assets && { assets: options.assets }),
        ...(doc.password && { password: doc.password }),
        onProgress: (p) => {
          job.progress = { done: p.stage === 'render' ? p.page : (job.progress?.done ?? 0), total: p.pageCount, text: `Page ${p.sourcePage + 1}: ${STAGES[p.stage] ?? p.stage}` };
          emitJob(job);
        },
      });
      job.progress = { done: doc.pages.length, total: doc.pages.length, text: 'Adding the text layer' };
      emitJob(job);
      const result = await makeSearchable(doc.bytes, document, reports);
      if (result.pagesWithText.length) job.notes.push(`${result.pagesWithText.length === 1 ? 'Page' : 'Pages'} ${result.pagesWithText.join(', ')} already had text and were left as they were.`);
      if (result.linesWithoutFont) job.notes.push(`${result.linesWithoutFont} line(s) were left out: no installed font has their characters.`);
      if (!result.pagesAdded.length) job.notes.push('No page needed recognising: the text was already searchable.');
      const searchable = await store.open(result.bytes, `${stemOf(doc.name)} (searchable).pdf`);
      searchable.dirty = true;
      job.resultDocId = searchable.id;
      emitDocs();
    });
  }

  function splitJob(doc: OpenDoc, body: Record<string, unknown>) {
    const groups = body.mode === 'ranges' ? rangeGroups(String(body.ranges ?? ''), doc.pages.length) : everyN(doc.pages.length, Number(body.every ?? 1));
    if (groups.length < 2 && body.mode !== 'ranges') throw new HttpError(400, 'That would give one file: the PDF is not longer than that.');
    return addJob('split', doc, `Split ${doc.name}`, async (job) => {
      const folder = await folderFor(doc, body.folder);
      const parts = await split(doc.bytes, groups);
      for (const [i, bytes] of parts.entries()) {
        const g = groups[i]!;
        const label = g.length === 1 ? `page ${g[0]! + 1}` : `pages ${g[0]! + 1}-${g.at(-1)! + 1}`;
        const path = join(folder, `${freeStem(folder, `${stemOf(doc.name)} - ${label}`, ['pdf'])}.pdf`);
        await writeFile(path, bytes);
        job.progress = { done: i + 1, total: parts.length, text: `Wrote ${basename(path)}` };
        output(job, path, bytes.length);
      }
    });
  }

  function imagesJob(doc: OpenDoc, body: Record<string, unknown>) {
    const format = body.format === 'jpg' ? 'jpg' : 'png';
    const dpi = Math.min(600, Math.max(36, Number(body.dpi ?? 150) || 150));
    const pages = typeof body.pages === 'string' && body.pages.trim() ? parsePages(body.pages) : doc.pages.map((_, i) => i);
    for (const p of pages) if (p >= doc.pages.length) throw new HttpError(400, `page ${p + 1} does not exist (the PDF has ${doc.pages.length})`);
    return addJob('images', doc, `Export pages of ${doc.name} as ${format.toUpperCase()}`, async (job) => {
      const folder = await folderFor(doc, body.folder);
      for (const [i, p] of pages.entries()) {
        job.progress = { done: i, total: pages.length, text: `Page ${p + 1}` };
        emitJob(job);
        const r = await doc.raster.render(p, dpi);
        const bytes = format === 'jpg' ? bgraToJpeg(r.bgra, r.width, r.height, 90) : encodePng({ width: r.width, height: r.height, data: bgraToRgb(r.bgra, r.width, r.height), channels: 3, depth: 8 });
        const path = join(folder, `${freeStem(folder, `${stemOf(doc.name)} - page ${p + 1}`, [format])}.${format}`);
        await writeFile(path, bytes);
        output(job, path, bytes.length);
      }
    });
  }

  // ---------- requests ----------

  const authorised = (req: IncomingMessage, url: URL) => {
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
    const given = Buffer.from(url.searchParams.get('t') ?? String(req.headers['x-scan2doc-token'] ?? ''));
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    if (Number(req.headers['content-length'] ?? 0) > limit) throw new HttpError(413, 'That file is too large (over 512 MB).');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new HttpError(413, 'That file is too large (over 512 MB).');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = (await readBody(req, MAX_JSON)).toString('utf8');
    if (!raw) return {};
    try {
      const value = JSON.parse(raw) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // fall through
    }
    throw new HttpError(400, 'The request was not understood.');
  }

  /** Opens the file dialog's choices; files that fail are reported, the rest still open. */
  async function openMany(paths: string[]) {
    const opened: string[] = [];
    const errors: { path: string; error: string; needsPassword: boolean }[] = [];
    for (const path of paths) {
      try {
        opened.push((await openPath(path)).id);
      } catch (err) {
        errors.push({ path, error: (err as Error).message, needsPassword: err instanceof HttpError && err.status === 401 });
      }
    }
    return { opened, errors };
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const doc = /^\/api\/docs\/([0-9a-f]{12})(\/.*)?$/.exec(path);

    if (method === 'GET' && path === '/') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:",
      });
      res.end(renderApp());
      return;
    }
    if (method === 'GET' && path === '/api/state') {
      return send(res, 200, {
        version: VERSION,
        platform: process.platform,
        dialogs: dialogs.available,
        outDir: options.outDir,
        languages: LANGUAGES.map((l) => ({ code: l.code, name: l.name })),
        formats: FORMATS,
        recent: recent.list(),
        docs: store.list().map(viewOf),
        jobs: [...jobs.values()],
      });
    }
    if (method === 'GET' && path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      listeners.add(res);
      clearTimeout(idleTimer);
      const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
      req.on('close', () => {
        clearInterval(ping);
        listeners.delete(res);
        if (listeners.size === 0 && options.idleQuitMs !== undefined) idleTimer = setTimeout(() => options.onQuit?.(), options.idleQuitMs);
      });
      return;
    }
    if (method === 'POST' && path === '/api/open-dialog') {
      if (!dialogs.available) throw new HttpError(501, 'File dialogs are only available on Windows; drop files into the window instead.');
      return send(res, 200, await openMany(await dialogs.openPdfs()));
    }
    if (method === 'POST' && path === '/api/open') {
      const body = await json(req);
      const opened = await openPath(String(body.path ?? ''), typeof body.password === 'string' ? body.password : undefined);
      return send(res, 200, { id: opened.id });
    }
    if (method === 'POST' && path === '/api/upload') {
      const name = safeName(url.searchParams.get('name') ?? 'document.pdf');
      const bytes = new Uint8Array(await readBody(req, MAX_UPLOAD));
      const password = req.headers['x-scan2doc-password'];
      const opened = await openBytes(bytes, /\.pdf$/i.test(name) ? name : `${name}.pdf`, undefined, typeof password === 'string' ? decodeURIComponent(password) : undefined);
      return send(res, 200, { id: opened.id });
    }
    if (method === 'POST' && path === '/api/recent/remove') {
      recent.remove(String((await json(req)).path ?? ''));
      emitRecent();
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/api/combine') {
      const ids = (await json(req)).ids;
      if (!Array.isArray(ids)) throw new HttpError(400, 'Choose the documents to combine.');
      const parts = ids.map((id) => store.get(String(id)));
      const combined = await openBytes(await combine(parts.map((p) => p.bytes)), 'Combined.pdf');
      combined.dirty = true;
      emitDocs();
      return send(res, 200, { id: combined.id });
    }
    if (method === 'POST' && path === '/api/pick-folder') {
      if (!dialogs.available) throw new HttpError(501, 'Folder choice is only available on Windows.');
      const body = await json(req);
      return send(res, 200, { path: await dialogs.pickFolder(typeof body.start === 'string' ? body.start : undefined) });
    }
    if (method === 'POST' && path === '/api/reveal') {
      const target = String((await json(req)).path ?? '');
      if (!known.has(target)) throw new HttpError(404, 'Scan2Doc did not make that file.');
      options.reveal?.(target);
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/api/quit') {
      send(res, 200, { ok: true });
      options.onQuit?.();
      return;
    }

    if (doc) {
      const d = store.get(doc[1]!);
      const sub = doc[2] ?? '';
      const page = /^\/page\/(\d+)$/.exec(sub);
      if (method === 'GET' && page) {
        const width = Number(url.searchParams.get('w') ?? 800);
        const image = await store.pageImage(d.id, Number(page[1]), Number.isFinite(width) ? width : 800);
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': image.length, 'cache-control': 'private, max-age=300' });
        res.end(image);
        return;
      }
      if (method === 'GET' && sub === '/search') return send(res, 200, { hits: store.search(d.id, url.searchParams.get('q') ?? '').slice(0, 500) });
      if (method === 'POST' && sub === '/close') {
        store.close(d.id);
        emitDocs();
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && sub === '/organize') {
        const pages = (await json(req)).pages;
        if (!Array.isArray(pages)) throw new HttpError(400, 'No pages were sent.');
        const edits = pages.map((p) => ({ source: Number((p as PageEdit).source), rotate: Number((p as PageEdit).rotate) as PageEdit['rotate'] }));
        await store.replace(d.id, await rebuild(d.bytes, edits), { dirty: true });
        emitDocs();
        return send(res, 200, { doc: viewOf(d) });
      }
      if (method === 'POST' && sub === '/extract') {
        const pages = (await json(req)).pages;
        if (!Array.isArray(pages) || pages.length === 0) throw new HttpError(400, 'Select the pages to extract.');
        const bytes = await rebuild(
          d.bytes,
          pages.map((source) => ({ source: Number(source), rotate: 0 })),
        );
        const extracted = await openBytes(bytes, `${stemOf(d.name)} (extract).pdf`);
        extracted.dirty = true;
        emitDocs();
        return send(res, 200, { id: extracted.id });
      }
      if (method === 'POST' && (sub === '/save' || sub === '/save-as')) {
        let target = sub === '/save' ? d.path : undefined;
        if (!target) {
          if (dialogs.available) {
            target = (await dialogs.savePdf(d.name, d.path ? dirname(d.path) : options.outDir)) ?? undefined;
            if (!target) return send(res, 200, { cancelled: true });
          } else {
            await mkdir(options.outDir, { recursive: true });
            target = join(options.outDir, `${freeStem(options.outDir, stemOf(d.name), ['pdf'])}.pdf`);
          }
        }
        if (!/\.pdf$/i.test(target)) target += '.pdf';
        await writeAtomic(target, d.bytes);
        d.dirty = false;
        d.path = target;
        d.name = basename(target);
        known.add(target);
        recent.add(target);
        emitDocs();
        emitRecent();
        return send(res, 200, { path: target });
      }
      if (method === 'POST' && sub === '/export') return send(res, 202, { job: exportJob(d, await json(req)).id });
      if (method === 'POST' && sub === '/ocr') return send(res, 202, { job: ocrJob(d, await json(req)).id });
      if (method === 'POST' && sub === '/split') return send(res, 202, { job: splitJob(d, await json(req)).id });
      if (method === 'POST' && sub === '/images') return send(res, 202, { job: imagesJob(d, await json(req)).id });
    }
    throw new HttpError(404, 'Not found.');
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    if (!authorised(req, url)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Open Scan2Doc from its own window: this address only works with the link it opened.');
      return;
    }
    route(req, res, url).catch((err: Error) => {
      const status = err instanceof HttpError ? err.status : /no longer open/.test(err.message) ? 404 : /does not exist|not a page range|unknown format|invalid|outside pages|at least|must be/i.test(err.message) ? 400 : 500;
      if (!res.headersSent) send(res, status, { error: err.message });
      else res.destroy();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;
  await mkdir(options.outDir, { recursive: true }).catch(() => {});

  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    token,
    store,
    async close() {
      clearTimeout(idleTimer);
      for (const res of listeners) res.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await queue.catch(() => {});
      store.closeAll();
      await rm(work, { recursive: true, force: true });
    },
  };
}

