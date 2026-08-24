import { InferredType, GoIndexRunner } from '../goIndex';
import { TemplateNameService } from '../templateNameService';

export { InferredType };

export interface ExecuteSiteIndex {
  /** Returns the distinct inferred root types for a template file URI (empty when none). */
  resolveGotype(uri: string): Promise<InferredType[]>;
  invalidate(): void;
}

function pathToUri(p: string): string {
  return 'file://' + encodeURI(p.replace(/\\/g, '/'));
}

function typeKey(t: InferredType): string {
  return `${t.importPath}\u0000${t.typeName}`;
}

/**
 * Resolves execute-site inference records (produced by the Go indexer) to a
 * template file's inferred root type(s). Name-keyed sites (`ExecuteTemplate`)
 * are mapped back to files via the define/block index plus root-name basename
 * matching; file-keyed sites (`Execute` + traced ParseFiles chains) map
 * directly. Results are deduplicated by (importPath, typeName).
 */
export function getExecuteSiteIndex(
  runner: GoIndexRunner,
  templateNames: TemplateNameService,
): ExecuteSiteIndex {
  async function resolve(): Promise<Map<string, InferredType[]>> {
    await templateNames.ensureReady();
    const result = await runner.getIndex();

    const fileTypes = new Map<string, Map<string, InferredType>>();
    const add = (uri: string, type: InferredType): void => {
      let byKey = fileTypes.get(uri);
      if (!byKey) {
        byKey = new Map();
        fileTypes.set(uri, byKey);
      }
      byKey.set(typeKey(type), type);
    };

    for (const site of result.executeSites) {
      if (site.files) {
        for (const file of site.files) add(pathToUri(file), site.type);
        continue;
      }
      if (site.name) {
        const uris = new Set<string>();
        for (const loc of templateNames.getDefinitions(site.name)) uris.add(loc.uri);
        for (const uri of templateNames.getFilesByBasename(site.name)) uris.add(uri);
        for (const uri of uris) add(uri, site.type);
      }
    }

    const out = new Map<string, InferredType[]>();
    for (const [uri, byKey] of fileTypes) out.set(uri, [...byKey.values()]);
    return out;
  }

  return {
    async resolveGotype(uri) {
      const index = await resolve();
      return index.get(uri) ?? [];
    },
    invalidate() {
      runner.invalidate();
    },
  };
}
