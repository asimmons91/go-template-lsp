import { FuncMapEntry, FuncMapParam, GoIndexRunner } from '../goIndex';

export { BUILTINS, FuncMapEntry, FuncMapParam } from '../goIndex';

export interface ExtraFuncsEntry {
  params?: Array<string | { name: string; type: string }>;
  results?: string[];
  variadic?: boolean;
  imports?: Record<string, string>;
  doc?: string;
}

export interface FuncMapIndexer {
  getIndex(): Promise<ReadonlyMap<string, FuncMapEntry>>;
  invalidate(): void;
  /** Replaces the extra (settings-declared) function layer used to fill gaps. */
  setExtraFuncs(entries: FuncMapEntry[]): void;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Normalizes the raw `goTemplate.extraFuncs` setting (an object keyed by
 * function name) into `FuncMapEntry`s. Malformed entries are dropped rather
 * than thrown, so a bad setting degrades gracefully.
 */
export function normalizeExtraFuncs(
  raw: Record<string, ExtraFuncsEntry> | undefined,
): FuncMapEntry[] {
  const entries: FuncMapEntry[] = [];
  if (!raw || typeof raw !== 'object') return entries;

  for (const [name, spec] of Object.entries(raw)) {
    if (!NAME_RE.test(name)) continue;
    if (!spec || typeof spec !== 'object') continue;

    const params: FuncMapParam[] = [];
    let ok = true;
    for (const p of spec.params ?? []) {
      if (typeof p === 'string') {
        params.push({ name: '', type: p });
      } else if (p && typeof p === 'object' && typeof p.type === 'string') {
        params.push({ name: typeof p.name === 'string' ? p.name : '', type: p.type });
      } else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    const results = (spec.results ?? []).filter((r): r is string => typeof r === 'string');

    entries.push({
      name,
      params,
      results,
      variadic: spec.variadic === true,
      imports: spec.imports && typeof spec.imports === 'object' ? spec.imports : undefined,
      doc: typeof spec.doc === 'string' ? spec.doc : undefined,
    });
  }
  return entries;
}

/**
 * Thin adapter over the shared workspace index runner: exposes the FuncMap
 * slice of the combined result as a key -> signature map. Settings-declared
 * `extraFuncs` form a base layer that scanned workspace entries override, so the
 * manual fallback fills gaps without displacing real type info.
 */
export function getFuncMapIndexer(runner: GoIndexRunner): FuncMapIndexer {
  let extraFuncs: FuncMapEntry[] = [];
  return {
    async getIndex() {
      const result = await runner.getIndex();
      const map = new Map<string, FuncMapEntry>();
      for (const fn of extraFuncs) {
        map.set(fn.name, fn);
      }
      for (const fn of result.functions) {
        map.set(fn.name, fn);
      }
      return map;
    },
    invalidate() {
      runner.invalidate();
    },
    setExtraFuncs(entries) {
      extraFuncs = entries;
    },
  };
}
