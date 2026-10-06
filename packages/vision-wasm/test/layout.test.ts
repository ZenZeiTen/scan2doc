import { describe, expect, it } from 'vitest';
import { assignRoles, despeckle, detectImageRegions, detectTables, findRulings, freeParagraphs, joinLines, type InkMask, type TextCandidate } from '../src/index.js';

const DPI = 100; // minLength 40 px, maxThickness 4 px, gap 1 px

function blankMask(width = 600, height = 400): InkMask {
  return { width, height, data: new Uint8Array(width * height) };
}
const fill = (m: InkMask, x: number, y: number, w: number, h: number) => {
  for (let j = y; j < y + h; j++) m.data.fill(1, j * m.width + x, j * m.width + x + w);
};
const hline = (m: InkMask, y: number, x0: number, x1: number, t = 2) => fill(m, x0, y, x1 - x0 + 1, t);
const vline = (m: InkMask, x: number, y0: number, y1: number, t = 2) => fill(m, x, y0, t, y1 - y0 + 1);

const cellsOf = (m: InkMask) => detectTables(m, DPI).map((t) => ({ rows: t.rows, cols: t.cols, cells: t.cells.map(({ row, col, rowSpan, colSpan }) => [row, col, rowSpan, colSpan]) }));

describe('findRulings', () => {
  it('finds long thin runs and ignores short ones and filled shapes', () => {
    const m = blankMask();
    hline(m, 50, 50, 350); // ruling
    hline(m, 80, 50, 70); // 21 px: too short
    fill(m, 400, 200, 120, 120); // filled box: too thick
    const h = findRulings(m, true, 40, 4, 1);
    expect(h).toEqual([{ pos: 50.5, start: 50, end: 350, thickness: 2 }]);
  });

  it('bridges one-pixel breaks in a scanned line', () => {
    const m = blankMask();
    hline(m, 60, 50, 150);
    m.data[60 * m.width + 100] = 0;
    m.data[61 * m.width + 100] = 0;
    expect(findRulings(m, true, 40, 4, 1)).toHaveLength(1);
  });
});

describe('detectTables', () => {
  it('reads a plain 2 × 3 grid', () => {
    const m = blankMask();
    for (const y of [50, 100, 150]) hline(m, y, 50, 351);
    for (const x of [50, 150, 250, 350]) vline(m, x, 50, 151);
    expect(cellsOf(m)).toEqual([
      { rows: 2, cols: 3, cells: [[0, 0, 1, 1], [0, 1, 1, 1], [0, 2, 1, 1], [1, 0, 1, 1], [1, 1, 1, 1], [1, 2, 1, 1]] },
    ]);
  });

  it('merges a header row whose inner verticals are missing', () => {
    const m = blankMask();
    for (const y of [50, 100, 150]) hline(m, y, 50, 351);
    for (const x of [50, 350]) vline(m, x, 50, 151);
    for (const x of [150, 250]) vline(m, x, 100, 151);
    expect(cellsOf(m)[0]!.cells).toEqual([[0, 0, 1, 3], [1, 0, 1, 1], [1, 1, 1, 1], [1, 2, 1, 1]]);
  });

  it('merges a column cell down two rows', () => {
    const m = blankMask();
    hline(m, 50, 50, 251);
    hline(m, 100, 150, 251); // no ruling under the left cell
    hline(m, 150, 50, 251);
    for (const x of [50, 150, 250]) vline(m, x, 50, 151);
    expect(cellsOf(m)[0]!.cells).toEqual([[0, 0, 2, 1], [0, 1, 1, 1], [1, 1, 1, 1]]);
  });

  it('reports two separate tables and ignores lone rulings', () => {
    const m = blankMask(600, 600);
    for (const y of [50, 100]) hline(m, y, 50, 251);
    for (const x of [50, 250]) vline(m, x, 50, 101);
    for (const y of [300, 350, 400]) hline(m, y, 300, 501);
    for (const x of [300, 500]) vline(m, x, 300, 401);
    hline(m, 500, 50, 550); // an underline or rule: no crossing verticals
    const tables = cellsOf(m);
    expect(tables.map((t) => [t.rows, t.cols])).toEqual([[1, 1], [2, 1]]);
  });

  it('finds nothing in text-like ink', () => {
    const m = blankMask();
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < 400; i++) fill(m, Math.floor(rand() * 560), Math.floor(rand() * 380), 3 + Math.floor(rand() * 15), 3 + Math.floor(rand() * 12));
    expect(detectTables(m, DPI)).toEqual([]);
  });
});

