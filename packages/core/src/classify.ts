import type { DocumentCategory, IDRPage } from './schema.js';

export interface ClassificationFeatures {
  /** Share of total block area covered by table blocks, 0–1. */
  tableAreaRatio: number;
  /** Share of pages wider than they are tall, 0–1. */
  landscapeRatio: number;
  /** Mean characters of text (all text blocks and table cells) per page. */
  charsPerPage: number;
}

export interface Classification {
  category: DocumentCategory;
  /** Heuristic certainty in [0.5, 1]: how far the deciding feature sits past its threshold. */
  confidence: number;
  features: ClassificationFeatures;
}

/** Table area at or above this share of the content makes the scan a spreadsheet. */
export const SPREADSHEET_TABLE_RATIO = 0.5;
/** Landscape pages must be a strict majority, with sparse text, for a presentation: a portrait report with a landscape appendix is still a document. */
export const PRESENTATION_LANDSCAPE_RATIO = 0.5;
/** Slides rarely carry more text than this per page. */
export const PRESENTATION_MAX_CHARS = 800;

const area = (b: { width: number; height: number }) => b.width * b.height;

export function extractFeatures(pages: readonly IDRPage[]): ClassificationFeatures {
  let tableArea = 0;
  let totalArea = 0;
  let chars = 0;
  for (const page of pages) {
    for (const block of page.blocks) {
      const a = area(block.bbox);
      totalArea += a;
      if (block.type === 'table') {
        tableArea += a;
        chars += block.cells.reduce((n, c) => n + c.text.length, 0);
      } else if (block.type !== 'image') {
        chars += block.text.length;
      }
    }
  }
  const n = Math.max(pages.length, 1);
  return {
    tableAreaRatio: totalArea === 0 ? 0 : tableArea / totalArea,
    landscapeRatio: pages.filter((p) => p.sizePx.width > p.sizePx.height).length / n,
    charsPerPage: chars / n,
  };
}

/** Maps distance past a threshold (in units of the threshold's headroom) onto [0.5, 1]. */
const certainty = (value: number, threshold: number, max: number) =>
  0.5 + 0.5 * Math.min(1, Math.abs(value - threshold) / Math.max(Math.abs(max - threshold), 1e-9));

/**
 * Picks the output family for a scanned document. Table-dominated scans become
 * spreadsheets first (a landscape ledger is still a ledger); then mostly-landscape,
 * text-sparse scans become presentations; everything else is a document.
 */
export function classifyDocument(pages: readonly IDRPage[]): Classification {
  const features = extractFeatures(pages);
  const { tableAreaRatio, landscapeRatio, charsPerPage } = features;

  if (tableAreaRatio >= SPREADSHEET_TABLE_RATIO) {
    return { category: 'spreadsheet', confidence: certainty(tableAreaRatio, SPREADSHEET_TABLE_RATIO, 1), features };
  }
  if (landscapeRatio > PRESENTATION_LANDSCAPE_RATIO && charsPerPage < PRESENTATION_MAX_CHARS) {
    const conf = Math.min(
      certainty(landscapeRatio, PRESENTATION_LANDSCAPE_RATIO, 1),
      certainty(charsPerPage, PRESENTATION_MAX_CHARS, 0),
    );
    return { category: 'presentation', confidence: conf, features };
  }
  // Document: certainty grows the further the scan is from both other categories.
  const conf = Math.min(
    certainty(tableAreaRatio, SPREADSHEET_TABLE_RATIO, 0),
    landscapeRatio > PRESENTATION_LANDSCAPE_RATIO
      ? certainty(charsPerPage, PRESENTATION_MAX_CHARS, PRESENTATION_MAX_CHARS * 2)
      : certainty(landscapeRatio, PRESENTATION_LANDSCAPE_RATIO, 0),
  );
  return { category: 'document', confidence: conf, features };
}
