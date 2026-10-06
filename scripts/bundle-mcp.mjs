// Bundles the MCP server into one file: dist/scan2doc-mcp.mjs.
// Workspace packages are compiled in from source (the repo cannot link them,
// see pnpm-workspace.yaml); npm dependencies stay external and load from
// node_modules. Stage 4's single-executable build replaces this.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const src = (pkg) => fileURLToPath(new URL(`../packages/${pkg}/src/index.ts`, import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL('../packages/mcp/src/bin.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/scan2doc-mcp.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  alias: {
    '@scan2doc/core': src('core'),
    '@scan2doc/vision-wasm': src('vision-wasm'),
    '@scan2doc/writer-openxml': src('writer-openxml'),
    '@scan2doc/writer-opendocument': src('writer-opendocument'),
  },
  sourcemap: true,
  logLevel: 'info',
});
