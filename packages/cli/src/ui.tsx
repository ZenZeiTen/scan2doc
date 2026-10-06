import { Box, Text } from 'ink';
import type { DocumentCategory } from '@scan2doc/core';
import type { PageReport, RecognizeStage } from '@scan2doc/vision-wasm';
import type { OutputFormat } from './args.js';
import type { ConvertEvent } from './convert.js';
import { VERSION } from './version.js';

export interface ProgressState {
  file?: string;
  pageCount: number;
  dpi: number;
  /** Pages fully recognised so far. */
  pagesDone: number;
  current?: { page: number; sourcePage: number; stage: RecognizeStage };
  reports?: PageReport[];
  category?: DocumentCategory;
  writes: { format: OutputFormat; path: string; bytes?: number }[];
  seconds?: number;
  error?: string;
}

export const initialProgress = (): ProgressState => ({ pageCount: 0, dpi: 300, pagesDone: 0, writes: [] });

/** Folds conversion events into what the screen shows. */
export function progressReducer(s: ProgressState, e: ConvertEvent): ProgressState {
  switch (e.type) {
    case 'start':
      return { ...s, file: e.file, pageCount: e.pageCount, dpi: e.dpi };
    case 'page':
      // A page starting to render means every page before it is finished.
      return { ...s, current: { page: e.page, sourcePage: e.sourcePage, stage: e.stage }, pagesDone: e.stage === 'render' ? e.page : s.pagesDone };
    case 'recognized':
      return { ...s, pagesDone: s.pageCount, current: undefined, reports: e.reports, category: e.document.category };
    case 'write':
      return { ...s, writes: [...s.writes, { format: e.format, path: e.path }] };
    case 'written':
      return { ...s, writes: s.writes.map((w) => (w.format === e.format ? { ...w, bytes: e.bytes } : w)) };
  }
}

const STAGE_LABEL: Readonly<Record<RecognizeStage, string>> = {
  render: 'rendering',
  layout: 'analysing layout',
  ocr: 'reading text',
  tables: 'reading tables',
  escalate: 'escalating to AI',
};

const ACCENT = '#E3A13B';

function bar(done: number, total: number, width = 24): string {
  const filled = total ? Math.round((done / total) * width) : 0;
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function Step({ state, label, detail }: { state: 'done' | 'active' | 'waiting'; label: string; detail?: string }) {
  const mark = state === 'done' ? <Text color="green">✓</Text> : state === 'active' ? <Text color={ACCENT}>›</Text> : <Text dimColor>·</Text>;
  return (
    <Box gap={1}>
      {mark}
      <Box width={22}>
        <Text dimColor={state === 'waiting'}>{label}</Text>
      </Box>
      {detail !== undefined && <Text dimColor>{detail}</Text>}
    </Box>
  );
}

/** The live conversion screen (the CLI artboard on the design canvas). */
export function Progress({ s }: { s: ProgressState }) {
  const recognised = s.reports !== undefined;
  const fromPdf = s.reports?.filter((r) => r.textSource === 'pdf').length ?? 0;
  const review = s.reports?.filter((r) => r.quality.issues.length > 0) ?? [];
  return (
    <Box flexDirection="column" paddingY={1}>
      <Text>
        <Text bold color={ACCENT}>
          scan2doc
        </Text>
        <Text dimColor>
          {' '}
          {VERSION}
          {s.file ? ` · ${s.file} · ${s.pageCount} page${s.pageCount === 1 ? '' : 's'} · ${s.dpi} dpi` : ''}
        </Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Step
          state={recognised ? 'done' : s.file ? 'active' : 'waiting'}
          label="Recognise pages"
          detail={
            recognised
              ? `${s.pageCount}/${s.pageCount} · ${fromPdf} from the PDF's text, ${s.pageCount - fromPdf} by OCR`
              : s.file
                ? `${bar(s.pagesDone, s.pageCount)} ${s.pagesDone}/${s.pageCount}${s.current ? ` · page ${s.current.sourcePage + 1}: ${STAGE_LABEL[s.current.stage]}` : ''}`
                : undefined
          }
        />
        {recognised && <Step state="done" label="Classify" detail={s.category} />}
        {s.writes.map((w) => (
          <Step key={w.format} state={w.bytes !== undefined ? 'done' : 'active'} label={`Write .${w.format}`} detail={w.bytes !== undefined ? `${w.path} · ${size(w.bytes)}` : undefined} />
        ))}
      </Box>
      {review.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="yellow">
            {review.length} page{review.length === 1 ? '' : 's'} need{review.length === 1 ? 's' : ''} review:
          </Text>
          {review.map((r) => (
            <Text key={r.sourcePage}>
              {'  '}page {r.sourcePage + 1}: {r.quality.issues.map((i) => i.detail).join('; ')}
            </Text>
          ))}
          <Text dimColor>{'  '}Run `scan2doc mcp` from an AI host (Claude Desktop, Claude Code) to have a model repair these pages.</Text>
        </Box>
      )}
      {s.seconds !== undefined && <Text dimColor>{`\nDone in ${s.seconds.toFixed(1)} s.`}</Text>}
      {s.error && <Text color="red">{`\nError: ${s.error}`}</Text>}
    </Box>
  );
}
