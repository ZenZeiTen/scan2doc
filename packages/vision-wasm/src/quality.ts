import type { BBox, IDRBlock } from '@scan2doc/core';
import { eraseBoxes, type InkMask } from './image.js';

export type QualityIssueCode =
  /** Recognised words are mostly uncertain: wrong language, poor scan, handwriting. */
  | 'low-confidence'
  /** Much of the ink on the page was not read as text, table or picture. */
  | 'unread-ink'
  /** The page has ink but no text was recognised at all. */
  | 'no-text'
  /** OSD found a script no shipped model reads (Arabic, Hebrew, Tamil, …). */
  | 'unsupported-script'
  /** Most cells of a detected table came back empty. */
  | 'empty-table-cells';

export interface QualityIssue {
  code: QualityIssueCode;
  detail: string;
}

export interface PageQuality {
  /** Character-weighted mean OCR confidence, 0–100; NaN when no text was read. */
  wordConfidence: number;
  /** Share of the page's ink not explained by words, tables or pictures, 0–1. */
  unreadInk: number;
  issues: QualityIssue[];
}

export const QUALITY_THRESHOLDS = {
  /** Clean print reads at 85–96; below this a page needs another look. */
  minWordConfidence: 65,
  /** Above this share of unexplained ink something on the page was missed. */
  maxUnreadInk: 0.3,
  /** Ignore unread ink on nearly blank pages (stamps, a page number, speckle). */
  minInkForUnreadCheck: 0.002,
  maxEmptyCellShare: 0.5,
} as const;

export interface QualityInput {
  mask: InkMask;
  dpi: number;
  wordBoxes: readonly BBox[];
  blocks: readonly IDRBlock[];
  wordConfidence: number;
  unsupportedScript?: string;
}

/**
 * Decides whether a page came out well enough to trust. Every issue is a
 * reason to escalate the page to an AI model when one is connected.
 */
export function assessPage(input: QualityInput): PageQuality {
  const { mask, dpi, blocks } = input;
  const t = QUALITY_THRESHOLDS;
  const issues: QualityIssue[] = [];

  const totalInk = mask.data.reduce((n, v) => n + v, 0);
  const pad = Math.max(2, Math.round(dpi / 75));
  const explained = [...input.wordBoxes, ...blocks.filter((b) => b.type === 'table' || b.type === 'image').map((b) => b.bbox)];
  const rest = eraseBoxes(mask, explained, pad).data.reduce((n, v) => n + v, 0);
  const unreadInk = totalInk ? rest / totalInk : 0;
  const inkShare = totalInk / mask.data.length;

  if (input.unsupportedScript) {
    issues.push({ code: 'unsupported-script', detail: `text in ${input.unsupportedScript} script, which no installed model reads` });
  }
  const textBlocks = blocks.filter((b) => b.type !== 'table' && b.type !== 'image');
  if (textBlocks.length === 0 && inkShare >= t.minInkForUnreadCheck && unreadInk > t.maxUnreadInk) {
    issues.push({ code: 'no-text', detail: 'the page has ink but no text was recognised' });
  } else if (inkShare >= t.minInkForUnreadCheck && unreadInk > t.maxUnreadInk) {
    issues.push({ code: 'unread-ink', detail: `${Math.round(unreadInk * 100)}% of the ink was not read as text, table or picture` });
  }
  if (!Number.isNaN(input.wordConfidence) && input.wordConfidence < t.minWordConfidence) {
    issues.push({ code: 'low-confidence', detail: `mean word confidence ${input.wordConfidence.toFixed(0)} (below ${t.minWordConfidence})` });
  }
  for (const b of blocks) {
    if (b.type !== 'table' || b.cells.length === 0) continue;
    const empty = b.cells.filter((c) => c.text.trim() === '').length / b.cells.length;
    if (empty > t.maxEmptyCellShare) {
      issues.push({ code: 'empty-table-cells', detail: `table ${b.id}: ${Math.round(empty * 100)}% of cells empty` });
    }
  }
  return { wordConfidence: input.wordConfidence, unreadInk, issues };
}
