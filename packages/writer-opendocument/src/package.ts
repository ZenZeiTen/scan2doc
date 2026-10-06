import JSZip from 'jszip';
import type { IDRDocument, ResolvedImage } from '@scan2doc/core';
import { esc, ODF_VERSION, XML_DECL, xmlns } from './xml.js';

export const ODF_MIME_TYPES = {
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
} as const;

export interface Picture {
  path: string;
  mediaType: string;
  data: Uint8Array;
}

/** Collects embedded images under Pictures/ with collision-free names. */
export class Pictures {
  readonly list: Picture[] = [];

  add(img: ResolvedImage): string {
    const ext = img.extension === 'png' ? 'png' : 'jpg';
    const path = `Pictures/image${this.list.length + 1}.${ext}`;
    this.list.push({ path, mediaType: `image/${img.extension}`, data: img.data });
    return path;
  }
}

export function metaXml(doc: IDRDocument): string {
  const m = doc.metadata;
  return (
    `${XML_DECL}<office:document-meta ${xmlns('office', 'meta', 'dc')} office:version="${ODF_VERSION}"><office:meta>` +
    `<meta:generator>scan2doc</meta:generator>` +
    (m.title ? `<dc:title>${esc(m.title)}</dc:title>` : '') +
    (m.author ? `<meta:initial-creator>${esc(m.author)}</meta:initial-creator>` : '') +
    `<meta:creation-date>${esc(m.createdAt.replace(/Z$/, ''))}</meta:creation-date>` +
    `<dc:language>${esc(m.language)}</dc:language>` +
    `</office:meta></office:document-meta>`
  );
}

function manifestXml(mimetype: string, pictures: readonly Picture[]): string {
  const entry = (path: string, type: string, extra = '') =>
    `<manifest:file-entry manifest:full-path="${path}" manifest:media-type="${type}"${extra}/>`;
  return (
    `${XML_DECL}<manifest:manifest ${xmlns('manifest')} manifest:version="${ODF_VERSION}">` +
    entry('/', mimetype, ` manifest:version="${ODF_VERSION}"`) +
    entry('content.xml', 'text/xml') +
    entry('styles.xml', 'text/xml') +
    entry('meta.xml', 'text/xml') +
    pictures.map((p) => entry(p.path, p.mediaType)).join('') +
    `</manifest:manifest>`
  );
}

/**
 * Zips an ODF package per ISO 26300 part 3: "mimetype" first, stored
 * uncompressed with no extra field so tools can sniff the type at offset 38.
 */
export async function packOdf(
  mimetype: string,
  parts: { content: string; styles: string; meta: string },
  pictures: readonly Picture[],
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', mimetype, { compression: 'STORE' });
  zip.file('content.xml', parts.content);
  zip.file('styles.xml', parts.styles);
  zip.file('meta.xml', parts.meta);
  // createFolders: false keeps directory entries (which the manifest does not list) out of the zip.
  for (const p of pictures) zip.file(p.path, p.data, { compression: 'STORE', createFolders: false });
  zip.file('META-INF/manifest.xml', manifestXml(mimetype, pictures), { createFolders: false });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: mimetype });
}
