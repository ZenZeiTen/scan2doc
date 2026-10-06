import { execFile } from 'node:child_process';

/** Native file dialogs: Windows only (through PowerShell and Windows Forms). */
export interface Dialogs {
  readonly available: boolean;
  /** The chosen PDF paths; empty when cancelled. */
  openPdfs(): Promise<string[]>;
  /** The chosen path to save to, or null when cancelled. */
  savePdf(suggestedName: string, folder?: string): Promise<string | null>;
  /** The chosen folder, or null when cancelled. */
  pickFolder(start?: string): Promise<string | null>;
}

// Inputs reach the scripts as environment variables, never spliced into the script text.
// An owner window set TopMost brings each dialog in front of the app window.
const PRELUDE = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Windows.Forms.Application]::EnableVisualStyles()',
  '$owner = New-Object Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = "CenterScreen" }',
  '$owner.Show(); $owner.Activate()',
].join('; ');

const SCRIPTS = {
  open: [
    '$d = New-Object Windows.Forms.OpenFileDialog',
    '$d.Title = "Open PDF files"',
    '$d.Filter = "PDF files (*.pdf)|*.pdf|All files (*.*)|*.*"',
    '$d.Multiselect = $true',
    'if ($d.ShowDialog($owner) -eq "OK") { ConvertTo-Json -Compress -InputObject @($d.FileNames) } else { "[]" }',
  ],
  save: [
    '$d = New-Object Windows.Forms.SaveFileDialog',
    '$d.Title = "Save PDF"',
    '$d.Filter = "PDF files (*.pdf)|*.pdf"',
    '$d.FileName = $env:S2D_NAME',
    'if ($env:S2D_FOLDER) { $d.InitialDirectory = $env:S2D_FOLDER }',
    '$d.OverwritePrompt = $true',
    'if ($d.ShowDialog($owner) -eq "OK") { ConvertTo-Json -Compress -InputObject @($d.FileName) } else { "[]" }',
  ],
  folder: [
    '$d = New-Object Windows.Forms.FolderBrowserDialog',
    '$d.Description = "Choose where to save the files"',
    'if ($env:S2D_FOLDER) { $d.SelectedPath = $env:S2D_FOLDER }',
    'if ($d.ShowDialog($owner) -eq "OK") { ConvertTo-Json -Compress -InputObject @($d.SelectedPath) } else { "[]" }',
  ],
} as const;

function run(kind: keyof typeof SCRIPTS, env: Record<string, string> = {}): Promise<string[]> {
  const script = `${PRELUDE}; ${SCRIPTS[kind].join('; ')}; $owner.Close()`;
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`The file dialog could not open: ${(stderr || err.message).trim().split('\n')[0]}`));
        try {
          const paths = JSON.parse(stdout.trim() || '[]') as unknown;
          resolve(Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && p !== '') : []);
        } catch {
          reject(new Error('The file dialog returned something unexpected.'));
        }
      },
    );
  });
}

export const windowsDialogs: Dialogs = {
  available: true,
  openPdfs: () => run('open'),
  savePdf: async (name, folder) => (await run('save', { S2D_NAME: name, S2D_FOLDER: folder ?? '' }))[0] ?? null,
  pickFolder: async (start) => (await run('folder', { S2D_FOLDER: start ?? '' }))[0] ?? null,
};

export const noDialogs: Dialogs = {
  available: false,
  openPdfs: async () => [],
  savePdf: async () => null,
  pickFolder: async () => null,
};

export const platformDialogs = (): Dialogs => (process.platform === 'win32' ? windowsDialogs : noDialogs);
