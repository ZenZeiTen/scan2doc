// Builds the standalone scan2doc executables: no Node, Python or Tesseract needed on the target.
//
//   node scripts/compile-binary.js [--targets win-x64,linux-x64] [--languages all|eng,ind,...] [--allow-download] [--bundle-only]
//
// 1. esbuild bundles the CLI and every dependency into dist/bundle.mjs.
// 2. The bundle, PDFium, both Tesseract builds and the language models become
//    Node single-executable-application (SEA) assets.
// 3. A small CommonJS bootstrap is the SEA entry: Node 24 runs only CommonJS as
//    the SEA main script, while Ink's layout engine needs top-level await (ES
//    modules only). The bootstrap caches the bundle in a per-user directory,
//    checks its hash, and import()s it.
// 4. node --experimental-sea-config makes the blob; postject injects it into a
//    Node binary per target. Targets other than the host need that platform's
//    Node binary, downloaded from nodejs.org only with --allow-download and
//    verified against the release's SHASUMS256.txt.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(root, 'package.json'));
const dist = join(root, 'dist');
const out = join(dist, 'bin');
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const NODE_VERSION = process.versions.node;
const HOST = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;

// ---------- arguments ----------
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  const i = args.indexOf(`--${name}`);
  return hit ? hit.slice(name.length + 3) : i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const TARGETS = { 'win-x64': { file: 'scan2doc-win-x64.exe' }, 'linux-x64': { file: 'scan2doc-linux-x64' } };
const targets = value('targets', 'win-x64,linux-x64').split(',').map((t) => t.trim());
for (const t of targets) if (!TARGETS[t]) throw new Error(`unknown target ${t} (known: ${Object.keys(TARGETS).join(', ')})`);

