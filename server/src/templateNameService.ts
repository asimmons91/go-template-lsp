import * as fs from 'fs';
import * as path from 'path';
import { Location, Range } from 'vscode-languageserver/node';
import { scanTemplateDirectives } from './templateDirectives';

const TEMPLATE_EXTENSIONS = new Set(['.gohtml', '.gotmpl', '.gtpl', '.tmpl']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.vscode', 'bin', 'obj']);

function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
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
 * the workspace root for template files and indexes them; open documents overlay
 * (and win over) the on-disk baseline via `indexDocument`, and `onFileEvent` /
 * `onDocumentClosed` keep it fresh as files change on disk.
 */
export class TemplateNameService {
  private definitions = new Map<string, Location[]>();
  private references = new Map<string, Location[]>();
  private ready: Promise<void>;

  constructor(private rootUri: string | undefined) {
    this.ready = this.scanWorkspace();
  }

  async ensureReady(): Promise<void> {
    await this.ready;
  }

  private scanWorkspace(): Promise<void> {
    if (!this.rootUri) return Promise.resolve();
    const files: string[] = [];
    this.walk(uriToPath(this.rootUri), files);
    for (const file of files) {
      try {
        this.indexDocument(pathToUri(file), fs.readFileSync(file, 'utf8'));
      } catch {
        // Unreadable file — skip.
      }
    }
    return Promise.resolve();
  }

  private walk(dir: string, out: string[]): void {
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
        this.walk(full, out);
      } else if (
        entry.isFile() &&
        TEMPLATE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
      ) {
        out.push(full);
      }
    }
  }

  indexDocument(uri: string, text: string): void {
    this.removeDocument(uri);
    for (const d of scanTemplateDirectives(text)) {
      const range = Range.create(
        offsetToPosition(text, d.quoteStart),
        offsetToPosition(text, d.quoteEnd),
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
