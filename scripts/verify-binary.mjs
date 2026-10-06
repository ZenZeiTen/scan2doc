// Checks the built Windows executable the way a user's machine would run it: from an empty
// directory, with no Node.js on PATH and no node_modules anywhere near.
//
//   node scripts/verify-binary.mjs [dist/bin/scan2doc-win-x64.exe]
//
// Needs the sample PDFs in .samples/mcp (written by the test suite's sample step).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const exe = process.argv[2] ?? join(root, 'dist/bin/scan2doc-win-x64.exe');
const samples = join(root, '.samples/mcp');
const pdfs = ['report-digital.pdf', 'report-scan.pdf', 'japanese.pdf', 'indonesian.pdf'];
for (const f of [exe, ...pdfs.map((p) => join(samples, p))]) if (!existsSync(f)) throw new Error(`missing ${f}`);

const dir = mkdtempSync(join(tmpdir(), 'scan2doc-verify-'));
for (const f of [exe, ...pdfs.map((p) => join(samples, p))]) copyFileSync(f, join(dir, basename(f)));
const windir = process.env.SystemRoot ?? 'C:\\Windows';
// Only the OS on PATH: no Node, no npm, no Python.
const env = { SystemRoot: windir, PATH: `${windir}\\System32;${windir}`, LOCALAPPDATA: process.env.LOCALAPPDATA, TEMP: process.env.TEMP, TMP: process.env.TMP };
const run = (...args) => {
  const t = performance.now();
  const r = spawnSync(join(dir, basename(exe)), args, { cwd: dir, env, encoding: 'utf8', timeout: 600_000 });
  return { ...r, seconds: (performance.now() - t) / 1000 };
};

let failures = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

console.log(`Verifying ${exe} in ${dir} (PATH: ${env.PATH})`);
const where = spawnSync('where', ['node'], { env, encoding: 'utf8', shell: true });
check('node.exe is not reachable on PATH', where.status !== 0);

const version = run('--version');
check('--version', version.status === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()), version.stdout.trim() || version.stderr.slice(0, 300));

const langs = run('languages');
check('languages lists 27', langs.status === 0 && langs.stdout.trim().split('\n').length === 27, `${langs.stdout.trim().split('\n').length} lines`);

const cases = [
  { pdf: 'report-digital.pdf', args: ['-f', 'docx', 'odt'], expect: { source: 'pdf', language: 'en', outputs: ['docx', 'odt'] } },
  { pdf: 'report-scan.pdf', args: ['-f', 'xlsx', 'pptx', 'ods', 'odp'], expect: { source: 'ocr', language: 'en', outputs: ['xlsx', 'pptx', 'ods', 'odp'] } },
  { pdf: 'japanese.pdf', args: ['--text-layer', 'ignore'], expect: { source: 'ocr', language: 'ja', outputs: ['docx'] } },
  { pdf: 'indonesian.pdf', args: [], expect: { source: 'pdf', language: 'id', outputs: ['docx'] } },
];
for (const c of cases) {
  const r = run('convert', c.pdf, ...c.args, '--json');
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    check(`convert ${c.pdf}`, false, `exit ${r.status}: ${r.stderr.slice(0, 400)}`);
    continue;
  }
  const sources = [...new Set(j.pages.map((p) => p.textSource))].join('/');
  const okFiles = j.outputs.every((o) => existsSync(o.path) && readFileSync(o.path).subarray(0, 2).toString() === 'PK');
  check(
    `convert ${c.pdf} ${c.args.join(' ')}`.trim(),
    r.status === 0 && sources === c.expect.source && j.language === c.expect.language && okFiles && j.outputs.map((o) => o.format).join() === c.expect.outputs.join(),
    `${r.seconds.toFixed(1)} s, ${j.pages.length} page(s), text from ${sources}, language ${j.language}, wrote ${j.outputs.map((o) => basename(o.path)).join(' ')}`,
  );
}

const again = run('convert', 'report-digital.pdf', '-f', 'docx');
check('refuses to overwrite without --force', again.status === 2 && /already exists/.test(again.stderr), again.stderr.trim().slice(0, 120));

const bad = run('convert', 'nope.pdf');
check('missing input fails cleanly (exit 1)', bad.status === 1 && /nope\.pdf/.test(bad.stderr), bad.stderr.trim().slice(0, 120));

rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nAll binary checks passed');
process.exit(failures ? 1 : 0);
