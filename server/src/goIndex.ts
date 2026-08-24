import { spawn } from 'child_process';
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
  invalidate(): void;
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

/**
 * Lazily runs the companion Go workspace indexer on demand — the pre-built
 * binary for the current platform when available, falling back to
 * `go run . <workspaceDir>` in development — and caches the combined
 * FuncMap + execute-site result. Any spawn or parse failure resolves to an empty
 * result so a missing/broken Go toolchain degrades gracefully. Shared by the
 * FuncMap and execute-site inference services so the workspace is scanned once.
 */
export function getGoIndexRunner(roots: string | string[] | undefined): GoIndexRunner {
  let cache: GoIndexResult | undefined;
  let pending: Promise<GoIndexResult> | undefined;

  const rootList = (Array.isArray(roots) ? roots : roots ? [roots] : []).filter(
    (r) => typeof r === 'string' && r.length > 0,
  );

  function runOne(workspaceDir: string): Promise<GoIndexResult> {
    return new Promise((resolve) => {
      const binary = prebuiltBinary();
      const child = binary
        ? spawn(binary, [workspaceDir], { stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn('go', ['run', '.', workspaceDir], {
            cwd: INDEXER_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

      let stdout = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', () => undefined);

      const timer = setTimeout(() => {
        child.kill();
        resolve({ functions: [], executeSites: [] });
      }, 60000);

      child.on('error', () => {
        clearTimeout(timer);
        resolve({ functions: [], executeSites: [] });
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(parseIndex(stdout));
      });
    });
  }

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

  function build(): Promise<GoIndexResult> {
    if (rootList.length === 0) return Promise.resolve({ functions: [], executeSites: [] });
    const dirs = rootList.map(uriToPath);
    return Promise.all(dirs.map(runOne)).then(merge);
  }

  return {
    async getIndex() {
      if (cache) return cache;
      if (!pending) pending = build();
      const result = await pending;
      cache = result;
      pending = undefined;
      return result;
    },
    invalidate() {
      cache = undefined;
      pending = undefined;
    },
  };
}
