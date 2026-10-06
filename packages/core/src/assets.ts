import type { BackgroundCrop, IDRImageBlock, IDRPage } from './schema.js';

/**
 * Turns a crop's opaque dataRef into image bytes. Return undefined when the
 * image cannot be found; writers then leave the image out rather than fail.
 */
export type ImageResolver = (crop: BackgroundCrop) => Uint8Array | undefined | Promise<Uint8Array | undefined>;

export interface WriterOptions {
  /** Defaults to decoding `data:image/png|jpeg;base64,…` dataRefs. */
  resolveImage?: ImageResolver;
}

export interface ResolvedImage {
  block: IDRImageBlock;
  crop: BackgroundCrop;
  data: Uint8Array;
  extension: 'png' | 'jpeg';
}

const DATA_URI = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/;

export function decodeDataUri(ref: string): Uint8Array | undefined {
  const m = DATA_URI.exec(ref);
  if (!m) return undefined;
  const bin = atob(m[2]!.replace(/\s+/g, ''));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export const defaultImageResolver: ImageResolver = (crop) => decodeDataUri(crop.dataRef);

/** Resolves every image block on a page, keyed by block id; unresolvable images are absent. */
export async function resolvePageImages(
  page: IDRPage,
  resolve: ImageResolver = defaultImageResolver,
): Promise<Map<string, ResolvedImage>> {
  const crops = new Map(page.backgroundCrops.map((c) => [c.id, c]));
  const out = new Map<string, ResolvedImage>();
  for (const block of page.blocks) {
    if (block.type !== 'image') continue;
    const crop = crops.get(block.cropRef);
    if (!crop) continue;
    const data = await resolve(crop);
    if (data && data.length > 0) {
      out.set(block.id, { block, crop, data, extension: crop.mimeType === 'image/png' ? 'png' : 'jpeg' });
    }
  }
  return out;
}
