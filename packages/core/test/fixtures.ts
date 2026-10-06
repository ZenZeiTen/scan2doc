import type { IDRDocumentInput } from '@scan2doc/core';

/** A4 portrait at 150 dpi: 210×297 mm → 1240×1754 px. */
export const A4_150 = { dpi: 150, sizeMm: { width: 210, height: 297 }, sizePx: { width: 1240, height: 1754 } };
/** 16:9 slide at 96 dpi: 254×142.875 mm → 960×540 px. */
export const SLIDE_96 = { dpi: 96, sizeMm: { width: 254, height: 142.875 }, sizePx: { width: 960, height: 540 } };

export const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

export function validDocument(): IDRDocumentInput {
  return {
    version: '1.0',
    metadata: { sourceFile: 'input_scan.pdf', createdAt: '2026-10-06T09:00:00Z', language: 'en' },
    category: 'document',
    pages: [
      {
        index: 0,
        ...A4_150,
        backgroundCrops: [{ id: 'crop-1', bbox: box(700, 300, 400, 300), mimeType: 'image/png', dataRef: 'asset://p0/crop-1.png' }],
        blocks: [
          { id: 'b1', type: 'title', bbox: box(100, 100, 1040, 80), text: 'Annual Report', font: { family: 'Times New Roman', sizePt: 24, bold: true } },
          { id: 'b2', type: 'body', bbox: box(100, 300, 500, 400), text: 'Revenue grew.', confidence: 0.97 },
          { id: 'b3', type: 'image', bbox: box(700, 300, 400, 300), cropRef: 'crop-1' },
          {
            id: 'b4',
            type: 'table',
            bbox: box(100, 800, 1040, 300),
            rows: 2,
            cols: 3,
            cells: [
              { row: 0, col: 0, colSpan: 3, text: 'Quarterly' },
              { row: 1, col: 0, text: 'Q1' },
              { row: 1, col: 1, text: 'Q2' },
              { row: 1, col: 2, text: 'Q3' },
            ],
          },
        ],
      },
    ],
  };
}
