import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface FuncMapParam {
  name: string;
  type: string;
}

export interface FuncMapEntry {
  name: string;
  params: FuncMapParam[];
  results: string[];
  variadic: boolean;
  imports?: Record<string, string>;
  /** Go doc comment on the function's declaration, when declared in the workspace. */
  doc?: string;
  /**
   * Declaration location (0-based line/character, matching LSP `Position`),
   * when the indexer could resolve one. Absent for bundled/known-library
   * entries (e.g. Sprig) that have no loaded declaration syntax.
   */
  file?: string;
  line?: number;
  character?: number;
}

export interface InferredType {
  importPath: string;
  typeName: string;
}

export interface ExecuteSite {
  /** Template name from an `ExecuteTemplate(w, "name", X)` call site. */
  name?: string;
  /** Template files (absolute paths) traced from a `ParseFiles`/`ParseGlob` chain. */
  files?: string[];
  type: InferredType;
}

export interface GoIndexResult {
  functions: FuncMapEntry[];
  executeSites: ExecuteSite[];
}

/** Standard text/template + html/template builtin functions, for name completion. */
export const BUILTINS: FuncMapEntry[] = [
  {
    name: 'and',
    params: [
      { name: 'arg0', type: 'interface{}' },
      { name: 'args', type: 'interface{}' },
    ],
    results: ['interface{}'],
    variadic: true,
  },
  {
    name: 'or',
    params: [
      { name: 'arg0', type: 'interface{}' },
      { name: 'args', type: 'interface{}' },
    ],
    results: ['interface{}'],
    variadic: true,
  },
  {
    name: 'not',
    params: [{ name: 'arg0', type: 'interface{}' }],
    results: ['bool'],
    variadic: false,
  },
  {
    name: 'eq',
    params: [
      { name: 'arg0', type: 'interface{}' },
      { name: 'args', type: 'interface{}' },
    ],
    results: ['bool'],
    variadic: true,
  },
  {
    name: 'ne',
    params: [
      { name: 'arg0', type: 'interface{}' },
      { name: 'args', type: 'interface{}' },
    ],
    results: ['bool'],
    variadic: true,
  },
  {
    name: 'lt',
    params: [
      { name: 'arg0', type: 'interface{}' },
      { name: 'args', type: 'interface{}' },
    ],
    results: ['bool'],
    variadic: true,
  },
  {
    name: 'le',
    params: [
      { name: 'arg0', type: 'interface{}' },
      { name: 'args', type: 'interface{}' },
    ],
    results: ['bool'],
    variadic: true,
  },
  {
    name: 'gt',
    params: [
      { name: 'arg0', type: 'interface{}' },
      { name: 'args', type: 'interface{}' },
    ],
    results: ['bool'],
    variadic: true,
  },
  {
    name: 'ge',
    params: [
      { name: 'arg0', type: 'interface{}' },
      { name: 'args', type: 'interface{}' },
    ],
    results: ['bool'],
    variadic: true,
  },
  {
    name: 'len',
    params: [{ name: 'arg0', type: 'interface{}' }],
    results: ['int'],
    variadic: false,
  },
  {
    name: 'index',
    params: [
      { name: 'item', type: 'interface{}' },
      { name: 'indexes', type: 'interface{}' },
    ],
    results: ['interface{}'],
    variadic: true,
  },
  {
    name: 'slice',
    params: [
      { name: 'item', type: 'interface{}' },
      { name: 'indexes', type: 'interface{}' },
    ],
    results: ['interface{}'],
    variadic: true,
  },
  {
    name: 'call',
    params: [
      { name: 'fn', type: 'interface{}' },
      { name: 'args', type: 'interface{}' },
    ],
    results: ['interface{}'],
    variadic: true,
  },
  {
    name: 'print',
    params: [{ name: 'args', type: 'interface{}' }],
    results: ['string'],
    variadic: true,
  },
  {
    name: 'printf',
    params: [
      { name: 'format', type: 'string' },
      { name: 'args', type: 'interface{}' },
    ],
    results: ['string'],
    variadic: true,
  },
  {
    name: 'println',
    params: [{ name: 'args', type: 'interface{}' }],
    results: ['string'],
    variadic: true,
  },
  {
    name: 'html',
    params: [{ name: 'args', type: 'interface{}' }],
    results: ['string'],
    variadic: true,
  },
  {
    name: 'js',
    params: [{ name: 'args', type: 'interface{}' }],
    results: ['string'],
    variadic: true,
  },
  {
    name: 'urlquery',
    params: [{ name: 'args', type: 'interface{}' }],
    results: ['string'],
    variadic: true,
  },
];