/** Language codes Scan2Doc ships, read from the core language table. */
const allLanguages = [...readFileSync(join(root, 'packages/core/src/languages.ts'), 'utf8').matchAll(/lang\('([a-z_]+)'/g)].map((m) => m[1]);
const langArg = value('languages', 'all');
const languages = langArg === 'all' ? allLanguages : langArg.split(',').map((s) => s.trim());
for (const l of languages) if (!allLanguages.includes(l)) throw new Error(`unknown language ${l}`);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const step = (msg) => console.log(`\n» ${msg}`);

// ---------- 1. bundle ----------
step('bundling the CLI (esbuild → dist/bundle.mjs)');
const src = (pkg) => join(root, 'packages', pkg, 'src', 'index.ts');
mkdirSync(out, { recursive: true });
const bundled = await build({
  entryPoints: [join(root, 'packages/cli/src/bin.ts')],
  outfile: join(dist, 'bundle.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  jsx: 'automatic',
  minifyWhitespace: true,
  minifySyntax: true,
  legalComments: 'none',
  metafile: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: {
    '@scan2doc/core': src('core'),
    '@scan2doc/vision-wasm': src('vision-wasm'),
    '@scan2doc/writer-openxml': src('writer-openxml'),
    '@scan2doc/writer-opendocument': src('writer-opendocument'),
    '@scan2doc/mcp': src('mcp'),
  },
  // Ink reaches its devtools bridge only when DEV=true, but bundling inlines that module and its
  // static `import 'react-devtools-core'` would then run on every start. A stub keeps it out.
  plugins: [
    {
      name: 'stub-react-devtools',
      setup(b) {
        b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default { initialize() {}, connectToDevTools() {} };', loader: 'js' }));
      },
    },
  ],
  // CommonJS dependencies inside an ES module bundle still call require() and use __dirname.
  banner: {
    js: [
      "import { createRequire as __s2dRequire } from 'node:module';",
      "import { fileURLToPath as __s2dPath } from 'node:url';",
      "import { dirname as __s2dDir } from 'node:path';",
      'const require = __s2dRequire(import.meta.url);',
      'const __filename = __s2dPath(import.meta.url);',
      'const __dirname = __s2dDir(__filename);',
    ].join('\n'),
  },
  logLevel: 'warning',
});
const bundle = readFileSync(join(dist, 'bundle.mjs'));
console.log(`  bundle.mjs ${mb(bundle.length)}`);
// --bundle-only: just dist/bundle.mjs, which `node dist/bundle.mjs ui` runs from the repo (assets from node_modules).
if (flag('bundle-only')) process.exit(0);

// ---------- 2. assets ----------
step(`collecting assets (${languages.length} language${languages.length === 1 ? '' : 's'})`);
/** A package's directory. Looked up on disk: some packages' export maps hide their package.json from require.resolve. */
const pkgDir = (name) => {
  const direct = join(root, 'node_modules', name);
  return existsSync(join(direct, 'package.json')) ? direct : dirname(require.resolve(`${name}/package.json`));
};
const assets = {
  'app.mjs': join(dist, 'bundle.mjs'),
  'pdfium.wasm': join(dirname(require.resolve('@hyzyla/pdfium')), 'pdfium.wasm'),
  'tesseract-core.wasm': require.resolve('tesseract.js-core/tesseract-core-simd-lstm.wasm'),
  'tesseract-core-osd.wasm': require.resolve('tesseract.js-core/tesseract-core-simd.wasm'),
  'osd.traineddata.gz': join(pkgDir('@tesseract.js-data/osd'), '4.0.0_best_int', 'osd.traineddata.gz'),
};
for (const l of languages) assets[`${l}.traineddata.gz`] = join(pkgDir(`@tesseract.js-data/${l}`), '4.0.0_best_int', `${l}.traineddata.gz`);
let assetBytes = 0;
for (const [key, file] of Object.entries(assets)) {
  if (!existsSync(file)) throw new Error(`asset ${key} not found at ${file}`);
  if (key.endsWith('.gz')) gunzipSync(readFileSync(file)); // fail the build on a corrupt model, not the user's run
  assetBytes += statSync(file).size;
}
console.log(`  ${Object.keys(assets).length} assets, ${mb(assetBytes)}`);

// ---------- 3. bootstrap ----------
step('writing the SEA bootstrap');
writeFileSync(
  join(dist, 'sea-boot.cjs'),
  `// SEA entry (CommonJS). Extracts the ES module app to a per-user cache, verifies it, imports it.
const { getAsset } = require('node:sea');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const code = Buffer.from(getAsset('app.mjs'));
const hash = createHash('sha256').update(code).digest('hex');
// Per user, never the shared temp directory: another account must not be able to plant the code we run.
const base = process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
const dir = path.join(base, 'scan2doc', 'app-' + hash.slice(0, 16));
const file = path.join(dir, 'app.mjs');
const intact = () => { try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') === hash; } catch { return false; } };
if (!intact()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid;
  fs.writeFileSync(tmp, code, { mode: 0o600 });
  try { fs.renameSync(tmp, file); } catch { fs.rmSync(tmp, { force: true }); }
  if (!intact()) { console.error('scan2doc: could not prepare its program files in ' + dir); process.exit(1); }
}
import(pathToFileURL(file).href).catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1); });
`,
);

// ---------- 4. blob ----------
step(`building the SEA blob with Node ${NODE_VERSION}`);
// Paths relative to dist/ (the blob is built there): Node stores the main script's path in the
// executable, and an absolute one would publish the build machine's folders and user name.
const seaConfig = {
  main: 'sea-boot.cjs',
  output: 'sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  // Without a V8 code cache the blob is the same for every platform of this Node version.
  useCodeCache: false,
  assets,
};
writeFileSync(join(dist, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { stdio: 'inherit', cwd: dist });
const blob = readFileSync(join(dist, seaConfig.output));

// ---------- 5. targets ----------
const cacheDir = join(process.env.LOCALAPPDATA || process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'scan2doc-build', `node-v${NODE_VERSION}`);

/** Reads one file out of a .tar (ustar) archive. */
function untarOne(tar, wanted) {
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, len) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    const name = (field(345, 155) ? `${field(345, 155)}/` : '') + field(0, 100);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    if (name === wanted) return tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} not found in the archive`);
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${url} (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** The Node binary to inject into: the running one for the host, otherwise a verified download. */
async function baseBinary(target) {
  if (target === HOST) return process.execPath;
  const cached = join(cacheDir, target, target.startsWith('win') ? 'node.exe' : 'node');
  if (existsSync(cached)) return cached;
  const dir = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const archive = target.startsWith('win') ? `${target}/node.exe` : `node-v${NODE_VERSION}-${target}.tar.gz`;
  if (!flag('allow-download')) {
    throw new Error(`target ${target} needs ${dir}/${archive} (the Node ${NODE_VERSION} runtime for ${target}); rerun with --allow-download to fetch and verify it`);
  }
  console.log(`  downloading ${dir}/${archive}`);
  const bytes = await download(`${dir}/${archive}`);
  const sums = (await download(`${dir}/SHASUMS256.txt`)).toString('utf8');
  const expected = sums.split('\n').find((l) => l.trim().endsWith(` ${archive}`))?.split(/\s+/)[0];
  if (!expected || expected !== sha256(bytes)) throw new Error(`checksum mismatch for ${archive}: refusing to use it`);
  console.log(`  verified sha256 ${expected.slice(0, 16)}… against SHASUMS256.txt`);
  const binary = target.startsWith('win') ? bytes : untarOne(gunzipSync(bytes), `node-v${NODE_VERSION}-${target}/bin/node`);
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, binary);
  return cached;
}

const { inject } = require('postject');
const sums = [];
for (const target of targets) {
  step(`target ${target}`);
  const file = join(out, TARGETS[target].file);
  rmSync(file, { force: true });
  copyFileSync(await baseBinary(target), file);
  await inject(file, 'NODE_SEA_BLOB', blob, { sentinelFuse: SENTINEL, overwrite: true });
  if (!target.startsWith('win')) chmodSync(file, 0o755);
  const bytes = readFileSync(file);
  sums.push(`${sha256(bytes)}  ${basename(file)}`);
  console.log(`  ${file} ${mb(bytes.length)}`);
}
writeFileSync(join(out, 'SHA256SUMS.txt'), `${sums.join('\n')}\n`);

// ---------- 6. third-party notices ----------
const packages = new Map();
for (const input of Object.keys(bundled.metafile.inputs)) {
  const m = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input);
  if (m) packages.set(m[1].replace(/\\/g, '/'), true);
}
for (const extra of ['@hyzyla/pdfium', 'tesseract.js-core', '@tesseract.js-data/osd', ...languages.map((l) => `@tesseract.js-data/${l}`)]) packages.set(extra, true);
const notices = [...packages.keys()].sort().map((name) => {
  const dir = pkgDir(name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const licenseFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying)/i.test(f));
  const text = licenseFile ? readFileSync(join(dir, licenseFile), 'utf8').trim() : `License: ${pkg.license ?? 'see package'}`;
  return `${name} ${pkg.version} (${pkg.license ?? 'unknown'})\n${'-'.repeat(60)}\n${text}\n`;
});
writeFileSync(join(out, 'THIRD_PARTY_NOTICES.txt'), `scan2doc bundles the following software:\n\n${notices.join('\n')}`);
console.log(`\n✓ done: ${targets.map((t) => TARGETS[t].file).join(', ')} in ${out} (+ SHA256SUMS.txt, THIRD_PARTY_NOTICES.txt for ${packages.size} packages)`);
