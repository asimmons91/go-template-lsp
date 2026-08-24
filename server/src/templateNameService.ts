import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { Location, Range } from 'vscode-languageserver/node';
import { scanTemplateDirectives } from './templateDirectives';

const TEMPLATE_EXTENSIONS = new Set(['.gohtml', '.gotmpl', '.gtpl', '.tmpl']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.vscode', 'bin', 'obj']);

function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

/**
 * The static directory prefix of a glob pattern — everything up to the first
 * glob metacharacter, then trimmed back to the last `/`. Used to decide whether
 * a directory could contain a matching path (e.g. `templates/**` -> `templates`).
 * Returns '' for a leading `**` (matches anywhere).
 */
function staticPrefix(pattern: string): string {
  let i = 0;
  while (i < pattern.length && !'*?[]{}!'.includes(pattern[i])) i++;
  const prefix = pattern.slice(0, i);
  const slash = prefix.lastIndexOf('/');
  return slash === -1 ? '' : prefix.slice(0, slash);
}

/** Whether directory `rel` (root-relative, posix) could contain a match for `pattern`. */
function dirDescendable(rel: string, pattern: string): boolean {
  const prefix = staticPrefix(pattern);
  if (prefix === '' || rel === '') return true;
  return rel === prefix || rel.startsWith(`${prefix}/`) || prefix.startsWith(`${rel}/`);
}

function pathToUri(p: string): string {
  return 'file://' + encodeURI(p.replace(/\\/g, '/'));
}

function offsetToPosition(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

export function isTemplateFileUri(uri: string): boolean {
  try {
    return TEMPLATE_EXTENSIONS.has(path.extname(uriToPath(uri)).toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Owns the workspace-wide define/block/template index. At construction it walks
 * each workspace root (optionally restricted by `templateRoots` glob patterns)
 * for template files and indexes them; open documents overlay (and win over) the
 * on-disk baseline via `indexDocument`, and `onFileEvent` / `onDocumentClosed`
 * keep it fresh as files change on disk.
 */
export class TemplateNameService {
  private definitions = new Map<string, Location[]>();
  private references = new Map<string, Location[]>();
  private files = new Set<string>();
  private ready: Promise<void>;

  constructor(
    private roots: string | string[] | undefined,
    private templateRoots?: string[],
  ) {
    this.ready = this.scanWorkspace();
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  /**
   * Re-scans the workspace with a new set of template root patterns. Roots are
   * unchanged (workspace folders don't move mid-session); only the glob filter
   * is updated and the index rebuilt.
   */
  rescan(templateRoots?: string[]): void {
    if (templateRoots !== undefined) this.templateRoots = templateRoots;
    this.definitions.clear();
    this.references.clear();
    this.files.clear();
    this.ready = this.scanWorkspace();
  }

  private rootList(): string[] {
    const list = Array.isArray(this.roots) ? this.roots : this.roots ? [this.roots] : [];
    return list.filter((r) => typeof r === 'string' && r.length > 0);
  }

  private scanWorkspace(): Promise<void> {
    const files: string[] = [];
    for (const root of this.rootList()) {
      this.walk(uriToPath(root), uriToPath(root), files);
    }
    for (const file of files) {
      try {
        this.indexDocument(pathToUri(file), fs.readFileSync(file, 'utf8'));
      } catch {
        // Unreadable file — skip.
      }
    }
    return Promise.resolve();
  }

  private relPosix(root: string, full: string): string {
    const rel = path.relative(root, full);
    return rel.split(path.sep).join('/');
  }

  private fileMatches(rel: string): boolean {
    const patterns = this.templateRoots;
    if (!patterns || patterns.length === 0) return true;
    return patterns.some((p) => minimatch(rel, p, { dot: true }));
  }

  private dirMatches(rel: string): boolean {
    const patterns = this.templateRoots;
    if (!patterns || patterns.length === 0) return true;
    return patterns.some((p) => dirDescendable(rel, p));
  }

  private walk(root: string, dir: string, out: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (!this.dirMatches(this.relPosix(root, full))) continue;
        this.walk(root, full, out);
      } else if (
        entry.isFile() &&
        TEMPLATE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) &&
        this.fileMatches(this.relPosix(root, full))
      ) {
        out.push(full);
      }
    }
  }

  indexDocument(uri: string, text: string): void {
    this.removeDocument(uri);
    this.files.add(uri);
    for (const d of scanTemplateDirectives(text)) {
      const range = Range.create(
        offsetToPosition(text, d.nameStart),
        offsetToPosition(text, d.nameEnd),
      );
      const loc: Location = { uri, range };
      if (d.keyword === 'define') {
        this.add(this.definitions, d.name, loc);
      } else if (d.keyword === 'block') {
        this.add(this.definitions, d.name, loc);
        this.add(this.references, d.name, loc);
      } else {
        this.add(this.references, d.name, loc);
      }
    }
  }

  removeDocument(uri: string): void {
    this.files.delete(uri);
    for (const map of [this.definitions, this.references]) {
      for (const [name, locs] of map) {
        const kept = locs.filter((l) => l.uri !== uri);
        if (kept.length === 0) map.delete(name);
        else map.set(name, kept);
      }
    }
  }

  onFileEvent(uri: string, type: number): void {
    if (type === 3) {
      this.removeDocument(uri);
      return;
    }
    try {
      this.indexDocument(uri, fs.readFileSync(uriToPath(uri), 'utf8'));
    } catch {
      this.removeDocument(uri);
    }
  }

  onDocumentClosed(uri: string): void {
    try {
      this.indexDocument(uri, fs.readFileSync(uriToPath(uri), 'utf8'));
    } catch {
      this.removeDocument(uri);
    }
  }

  getAllNames(): string[] {
    return [...this.definitions.keys()];
  }

  getAllFiles(): string[] {
    return [...this.files];
  }

  /**
   * Returns the URI(s) whose on-disk basename equals `name`, for resolving a
   * root template name (e.g. `ParseFiles("page.gohtml")` names its root template
   * `page.gohtml`) back to its file during execute-site type inference.
   */
  getFilesByBasename(name: string): string[] {
    const out: string[] = [];
    for (const uri of this.files) {
      try {
        if (path.basename(uriToPath(uri)) === name) out.push(uri);
      } catch {
        // Unparseable URI — skip.
      }
    }
    return out;
  }

  getDefinitions(name: string): Location[] {
    return this.definitions.get(name) ?? [];
  }

  getReferences(name: string): Location[] {
    return this.references.get(name) ?? [];
  }

  private add(map: Map<string, Location[]>, name: string, loc: Location): void {
    const list = map.get(name) ?? [];
    list.push(loc);
    map.set(name, list);
  }
}
