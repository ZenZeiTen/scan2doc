import { languageForTag, officeLanguageTag, type FontProps } from '@scan2doc/core';

export const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  dc: 'http://purl.org/dc/elements/1.1/',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  presentation: 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
} as const;

export const ODF_VERSION = '1.3';

/** xmlns declarations for the given prefixes. */
export const xmlns = (...prefixes: (keyof typeof NS)[]) => prefixes.map((p) => `xmlns:${p}="${NS[p]}"`).join(' ');

export const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';

export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * ODF collapses runs of spaces like HTML and drops leading ones, so spaces that
 * matter become <text:s/>; tabs become <text:tab/>.
 */
function spaces(segment: string, atLineStart: boolean): string {
  return segment.replace(/ +/g, (run, offset: number) => {
    if (offset === 0 && atLineStart) return `<text:s text:c="${run.length}"/>`;
    return run.length === 1 ? ' ' : ` <text:s text:c="${run.length - 1}"/>`;
  });
}

/** One line of text (no LF) as escaped paragraph content. */
export const odfLine = (line: string) =>
  line
    .split('\t')
    .map((seg, i) => spaces(esc(seg), i === 0))
    .join('<text:tab/>');

/** Paragraph content where LF becomes <text:line-break/>. */
export const odfText = (text: string) => text.split('\n').map(odfLine).join('<text:line-break/>');

/** XSL-FO font-family needs quoting when the name has spaces. */
const family = (name: string) => (/\s/.test(name) ? `'${name}'` : name);

/**
 * The page language, in the slot ODF uses for its script. Without it Word
 * tags Japanese text in an .odt as Chinese (found by opening one in Word).
 */
export function languageAttributes(tag: string | undefined): string {
  if (!tag) return '';
  const info = languageForTag(tag);
  const lang = tag.split('-')[0]!.toLowerCase();
  if (info?.eastAsian) {
    const country = officeLanguageTag(tag).split('-')[1];
    return ` style:language-asian="${lang}"${country ? ` style:country-asian="${country}"` : ''}`;
  }
  if (info && (info.script === 'Thai' || info.script === 'Devanagari')) return ` style:language-complex="${lang}"`;
  return ` fo:language="${lang}"`;
}

/** Fonts the document uses, declared once in office:font-face-decls and referenced by name. */
export class FontFaces {
  private readonly names = new Set<string>();

  add(name: string): string {
    this.names.add(name);
    return name;
  }

  /** Must precede office:automatic-styles in the document. */
  toXml(): string {
    if (this.names.size === 0) return '';
    const faces = [...this.names].map((n) => `<style:font-face style:name="${esc(n)}" svg:font-family="${esc(family(n))}"/>`).join('');
    return `<office:font-face-decls>${faces}</office:font-face-decls>`;
  }
}

/**
 * ODF keeps Western, Asian and complex-script (Thai, Devanagari, …) text in
 * separate property sets; without the -asian / -complex variants a size or
 * weight set on Japanese or Thai text silently does not apply to it. Fonts are
 * named twice: style:font-name (a declared face, which Excel's .ods import
 * needs) and fo:font-family (which other readers use).
 */
export const textProperties = (f: FontProps, options: { faces?: FontFaces; language?: string } = {}) => {
  const fam = esc(family(f.family));
  const face = options.faces ? esc(options.faces.add(f.family)) : undefined;
  const weight = f.bold ? 'bold' : 'normal';
  const style = f.italic ? 'italic' : 'normal';
  const named = face ? ` style:font-name="${face}" style:font-name-asian="${face}" style:font-name-complex="${face}"` : '';
  const scripts = (['asian', 'complex'] as const)
    .map((s) => ` style:font-family-${s}="${fam}" style:font-size-${s}="${f.sizePt}pt" style:font-weight-${s}="${weight}" style:font-style-${s}="${style}"`)
    .join('');
  return textPropertiesWestern(f) + named + scripts + languageAttributes(options.language) + '/>';
};

const textPropertiesWestern = (f: FontProps) =>
  `<style:text-properties fo:font-family="${esc(family(f.family))}" fo:font-size="${f.sizePt}pt"` +
  ` fo:font-weight="${f.bold ? 'bold' : 'normal'}" fo:font-style="${f.italic ? 'italic' : 'normal'}"` +
  ` style:text-underline-style="${f.underline ? 'solid' : 'none'}"` +
  (f.underline ? ' style:text-underline-width="auto" style:text-underline-color="font-color"' : '') +
  ` fo:color="${f.color}"`;

/**
 * Span attributes for a merged anchor cell. Both are always written together:
 * Excel ignores a merge that names only one of them (found by opening the
 * output in Excel), while ODF treats a missing one as 1, so this is harmless
 * for Word, PowerPoint and LibreOffice.
 */
export const spanAttrs = (cell?: { colSpan: number; rowSpan: number }) =>
  cell && (cell.colSpan > 1 || cell.rowSpan > 1)
    ? ` table:number-columns-spanned="${cell.colSpan}" table:number-rows-spanned="${cell.rowSpan}"`
    : '';

export const fontKey = (f: FontProps) => `${f.family}|${f.sizePt}|${+f.bold}${+f.italic}${+f.underline}|${f.color}`;

/** Deduplicating registry of automatic styles: identical properties share one name. */
export class StyleRegistry {
  private readonly names = new Map<string, string>();
  private readonly xml: string[] = [];

  constructor(private readonly prefix: string) {}

  get(key: string, build: (name: string) => string): string {
    let name = this.names.get(key);
    if (!name) {
      name = `${this.prefix}${this.names.size + 1}`;
      this.names.set(key, name);
      this.xml.push(build(name));
    }
    return name;
  }

  toXml(): string {
    return this.xml.join('');
  }
}
