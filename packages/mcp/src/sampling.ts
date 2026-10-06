import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CreateMessageRequest } from '@modelcontextprotocol/sdk/types.js';
import type { PageEscalator } from '@scan2doc/vision-wasm';
import { parseRepair, REPAIR_SYSTEM_PROMPT, repairPrompt } from './repair.js';

type SamplingMessage = CreateMessageRequest['params']['messages'][number];

export interface SamplingOptions {
  /** Reply budget; a dense page of JSON blocks needs several thousand tokens. */
  maxTokens?: number;
  /** Tries per page; each retry shows the model what was wrong with its last answer. */
  maxAttempts?: number;
}

/** Does the connected MCP client let this server ask its model for completions? */
export const canSample = (server: Server) => server.getClientCapabilities()?.sampling !== undefined;

const textOf = (content: unknown): string => {
  const parts = Array.isArray(content) ? content : [content];
  return parts
    .filter((c): c is { type: 'text'; text: string } => (c as { type?: string })?.type === 'text')
    .map((c) => c.text)
    .join('\n');
};

/**
 * Escalates failed pages to the host's AI model through MCP sampling
 * (`sampling/createMessage`): the model sees the page image and the OCR
 * draft and answers with blocks. The host decides which model answers and
 * may ask the user to approve each request; no API key lives in Scan2Doc.
 */
export function samplingEscalator(server: Server, options: SamplingOptions = {}): PageEscalator {
  const maxTokens = options.maxTokens ?? 8192;
  const maxAttempts = options.maxAttempts ?? 2;
  return async (req) => {
    const ctx = { image: req.image, page: req.page, crops: req.crops };
    const messages: SamplingMessage[] = [
      { role: 'user', content: { type: 'image', data: Buffer.from(req.image.png).toString('base64'), mimeType: 'image/png' } },
      { role: 'user', content: { type: 'text', text: repairPrompt(req) } },
    ];
    let lastError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const reply = await server.createMessage({
        messages,
        systemPrompt: REPAIR_SYSTEM_PROMPT,
        maxTokens,
        temperature: 0,
        includeContext: 'none',
        modelPreferences: { intelligencePriority: 0.9, speedPriority: 0.2, costPriority: 0.3 },
      });
      const text = textOf(reply.content);
      const parsed = parseRepair(text, ctx);
      if (parsed.ok) return { blocks: parsed.blocks, ...(parsed.language && { language: parsed.language }) };
      lastError = parsed.error;
      messages.push(
        { role: 'assistant', content: { type: 'text', text } },
        { role: 'user', content: { type: 'text', text: `That reply could not be used: ${parsed.error}. Answer again with only the corrected JSON object.` } },
      );
    }
    throw new Error(`model reply unusable after ${maxAttempts} attempts: ${lastError}`);
  };
}
