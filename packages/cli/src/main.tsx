import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command, CommanderError, Option } from 'commander';
import { render } from 'ink';
import { LANGUAGES } from '@scan2doc/core';
import { parseFormats, parseLanguages, parsePages, UsageError } from './args.js';
import { pagesNeedingReview, runConvert, type ConvertEvent, type ConvertResult } from './convert.js';
import { platformDialogs } from './app/dialogs.js';
import { forgetInstance, rememberInstance, runningInstance } from './app/instance.js';
import { RecentFiles } from './app/recent.js';
import { startApp } from './app/server.js';
import { hideOwnConsole, openAppWindow, revealInFileManager } from './app/window.js';
import { initialProgress, Progress, progressReducer } from './ui.js';
import { VERSION } from './version.js';

/** Exit codes: success, failure, bad usage, and (with --strict) converted but pages need review. */
export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, NEEDS_REVIEW: 3 } as const;

export interface Io {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  env: NodeJS.ProcessEnv;
}

interface ConvertFlags {
  format: string[];
  out?: string;
  lang: string;
  pages?: string;
  dpi: string;
  textLayer: 'auto' | 'include-hidden' | 'ignore';
  password?: string;
  force?: boolean;
  json?: boolean;
  quiet?: boolean;
  strict?: boolean;
}

function summaryJson(input: string, r: ConvertResult) {
  return {
    input,
    category: r.document.category,
    language: r.document.metadata.language,
    seconds: Number(r.seconds.toFixed(2)),
    outputs: r.outputs,
    pages: r.reports.map((p) => ({
      // The PDF's page number, which is what the user asked for with --pages.
      page: p.sourcePage + 1,
      language: r.document.pages[p.index]!.language ?? null,
      textSource: p.textSource,
      rotation: p.rotation,
      wordConfidence: Number.isNaN(p.quality.wordConfidence) ? null : Math.round(p.quality.wordConfidence),
      issues: p.quality.issues,
      ...(p.textNote && { note: p.textNote }),
    })),
  };
}

async function convert(input: string, flags: ConvertFlags, io: Io): Promise<number> {
  const options = {
    input,
    formats: parseFormats(flags.format),
    ...(flags.out && { outDir: flags.out }),
    languages: parseLanguages(flags.lang),
    ...(flags.pages && { pages: parsePages(flags.pages) }),
    dpi: Number(flags.dpi),
    textLayer: flags.textLayer,
    // An environment variable keeps the password out of shell history and process lists.
    ...((flags.password ?? io.env.SCAN2DOC_PASSWORD) && { password: flags.password ?? io.env.SCAN2DOC_PASSWORD }),
    force: flags.force ?? false,
  };
  if (!Number.isInteger(options.dpi) || options.dpi < 100 || options.dpi > 600) throw new UsageError('--dpi must be a whole number from 100 to 600');

  // The live screen goes to stderr, so stdout stays clean for --json.
  const live = !flags.json && !flags.quiet && io.stderr.isTTY;
  let state = initialProgress();
  const screen = live ? render(<Progress s={state} />, { stdout: io.stderr, patchConsole: false }) : undefined;
  const onEvent = (e: ConvertEvent) => {
    state = progressReducer(state, e);
    screen?.rerender(<Progress s={state} />);
    if (!live && !flags.json && !flags.quiet && e.type === 'written') io.stderr.write(`wrote ${e.path}\n`);
  };
  try {
    const result = await runConvert(options, onEvent);
    state = { ...state, seconds: result.seconds };
    screen?.rerender(<Progress s={state} />);
    screen?.unmount();
    if (flags.json) io.stdout.write(`${JSON.stringify(summaryJson(input, result), null, 2)}\n`);
    else if (!live && !flags.quiet) {
      for (const r of pagesNeedingReview(result.reports)) io.stderr.write(`page ${r.sourcePage + 1} needs review: ${r.quality.issues.map((i) => i.detail).join('; ')}\n`);
    }
    return flags.strict && pagesNeedingReview(result.reports).length > 0 ? EXIT.NEEDS_REVIEW : EXIT.OK;
  } catch (err) {
    state = { ...state, error: (err as Error).message };
    screen?.rerender(<Progress s={state} />);
    screen?.unmount();
    throw err;
  }
}

