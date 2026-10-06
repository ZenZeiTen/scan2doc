import { IDRDocumentSchema, type IDRDocument } from '@scan2doc/core';

/** A valid 1×1 PNG. */
export const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export const BELL = '\u0007';

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

/**
 * Two pages exercising every writer path: XML-special characters plus a
 * control character OCR might emit, double spaces / LF / tab, an embedded PNG,
 * a 3×3 table with a column merge and a row merge, a number and a
 * leading-zero string, and a second page in a different orientation.
 */
export function sampleDocument(overrides: { imageDataRef?: string } = {}): IDRDocument {
  return IDRDocumentSchema.parse({
    version: '1.0',
    metadata: { title: 'Annual Report', author: 'Scan2Doc Tests', sourceFile: 'input_scan.pdf', createdAt: '2026-10-06T09:00:00Z', language: 'en' },
    category: 'document',
    pages: [
      {
        index: 0,
        dpi: 150,
        sizeMm: { width: 210, height: 297 },
        sizePx: { width: 1240, height: 1754 },
        backgroundCrops: [
          { id: 'crop-1', bbox: box(760, 270, 380, 300), mimeType: 'image/png', dataRef: overrides.imageDataRef ?? `data:image/png;base64,${PNG_1PX}` },
        ],
        blocks: [
          {
            id: 'title',
            type: 'title',
            bbox: box(100, 80, 1040, 90),
            text: `Annual Report 2026 & <Outlook>${BELL}`,
            align: 'center',
            font: { family: 'Times New Roman', sizePt: 24, bold: true, color: '#1F3864' },
          },
          { id: 'h1', type: 'heading_1', bbox: box(100, 200, 1040, 50), text: 'Revenue' },
          { id: 'body', type: 'body', bbox: box(100, 270, 600, 200), text: 'Revenue grew  12%\nacross all regions.\tSee table.' },
          { id: 'logo', type: 'image', bbox: box(760, 270, 380, 300), cropRef: 'crop-1', altText: 'Company logo' },
          {
            id: 'tbl',
            type: 'table',
            bbox: box(100, 620, 1040, 240),
            rows: 3,
            cols: 3,
            cells: [
              { row: 0, col: 0, colSpan: 3, text: 'Quarterly figures', font: { family: 'Calibri', sizePt: 12, bold: true } },
              { row: 1, col: 0, rowSpan: 2, text: '2026' },
              { row: 1, col: 1, text: 'Q1' },
              { row: 1, col: 2, text: '12' },
              { row: 2, col: 1, text: 'Q2' },
              { row: 2, col: 2, text: '007' },
            ],
          },
        ],
      },
      {
        index: 1,
        dpi: 150,
        sizeMm: { width: 297, height: 210 },
        sizePx: { width: 1754, height: 1240 },
        blocks: [
          { id: 'h2', type: 'heading_2', bbox: box(100, 100, 1500, 60), text: 'Appendix' },
          { id: 'h3', type: 'heading_3', bbox: box(100, 200, 1500, 50), text: 'Notes' },
          { id: 'done', type: 'body', bbox: box(100, 280, 1500, 80), text: 'Done.' },
        ],
      },
    ],
  });
}
