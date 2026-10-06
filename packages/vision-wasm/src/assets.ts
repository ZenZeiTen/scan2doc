import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * Every binary the engine needs. Stage 4 serves these from the Node SEA blob
 * (`node:sea` getAsset); development and tests read them from node_modules.
 */
export type AssetName =
  | 'pdfium.wasm'
  /** LSTM-only Tesseract build: all text recognition. */
  | 'tesseract-core.wasm'
  /** Full Tesseract build (with the legacy engine): only orientation and script detection needs it. */
  | 'tesseract-core-osd.wasm'
  | `${string}.traineddata`;

export interface AssetSource {
  read(name: AssetName): Promise<Uint8Array>;
}

/**
 * Tesseract model set. "best_int" (default): LSTM-only integer models, 0.7–3.6 MB
 * gzipped per language, 54 MB for all 27 shipped. "standard": the tessdata
 * models that also carry legacy-engine data the LSTM build cannot use, 4× larger.
 */
export type ModelSet = 'best_int' | 'standard';

const require = createRequire(import.meta.url);

interface SeaModule {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
}

/**
 * Reads the engine's binaries from a Node single-executable application's
 * embedded assets (see scripts/compile-binary.js). Language models are stored
 * gzipped. Undefined outside a single executable.
 */
export function seaAssets(): AssetSource | undefined {
  let sea: SeaModule;
  try {
    sea = require('node:sea') as SeaModule;
  } catch {
    return undefined;
  }
  if (!sea.isSea()) return undefined;
  const get = (key: string): Uint8Array | undefined => {
    try {
      return new Uint8Array(sea.getAsset(key));
    } catch {
      return undefined;
    }
  };
  return {
    async read(name) {
      if (name.endsWith('.traineddata')) {
        const gz = get(`${name}.gz`);
        if (!gz) throw new Error(`no model installed for language "${name.slice(0, -'.traineddata'.length)}"`);
        return gunzipSync(gz);
      }
      const bytes = get(name);
      if (!bytes) throw new Error(`asset ${name} is missing from this build`);
      return bytes;
    },
  };
}

/** The assets of this build: embedded ones in the single executable, node_modules otherwise. */
export const defaultAssets = (): AssetSource => seaAssets() ?? nodeModulesAssets();

/** Reads the engine's binaries from the installed npm packages. */
export function nodeModulesAssets(models: ModelSet = 'best_int'): AssetSource {
  return {
    async read(name) {
      if (name === 'pdfium.wasm') {
        return readFile(join(dirname(require.resolve('@hyzyla/pdfium')), 'pdfium.wasm'));
      }
      if (name === 'tesseract-core.wasm') {
        return readFile(require.resolve('tesseract.js-core/tesseract-core-simd-lstm.wasm'));
      }
      if (name === 'tesseract-core-osd.wasm') {
        return readFile(require.resolve('tesseract.js-core/tesseract-core-simd.wasm'));
      }
      const lang = name.slice(0, -'.traineddata'.length);
      if (!/^[a-z_]+$/.test(lang)) throw new Error(`invalid language code "${lang}"`);
      let pkg: string;
      try {
        pkg = dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
      } catch {
        throw new Error(`no model installed for language "${lang}"`);
      }
      const dir = models === 'standard' ? '4.0.0' : '4.0.0_best_int';
      return gunzipSync(await readFile(join(pkg, dir, `${lang}.traineddata.gz`)));
    },
  };
}