export function program(io: Io): Command {
  const cli = new Command('scan2doc')
    .description('Convert PDF scans into editable Office (.docx .xlsx .pptx) and OpenDocument (.odt .ods .odp) files.')
    .version(VERSION, '-v, --version')
    .configureOutput({ writeOut: (s) => io.stdout.write(s), writeErr: (s) => io.stderr.write(s) })
    .exitOverride();

  cli
    .command('convert')
    .description('convert a PDF (scanned or digital)')
    .argument('<input.pdf>', 'the PDF to convert')
    .addOption(new Option('-f, --format <formats...>', 'docx xlsx pptx odt ods odp, or auto (by document type)').default(['auto']))
    .option('-o, --out <dir>', 'output directory (default: next to the PDF)')
    .option('-l, --lang <codes>', 'auto, or Tesseract codes such as jpn+eng (see `scan2doc languages`)', 'auto')
    .option('-p, --pages <ranges>', 'pages to convert, e.g. 1-3,5')
    .option('--dpi <n>', 'render resolution for OCR', '300')
    .addOption(new Option('--text-layer <mode>', 'use the PDF’s own text: auto, include-hidden, ignore').choices(['auto', 'include-hidden', 'ignore']).default('auto'))
    .option('--password <password>', 'password of an encrypted PDF (or set SCAN2DOC_PASSWORD)')
    .option('--force', 'overwrite existing output files')
    .option('--json', 'print a JSON summary on stdout')
    .option('-q, --quiet', 'no progress output')
    .option('--strict', `exit with code ${EXIT.NEEDS_REVIEW} when any page needs review`)
    .action(async (input: string, flags: ConvertFlags) => {
      cli.setOptionValue('exitCode', await convert(input, flags, io));
    });

  cli
    .command('ui')
    .description('open the Scan2Doc app window (what double-clicking scan2doc does)')
    .option('-o, --out <dir>', 'where files go for documents with no folder of their own', join(homedir(), 'Documents', 'Scan2Doc'))
    .option('--port <n>', 'port on 127.0.0.1 (default: any free one)', '0')
    .option('--no-open', 'do not open a window; just print the address')
    .option('--stay', 'keep running after the window is closed')
    .addOption(new Option('--launched').hideHelp())
    .action(async (flags: { out: string; port: string; open: boolean; stay?: boolean; launched?: boolean }) => {
      const port = Number(flags.port);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new UsageError('--port must be a whole number from 0 to 65535');
      const profile = join(process.env.LOCALAPPDATA ?? join(homedir(), '.cache'), 'Scan2Doc', 'Window');
      // A second double-click opens another window onto the app already running.
      const running = flags.open && port === 0 ? await runningInstance() : null;
      if (running) {
        openAppWindow(running, profile);
        io.stderr.write(`Scan2Doc is already running; opened another window.\n`);
        return;
      }
      if (flags.launched) hideOwnConsole();
      const app = await startApp({
        outDir: resolve(flags.out),
        port,
        dialogs: platformDialogs(),
        recent: new RecentFiles(),
        reveal: revealInFileManager,
        ...(!flags.stay && flags.open && { idleQuitMs: 12_000 }),
        onQuit: () => {
          io.stderr.write('Scan2Doc stopped.\n');
          forgetInstance(app.url);
          void app.close();
        },
      });
      rememberInstance(app.url);
      io.stderr.write(`Scan2Doc is running at ${app.url}\nClose its window to stop it.\n`);
      if (flags.open) openAppWindow(app.url, profile);
      // Like mcp: the process lives as long as the server does.
      cli.setOptionValue('serving', true);
    });

  cli
    .command('languages')
    .description('list the languages scan2doc can read')
    .action(() => {
      for (const l of LANGUAGES) io.stdout.write(`${l.code.padEnd(8)} ${l.name} (${l.bcp47})\n`);
    });

  cli
    .command('mcp')
    .description('run as an MCP server over stdio, for AI hosts such as Claude Desktop')
    .option('--root <dir...>', 'directories the server may read PDFs from and write to (default: current directory)')
    .action(async (flags: { root?: string[] }) => {
      const [{ createScan2DocServer }, { StdioServerTransport }] = await Promise.all([
        import('@scan2doc/mcp'),
        import('@modelcontextprotocol/sdk/server/stdio.js'),
      ]);
      const roots = flags.root?.length ? flags.root : [process.cwd()];
      await createScan2DocServer({ roots }).connect(new StdioServerTransport());
      io.stderr.write(`scan2doc mcp ready; allowed directories: ${roots.join(', ')}\n`);
      // Keep the exit code unset: the process lives as long as the host keeps stdio open.
      cli.setOptionValue('serving', true);
    });

  return cli;
}

/** Runs the CLI; resolves to the exit code (or undefined for the long-running mcp server). */
/** No arguments is what a double-click gives: open the app rather than print help into a window that closes. */
export const withDefaultCommand = (argv: readonly string[]): string[] => (argv.length === 0 ? ['ui', '--launched'] : [...argv]);

export async function main(argv: readonly string[], io: Io): Promise<number | undefined> {
  const cli = program(io);
  try {
    await cli.parseAsync(withDefaultCommand(argv), { from: 'user' });
    if (cli.getOptionValue('serving')) return undefined;
    return (cli.getOptionValue('exitCode') as number | undefined) ?? EXIT.OK;
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help and --version also arrive here, with exit code 0.
      return err.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
    }
    if (err instanceof UsageError) {
      io.stderr.write(`scan2doc: ${err.message}\n`);
      return EXIT.USAGE;
    }
    io.stderr.write(`scan2doc: ${(err as Error).message}\n`);
    return EXIT.FAILED;
  }
}
