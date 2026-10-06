#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createScan2DocServer } from './server.js';

/**
 * stdio entry for MCP hosts:  scan2doc-mcp --root <dir> [--root <dir> …]
 * Without --root the server may use only the directory it was started in.
 * stdout carries the protocol, so diagnostics go to stderr.
 */
const roots: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1]) roots.push(args[++i]!);
  else {
    process.stderr.write(`scan2doc-mcp: unknown argument ${args[i]}\nusage: scan2doc-mcp [--root <dir>]...\n`);
    process.exit(2);
  }
}

const server = createScan2DocServer({ roots: roots.length ? roots : [process.cwd()] });
await server.connect(new StdioServerTransport());
process.stderr.write(`scan2doc-mcp ready; allowed directories: ${(roots.length ? roots : [process.cwd()]).join(', ')}\n`);
