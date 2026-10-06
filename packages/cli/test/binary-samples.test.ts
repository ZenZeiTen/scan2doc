import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeFixturePdf, simulateScan } from '../../../test/support/make-pdf.js';
import { fontAvailable, makeLanguagePdf, SAMPLES } from '../../../test/support/multilingual.js';

/**
 * Writes the PDFs scripts/verify-binary.mjs feeds the built executable:
 * a digital and a scanned report, a Japanese page and an Indonesian page.
 */
const OUT = fileURLToPath(new URL('../../../.samples/bin/', import.meta.url));

describe('binary sample files', () => {
  it('writes the PDFs the executable is checked against', async () => {
    const japanese = SAMPLES.find((s) => s.code === 'jpn')!;
    const indonesian = SAMPLES.find((s) => s.code === 'ind')!;
    // Without the system fonts the samples cannot be drawn: fail visibly rather than skip.
    expect(fontAvailable(japanese.font), japanese.font).toBe(true);
    expect(fontAvailable(indonesian.font), indonesian.font).toBe(true);

    mkdirSync(OUT, { recursive: true });
    const report = await makeFixturePdf();
    writeFileSync(`${OUT}report-digital.pdf`, report);
    writeFileSync(`${OUT}report-scan.pdf`, await simulateScan(report, 300, 85, 0));
    writeFileSync(`${OUT}japanese.pdf`, await makeLanguagePdf(japanese));
    writeFileSync(`${OUT}indonesian.pdf`, await makeLanguagePdf(indonesian));
  });
});
