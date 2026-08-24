import * as path from 'path';

export function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

/**
 * Normalizes a single root URI (or list of root URIs) into a flat string array,
 * dropping undefined/empty entries. A lone string is the legacy single-root
 * shape kept for backward compatibility with callers that pass one root.
 */
export function normalizeRoots(roots: string | string[] | undefined): string[] {
  if (!roots) return [];
  const list = Array.isArray(roots) ? roots : [roots];
  return list.filter((r) => typeof r === 'string' && r.length > 0);
}

/**
 * Returns the workspace root (URI) that contains `uri` via longest-path-prefix
 * matching, or undefined when no root is a prefix of the document path. Used to
 * resolve per-document context (e.g. the JS import baseUrl) in a multi-root
 * workspace.
 */
export function longestPrefixRoot(roots: string[], uri: string): string | undefined {
  const target = uriToPath(uri);
  let best: string | undefined;
  let bestLen = -1;
  for (const root of roots) {
    const rootPath = uriToPath(root);
    const rel = path.relative(rootPath, target);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (rootPath.length > bestLen) {
      best = root;
      bestLen = rootPath.length;
    }
  }
  return best;
}
