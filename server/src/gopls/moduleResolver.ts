import * as fs from 'fs';
import * as path from 'path';
import { longestPrefixRoot, uriToPath } from '../workspace';

const cache = new Map<string, string>();

function pathToUri(p: string): string {
  return `file://${p}`;
}

/**
 * Resolves the Go module that owns `uri`: the directory of the nearest ancestor
 * `go.mod`, walking up from the file's directory. When no module is found, the
 * request falls back to the workspace root that contains the file (or the first
 * workspace root, or the file's own directory when there are no roots) so a
 * template living outside any module still gets a gopls process rather than
 * nothing. Results are cached per starting directory since the module boundary
 * for a tree rarely changes within a session.
 */
export function findModuleRootUri(uri: string, workspaceRoots: string[]): string {
  const target = uriToPath(uri);
  const startDir = path.dirname(target);
  const cached = cache.get(startDir);
  if (cached !== undefined) return cached;

  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'go.mod'))) {
      cache.set(startDir, pathToUri(dir));
      return pathToUri(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const fallback =
    longestPrefixRoot(workspaceRoots, uri) ?? workspaceRoots[0] ?? pathToUri(startDir);
  cache.set(startDir, fallback);
  return fallback;
}

/** Drops the cached module-root lookups (e.g. after a `go.mod` is created/removed). */
export function clearModuleRootCache(): void {
  cache.clear();
}
