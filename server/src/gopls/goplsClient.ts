import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import {
  createMessageConnection,
  MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import {
  CompletionItem,
  CompletionList,
  Diagnostic,
  Hover,
  Location,
  WorkspaceEdit,
} from 'vscode-languageserver/node';

export interface GoplsClient {
  /** Opens the URI on first use, otherwise pushes a full-text update. */
  openOrUpdate(uri: string, text: string): Promise<void>;
  completion(uri: string, offset: number): Promise<CompletionList>;
  definition(uri: string, offset: number): Promise<Location[]>;
  hover(uri: string, offset: number): Promise<Hover | undefined>;
  /** Runs gopls's own rename at the given position, returning its workspace edit. */
  rename(uri: string, offset: number, newName: string): Promise<WorkspaceEdit | undefined>;
  /** Returns gopls's latest published diagnostics for the URI, waiting for a fresh publish when the file was just updated. */
  diagnostics(uri: string): Promise<Diagnostic[]>;
  /** Resolves true once a gopls child process has been successfully initialized and is alive. */
  health(): Promise<boolean>;
  /** Kills the current child (if any) and starts a fresh one, re-opening every known synthetic file. */
  restart(): Promise<void>;
  /** Test-only accessor for the underlying child process, if one is running. */
  getChild(): ChildProcessWithoutNullStreams | undefined;
  dispose(): void;
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

/** How long a gopls request may hang before it is treated as unresponsive. */
const REQUEST_TIMEOUT_MS = 5000;

/** Wraps a gopls request promise with a timeout that triggers a restart on expiry. */
function withTimeout<T>(p: Promise<T>, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error('gopls request timed out'));
    }, REQUEST_TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface WorkspaceFolder {
  uri: string;
  name: string;
}

/**
 * Lazily spawns a `gopls` subprocess and speaks LSP to it over stdio via
 * vscode-jsonrpc, with the server acting as the client in that exchange. Startup
 * and request failures resolve to an empty completion list rather than throwing,
 * so a missing/broken gopls degrades gracefully instead of crashing the server.
 *
 * §3 — a crashed or unresponsive gopls is detected (child exit, connection
 * close/error, or request timeout) and transparently restarted, re-opening every
 * synthetic file the server has previously sent so the Go-side delegate never
 * stays silently dead for the rest of the session.
 */
export function createGoplsClient(
  goplsPath: string,
  rootUri: string | undefined,
  workspaceFolders?: WorkspaceFolder[],
): GoplsClient {
  let childProcess: ChildProcessWithoutNullStreams | undefined;
  let connection: MessageConnection | undefined;
  let starting: Promise<MessageConnection | undefined> | undefined;
  let alive = false;
  const openVersions = new Map<string, number>();
  const openText = new Map<string, string>();

  // gopls publishes diagnostics as notifications; we cache them per synthetic URI.
  const diagnosticCache = new Map<string, Diagnostic[]>();
  const dirty = new Set<string>();
  const diagnosticWaiters = new Map<
    string,
    { resolve: (d: Diagnostic[]) => void; timer: NodeJS.Timeout }[]
  >();

  function settleDiagnostics(uri: string, diagnostics: Diagnostic[]): void {
    diagnosticCache.set(uri, diagnostics);
    dirty.delete(uri);
    const waiters = diagnosticWaiters.get(uri);
    if (!waiters) return;
    diagnosticWaiters.delete(uri);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve(diagnostics);
    }
  }

  /**
   * Tears down the current child/connection and all derived state. Idempotent:
   * stale exit/close handlers are no-ops because `childProcess`/`connection` are
   * cleared before the old handles are killed/disposed.
   */
  function teardown(): void {
    alive = false;
    const oldConn = connection;
    const oldChild = childProcess;
    connection = undefined;
    childProcess = undefined;
    starting = undefined;
    if (oldConn) {
      try {
        oldConn.dispose();
      } catch {
        // ignore
      }
    }
    if (oldChild) {
      try {
        oldChild.kill();
      } catch {
        // ignore
      }
    }
    openVersions.clear();
    diagnosticCache.clear();
    dirty.clear();
    for (const waiters of diagnosticWaiters.values()) {
      for (const w of waiters) clearTimeout(w.timer);
    }
    diagnosticWaiters.clear();
  }

  async function start(): Promise<MessageConnection | undefined> {
    try {
      const child = spawn(goplsPath, [], { stdio: 'pipe' });
      childProcess = child;
      child.on('exit', () => {
        if (childProcess === child) teardown();
      });
      child.on('error', () => {
        if (childProcess === child) teardown();
      });

      const conn = createMessageConnection(
        new StreamMessageReader(child.stdout),
        new StreamMessageWriter(child.stdin),
      );
      conn.onNotification(
        'textDocument/publishDiagnostics',
        (params: { uri: string; diagnostics: Diagnostic[] }) => {
          settleDiagnostics(params.uri, params.diagnostics ?? []);
        },
      );
      conn.onClose(() => {
        if (connection === conn) teardown();
      });
      conn.onError(() => {
        if (connection === conn) teardown();
      });
      conn.listen();

      await conn.sendRequest('initialize', {
        processId: process.pid ?? null,
        rootUri: rootUri ?? workspaceFolders?.[0]?.uri ?? null,
        workspaceFolders: workspaceFolders ?? null,
        capabilities: {},
      });
      void conn.sendNotification('initialized', {});

      connection = conn;
      alive = true;

      // Re-open every synthetic file previously sent, so a restarted gopls
      // reloads its contents from scratch.
      openVersions.clear();
      for (const [uri, text] of openText) {
        openVersions.set(uri, 1);
        void conn.sendNotification('textDocument/didOpen', {
          textDocument: { uri, languageId: 'go', version: 1, text },
        });
      }

      return conn;
    } catch {
      teardown();
      return undefined;
    }
  }

  function ensureStarted(): Promise<MessageConnection | undefined> {
    if (alive && connection) return Promise.resolve(connection);
    if (!starting) {
      starting = start().finally(() => {
        starting = undefined;
      });
    }
    return starting;
  }

  return {
    async openOrUpdate(uri, text) {
      const prev = openText.get(uri);
      openText.set(uri, text);
      const conn = await ensureStarted();
      if (!conn) return;

      if (!openVersions.has(uri)) {
        openVersions.set(uri, 1);
        dirty.add(uri);
        void conn.sendNotification('textDocument/didOpen', {
          textDocument: { uri, languageId: 'go', version: 1, text },
        });
      } else if (prev !== text) {
        const version = openVersions.get(uri)! + 1;
        openVersions.set(uri, version);
        dirty.add(uri);
        void conn.sendNotification('textDocument/didChange', {
          textDocument: { uri, version },
          contentChanges: [{ text }],
        });
      }
    },

    async completion(uri, offset) {
      const conn = await ensureStarted();
      if (!conn) return CompletionList.create([], false);

      try {
        const text = openText.get(uri) ?? '';
        const response = await withTimeout(
          conn.sendRequest<{ items?: CompletionItem[] } | CompletionItem[] | null>(
            'textDocument/completion',
            {
              textDocument: { uri },
              position: offsetToPosition(text, offset),
            },
          ),
          () => teardown(),
        );
        if (!response) return CompletionList.create([], false);
        const items = Array.isArray(response) ? response : (response.items ?? []);
        return CompletionList.create(items, false);
      } catch {
        return CompletionList.create([], false);
      }
    },

    async definition(uri, offset) {
      const conn = await ensureStarted();
      if (!conn) return [];

      try {
        const text = openText.get(uri) ?? '';
        const response = await withTimeout(
          conn.sendRequest<Location[] | Location | null>('textDocument/definition', {
            textDocument: { uri },
            position: offsetToPosition(text, offset),
          }),
          () => teardown(),
        );
        if (!response) return [];
        if (Array.isArray(response)) return response;
        return [response];
      } catch {
        return [];
      }
    },

    async hover(uri, offset) {
      const conn = await ensureStarted();
      if (!conn) return undefined;

      try {
        const text = openText.get(uri) ?? '';
        const response = await withTimeout(
          conn.sendRequest<Hover | null>('textDocument/hover', {
            textDocument: { uri },
            position: offsetToPosition(text, offset),
          }),
          () => teardown(),
        );
        return response ?? undefined;
      } catch {
        return undefined;
      }
    },

    async rename(uri, offset, newName) {
      const conn = await ensureStarted();
      if (!conn) return undefined;

      try {
        const text = openText.get(uri) ?? '';
        const response = await withTimeout(
          conn.sendRequest<WorkspaceEdit | null>('textDocument/rename', {
            textDocument: { uri },
            position: offsetToPosition(text, offset),
            newName,
          }),
          () => teardown(),
        );
        return response ?? undefined;
      } catch {
        return undefined;
      }
    },

    async health() {
      const conn = await ensureStarted();
      return conn !== undefined && alive;
    },

    async restart() {
      teardown();
      await ensureStarted();
    },

    async diagnostics(uri) {
      const conn = await ensureStarted();
      if (!conn) return [];
      if (!dirty.has(uri)) return diagnosticCache.get(uri) ?? [];

      return new Promise<Diagnostic[]>((resolve) => {
        const timer = setTimeout(() => {
          const waiters = diagnosticWaiters.get(uri) ?? [];
          diagnosticWaiters.set(
            uri,
            waiters.filter((w) => w.timer !== timer),
          );
          settleDiagnostics(uri, diagnosticCache.get(uri) ?? []);
        }, 2000);
        const waiters = diagnosticWaiters.get(uri) ?? [];
        waiters.push({ resolve, timer });
        diagnosticWaiters.set(uri, waiters);
      });
    },

    getChild() {
      return childProcess;
    },

    dispose() {
      teardown();
      openText.clear();
    },
  };
}
