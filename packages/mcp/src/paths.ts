import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

const caseFold = process.platform === 'win32' || process.platform === 'darwin' ? (p: string) => p.toLowerCase() : (p: string) => p;

/** Resolves symlinks (and, for files not yet written, their directory). */
function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(realpathSync.native(dirname(p)), p.slice(dirname(p).length + 1));
  }
}

/**
 * Confines every path a model hands the server to the directories the user
 * started it with: an AI client must not be able to read or overwrite files
 * elsewhere through Scan2Doc.
 */
export class Roots {
  private readonly roots: string[];

  constructor(roots: readonly string[]) {
    if (roots.length === 0) throw new Error('at least one allowed directory is required');
    this.roots = roots.map((r) => real(resolve(r)));
  }

  get list(): readonly string[] {
    return this.roots;
  }

  /** Absolute, symlink-free path inside a root; relative paths resolve against the first root. */
  resolve(path: string): string {
    const abs = real(isAbsolute(path) ? path : resolve(this.roots[0]!, path));
    const ok = this.roots.some((r) => caseFold(abs) === caseFold(r) || caseFold(abs).startsWith(caseFold(r.endsWith(sep) ? r : r + sep)));
    if (!ok) throw new Error(`${path} is outside the allowed directories (${this.roots.join(', ')})`);
    return abs;
  }
}