export interface GoIndexRunner {
  getIndex(): Promise<GoIndexResult>;
  /** Marks the index stale. Pass changed `.go` file URIs for an incremental re-index, or nothing for a full re-scan. */
  invalidate(files?: string[]): void;
  dispose(): void;
}

/** Test-facing view of a runner: exposes how many full vs incremental scans ran. */
export interface TestableGoIndexRunner extends GoIndexRunner {
  _scanCounts(): Array<{ index: number; reindex: number }>;
}

// Resolved relative to the compiled server output (server/out), the Go indexer
// module lives at the repository root's `indexer/` directory.
const INDEXER_DIR = path.resolve(__dirname, '..', '..', 'indexer');

// Pre-built indexer binaries (produced by `mise run build-indexer`) live at the
// repository root's `bin/` directory, which the packaged extension ships too.
const BIN_DIR = path.resolve(__dirname, '..', '..', 'bin');

function currentGOOS(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'darwin';
    default:
      return 'linux';
  }
}

function currentGOARCH(): string {
  switch (process.arch) {
    case 'x64':
      return 'amd64';
    case 'arm64':
      return 'arm64';
    default:
      return process.arch;
  }
}

function prebuiltBinary(): string | undefined {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const candidate = path.join(
    BIN_DIR,
    `gotmpl-indexer-${currentGOOS()}-${currentGOARCH()}${suffix}`,
  );
  return fs.existsSync(candidate) ? candidate : undefined;
}

function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

function parseIndex(stdout: string): GoIndexResult {
  const empty: GoIndexResult = { functions: [], executeSites: [] };
  try {
    const parsed = JSON.parse(stdout) as {
      functions?: FuncMapEntry[];
      executeSites?: ExecuteSite[];
    };
    return {
      functions: (parsed.functions ?? []).filter((fn) => fn && fn.name),
      executeSites: (parsed.executeSites ?? []).filter((s) => s && s.type),
    };
  } catch {
    // Malformed output degrades to an empty index.
  }
  return empty;
}

/** How long to coalesce a burst of `.go` change events before re-indexing. */
const REINDEX_DEBOUNCE_MS = 150;

/**
 * A single long-running indexer child process (one per workspace root), spoken
 * to over newline-delimited JSON. It keeps `go/packages` warm and answers an
 * `index` (full scan) or a `reindex` (package-scoped rescan of the changed
 * files) with the full merged index, so a single-file change never re-scans the
 * whole workspace.
 */
class IndexDaemon {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = '';
  private pending: Array<{ resolve: (r: GoIndexResult) => void }> = [];
  private cache: GoIndexResult | undefined;
  private inflight: Promise<GoIndexResult> | undefined;
  private pendingFiles: string[] = [];
  private debounce: NodeJS.Timeout | undefined;
  private counts = { index: 0, reindex: 0 };

  constructor(readonly workspaceDir: string) {}

