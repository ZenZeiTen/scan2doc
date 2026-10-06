import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { settingsDir } from './recent.js';

const file = (dir = settingsDir()) => join(dir, 'instance.json');

/** Records the running app's address (with its token) for the next launch to find. */
export function rememberInstance(url: string, dir?: string): void {
  try {
    mkdirSync(dirname(file(dir)), { recursive: true });
    writeFileSync(file(dir), JSON.stringify({ url, pid: process.pid }));
  } catch {
    // Without the note, a second launch simply starts a second app.
  }
}

export function forgetInstance(url: string, dir?: string): void {
  try {
    if ((JSON.parse(readFileSync(file(dir), 'utf8')) as { url?: string }).url === url) rmSync(file(dir), { force: true });
  } catch {
    // Nothing recorded.
  }
}

/** The address of an app that is still running and answering, if any. */
export async function runningInstance(dir?: string): Promise<string | null> {
  let url: string;
  try {
    url = (JSON.parse(readFileSync(file(dir), 'utf8')) as { url: string }).url;
    if (!/^http:\/\/127\.0\.0\.1:\d+\/\?t=[\w-]+$/.test(url)) return null;
  } catch {
    return null;
  }
  try {
    const state = new URL(url);
    state.pathname = '/api/state';
    const res = await fetch(state, { signal: AbortSignal.timeout(1500) });
    return res.ok ? url : null;
  } catch {
    return null;
  }
}
