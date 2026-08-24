import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import {
  createMessageConnection,
  MessageConnection,
  StreamMessageReader,
  StreamMessageWriter
} from 'vscode-jsonrpc/node';
import { CompletionItem, CompletionList } from 'vscode-languageserver/node';

export interface GoplsClient {
  /** Opens the URI on first use, otherwise pushes a full-text update. */
  openOrUpdate(uri: string, text: string): Promise<void>;
  completion(uri: string, offset: number): Promise<CompletionList>;
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

  async function start(): Promise<MessageConnection | undefined> {
    try {
      const child = spawn(goplsPath, [], { stdio: 'pipe' });
      childProcess = child;
      const conn = createMessageConnection(
        new StreamMessageReader(child.stdout),
        new StreamMessageWriter(child.stdin)
      );
      conn.listen();

      await conn.sendRequest('initialize', {
        processId: process.pid ?? null,
        rootUri: rootUri ?? null,
        capabilities: {}
      });
      conn.sendNotification('initialized', {});

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
      openText.set(uri, text);
      if (!conn) return;

      if (!openVersions.has(uri)) {
        openVersions.set(uri, 1);
        conn.sendNotification('textDocument/didOpen', {
          textDocument: { uri, languageId: 'go', version: 1, text }
        });
      } else {
        const version = openVersions.get(uri)! + 1;
        openVersions.set(uri, version);
        conn.sendNotification('textDocument/didChange', {
          textDocument: { uri, version },
          contentChanges: [{ text }]
        });
      }
    },

    async completion(uri, offset) {
      const conn = await ensureStarted();
      if (!conn) return CompletionList.create([], false);

      try {
        const text = openText.get(uri) ?? '';
        const response = await conn.sendRequest<{ items?: CompletionItem[] } | CompletionItem[] | null>(
          'textDocument/completion',
          {
            textDocument: { uri },
            position: offsetToPosition(text, offset)
          }
        );
        if (!response) return CompletionList.create([], false);
        const items = Array.isArray(response) ? response : response.items ?? [];
        return CompletionList.create(items, false);
      } catch {
        return CompletionList.create([], false);
      }
    },

    dispose() {
      if (connection) {
        connection.dispose();
      }
      childProcess?.kill();
      openVersions.clear();
      openText.clear();
    }
  };
}
