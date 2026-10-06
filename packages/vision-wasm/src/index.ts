export { defaultAssets, nodeModulesAssets, seaAssets, type AssetName, type AssetSource, type ModelSet } from './assets.js';
export { ESCALATION_IMAGE_MAX_SIDE, type EscalationOutcome, type EscalationReply, type EscalationRequest, type PageEscalator } from './escalation.js';
export {
  bgraToGray,
  cropToPng,
  despeckle,
  downscaleGray,
  eraseBoxes,
  grayToPng,
  inkMask,
  otsuThreshold,
  pngDataUri,
  rotateRaster,
  type GrayImage,
  type InkMask,
  type Rotation,
} from './image.js';
export { identifyLatin, SCRIPT_CANDIDATES, scriptFromOsd, type LanguageGuess } from './languages.js';
export { detectImageRegions, type ImageRegionOptions } from './layout/images.js';
export { detectTables, findRulings, type GridCell, type Ruling, type TableGrid, type TableOptions } from './layout/tables.js';
export {
  alignment,
  assignRoles,
  bodySizePt,
  estimateFontPt,
  freeParagraphs,
  joinLines,
  ROLE_RATIOS,
  ROW_HEIGHT_PER_EM,
  tidyCjkSpacing,
  type TextCandidate,
} from './layout/text.js';
export { meanConfidence, OcrEngine, type OcrLine, type OcrParagraph, type OcrWord } from './ocr.js';
export { OsdEngine, type OsdResult } from './osd.js';
export { PdfRasterizer, type RasterPage } from './pdf.js';
export { assessPage, QUALITY_THRESHOLDS, type PageQuality, type QualityIssue, type QualityIssueCode } from './quality.js';
export {
  MIN_ORIENTATION_CONFIDENCE,
  recognizePdf,
  scanToIdr,
  type PageReport,
  type RecognizeOptions,
  type RecognizeProgress,
  type RecognizeResult,
  type RecognizeStage,
  type ScanOptions,
  type ScanResult,
} from './recognize.js';
export { buildLines, buildParagraphs, textInside, type CharLine, type CharParagraph } from './layout/chars.js';
export { languageFromText } from './script.js';
export { familyFromFontName, type PdfChar } from './textlayer.js';
export { judgeTextLayer, type TextSource } from './recognize.js';
