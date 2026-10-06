import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
} as const;

/** Parses XML strictly: any well-formedness error throws, naming the part. */
export function parseXml(xml: string, part: string): Document {
  const parser = new DOMParser({
    onError: (level, message) => {
      if (level !== 'warning') throw new Error(`${part}: ${message}`);
    },
  });
  return parser.parseFromString(xml, 'text/xml') as unknown as Document;
}

export interface Package {
  zip: JSZip;
  names: string[];
  text(name: string): Promise<string>;
  xml(name: string): Promise<Document>;
}

export async function openPackage(bytes: Uint8Array): Promise<Package> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
  const text = async (name: string) => {
    const f = zip.file(name);
    if (!f) throw new Error(`missing part ${name}; have ${names.join(', ')}`);
    return f.async('string');
  };
  return { zip, names, text, xml: async (name) => parseXml(await text(name), name) };
}

/** Parses every .xml / .rels part; returns how many were checked. */
export async function parseAllXmlParts(pkg: Package): Promise<number> {
  const xmlParts = pkg.names.filter((n) => /\.(xml|rels)$/.test(n));
  for (const n of xmlParts) await pkg.xml(n);
  return xmlParts.length;
}

export const all = (root: Document | Element, ns: string, local: string): Element[] =>
  Array.from(root.getElementsByTagNameNS(ns, local) as ArrayLike<Element>);

/** Children (not descendants) with the given name. */
export const kids = (el: Element, ns: string, local: string): Element[] =>
  Array.from(el.childNodes as ArrayLike<Node>).filter(
    (n): n is Element => n.nodeType === 1 && (n as Element).namespaceURI === ns && (n as Element).localName === local,
  );

export const attr = (el: Element, ns: string, local: string) => el.getAttributeNS(ns, local);

/** Every ODF table row must fill exactly its table's declared columns (covered cells included). */
export function odfRowWidths(doc: Document): { declared: number; rows: number[] }[] {
  return all(doc, NS.table, 'table').map((t) => {
    const repeated = (el: Element) => Number(attr(el, NS.table, 'number-columns-repeated') || 1);
    const declared = kids(t, NS.table, 'table-column').reduce((n, c) => n + repeated(c), 0);
    const rows = kids(t, NS.table, 'table-row').map((r) =>
      [...kids(r, NS.table, 'table-cell'), ...kids(r, NS.table, 'covered-table-cell')].reduce((n, c) => n + repeated(c), 0),
    );
    return { declared, rows };
  });
}
