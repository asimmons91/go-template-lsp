import {
  CompletionList,
  Diagnostic,
  Hover,
  Location,
  WorkspaceEdit,
} from 'vscode-languageserver/node';
import { createGoplsClient, GoplsClient } from './goplsClient';
import { findModuleRootUri } from './moduleResolver';

export interface GoplsClientPool extends GoplsClient {
  /** Test-only accessor for the client serving `uri`, if one has been created yet. */
  clientFor(uri: string): GoplsClient | undefined;
  /** Test-only count of gopls processes the pool has spawned so far. */
  moduleCount(): number;
}

/**
 * Pools one `gopls` child process per Go module (the directory of the nearest
 * `go.mod`), routing every request to the client that owns the file's module
 * (§2.4). Splitting the Go-side delegate this way isolates failures: a crashed
 * or unresponsive `gopls` in one module is detected and restarted by that
 * module's own client, while completion for unrelated modules keeps working on
 * their separate processes.
 */
export function createGoplsClientPool(
  goplsPath: string,
  workspaceRoots: string[],
  resolveModuleRoot: (uri: string) => string = (uri) => findModuleRootUri(uri, workspaceRoots),
): GoplsClientPool {
  const clients = new Map<string, GoplsClient>();

  function clientFor(uri: string): GoplsClient {
    const moduleRoot = resolveModuleRoot(uri);
    let client = clients.get(moduleRoot);
    if (!client) {
      client = createGoplsClient(goplsPath, moduleRoot, [{ uri: moduleRoot, name: moduleRoot }]);
      clients.set(moduleRoot, client);
    }
    return client;
  }

  return {
    async openOrUpdate(uri, text) {
      await clientFor(uri).openOrUpdate(uri, text);
    },

    completion(uri, offset): Promise<CompletionList> {
      return clientFor(uri).completion(uri, offset);
    },

    definition(uri, offset): Promise<Location[]> {
      return clientFor(uri).definition(uri, offset);
    },

    hover(uri, offset): Promise<Hover | undefined> {
      return clientFor(uri).hover(uri, offset);
    },

    rename(uri, offset, newName): Promise<WorkspaceEdit | undefined> {
      return clientFor(uri).rename(uri, offset, newName);
    },

    diagnostics(uri): Promise<Diagnostic[]> {
      return clientFor(uri).diagnostics(uri);
    },

    async health(uri) {
      if (uri !== undefined) return clientFor(uri).health(uri);
      if (clients.size === 0) return true;
      const results = await Promise.all([...clients.values()].map((c) => c.health()));
      return results.every(Boolean);
    },

    async restart() {
      await Promise.all([...clients.values()].map((c) => c.restart()));
    },

    getChild() {
      return clients.values().next().value?.getChild();
    },

    dispose() {
      const all = [...clients.values()];
      clients.clear();
      for (const c of all) c.dispose();
    },

    clientFor,

    moduleCount() {
      return clients.size;
    },
  };
}
