// Starts dist/scan2doc-mcp.mjs as an MCP host would (a child process over stdio)
// and drives it with the SDK's own client: list tools, list languages, convert
// a PDF, write documents. Usage: node scripts/smoke-mcp.mjs <file.pdf>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pdf = resolve(process.argv[2] ?? '');
if (!existsSync(pdf)) {
  console.error('usage: node scripts/smoke-mcp.mjs <file.pdf>');
  process.exit(2);
}
const server = fileURLToPath(new URL('../dist/scan2doc-mcp.mjs', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [server, '--root', dirname(pdf)], stderr: 'inherit' });
const client = new Client({ name: 'smoke-test', version: '1.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));
const langs = await client.callTool({ name: 'list_languages', arguments: {} });
console.log('languages:', langs.content[0].text.split('\n').length);
const started = Date.now();
const scan = await client.callTool({ name: 'scan_document', arguments: { path: basename(pdf) } });
console.log(`scan_document (${((Date.now() - started) / 1000).toFixed(1)} s):\n${scan.content[0].text}`);
if (scan.isError) process.exit(1);
const out = await client.callTool({ name: 'write_documents', arguments: { jobId: scan.structuredContent.jobId, formats: ['docx', 'odt'] } });
console.log(out.content[0].text);
await client.close();
process.exit(out.isError ? 1 : 0);
