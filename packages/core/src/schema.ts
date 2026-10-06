import { z } from 'zod';

/** Axis-aligned box in page pixel space; origin top-left, y grows downward. */
export const BBoxSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
});
export type BBox = z.infer<typeof BBoxSchema>;

export const FontPropsSchema = z.object({
  family: z.string().min(1),
  sizePt: z.number().positive(),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
  underline: z.boolean().default(false),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #RRGGBB').default('#000000'),
});
export type FontProps = z.infer<typeof FontPropsSchema>;

export const TEXT_BLOCK_TYPES = ['title', 'heading_1', 'heading_2', 'heading_3', 'body'] as const;
export type TextBlockType = (typeof TEXT_BLOCK_TYPES)[number];

const blockBase = {
  id: z.string().min(1),
  bbox: BBoxSchema,
  /** OCR / detector confidence in [0, 1]; absent when the block was not machine-detected. */
  confidence: z.number().min(0).max(1).optional(),
};

const textBlock = <T extends TextBlockType>(type: T) =>
  z.object({
    ...blockBase,
    type: z.literal(type),
    text: z.string(),
    font: FontPropsSchema.optional(),
    align: z.enum(['left', 'center', 'right', 'justify']).default('left'),
  });

export const TitleBlockSchema = textBlock('title');
export const Heading1BlockSchema = textBlock('heading_1');
export const Heading2BlockSchema = textBlock('heading_2');
export const Heading3BlockSchema = textBlock('heading_3');
export const BodyBlockSchema = textBlock('body');

export const TableCellSchema = z.object({
  row: z.number().int().nonnegative(),
  col: z.number().int().nonnegative(),
  rowSpan: z.number().int().positive().default(1),
  colSpan: z.number().int().positive().default(1),
  text: z.string(),
  font: FontPropsSchema.optional(),
  bbox: BBoxSchema.optional(),
});
export type TableCell = z.infer<typeof TableCellSchema>;

export const TableBlockSchema = z
  .object({
    ...blockBase,
    type: z.literal('table'),
    rows: z.number().int().positive(),
    cols: z.number().int().positive(),
    /** Sparse matrix grid: one entry per anchor cell; merged cells declare rowSpan/colSpan. */
    cells: z.array(TableCellSchema),
  })
  .superRefine((table, ctx) => {
    const owner = new Map<string, number>();
    table.cells.forEach((cell, i) => {
      if (cell.row + cell.rowSpan > table.rows || cell.col + cell.colSpan > table.cols) {
        ctx.addIssue({
          code: 'custom',
          path: ['cells', i],
          message: `cell (${cell.row},${cell.col}) span ${cell.rowSpan}x${cell.colSpan} exceeds ${table.rows}x${table.cols} grid`,
        });
        return;
      }
      for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
        for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
          const key = `${r},${c}`;
          const prev = owner.get(key);
          if (prev !== undefined) {
            ctx.addIssue({
              code: 'custom',
              path: ['cells', i],
              message: `grid slot (${r},${c}) already covered by cells[${prev}]`,
            });
            return;
          }
          owner.set(key, i);
        }
      }
    });
  });

export const ImageBlockSchema = z.object({
  ...blockBase,
  type: z.literal('image'),
  /** Id of an entry in the page's backgroundCrops. */
  cropRef: z.string().min(1),
  altText: z.string().optional(),
});

export const IDRBlockSchema = z.discriminatedUnion('type', [
  TitleBlockSchema,
  Heading1BlockSchema,
  Heading2BlockSchema,
  Heading3BlockSchema,
  BodyBlockSchema,
  TableBlockSchema,
  ImageBlockSchema,
]);
export type IDRBlock = z.infer<typeof IDRBlockSchema>;
export type IDRTextBlock = Extract<IDRBlock, { type: TextBlockType }>;
export type IDRTableBlock = Extract<IDRBlock, { type: 'table' }>;
export type IDRImageBlock = Extract<IDRBlock, { type: 'image' }>;

export const BackgroundCropSchema = z.object({
  id: z.string().min(1),
  bbox: BBoxSchema,
  mimeType: z.enum(['image/png', 'image/jpeg']),
  /** Opaque reference resolved by the vision engine (asset key, file path, or data URI). */
  dataRef: z.string().min(1),
});
export type BackgroundCrop = z.infer<typeof BackgroundCropSchema>;

