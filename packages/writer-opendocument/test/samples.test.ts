import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { writeOpenXml } from '@scan2doc/writer-openxml';
import { writeOpenDocument } from '../src/index.js';
import { sampleDocument } from '../../../test/support/sample-doc.js';

/**
 * Writes all six formats to .samples/ so scripts/verify-office.ps1 can open
 * them in real Word / Excel / PowerPoint.
 */
const OUT = fileURLToPath(new URL('../../../.samples/', import.meta.url));

describe('sample files', () => {
  it('writes every format to .samples/', async () => {
    mkdirSync(OUT, { recursive: true });
    const doc = sampleDocument();
    for (const f of ['docx', 'xlsx', 'pptx'] as const) writeFileSync(`${OUT}sample.${f}`, await writeOpenXml(doc, f));
    for (const f of ['odt', 'ods', 'odp'] as const) writeFileSync(`${OUT}sample.${f}`, await writeOpenDocument(doc, f));
    expect(true).toBe(true);
  });
});
