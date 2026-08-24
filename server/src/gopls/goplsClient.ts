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
  /** Resolves true once a gopls child process has been successfully initialized. */
  health(): Promise<boolean>;
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

/**
 * Lazily spawns a `gopls` subprocess and speaks LSP to it over stdio via
 * vscode-jsonrpc, with the server acting as the client in that exchange. Startup
 * and request failures resolve to an empty completion list rather than throwing,
 * so a missing/broken gopls degrades gracefully instead of crashing the server.
 */
export function createGoplsClient(goplsPath: string, rootUri: string | undefined): GoplsClient {
  let childProcess: ChildProcessWithoutNullStreams | undefined;
  let connection: MessageConnection | undefined;
  let starting: Promise<MessageConnection | undefined> | undefined;
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

  async function start(): Promise<MessageConnection | undefined> {
    try {
      const child = spawn(goplsPath, [], { stdio: 'pipe' });
      childProcess = child;
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
      conn.listen();

      await conn.sendRequest('initialize', {
        processId: process.pid ?? null,
        rootUri: rootUri ?? null,
        capabilities: {},
      });
      void conn.sendNotification('initialized', {});

      connection = conn;
      return conn;
    } catch {
      return undefined;
    }
  }

  function ensureStarted(): Promise<MessageConnection | undefined> {
    if (!starting) starting = start();
    return starting;
  }

  return {
    async openOrUpdate(uri, text) {
      const conn = await ensureStarted();
      const prev = openText.get(uri);
      openText.set(uri, text);
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
        const response = await conn.sendRequest<
          { items?: CompletionItem[] } | CompletionItem[] | null
        >('textDocument/completion', {
          textDocument: { uri },
          position: offsetToPosition(text, offset),
        });
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
        const response = await conn.sendRequest<Location[] | Location | null>(
          'textDocument/definition',
          {
            textDocument: { uri },
            position: offsetToPosition(text, offset),
          },
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
        const response = await conn.sendRequest<Hover | null>('textDocument/hover', {
          textDocument: { uri },
          position: offsetToPosition(text, offset),
        });
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
        const response = await conn.sendRequest<WorkspaceEdit | null>('textDocument/rename', {
          textDocument: { uri },
          position: offsetToPosition(text, offset),
          newName,
        });
        return response ?? undefined;
      } catch {
        return undefined;
      }
    },

    async health() {
      return (await ensureStarted()) !== undefined;
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

    dispose() {
      if (connection) {
        connection.dispose();
      }
      childProcess?.kill();
      openVersions.clear();
      openText.clear();
      diagnosticCache.clear();
      dirty.clear();
      for (const waiters of diagnosticWaiters.values()) {
        for (const w of waiters) clearTimeout(w.timer);
      }
      diagnosticWaiters.clear();
    },
  };
}
