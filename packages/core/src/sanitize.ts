import type { IDRBlock, IDRDocument } from './schema.js';

/** Characters XML 1.0 forbids (C0 controls except tab/LF/CR, lone surrogates, U+FFFE/FFFF). */
// Built from a string: TypeScript 7's regex-literal checker rejects this valid class.
const XML_INVALID = new RegExp('[^\\t\\n\\r\\u0020-\\uD7FF\\uE000-\\uFFFD\\u{10000}-\\u{10FFFF}]', 'gu');

/**
 * Makes OCR output safe for every XML-based format: drops characters XML cannot
 * carry (form feeds and stray control codes are common in OCR text) and folds
 * CRLF / CR line endings to LF, which writers turn into line breaks.
 */
export function sanitizeXmlText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(XML_INVALID, '');
}

function sanitizeBlock(block: IDRBlock): IDRBlock {
  switch (block.type) {
    case 'table':
      return { ...block, cells: block.cells.map((c) => ({ ...c, text: sanitizeXmlText(c.text) })) };
    case 'image':
      return block.altText === undefined ? block : { ...block, altText: sanitizeXmlText(block.altText) };
    default:
      return { ...block, text: sanitizeXmlText(block.text) };
  }
}

/** Returns a copy of the document with every user-visible string passed through sanitizeXmlText. */
export function sanitizeDocument(doc: IDRDocument): IDRDocument {
  const { title, author } = doc.metadata;
  return {
    ...doc,
    metadata: {
      ...doc.metadata,
      ...(title !== undefined && { title: sanitizeXmlText(title) }),
      ...(author !== undefined && { author: sanitizeXmlText(author) }),
    },
    pages: doc.pages.map((p) => ({ ...p, blocks: p.blocks.map(sanitizeBlock) })),
  };
}
