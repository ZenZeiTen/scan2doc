import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Chromium browsers that can show a page as a plain app window (`--app`), most likely first. */
export function appBrowserCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform === 'win32') {
    const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter((r): r is string => !!r);
    return roots.flatMap((root) => [join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')]);
  }
  if (process.platform === 'darwin') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
}

/** Opens a URL in the default browser. */
export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '""', `"${url}"`]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args as string[], { detached: true, stdio: 'ignore', windowsVerbatimArguments: process.platform === 'win32' }).on('error', () => {}).unref();
}

/**
 * Shows the app in its own window: a Chromium browser in app mode (no tabs or
 * address bar) with its own profile, so it is a window of its own and never a
 * tab in the person's browser. Falls back to the default browser.
 * Returns which it did.
 */
export function openAppWindow(url: string, profileDir: string, candidates = appBrowserCandidates()): 'app' | 'browser' {
  const browser = candidates.find((p) => existsSync(p));
  if (!browser) {
    openInBrowser(url);
    return 'browser';
  }
  spawn(browser, [`--app=${url}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1440,920'], {
    detached: true,
    stdio: 'ignore',
  })
    .on('error', () => openInBrowser(url))
    .unref();
  return 'app';
}

/**
 * Hides the console window when Scan2Doc was double-clicked: Windows gave it a
 * console of its own, which would otherwise sit behind the app. A console that
 * other programs share (a terminal it was started from) is left alone.
 */
export function hideOwnConsole(): void {
  if (process.platform !== 'win32') return;
  const script = [
    'Add-Type -Name W -Namespace S2D -MemberDefinition \'[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); [DllImport("kernel32.dll")] public static extern uint GetConsoleProcessList(uint[] l, uint n);\'',
    '$l = New-Object "uint32[]" 16',
    // Scan2Doc plus this PowerShell: nobody else is using the window.
    'if ([S2D.W]::GetConsoleProcessList($l, 16) -le 2) { [void][S2D.W]::ShowWindow([S2D.W]::GetConsoleWindow(), 0) }',
  ].join('; ');
  // Not detached and not windowsHide: PowerShell must share Scan2Doc's console to see it.
  spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' }).on('error', () => {});
}

/** Opens `path`'s folder with the file selected, where the platform allows it. */
export function revealInFileManager(path: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['explorer.exe', [`/select,${path}`]] : process.platform === 'darwin' ? ['open', ['-R', path]] : ['xdg-open', [path.replace(/[\/][^\/]*$/, '')]];
  spawn(cmd, args as string[], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}
