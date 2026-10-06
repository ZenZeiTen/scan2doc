import type { IDRDocument, WriterOptions } from '@scan2doc/core';
import { writeOdp } from './odp.js';
import { writeOds } from './ods.js';
import { writeOdt } from './odt.js';

export { writeOdp, writeOds, writeOdt };
export { ODF_MIME_TYPES } from './package.js';

export const OPENDOCUMENT_FORMATS = ['odt', 'ods', 'odp'] as const;
export type OpenDocumentFormat = (typeof OPENDOCUMENT_FORMATS)[number];

/** Serializes an IDR document to an OpenDocument (ISO 26300) package. */
export function writeOpenDocument(doc: IDRDocument, format: OpenDocumentFormat, options?: WriterOptions): Promise<Uint8Array> {
  switch (format) {
    case 'odt':
      return writeOdt(doc, options);
    case 'ods':
      return writeOds(doc, options);
    case 'odp':
      return writeOdp(doc, options);
  }
}
