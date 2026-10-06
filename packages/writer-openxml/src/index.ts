import type { IDRDocument, WriterOptions } from '@scan2doc/core';
import { writeDocx } from './docx.js';
import { writePptx } from './pptx.js';
import { writeXlsx } from './xlsx.js';

export { writeDocx, writePptx, writeXlsx };

export const OPENXML_FORMATS = ['docx', 'xlsx', 'pptx'] as const;
export type OpenXmlFormat = (typeof OPENXML_FORMATS)[number];

export const OPENXML_MIME_TYPES: Readonly<Record<OpenXmlFormat, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Serializes an IDR document to an Office Open XML package. */
export function writeOpenXml(doc: IDRDocument, format: OpenXmlFormat, options?: WriterOptions): Promise<Uint8Array> {
  switch (format) {
    case 'docx':
      return writeDocx(doc, options);
    case 'xlsx':
      return writeXlsx(doc, options);
    case 'pptx':
      return writePptx(doc, options);
  }
}
