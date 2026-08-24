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
}

/** Standard text/template + html/template builtin functions, for name completion. */
export const BUILTINS: FuncMapEntry[] = [
  { name: 'and', params: [{ name: 'arg0', type: 'interface{}' }, { name: 'args', type: 'interface{}' }], results: ['interface{}'], variadic: true },
  { name: 'or', params: [{ name: 'arg0', type: 'interface{}' }, { name: 'args', type: 'interface{}' }], results: ['interface{}'], variadic: true },
  { name: 'not', params: [{ name: 'arg0', type: 'interface{}' }], results: ['bool'], variadic: false },
  { name: 'eq', params: [{ name: 'arg0', type: 'interface{}' }, { name: 'args', type: 'interface{}' }], results: ['bool'], variadic: true },
  { name: 'ne', params: [{ name: 'arg0', type: 'interface{}' }, { name: 'args', type: 'interface{}' }], results: ['bool'], variadic: true },
  { name: 'lt', params: [{ name: 'arg0', type: 'interface{}' }, { name: 'args', type: 'interface{}' }], results: ['bool'], variadic: true },
  { name: 'le', params: [{ name: 'arg0', type: 'interface{}' }, { name: 'args', type: 'interface{}' }], results: ['bool'], variadic: true },
  { name: 'gt', params: [{ name: 'arg0', type: 'interface{}' }, { name: 'args', type: 'interface{}' }], results: ['bool'], variadic: true },
  { name: 'ge', params: [{ name: 'arg0', type: 'interface{}' }, { name: 'args', type: 'interface{}' }], results: ['bool'], variadic: true },
  { name: 'len', params: [{ name: 'arg0', type: 'interface{}' }], results: ['int'], variadic: false },
  { name: 'index', params: [{ name: 'item', type: 'interface{}' }, { name: 'indexes', type: 'interface{}' }], results: ['interface{}'], variadic: true },
  { name: 'slice', params: [{ name: 'item', type: 'interface{}' }, { name: 'indexes', type: 'interface{}' }], results: ['interface{}'], variadic: true },
  { name: 'call', params: [{ name: 'fn', type: 'interface{}' }, { name: 'args', type: 'interface{}' }], results: ['interface{}'], variadic: true },
  { name: 'print', params: [{ name: 'args', type: 'interface{}' }], results: ['string'], variadic: true },
  { name: 'printf', params: [{ name: 'format', type: 'string' }, { name: 'args', type: 'interface{}' }], results: ['string'], variadic: true },
  { name: 'println', params: [{ name: 'args', type: 'interface{}' }], results: ['string'], variadic: true },
  { name: 'html', params: [{ name: 'args', type: 'interface{}' }], results: ['string'], variadic: true },
  { name: 'js', params: [{ name: 'args', type: 'interface{}' }], results: ['string'], variadic: true },
  { name: 'urlquery', params: [{ name: 'args', type: 'interface{}' }], results: ['string'], variadic: true }
];

export interface FuncMapIndexer {
  getIndex(): Promise<ReadonlyMap<string, FuncMapEntry>>;
  invalidate(): void;
}

// Resolved relative to the compiled server output (server/out/funcmap), the Go
// indexer module lives at the repository root's `funcmap/` directory.
const FUNCMAP_DIR = path.resolve(__dirname, '..', '..', '..', 'funcmap');

// Pre-built indexer binaries (produced by `mise run build-funcmap`) live at the
// repository root's `bin/` directory, which the packaged extension ships too.
const BIN_DIR = path.resolve(__dirname, '..', '..', '..', 'bin');

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
  const candidate = path.join(BIN_DIR, `gotmpl-funcmap-${currentGOOS()}-${currentGOARCH()}${suffix}`);
  return fs.existsSync(candidate) ? candidate : undefined;
}

function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

function parseIndex(stdout: string): Map<string, FuncMapEntry> {
  const map = new Map<string, FuncMapEntry>();
  try {
    const parsed = JSON.parse(stdout) as { functions?: FuncMapEntry[] };
    for (const fn of parsed.functions ?? []) {
      if (fn && fn.name) map.set(fn.name, fn);
    }
  } catch {
    // Malformed output degrades to an empty index.
  }
  return map;
}

/**
 * Lazily runs the companion Go indexer on demand — the pre-built binary for the
 * current platform when available (`<workspaceDir>`), falling back to
 * `go run . <workspaceDir>` in development — and caches the resulting key ->
 * signature map. Any spawn or parse failure resolves to an empty index so a
 * missing/broken Go toolchain degrades gracefully.
 */
export function getFuncMapIndexer(rootUri: string | undefined): FuncMapIndexer {
  let cache: Map<string, FuncMapEntry> | undefined;
  let pending: Promise<Map<string, FuncMapEntry>> | undefined;

  function build(): Promise<Map<string, FuncMapEntry>> {
    if (!rootUri) return Promise.resolve(new Map());
    const workspaceDir = uriToPath(rootUri);

    return new Promise((resolve) => {
      const binary = prebuiltBinary();
      const child = binary
        ? spawn(binary, [workspaceDir], { stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn('go', ['run', '.', workspaceDir], {
            cwd: FUNCMAP_DIR,
            stdio: ['ignore', 'pipe', 'pipe']
          });

      let stdout = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', () => undefined);

      const timer = setTimeout(() => {
        child.kill();
        resolve(new Map());
      }, 60000);

      child.on('error', () => {
        clearTimeout(timer);
        resolve(new Map());
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(parseIndex(stdout));
      });
    });
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
    }
  };
}
