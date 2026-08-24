import { CompletionItem, CompletionItemKind } from 'vscode-languageserver/node';
import { GoplsClient } from './gopls/goplsClient';
import { scanActions } from './templateParser';
import { resolvePackageName } from './transpiler';

const GOTYPE_MARKER = 'gotype:';

const PACKAGE_SYNTHETIC_SUFFIX = '.gotype_pkg.go';
const MEMBER_SYNTHETIC_SUFFIX = '.gotype_members.go';
const WARMUP_SYNTHETIC_SUFFIX = '.gotype_warmup.go';

export interface GotypeValueSpan {
  /** Document offset of the start of the gotype value (after `gotype:` + whitespace). */
  start: number;
  /** Document offset one past the end of the gotype value run. */
  end: number;
  /** The non-whitespace value text (may be partial while typing). */
  value: string;
}

export interface GotypeValueParts {
  packagePath: string;
  typePrefix: string;
  /** true when the cursor is past the type-separator dot (struct-name mode). */
  hasTypeSeparator: boolean;
}

/**
 * Locates the `{{ / * gotype: ... * / }}` value run in a template, if any. Unlike
 * `parseGotypeComment`, this matches *partial* comments — the closing marker may
 * not have been typed yet — so it can drive completion while authoring the value.
 */
export function findGotypeValueRange(text: string): GotypeValueSpan | undefined {
  for (const span of scanActions(text)) {
    const content = span.content;
    const markerIdx = content.indexOf(GOTYPE_MARKER);
    if (markerIdx === -1) continue;

    const base = span.start + 2;
    let i = markerIdx + GOTYPE_MARKER.length;
    while (i < content.length && /\s/.test(content[i])) i++;
    let j = i;
    while (j < content.length && !/\s/.test(content[j])) j++;

    let value = content.slice(i, j);
    if (value.endsWith('*/')) value = value.slice(0, -2);

    return { start: base + i, end: base + i + value.length, value };
  }
  return undefined;
}

/**
 * Like `findGotypeValueRange`, but only returns a result when `offset` sits
 * inside the value run (or at its empty start), signalling "cursor is in the
 * gotype value" for completion purposes.
 */
export function findGotypeValueSpan(text: string, offset: number): GotypeValueSpan | undefined {
  const range = findGotypeValueRange(text);
  if (!range) return undefined;
  if (offset >= range.start && offset <= range.end) return range;
  return undefined;
}

/**
 * Splits a (possibly partial) gotype value into its package path and type name
 * segments. The type-separator dot is the last `.` that appears after the final
 * `/`, since Go import paths may contain dots (domains) but the final path
 * segment (the package name) never does. Before that dot is typed we're still in
 * the package-path segment.
 */
export function splitGotypeValue(value: string): GotypeValueParts {
  const lastSlash = value.lastIndexOf('/');
  const lastDot = value.lastIndexOf('.');
  if (lastDot > lastSlash) {
    return { packagePath: value.slice(0, lastDot), typePrefix: value.slice(lastDot + 1), hasTypeSeparator: true };
  }
  return { packagePath: value, typePrefix: '', hasTypeSeparator: false };
}

function fullImportPath(item: CompletionItem): string {
  const detail = item.detail;
  if (detail && detail.length >= 2 && detail[0] === '"' && detail[detail.length - 1] === '"') {
    return detail.slice(1, -1);
  }
  return item.label;
}

/**
 * Offers importable package paths for a partial import prefix, reusing gopls's
 * own import-statement completion via a synthetic `import "…"` file placed next
 * to the template so it joins the enclosing module.
 */
export async function completePackagePath(
  client: GoplsClient,
  documentUri: string,
  prefix: string
): Promise<CompletionItem[]> {
  const pkgName = resolvePackageName(documentUri);
  const uri = `${documentUri}${PACKAGE_SYNTHETIC_SUFFIX}`;
  const source = `package ${pkgName}\n\nimport "${prefix}"`;
  await client.openOrUpdate(uri, source);

  let list = await client.completion(uri, source.length - 1);
  if (list.items.length === 0) {
    // On a cold start gopls may answer import completion before the module's
    // package list is loaded. Type-checking a plain file in this package forces
    // the workspace load, after which the import query resolves.
    const warmupUri = `${documentUri}${WARMUP_SYNTHETIC_SUFFIX}`;
    const warmupSource = `package ${pkgName}\n\nfunc _gotmplWarmup() {\n\tvar _ int\n}\n`;
    await client.openOrUpdate(warmupUri, warmupSource);
    await client.completion(warmupUri, warmupSource.length);
    list = await client.completion(uri, source.length - 1);
  }

  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const item of list.items) {
    const path = fullImportPath(item);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    items.push({ label: path, kind: CompletionItemKind.Module, sortText: `0${path}` });
  }
  return items;
}

/**
 * Offers exported struct type names for a given package path, via a synthetic
 * `var _ = gotmpl0.<prefix>` file whose members gopls completes. Non-struct
 * exported identifiers are filtered out (see §4.1a).
 */
export async function completeStructNames(
  client: GoplsClient,
  documentUri: string,
  packagePath: string,
  typePrefix: string
): Promise<CompletionItem[]> {
  const uri = `${documentUri}${MEMBER_SYNTHETIC_SUFFIX}`;
  const source = `package ${resolvePackageName(documentUri)}\n\nimport gotmpl0 "${packagePath}"\n\nvar _ = gotmpl0.${typePrefix}`;
  await client.openOrUpdate(uri, source);
  const list = await client.completion(uri, source.length);

  const seen = new Set<string>();
  const items: CompletionItem[] = [];
  for (const item of list.items) {
    if (item.kind !== CompletionItemKind.Struct) continue;
    if (seen.has(item.label)) continue;
    seen.add(item.label);
    items.push({ label: item.label, kind: CompletionItemKind.Struct, sortText: `0${item.label}` });
  }
  return items;
}

/**
 * Resolves whether `importPath.typeName` is a real, importable struct type, for
 * the §4.1a validation diagnostic. Reuses the same synthetic member completion
 * as `completeStructNames` and reports true only when the exact type name comes
 * back as a struct.
 */
export async function resolveGotypeType(
  client: GoplsClient,
  documentUri: string,
  importPath: string,
  typeName: string
): Promise<boolean> {
  const uri = `${documentUri}${MEMBER_SYNTHETIC_SUFFIX}`;
  const source = `package ${resolvePackageName(documentUri)}\n\nimport gotmpl0 "${importPath}"\n\nvar _ = gotmpl0.${typeName}`;
  await client.openOrUpdate(uri, source);
  const list = await client.completion(uri, source.length);
  return list.items.some((item) => item.label === typeName && item.kind === CompletionItemKind.Struct);
}
