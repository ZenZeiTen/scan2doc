/** Unit conversions from scan space (pixels at the page DPI) to the units each format uses. */

export const MM_PER_INCH = 25.4;
/** Word processing twentieths of a point. */
export const TWIPS_PER_INCH = 1440;
/** OOXML English Metric Units. */
export const EMU_PER_INCH = 914_400;
/** CSS / Office "screen" pixels. */
export const SCREEN_DPI = 96;

export const pxToInches = (px: number, dpi: number) => px / dpi;
export const pxToCm = (px: number, dpi: number) => (px / dpi) * 2.54;
export const pxToTwips = (px: number, dpi: number) => Math.round((px / dpi) * TWIPS_PER_INCH);
export const pxToEmu = (px: number, dpi: number) => Math.round((px / dpi) * EMU_PER_INCH);
export const pxToScreenPx = (px: number, dpi: number) => (px / dpi) * SCREEN_DPI;
export const mmToTwips = (mm: number) => Math.round((mm / MM_PER_INCH) * TWIPS_PER_INCH);
export const mmToInches = (mm: number) => mm / MM_PER_INCH;
export const mmToCm = (mm: number) => mm / 10;

/** Formats a length for ODF attributes, e.g. cm(2.5) → "2.5cm" (4 decimals, trailing zeros dropped). */
export const cm = (value: number) => `${Number(value.toFixed(4))}cm`;
