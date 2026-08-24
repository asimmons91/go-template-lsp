import { FuncMapEntry, GoIndexRunner } from '../goIndex';

export { BUILTINS, FuncMapEntry, FuncMapParam } from '../goIndex';

export interface FuncMapIndexer {
  getIndex(): Promise<ReadonlyMap<string, FuncMapEntry>>;
  invalidate(): void;
}

/**
 * Thin adapter over the shared workspace index runner: exposes the FuncMap
 * slice of the combined result as a key -> signature map. `invalidate` delegates
 * to the runner so a `.go` change re-scans both FuncMap and execute-site data.
 */
export function getFuncMapIndexer(runner: GoIndexRunner): FuncMapIndexer {
  return {
    async getIndex() {
      const result = await runner.getIndex();
      const map = new Map<string, FuncMapEntry>();
      for (const fn of result.functions) {
        map.set(fn.name, fn);
      }
      return map;
    },
    invalidate() {
      runner.invalidate();
    }
  };
}