describe('detectImageRegions', () => {
  it('finds a dense picture to tile accuracy and ignores speckle', () => {
    const m = blankMask();
    fill(m, 300, 100, 120, 90);
    let seed = 3;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < 300; i++) m.data[Math.floor(rand() * m.data.length)] = 1;
    const [r, ...rest] = detectImageRegions(m, DPI);
    expect(rest).toEqual([]);
    // tile = 4 px at 100 dpi, so edges land within one tile of the drawn box
    expect(Math.abs(r!.x - 300)).toBeLessThanOrEqual(4);
    expect(Math.abs(r!.y - 100)).toBeLessThanOrEqual(4);
    expect(Math.abs(r!.width - 120)).toBeLessThanOrEqual(8);
    expect(Math.abs(r!.height - 90)).toBeLessThanOrEqual(8);
  });

  it('holds a photo with light patches together as one region', () => {
    const m = blankMask();
    for (let y = 100; y < 220; y++) for (let x = 100; x < 260; x++) if ((x + y) % 3 !== 0) m.data[y * m.width + x] = 1;
    fill(m, 150, 140, 2, 2); // already ink; plus a blank patch:
    for (let y = 150; y < 160; y++) m.data.fill(0, y * m.width + 170, y * m.width + 178);
    expect(detectImageRegions(m, DPI)).toHaveLength(1);
  });

  it('drops regions smaller than 0.4 in', () => {
    const m = blankMask();
    fill(m, 50, 50, 30, 30); // 0.3 in square
    hline(m, 300, 50, 550, 3); // long but only 3 px tall
    expect(detectImageRegions(m, DPI)).toEqual([]);
  });

  it('drops a large but hollow frame (a boxed callout is not a picture)', () => {
    const m = blankMask();
    hline(m, 100, 100, 300, 3);
    hline(m, 300, 100, 300, 3);
    vline(m, 100, 100, 302, 3);
    vline(m, 300, 100, 302, 3);
    expect(detectImageRegions(m, DPI)).toEqual([]);
  });
});

describe('despeckle', () => {
  it('removes blobs up to (dpi/150)² px and keeps full stops, letters and lines', () => {
    const dpi = 300; // maxArea 4 px
    const m = blankMask(200, 100);
    fill(m, 10, 10, 1, 1); // 1 px speck
    fill(m, 30, 10, 2, 2); // 4 px speck
    fill(m, 50, 10, 3, 3); // 9 px: the full stop of 6 pt text
    fill(m, 70, 10, 2, 40); // a letter stroke
    hline(m, 80, 10, 190); // a ruling
    m.data[60 * m.width + 120] = 1; // diagonal pair: 8-connected, 2 px → removed
    m.data[61 * m.width + 121] = 1;
    const gray = { width: m.width, height: m.height, data: Uint8Array.from(m.data, (v) => (v ? 0 : 255)) };
    const out = despeckle(gray, m, dpi);
    expect(out.removed).toBe(3);
    const at = (x: number, y: number) => out.mask.data[y * m.width + x];
    expect([at(10, 10), at(30, 10), at(120, 60), at(121, 61)]).toEqual([0, 0, 0, 0]);
    expect([at(50, 10), at(70, 30), at(100, 80)]).toEqual([1, 1, 1]);
    expect(out.gray.data[10 * m.width + 10]).toBe(255);
    expect(m.data[10 * m.width + 10]).toBe(1); // input untouched
  });
});

describe('freeParagraphs', () => {
  it('drops paragraphs centred in a table or picture and keeps ones that merely touch', () => {
    const box = (x: number, y: number, width: number, height: number) => ({ bbox: { x, y, width, height } });
    const table = { x: 100, y: 100, width: 300, height: 200 };
    const inside = box(150, 150, 50, 20);
    const overlapping = box(380, 280, 100, 60); // centre (430, 310): outside
    const away = box(500, 500, 50, 20);
    expect(freeParagraphs([inside, overlapping, away], [table])).toEqual([overlapping, away]);
    expect(freeParagraphs([inside], [])).toEqual([inside]);
  });
});

describe('joinLines', () => {
  it('reflows soft line breaks and rejoins hyphenated words', () => {
    expect(joinLines(['Revenue grew in the regi-', 'ons we serve.'])).toBe('Revenue grew in the regions we serve.');
    expect(joinLines(['  first line ', '', 'second line'])).toBe('first line second line');
    expect(joinLines(['well-', 'Known names'])).toBe('well- Known names');
    expect(joinLines(['ends with 5-', '7 items'])).toBe('ends with 5- 7 items');
  });
});

describe('assignRoles', () => {
  const c = (pageIndex: number, sizePt: number, text: string, lineCount = 1): TextCandidate => ({
    pageIndex, sizePt, text, lineCount, bbox: { x: 0, y: 0, width: 10, height: 10 }, confidence: 0.9, align: 'left',
  });
  const body = c(0, 11, 'x'.repeat(400), 6);

  it('ranks sizes against body text and picks one title on the first page', () => {
    const cands = [c(0, 28, 'Report'), c(0, 21, 'Big section'), body, c(0, 16, 'Section'), c(0, 13.5, 'Subsection'), c(0, 12, 'Minor'), c(1, 30, 'Later huge')];
    expect(assignRoles(cands)).toEqual(['title', 'heading_1', 'body', 'heading_1', 'heading_2', 'heading_3', 'heading_1']);
  });

  it('keeps long or many-line paragraphs as body however large', () => {
    expect(assignRoles([body, c(0, 20, 'y'.repeat(250)), c(0, 20, 'four lines', 4)])).toEqual(['body', 'body', 'body']);
  });

  it('gives no title when nothing on page 1 is large enough', () => {
    expect(assignRoles([body, c(0, 18, 'Heading')])).toEqual(['body', 'heading_1']);
  });
});