/** Allowed relative mismatch between sizePx and sizeMm converted at the page DPI. */
const PX_MM_TOLERANCE = 0.02;
/** Blocks may overhang the page edge by this many pixels (detector rounding). */
const BOUNDS_TOLERANCE_PX = 1;

export const IDRPageSchema = z
  .object({
    index: z.number().int().nonnegative(),
    dpi: z.number().positive(),
    sizeMm: z.object({ width: z.number().positive(), height: z.number().positive() }),
    sizePx: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    backgroundCrops: z.array(BackgroundCropSchema).default([]),
    blocks: z.array(IDRBlockSchema),
    /** BCP 47 tag of the page's main language, when recognised. */
    language: z.string().min(2).optional(),
    /** Who produced the blocks: the OCR engine, or an AI model after escalation. */
    source: z.enum(['ocr', 'ai']).optional(),
  })
  .superRefine((page, ctx) => {
    for (const axis of ['width', 'height'] as const) {
      const expected = (page.sizeMm[axis] / 25.4) * page.dpi;
      if (Math.abs(page.sizePx[axis] - expected) > expected * PX_MM_TOLERANCE) {
        ctx.addIssue({
          code: 'custom',
          path: ['sizePx', axis],
          message: `sizePx.${axis}=${page.sizePx[axis]} disagrees with ${page.sizeMm[axis]}mm at ${page.dpi}dpi (expected ~${Math.round(expected)})`,
        });
      }
    }

    const cropIds = new Set(page.backgroundCrops.map((c) => c.id));
    const seen = new Set<string>();
    page.blocks.forEach((block, i) => {
      if (seen.has(block.id)) {
        ctx.addIssue({ code: 'custom', path: ['blocks', i, 'id'], message: `duplicate block id "${block.id}"` });
      }
      seen.add(block.id);

      const { x, y, width, height } = block.bbox;
      if (x + width > page.sizePx.width + BOUNDS_TOLERANCE_PX || y + height > page.sizePx.height + BOUNDS_TOLERANCE_PX) {
        ctx.addIssue({ code: 'custom', path: ['blocks', i, 'bbox'], message: `block "${block.id}" extends past the page` });
      }
      if (block.type === 'image' && !cropIds.has(block.cropRef)) {
        ctx.addIssue({
          code: 'custom',
          path: ['blocks', i, 'cropRef'],
          message: `image block "${block.id}" references unknown crop "${block.cropRef}"`,
        });
      }
    });
  });
export type IDRPage = z.infer<typeof IDRPageSchema>;

export const DOCUMENT_CATEGORIES = ['document', 'spreadsheet', 'presentation'] as const;
export const DocumentCategorySchema = z.enum(DOCUMENT_CATEGORIES);
export type DocumentCategory = z.infer<typeof DocumentCategorySchema>;

export const IDRMetadataSchema = z.object({
  title: z.string().optional(),
  author: z.string().optional(),
  /** BCP 47 tag, e.g. "en", "id", "pt-BR". */
  language: z.string().min(2).default('en'),
  sourceFile: z.string().min(1),
  createdAt: z.iso.datetime(),
  ocrEngine: z.string().optional(),
});
export type IDRMetadata = z.infer<typeof IDRMetadataSchema>;

export const IDR_VERSION = '1.0' as const;

export const IDRDocumentSchema = z
  .object({
    version: z.literal(IDR_VERSION),
    metadata: IDRMetadataSchema,
    category: DocumentCategorySchema,
    pages: z.array(IDRPageSchema).min(1),
  })
  .superRefine((doc, ctx) => {
    doc.pages.forEach((page, i) => {
      if (page.index !== i) {
        ctx.addIssue({ code: 'custom', path: ['pages', i, 'index'], message: `page index ${page.index} at position ${i}` });
      }
    });
  });
export type IDRDocument = z.infer<typeof IDRDocumentSchema>;
/** Shape accepted before defaults are applied (what a producer may emit). */
export type IDRDocumentInput = z.input<typeof IDRDocumentSchema>;
