import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export interface RecentFile {
  path: string;
  name: string;
  folder: string;
  /** Epoch milliseconds. */
  openedAt: number;
}

const MAX_RECENT = 20;

/** Per-user settings folder: %APPDATA%\Scan2Doc, else ~/.config/scan2doc. */
export function settingsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.APPDATA ? join(env.APPDATA, 'Scan2Doc') : join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'scan2doc');
}

/** The recently opened files, newest first, kept in a small JSON file. */
export class RecentFiles {
  private readonly file: string;

  constructor(dir = settingsDir()) {
    this.file = join(dir, 'recent.json');
  }

  /** Newest first; files that have since been moved or deleted are left out. */
  list(): RecentFile[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((r): r is RecentFile => typeof r?.path === 'string' && typeof r?.openedAt === 'number')
        .filter((r) => existsSync(r.path))
        .map((r) => ({ path: r.path, name: basename(r.path), folder: dirname(r.path), openedAt: r.openedAt }));
    } catch {
      return [];
    }
  }

  add(path: string, now = Date.now()): RecentFile[] {
    const list = [{ path, name: basename(path), folder: dirname(path), openedAt: now }, ...this.list().filter((r) => r.path.toLowerCase() !== path.toLowerCase())].slice(0, MAX_RECENT);
    this.write(list);
    return list;
  }

  remove(path: string): RecentFile[] {
    const list = this.list().filter((r) => r.path.toLowerCase() !== path.toLowerCase());
    this.write(list);
    return list;
  }

  private write(list: RecentFile[]) {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(list.map(({ path, openedAt }) => ({ path, openedAt })), null, 1));
    } catch {
      // A read-only profile only loses the list.
    }
  }
}
