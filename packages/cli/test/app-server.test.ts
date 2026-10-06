import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { IDRDocument } from '@scan2doc/core';
import { freeStem, main, RecentFiles, safeName, startApp, withDefaultCommand, type App, type AppOptions, type ConvertEvent, type ConvertOptions, type ConvertResult, type Io, type JobView } from '../src/index.js';
import type { Dialogs } from '../src/app/dialogs.js';
import { forgetInstance, rememberInstance, runningInstance } from '../src/app/instance.js';
import { makeFixturePdf, simulateScan } from '../../../test/support/make-pdf.js';

let dir: string;
let pdf: Uint8Array;
let scan: Uint8Array;
const running: App[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scan2doc-app-'));
  pdf = await makeFixturePdf();
  scan = await simulateScan(pdf, 200, 80, 0);
  writeFileSync(join(dir, 'report.pdf'), pdf);
  writeFileSync(join(dir, 'scan.pdf'), scan);
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((a) => a.close()));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const fresh = (name: string) => join(dir, `${name}-${++n}`);

/** Dialogs that answer from a script instead of a person. */
function fakeDialogs(answers: { open?: string[]; save?: string | null; folder?: string | null } = {}): Dialogs & { asked: string[] } {
  const asked: string[] = [];
  return {
    available: true,
    asked,
    openPdfs: async () => (asked.push('open'), answers.open ?? []),
    savePdf: async (name) => (asked.push(`save ${name}`), answers.save ?? null),
    pickFolder: async () => (asked.push('folder'), answers.folder ?? null),
  };
}

async function start(options: Partial<AppOptions> = {}) {
  const app = await startApp({ outDir: fresh('out'), recent: new RecentFiles(fresh('settings')), ...options });
  running.push(app);
  return app;
}

