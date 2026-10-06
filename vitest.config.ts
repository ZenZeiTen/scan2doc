import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

// Tests run against TypeScript sources, so a stale dist/ can never mask a failure.
export default defineConfig({
  resolve: {
    alias: {
      '@scan2doc/core': src('core'),
      '@scan2doc/vision-wasm': src('vision-wasm'),
      '@scan2doc/writer-openxml': src('writer-openxml'),
      '@scan2doc/writer-opendocument': src('writer-opendocument'),
      '@scan2doc/mcp': src('mcp'),
      '@scan2doc/cli': src('cli'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // OCR runs real Tesseract on 300-dpi pages: seconds per page, not milliseconds.
    testTimeout: 120_000,
  },
});
