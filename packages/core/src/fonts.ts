import type { FontProps, IDRTextBlock, TextBlockType } from './schema.js';

export const DEFAULT_FONT_FAMILY = 'Calibri';

/** Point sizes used when the vision engine could not measure a block's font. */
export const DEFAULT_FONT_SIZES: Readonly<Record<TextBlockType, number>> = {
  title: 26,
  heading_1: 20,
  heading_2: 16,
  heading_3: 13,
  body: 11,
};

export function defaultFont(type: TextBlockType): FontProps {
  return {
    family: DEFAULT_FONT_FAMILY,
    sizePt: DEFAULT_FONT_SIZES[type],
    bold: type !== 'body',
    italic: false,
    underline: false,
    color: '#000000',
  };
}

/** The measured font when there is one, otherwise the default for the block's role. */
export const effectiveFont = (block: IDRTextBlock): FontProps => block.font ?? defaultFont(block.type);