  private spawnChild(): void {
    const binary = prebuiltBinary();
    const child = binary
      ? spawn(binary, ['serve', this.workspaceDir], { stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn('go', ['run', '.', 'serve', this.workspaceDir], {
          cwd: INDEXER_DIR,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
    this.child = child;
    child.stdout.on('data', (d: Buffer) => this.onData(d.toString()));
    child.stderr.on('data', () => undefined);
    // Swallow stream errors so a child that dies mid-write can't crash the server.
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);
    child.on('error', () => this.onExit());
    child.on('exit', () => this.onExit());
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const result = parseIndex(line);
      this.cache = result;
      const waiter = this.pending.shift();
      if (waiter) waiter.resolve(result);
    }
  }

  private onExit(): void {
    this.child = undefined;
    this.cache = undefined;
    const waiters = this.pending;
    this.pending = [];
    for (const w of waiters) w.resolve({ functions: [], executeSites: [] });
  }

  private send(cmd: object): Promise<GoIndexResult> {
    if (!this.child) this.spawnChild();
    const child = this.child;
    if (!child) return Promise.resolve({ functions: [], executeSites: [] });

    return new Promise<GoIndexResult>((resolve) => {
      this.pending.push({ resolve });
      child.stdin.write(`${JSON.stringify(cmd)}\n`);
    });
  }

  private track(p: Promise<GoIndexResult>): Promise<GoIndexResult> {
    const tracked = p.finally(() => {
      if (this.inflight === tracked) this.inflight = undefined;
    });
    this.inflight = tracked;
    return tracked;
  }

  getIndex(): Promise<GoIndexResult> {
    if (this.debounce) this.flush();
    if (this.inflight) return this.inflight;
    if (this.cache) return Promise.resolve(this.cache);
    this.counts.index++;
    return this.track(this.send({ op: 'index' }));
  }

  invalidate(files: string[]): void {
    if (files.length === 0) {
      this.cache = undefined;
      this.counts.index++;
      void this.track(this.send({ op: 'index' }));
      return;
    }
    for (const f of files) this.pendingFiles.push(f);
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.flush(), REINDEX_DEBOUNCE_MS);
  }

  private flush(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    const files = this.pendingFiles;
    this.pendingFiles = [];
    if (files.length === 0) return;
    if (!this.cache) {
      // No baseline yet; a full scan is required before we can splice deltas.
      this.counts.index++;
      void this.track(this.send({ op: 'index' }));
      return;
    }
    this.counts.reindex++;
    void this.track(this.send({ op: 'reindex', files }));
  }

  getScanCounts(): { index: number; reindex: number } {
    return { ...this.counts };
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = undefined;
    this.pendingFiles = [];
    const child = this.child;
    this.child = undefined;
    if (child) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Manages one warm indexer daemon per workspace root, merging their results
 * into a single workspace-wide FuncMap + execute-site index. `invalidate(files)`
 * routes changed `.go` files to the owning root's daemon for an incremental
 * re-index; a file-less `invalidate()` forces a full re-scan everywhere.
 */
export function getGoIndexRunner(roots: string | string[] | undefined): TestableGoIndexRunner {
  const rootList = (Array.isArray(roots) ? roots : roots ? [roots] : []).filter(
    (r) => typeof r === 'string' && r.length > 0,
  );
  const daemons = rootList.map((uri) => new IndexDaemon(uriToPath(uri)));

  /**
   * Merges per-folder index runs into one workspace-wide result. FuncMap entries
   * are first-wins by name (matching the single-root semantics), and execute
   * sites are concatenated then de-duplicated by target + type.
   */
  function merge(results: GoIndexResult[]): GoIndexResult {
    const functions = new Map<string, FuncMapEntry>();
    for (const r of results) {
      for (const fn of r.functions) {
        if (!functions.has(fn.name)) functions.set(fn.name, fn);
      }
    }

    const seen = new Set<string>();
    const executeSites: ExecuteSite[] = [];
    for (const r of results) {
      for (const site of r.executeSites) {
        const key = site.name
          ? `name:${site.name}|${site.type.importPath}.${site.type.typeName}`
          : `files:${(site.files ?? []).join(',')}|${site.type.importPath}.${site.type.typeName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        executeSites.push(site);
      }
    }

    return { functions: [...functions.values()], executeSites };
  }

  return {
    async getIndex() {
      if (rootList.length === 0) return { functions: [], executeSites: [] };
      const results = await Promise.all(daemons.map((d) => d.getIndex()));
      return merge(results);
    },
    invalidate(files?: string[]) {
      const changed = (files ?? []).map(uriToPath).filter((p) => p.length > 0);
      if (changed.length === 0) {
        for (const d of daemons) d.invalidate([]);
        return;
      }
      for (const d of daemons) {
        const owned = changed.filter(
          (p) => p === d.workspaceDir || p.startsWith(`${d.workspaceDir}${path.sep}`),
        );
        if (owned.length > 0) d.invalidate(owned);
      }
    },
    dispose() {
      for (const d of daemons) d.dispose();
    },
    _scanCounts() {
      return daemons.map((d) => d.getScanCounts());
    },
  };
}