const url = (app: App, path: string) => new URL(path + (path.includes('?') ? '&' : '?') + `t=${app.token}`, app.url).href;
async function call(app: App, method: string, path: string, body?: unknown) {
  const res = await fetch(url(app, path), { method, ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
}
const open = async (app: App, path: string) => (await call(app, 'POST', '/api/open', { path })).body.id as string;

/** Collects events until `done` says stop. */
async function until(app: App, done: (events: any[]) => boolean): Promise<any[]> {
  const res = await fetch(url(app, '/api/events'));
  const reader = res.body!.getReader();
  const events: any[] = [];
  let buffer = '';
  const deadline = Date.now() + 90_000;
  try {
    while (Date.now() < deadline) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buffer += Buffer.from(value).toString('utf8');
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (chunk.startsWith('data: ')) events.push(JSON.parse(chunk.slice(6)));
        if (done(events)) return events;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  throw new Error(`events never matched: ${JSON.stringify(events.slice(-3))}`);
}
const job = async (app: App, id: string) =>
  (await until(app, (ev) => ev.some((e) => e.type === 'job' && e.job.id === id && (e.job.status === 'done' || e.job.status === 'failed')))).filter((e) => e.type === 'job' && e.job.id === id).at(-1)!.job as JobView;

function raw(app: App, path: string, host: string): Promise<number> {
  const { port } = new URL(app.url);
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on('error', reject)
      .end();
  });
}

describe('helpers', () => {
  it('names files safely and never over existing ones', () => {
    expect(safeName('../../evil.pdf')).toBe('evil.pdf');
    expect(safeName('C:\\x\\a<b>:c?.pdf')).toBe('a_b__c_.pdf');
    expect(safeName('...')).toBe('document');
    const out = fresh('stems');
    mkdirSync(out);
    writeFileSync(join(out, 'scan.docx'), '');
    writeFileSync(join(out, 'scan (2).odt'), '');
    expect(freeStem(out, 'scan', ['docx', 'odt'])).toBe('scan (3)');
    expect(freeStem(out, 'scan', ['odt'])).toBe('scan');
  });

  it('opens the app on a double-click', () => {
    expect(withDefaultCommand([])).toEqual(['ui', '--launched']);
    expect(withDefaultCommand(['convert', 'a.pdf'])).toEqual(['convert', 'a.pdf']);
  });

  it('remembers recent files, newest first, and forgets missing ones', () => {
    const recent = new RecentFiles(fresh('recent'));
    recent.add(join(dir, 'report.pdf'), 1);
    recent.add(join(dir, 'scan.pdf'), 2);
    recent.add(join(dir, 'gone.pdf'), 3);
    recent.add(join(dir, 'REPORT.pdf'), 4);
    expect(recent.list().map((r) => [r.name, r.openedAt])).toEqual([
      ['REPORT.pdf', 4],
      ['scan.pdf', 2],
    ]);
  });

  it('finds a running app, and not a stale note', async () => {
    const settings = fresh('instance');
    const app = await start();
    rememberInstance(app.url, settings);
    expect(await runningInstance(settings)).toBe(app.url);
    await app.close();
    running.splice(running.indexOf(app), 1);
    expect(await runningInstance(settings)).toBe(null);
    forgetInstance(app.url, settings);
    expect(await runningInstance(settings)).toBe(null);
  });

  it('does not mistake another program on the old port for the app', async () => {
    const settings = fresh('instance');
    const other = await start();
    // The note's token is stale: whatever answers on that port refuses it.
    rememberInstance(other.url.replace(/t=.*/, 't=stale-token'), settings);
    expect(await runningInstance(settings)).toBe(null);
  });
});

describe('security', () => {
  it('answers only with the token and a loopback Host', async () => {
    const app = await start();
    const { port } = new URL(app.url);
    expect(await raw(app, `/?t=${app.token}`, `127.0.0.1:${port}`)).toBe(200);
    expect(await raw(app, `/api/state?t=${app.token}`, `localhost:${port}`)).toBe(200);
    expect(await raw(app, `/?t=${app.token}`, `attacker.example:${port}`)).toBe(403);
    expect(await raw(app, '/api/state', `127.0.0.1:${port}`)).toBe(403);
    expect(await raw(app, `/api/state?t=${app.token}x`, `127.0.0.1:${port}`)).toBe(403);
  });

  it('serves a self-contained page with a strict content policy', async () => {
    const app = await start();
    const res = await fetch(app.url);
    const html = await res.text();
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(html).toContain('<title>Scan2Doc</title>');
    // Only the SVG namespace (inside the data: icon) looks like a URL; nothing is fetched elsewhere.
    expect((html.match(/https?:\/\/[^'"\s)]+/g) ?? []).filter((u) => !u.startsWith('http://www.w3.org/2000/svg'))).toEqual([]);
    // The page's script parses.
    expect(() => new Function(/<script>([\s\S]*)<\/script>/.exec(html)![1]!)).not.toThrow();
  });

  it('refuses what is not a PDF, and shows only files it made', async () => {
    const app = await start({ reveal: () => {} });
    writeFileSync(join(dir, 'notes.pdf'), 'plain text');
    expect(await call(app, 'POST', '/api/open', { path: join(dir, 'notes.pdf') })).toMatchObject({ status: 400, body: { error: 'notes.pdf is not a PDF.' } });
    expect((await call(app, 'POST', '/api/open', { path: join(dir, 'x.txt') })).status).toBe(400);
    expect((await call(app, 'POST', '/api/reveal', { path: 'C:\\Windows\\system32\\cmd.exe' })).status).toBe(404);
  });
});

describe('documents', () => {
  it('opens files, lists them as recent, and serves pages and search', async () => {
    const app = await start();
    const id = await open(app, join(dir, 'report.pdf'));
    const again = await open(app, join(dir, 'report.pdf'));
    expect(again).toBe(id);
    const state = (await call(app, 'GET', '/api/state')).body;
    expect(state.docs).toEqual([expect.objectContaining({ id, name: 'report.pdf', path: join(dir, 'report.pdf'), dirty: false, rev: 1 })]);
    expect(state.recent.map((r: any) => r.path)).toEqual([join(dir, 'report.pdf')]);
    const page = await fetch(url(app, `/api/docs/${id}/page/0?w=200`));
    expect(page.headers.get('content-type')).toBe('image/jpeg');
    expect((await call(app, 'GET', `/api/docs/${id}/search?q=northern`)).body.hits).toHaveLength(1);
    expect((await call(app, 'GET', `/api/docs/${id}/page/9?w=200`)).status).toBe(400);
    expect((await call(app, 'POST', `/api/docs/${id}/close`)).status).toBe(200);
    expect((await call(app, 'GET', `/api/docs/${id}/search?q=x`)).status).toBe(404);
  });

  it('opens dropped files by upload, and from the file dialog', async () => {
    const dialogs = fakeDialogs({ open: [join(dir, 'report.pdf'), join(dir, 'missing.pdf')] });
    const app = await start({ dialogs });
    const up = await fetch(url(app, '/api/upload?name=Dropped%20scan.pdf'), { method: 'POST', body: scan });
    expect(up.status).toBe(200);
    const picked = (await call(app, 'POST', '/api/open-dialog')).body;
    expect(picked.opened).toHaveLength(1);
    expect(picked.errors).toEqual([expect.objectContaining({ path: join(dir, 'missing.pdf'), needsPassword: false })]);
    const names = (await call(app, 'GET', '/api/state')).body.docs.map((d: any) => [d.name, d.path]);
    expect(names).toEqual([
      ['Dropped scan.pdf', null],
      ['report.pdf', join(dir, 'report.pdf')],
    ]);
  });

  it('tells the window about changes as they happen', async () => {
    const app = await start();
    const seen = until(app, (ev) => ev.some((e) => e.type === 'docs' && e.docs.length === 1) && ev.some((e) => e.type === 'recent' && e.recent.length === 1));
    await new Promise((r) => setTimeout(r, 100));
    await open(app, join(dir, 'report.pdf'));
    expect((await seen).map((e) => e.type)).toEqual(expect.arrayContaining(['docs', 'recent']));
  });

  it('organizes pages, extracts and combines, marking results unsaved', async () => {
    const app = await start();
    const id = await open(app, join(dir, 'report.pdf'));
    const organized = await call(app, 'POST', `/api/docs/${id}/organize`, { pages: [{ source: 1, rotate: 0 }, { source: 0, rotate: 90 }] });
    expect(organized.body.doc).toMatchObject({ dirty: true, rev: 2 });
    // The fixture's page 2 is landscape: first now, upright; page 1 turned on its side.
    expect(organized.body.doc.pages).toEqual([
      { widthPt: 842, heightPt: 595 },
      { widthPt: 842, heightPt: 595 },
    ]);
    expect((await call(app, 'POST', `/api/docs/${id}/organize`, { pages: [] })).status).toBe(400);
    const extracted = (await call(app, 'POST', `/api/docs/${id}/extract`, { pages: [1] })).body.id;
    const combined = (await call(app, 'POST', '/api/combine', { ids: [id, extracted] })).body.id;
    const docs = (await call(app, 'GET', '/api/state')).body.docs;
    expect(docs.map((d: any) => [d.name, d.pages.length, d.dirty])).toEqual([
      ['report.pdf', 2, true],
      ['report (extract).pdf', 1, true],
      ['Combined.pdf', 3, true],
    ]);
    expect(docs.find((d: any) => d.id === combined)).toBeTruthy();
  });

  it('saves in place atomically, and "save as" through the dialog', async () => {
    const folder = fresh('save');
    mkdirSync(folder);
    const original = join(folder, 'mine.pdf');
    writeFileSync(original, pdf);
    const target = join(folder, 'copy.pdf');
    const dialogs = fakeDialogs({ save: target });
    const app = await start({ dialogs });
    const id = await open(app, original);
    await call(app, 'POST', `/api/docs/${id}/organize`, { pages: [{ source: 0, rotate: 0 }] });
    expect((await call(app, 'POST', `/api/docs/${id}/save`)).body).toEqual({ path: original });
    expect((await PDFDocument.load(readFileSync(original))).getPageCount()).toBe(1);
    expect(readFileSync(original).length).toBeGreaterThan(0);
    expect((await call(app, 'POST', `/api/docs/${id}/save-as`)).body).toEqual({ path: target });
    expect(dialogs.asked).toEqual(['save mine.pdf']);
    const doc = (await call(app, 'GET', '/api/state')).body.docs[0];
    expect(doc).toMatchObject({ name: 'copy.pdf', path: target, dirty: false });
    // A cancelled dialog writes nothing.
    const cancel = await start({ dialogs: fakeDialogs({ save: null }) });
    const other = (await (await fetch(url(cancel, '/api/upload?name=new.pdf'), { method: 'POST', body: pdf })).json()).id;
    expect((await call(cancel, 'POST', `/api/docs/${other}/save`)).body).toEqual({ cancelled: true });
  });
});

describe('tools', () => {
  /** A converter stand-in: writes small files and reports like the real one. */
  const fakeConvert = async (options: ConvertOptions, onEvent: (e: ConvertEvent) => void): Promise<ConvertResult> => {
    onEvent({ type: 'start', file: 'x.pdf', pageCount: 2, dpi: 300 });
    onEvent({ type: 'page', page: 1, sourcePage: 1, stage: 'render' });
    const document = { category: 'document' } as IDRDocument;
    onEvent({ type: 'recognized', document, reports: [] });
    const formats = options.formats === 'auto' ? ['docx' as const] : options.formats;
    const outputs = formats.map((format) => {
      const path = join(options.outDir!, `${options.input.replace(/^.*[\\/]/, '').replace(/\.pdf$/, '')}.${format}`);
      writeFileSync(path, 'PK fake');
      onEvent({ type: 'written', format, path, bytes: 7 });
      return { format, path, bytes: 7 };
    });
    return { document, reports: [], outputs, seconds: 0.01 };
  };

  it('exports next to the PDF, never over an existing file, and can show the result', async () => {
    const folder = fresh('export');
    mkdirSync(folder);
    writeFileSync(join(folder, 'report.pdf'), pdf);
    writeFileSync(join(folder, 'report.docx'), 'mine');
    const shown: string[] = [];
    const app = await start({ convert: fakeConvert, reveal: (p) => shown.push(p) });
    const id = await open(app, join(folder, 'report.pdf'));
    const started = await call(app, 'POST', `/api/docs/${id}/export`, { formats: 'docx,odt' });
    expect(started.status).toBe(202);
    const done = await job(app, started.body.job);
    expect(done).toMatchObject({ status: 'done', kind: 'export' });
    expect(done.outputs.map((o) => o.name)).toEqual(['report (2).docx', 'report (2).odt']);
    expect(readFileSync(join(folder, 'report.docx'), 'utf8')).toBe('mine');
    expect((await call(app, 'POST', '/api/reveal', { path: done.outputs[0]!.path })).status).toBe(200);
    expect(shown).toEqual([join(folder, 'report (2).docx')]);
    expect((await call(app, 'POST', `/api/docs/${id}/export`, { formats: 'doc' })).status).toBe(400);
  });

  it('makes a scan searchable as a new, unsaved document', async () => {
    const app = await start();
    const id = await open(app, join(dir, 'scan.pdf'));
    expect((await call(app, 'GET', `/api/docs/${id}/search?q=northern`)).body.hits).toEqual([]);
    const done = await job(app, (await call(app, 'POST', `/api/docs/${id}/ocr`, { lang: 'eng' })).body.job);
    expect(done.status).toBe('done');
    const result = (await call(app, 'GET', '/api/state')).body.docs.find((d: any) => d.id === done.resultDocId);
    expect(result).toMatchObject({ name: 'scan (searchable).pdf', dirty: true, path: null });
    expect((await call(app, 'GET', `/api/docs/${done.resultDocId}/search?q=northern markets`)).body.hits).toHaveLength(1);
  });

  it('splits and exports page images into a chosen folder', async () => {
    const app = await start();
    const id = await open(app, join(dir, 'report.pdf'));
    const folder = fresh('parts');
    const parts = await job(app, (await call(app, 'POST', `/api/docs/${id}/split`, { mode: 'every', every: 1, folder })).body.job);
    expect(parts.outputs.map((o) => o.name)).toEqual(['report - page 1.pdf', 'report - page 2.pdf']);
    expect((await call(app, 'POST', `/api/docs/${id}/split`, { mode: 'every', every: 5 })).status).toBe(400);
    expect((await call(app, 'POST', `/api/docs/${id}/split`, { mode: 'ranges', ranges: '1-3' })).status).toBe(400);
    const images = await job(app, (await call(app, 'POST', `/api/docs/${id}/images`, { format: 'png', dpi: 50, pages: '2', folder })).body.job);
    expect(images.outputs.map((o) => o.name)).toEqual(['report - page 2.png']);
    const png = readFileSync(join(folder, 'report - page 2.png'));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(Math.floor((842 / 72) * 50));
  });

  it('reports a failed job and keeps going', async () => {
    let calls = 0;
    const app = await start({
      convert: async (o, e) => {
        if (calls++ === 0) throw new Error('disk full');
        return fakeConvert(o, e);
      },
    });
    const id = await open(app, join(dir, 'report.pdf'));
    const first = (await call(app, 'POST', `/api/docs/${id}/export`, { formats: 'docx', folder: fresh('fail') })).body.job;
    const second = (await call(app, 'POST', `/api/docs/${id}/export`, { formats: 'odt', folder: fresh('fail') })).body.job;
    expect(await job(app, first)).toMatchObject({ status: 'failed', error: 'disk full' });
    expect((await job(app, second)).status).toBe('done');
  });
});

describe('lifetime', () => {
  it('quits after its last window closes', async () => {
    let quit = 0;
    const app = await start({ idleQuitMs: 200, onQuit: () => quit++ });
    const res = await fetch(url(app, '/api/events'));
    const reader = res.body!.getReader();
    await reader.read();
    await new Promise((r) => setTimeout(r, 400));
    expect(quit).toBe(0);
    await reader.cancel();
    await expect.poll(() => quit, { timeout: 3000 }).toBe(1);
  });

  it('a reload within the grace period keeps it running', async () => {
    let quit = 0;
    const app = await start({ idleQuitMs: 600, onQuit: () => quit++ });
    const first = (await fetch(url(app, '/api/events'))).body!.getReader();
    await first.read();
    await first.cancel();
    const second = (await fetch(url(app, '/api/events'))).body!.getReader();
    await second.read();
    await new Promise((r) => setTimeout(r, 900));
    expect(quit).toBe(0);
    await second.cancel();
  });

  it('runs as `scan2doc ui` and stops on request', async () => {
    const err: string[] = [];
    const sink = (s: string[]) => ({ isTTY: false, write: (t: string) => (s.push(t), true) }) as unknown as NodeJS.WriteStream;
    const io: Io = { stdout: sink([]), stderr: sink(err), env: {} };
    expect(await main(['ui', '--no-open', '-o', fresh('cli')], io)).toBe(undefined);
    const address = /running at (http:\/\/127\.0\.0\.1:\d+\/\?t=\S+)/.exec(err.join(''))![1]!;
    expect((await fetch(address)).status).toBe(200);
    await fetch(new URL(`/api/quit?t=${new URL(address).searchParams.get('t')}`, address), { method: 'POST' });
    await expect.poll(async () => fetch(address).then(() => 'up', () => 'down')).toBe('down');
    expect(err.join('')).toContain('Scan2Doc stopped.');
    expect(existsSync(fresh('cli'))).toBe(false);
  });
});
