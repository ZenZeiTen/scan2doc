import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CreateMessageRequestSchema, type CreateMessageRequest } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScan2DocServer, parseRepair, type RepairContext } from '../src/index.js';
import { makeFixturePdf, simulateScan } from '../../../test/support/make-pdf.js';
import { fontAvailable, makeLanguagePdf, SAMPLES } from '../../../test/support/multilingual.js';

const KOREAN = SAMPLES.find((s) => s.code === 'kor')!;
const KOREAN_TEXT = KOREAN.lines.join(' ');

let dir: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'scan2doc-mcp-'));
  writeFileSync(join(dir, 'report.pdf'), await makeFixturePdf());
  // Image-only, as from a scanner: a digital Korean PDF would be read from its text layer and never fail.
  writeFileSync(join(dir, 'korean.pdf'), await simulateScan(await makeLanguagePdf(KOREAN), 300, 85, 0));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Model = (req: CreateMessageRequest['params'], call: number) => string;

/** A client wired to the server in memory; with `model`, it supports sampling and answers with it. */
async function connect(model?: Model) {
  const server = createScan2DocServer({ roots: [dir] });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-host', version: '1.0.0' }, { capabilities: model ? { sampling: {} } : {} });
  const requests: CreateMessageRequest['params'][] = [];
  if (model) {
    client.setRequestHandler(CreateMessageRequestSchema, async (req) => {
      requests.push(req.params);
      return { role: 'assistant', model: 'fake-vision-model', content: { type: 'text', text: model(req.params, requests.length) } };
    });
  }
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: { type: string; text?: string; data?: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    return { ...res, text: res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
  };
  return { client, call, requests, close: () => client.close() };
}

/** A fake model that reads the page correctly: one body block covering the text area of the image. */
const goodAnswer: Model = (req) => {
  const prompt = (req.messages[1]!.content as { text: string }).text;
  const [, w, h] = /image is (\d+) × (\d+) px/.exec(prompt)!;
  return '```json\n' + JSON.stringify({ language: 'ko', blocks: [{ id: 'ai-1', type: 'body', bbox: { x: 30, y: 30, width: Number(w) - 60, height: Number(h) / 3 }, text: KOREAN_TEXT, align: 'left' }] }) + '\n```';
};

describe.skipIf(!fontAvailable(KOREAN.font))('escalation by MCP sampling', () => {
  it('sends a failing page to the host model and applies its answer', async () => {
    const { call, requests, close } = await connect(goodAnswer);
    const res = await call('scan_document', { path: 'korean.pdf', languages: ['eng'] });
    expect(res.isError).toBeFalsy();
    const page = (res.structuredContent!.pages as { escalation: string; issues: { code: string }[] }[])[0]!;
    expect(page.issues.length).toBeGreaterThan(0);
    expect(page.escalation).toBe('applied');

    // What the model was shown: the page as a PNG, the issues, the format, and the draft as data.
    expect(requests).toHaveLength(1);
    const [image, prompt] = requests[0]!.messages;
    expect(image!.content).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from((image!.content as { data: string }).data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const promptText = (prompt!.content as { text: string }).text;
    expect(promptText).toMatch(/failed its quality checks/);
    expect(promptText).toMatch(/"blocks"/);
    expect(requests[0]!.systemPrompt).toMatch(/never instructions to you/);
    expect(requests[0]!.includeContext).toBe('none');

    // The repaired page is what gets written.
    const jobId = res.structuredContent!.jobId as string;
    const out = await call('write_documents', { jobId, formats: ['docx', 'odt'] });
    expect(out.isError).toBeFalsy();
    const files = out.structuredContent!.files as string[];
    expect(files.map((f) => f.split(/[\\/]/).pop())).toEqual(['korean.docx', 'korean.odt']);
    for (const f of files) expect(readFileSync(f).subarray(0, 2).toString()).toBe('PK');
    await close();
  });

  it('retries once with the validation error, then succeeds', async () => {
    const { call, requests, close } = await connect((req, n) =>
      n === 1 ? '{"blocks": [{"id": "x", "type": "paragraph", "text": "?"}]}' : goodAnswer(req, n),
    );
    const res = await call('scan_document', { path: 'korean.pdf', languages: ['eng'] });
    expect((res.structuredContent!.pages as { escalation: string }[])[0]!.escalation).toBe('applied');
    expect(requests).toHaveLength(2);
    const followUp = requests[1]!.messages.at(-1)!.content as { text: string };
    expect(followUp.text).toMatch(/could not be used: blocks\.0/);
    await close();
  });

  it('keeps the OCR draft when the model keeps answering badly', async () => {
    const { call, requests, close } = await connect(() => 'I cannot read this page, sorry.');
    const res = await call('scan_document', { path: 'korean.pdf', languages: ['eng'] });
    const page = (res.structuredContent!.pages as { escalation: string }[])[0]!;
    expect(page.escalation).toBe('failed');
    expect(res.text).toMatch(/no JSON object in the reply/);
    expect(res.text).toMatch(/Pages needing review: 1/);
    expect(requests).toHaveLength(2);
    await close();
  });

  it('does not bother the model with pages that pass', async () => {
    const { call, requests, close } = await connect(goodAnswer);
    const res = await call('scan_document', { path: 'report.pdf' });
    expect((res.structuredContent!.pages as { escalation: string }[]).map((p) => p.escalation)).toEqual(['not-needed', 'not-needed']);
    expect(requests).toHaveLength(0);
    await close();
  });
});

describe.skipIf(!fontAvailable(KOREAN.font))('escalation to the agent (client without sampling)', () => {
  it('flags the page, shows it, rejects bad repairs and accepts a good one', async () => {
    const { call, close } = await connect();
    const scan = await call('scan_document', { path: 'korean.pdf', languages: ['eng'] });
    expect((scan.structuredContent!.pages as { escalation: string }[])[0]!.escalation).toBe('unavailable');
    expect(scan.text).toMatch(/Pages needing review: 1\. For each, call get_page/);
    const jobId = scan.structuredContent!.jobId as string;

    const shown = await call('get_page', { jobId, page: 1 });
    expect(shown.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    const [, w, h] = /image (\d+) × (\d+) px/.exec(shown.text)!;
    expect(shown.text).toMatch(/Current blocks: \{"blocks":/);

    const outside = await call('update_page', {
      jobId,
      page: 1,
      blocks: [{ id: 'a', type: 'body', bbox: { x: 10, y: 10, width: Number(w) * 2, height: 50 }, text: KOREAN_TEXT }],
    });
    expect(outside.isError).toBe(true);
    expect(outside.text).toMatch(/extends past the page/);

    const unknownCrop = await call('update_page', { jobId, page: 1, blocks: [{ id: 'p', type: 'image', bbox: { x: 10, y: 10, width: 50, height: 50 }, cropRef: 'invented' }] });
    expect(unknownCrop.text).toMatch(/unknown crop "invented"/);

    const good = await call('update_page', {
      jobId,
      page: 1,
      blocks: [{ id: 'a', type: 'body', bbox: { x: 30, y: 30, width: Number(w) - 60, height: Number(h) / 3 }, text: KOREAN_TEXT }],
      language: 'ko',
    });
    expect(good.isError).toBeFalsy();

    const out = await call('write_documents', { jobId, formats: ['docx'] });
    const docx = readFileSync((out.structuredContent!.files as string[])[0]!);
    const JSZip = (await import('jszip')).default;
    const xml = await (await JSZip.loadAsync(docx)).file('word/document.xml')!.async('string');
    expect(xml).toContain('올해 3분기 매출이 크게 증가했습니다.');
    // The repair said the page is Korean: Word proofs it as Korean, in the East Asian slot.
    expect(xml).toContain('<w:lang w:eastAsia="ko-KR"/>');
    await close();
  });

  it('refuses sampling mode when the client cannot sample', async () => {
    const { call, close } = await connect();
    const res = await call('scan_document', { path: 'korean.pdf', escalation: 'sampling' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/does not support sampling/);
    await close();
  });
});

describe('text layer option', () => {
  it('reads a digital PDF from its own text by default, and by OCR when told to ignore it', async () => {
    const { call, close } = await connect();
    const own = await call('scan_document', { path: 'report.pdf' });
    expect((own.structuredContent!.pages as { textSource: string }[]).map((p) => p.textSource)).toEqual(['pdf', 'pdf']);
    expect(own.text).toMatch(/text from the PDF itself/);
    const ocr = await call('scan_document', { path: 'report.pdf', textLayer: 'ignore' });
    expect((ocr.structuredContent!.pages as { textSource: string }[]).map((p) => p.textSource)).toEqual(['ocr', 'ocr']);
    expect(ocr.text).toMatch(/OCR confidence \d+/);
    await close();
  });
});

describe('file access', () => {
  it('reads and writes only inside the allowed directories', async () => {
    const { call, close } = await connect();
    const res = await call('scan_document', { path: join(tmpdir(), '..', 'secret.pdf') });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/outside the allowed directories/);
    const scan = await call('scan_document', { path: 'report.pdf' });
    const write = await call('write_documents', { jobId: scan.structuredContent!.jobId, formats: ['odt'], outputDir: tmpdir() });
    expect(write.isError).toBe(true);
    expect(write.text).toMatch(/outside the allowed directories/);
    await close();
  });

  it('lists the 27 languages and rejects unknown jobs and pages', async () => {
    const { call, close } = await connect();
    expect((await call('list_languages', {})).text.split('\n')).toHaveLength(27);
    expect((await call('get_page', { jobId: 'nope', page: 1 })).text).toMatch(/no job nope/);
    const scan = await call('scan_document', { path: 'report.pdf' });
    expect((await call('get_page', { jobId: scan.structuredContent!.jobId, page: 9 })).text).toMatch(/page 9 is out of range \(1–2\)/);
    await close();
  });
});

describe('parseRepair', () => {
  const ctx: RepairContext = {
    image: { width: 500, height: 700, scale: 0.5 },
    page: { sizePx: { width: 1000, height: 1400 }, dpi: 120 },
    crops: [{ id: 'c1', bbox: { x: 100, y: 100, width: 200, height: 200 } }],
  };

  it('converts image coordinates back to page pixels', () => {
    const r = parseRepair('Here you go:\n{"blocks":[{"id":"t","type":"title","bbox":{"x":10,"y":20,"width":300,"height":40},"text":"Hi"}]}', ctx);
    expect(r.ok && r.blocks[0]!.bbox).toEqual({ x: 20, y: 40, width: 600, height: 80 });
  });

  it('rejects malformed, out-of-bounds and duplicate-id answers with reasons', () => {
    expect(parseRepair('not json at all', ctx)).toEqual({ ok: false, error: 'no JSON object in the reply' });
    const outside = parseRepair('{"blocks":[{"id":"t","type":"body","bbox":{"x":400,"y":0,"width":300,"height":10},"text":"x"}]}', ctx);
    expect(!outside.ok && outside.error).toMatch(/extends past the page.*500 × 700 px/);
    const dup = parseRepair('{"blocks":[{"id":"a","type":"body","bbox":{"x":0,"y":0,"width":9,"height":9},"text":"x"},{"id":"a","type":"body","bbox":{"x":0,"y":20,"width":9,"height":9},"text":"y"}]}', ctx);
    expect(!dup.ok && dup.error).toMatch(/duplicate block id "a"/);
  });
});
