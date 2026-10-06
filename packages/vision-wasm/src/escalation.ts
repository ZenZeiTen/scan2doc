import type { BackgroundCrop, IDRBlock } from '@scan2doc/core';
import type { QualityIssue } from './quality.js';

/** Longest image side sent to a vision model; larger images are downscaled by the model anyway. */
export const ESCALATION_IMAGE_MAX_SIDE = 1568;

/** What an AI model gets when a page fails the quality checks. */
export interface EscalationRequest {
  pageIndex: number;
  pageCount: number;
  /** Grayscale PNG of the page, downscaled; `scale` = image pixels per page pixel. */
  image: { png: Uint8Array; width: number; height: number; scale: number };
  page: { sizePx: { width: number; height: number }; dpi: number; language?: string };
  /** The OCR engine's best attempt, in page pixels. */
  draft: IDRBlock[];
  /** Detected picture crops; image blocks in a repair must reference these ids. */
  crops: Pick<BackgroundCrop, 'id' | 'bbox'>[];
  issues: QualityIssue[];
}

export interface EscalationReply {
  /** Replacement blocks in page pixels. */
  blocks: IDRBlock[];
  /** BCP 47 tag of the page's main language, when the model can tell (the draft's may be wrong). */
  language?: string;
}

/**
 * Asks something smarter to redo a page. Returns replacement blocks, or
 * undefined to keep the draft. The engine validates the result against the
 * IDR schema and keeps the draft if it does not fit.
 */
export type PageEscalator = (request: EscalationRequest) => Promise<EscalationReply | undefined>;

export type EscalationOutcome =
  /** The page passed the checks. */
  | 'not-needed'
  /** It failed, and no escalator is connected. */
  | 'unavailable'
  /** The model's blocks replaced the draft. */
  | 'applied'
  /** The model answered, but its blocks did not validate; the draft was kept. */
  | 'rejected'
  /** The escalator threw or declined; the draft was kept. */
  | 'failed';
