import {
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  Diagnostic,
  DiagnosticSeverity,
  Hover,
  Location,
  Position,
  Range,
  ReferenceContext,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LanguageMode } from '../languageModes';
import { GoTemplateDocument } from '../documentRegions';
import { GotypeDescriptor, parseGotypeComment } from '../gotype';
import { ExecuteSiteIndex, InferredType } from '../inference/executeSiteIndex';
import {
  completePackagePath,
  completeStructNames,
  findGotypeValueRange,
  findGotypeValueSpan,
  GotypeValueSpan,
  resolveGotypeType,
  splitGotypeValue,
} from '../gotypeCompletion';
import { parseTemplate, findPipelineAtOffset, validateTemplateSyntax } from '../templateParser';
import { scanTemplateDirectives } from '../templateDirectives';
import { parsePipeline } from '../pipeline';
import { transpileTemplate } from '../transpiler';
import { createGoplsClient, GoplsClient } from '../gopls/goplsClient';
import { BUILTINS, FuncMapEntry, FuncMapIndexer } from '../indexer/funcMapIndex';
import { TemplateNameService } from '../templateNameService';

export interface GoTemplateLanguageMode extends LanguageMode {
  dispose(): void;
}

export function getGoTemplateMode(
  goplsPath: string,
  rootUri: string | undefined,
  funcMapIndexer: FuncMapIndexer,
  templateNames: TemplateNameService,
  executeSiteIndex: ExecuteSiteIndex,
): GoTemplateLanguageMode {
  const client: GoplsClient = createGoplsClient(goplsPath, rootUri);

  return {
    getId: () => 'gotemplate',

    async doComplete(
      document: TextDocument,
      position: Position,
      regions: GoTemplateDocument,
    ): Promise<CompletionList> {
      const text = document.getText();
      const offset = document.offsetAt(position);

      const span = regions.actionSpans.find((s) => s.start <= offset && offset <= s.end);
      if (!span) return CompletionList.create([], false);

      const gotypeSpan = findGotypeValueSpan(text, offset);
      if (gotypeSpan) {
        return completeGotypeValue(client, document, offset, gotypeSpan);
      }

      const directive = scanTemplateDirectives(text).find(
        (d) => d.nameStart <= offset && offset <= d.nameEnd,
      );
      if (directive && directive.keyword === 'template') {
        await templateNames.ensureReady();
        const prefix = text.slice(directive.nameStart, offset);
        const items: CompletionItem[] = templateNames
          .getAllNames()
          .filter((n) => n.startsWith(prefix))
          .map((n) => ({ label: n, kind: CompletionItemKind.Module, sortText: `0${n}` }));
        return CompletionList.create(items, true);
      }

      const gotype = (await resolveGotype(document, executeSiteIndex)).gotype;
      if (!gotype) return CompletionList.create([], false);

      const nodes = parseTemplate(text);
      const pipe = findPipelineAtOffset(nodes, offset);

      let funcMap: ReadonlyMap<string, FuncMapEntry> = new Map();
      if (pipe) {
        const commands = parsePipeline(pipe.pipeline);
        if (commands.some((c) => c.isCall)) {
          funcMap = await funcMapIndexer.getIndex();
        }
        const native = completeFunctionNames(pipe.pipeline, offset - pipe.pipeStart, funcMap);
        if (native) return native;
      }

      const { uri, goSource, mapOffset } = transpileTemplate(document.uri, text, gotype, funcMap);
      const goOffset = mapOffset(offset);
      if (goOffset < 0) return CompletionList.create([], false);

      await client.openOrUpdate(uri, goSource);
      return client.completion(uri, goOffset);
    },

    async doDefinition(
      document: TextDocument,
      position: Position,
    ): Promise<Location[] | undefined> {
      const text = document.getText();
      const offset = document.offsetAt(position);
      const directive = scanTemplateDirectives(text).find(
        (d) => d.nameStart <= offset && offset <= d.nameEnd,
      );
      if (directive) {
        await templateNames.ensureReady();
        return templateNames.getDefinitions(directive.name);
      }

      const gotype = (await resolveGotype(document, executeSiteIndex)).gotype;
      if (!gotype) return undefined;

      const nodes = parseTemplate(text);
      const pipe = findPipelineAtOffset(nodes, offset);
      if (!pipe) return undefined;

      const { uri, goSource, mapOffset } = transpileTemplate(document.uri, text, gotype);
      const goOffset = mapOffset(offset);
      if (goOffset < 0) return undefined;

      await client.openOrUpdate(uri, goSource);
      return client.definition(uri, resolveGoOffset(goSource, goOffset));
    },

    async doReferences(
      document: TextDocument,
      position: Position,
      _regions: GoTemplateDocument,
      context: ReferenceContext,
    ): Promise<Location[] | undefined> {
      const text = document.getText();
      const offset = document.offsetAt(position);
      const directive = scanTemplateDirectives(text).find(
        (d) => d.nameStart <= offset && offset <= d.nameEnd,
      );
      if (!directive) return undefined;
      await templateNames.ensureReady();
      const refs = templateNames.getReferences(directive.name);
      return context.includeDeclaration
        ? refs.concat(templateNames.getDefinitions(directive.name))
        : refs;
    },

    async doHover(document: TextDocument, position: Position): Promise<Hover | undefined> {
      const text = document.getText();
      const offset = document.offsetAt(position);

      const gotype = (await resolveGotype(document, executeSiteIndex)).gotype;
      if (!gotype) return undefined;

      const nodes = parseTemplate(text);
      const pipe = findPipelineAtOffset(nodes, offset);
      if (!pipe) return undefined;

      const { uri, goSource, mapOffset } = transpileTemplate(document.uri, text, gotype);
      const goOffset = mapOffset(offset);
      if (goOffset < 0) return undefined;

      await client.openOrUpdate(uri, goSource);
      return client.hover(uri, resolveGoOffset(goSource, goOffset));
    },

    async doDiagnostics(document: TextDocument): Promise<Diagnostic[]> {
      const text = document.getText();
      const diagnostics: Diagnostic[] = validateTemplateSyntax(text).map((issue) => ({
        range: Range.create(document.positionAt(issue.start), document.positionAt(issue.end)),
        message: issue.message,
        severity: DiagnosticSeverity.Error,
        source: 'go-template',
      }));

      const binding = await resolveGotype(document, executeSiteIndex);
      const gotype = binding.gotype;
      if (!gotype) {
        if (binding.inferred.length > 1) {
          const names = binding.inferred.map((t) => `${t.importPath}.${t.typeName}`).join(', ');
          diagnostics.push({
            range: Range.create({ line: 0, character: 0 }, { line: 0, character: 0 }),
            message: `Template executed with multiple types (${names}); add a gotype: comment to disambiguate.`,
            severity: DiagnosticSeverity.Hint,
            source: 'go-template',
          });
        }
        return diagnostics;
      }

      if (!(await client.health())) return diagnostics;

      const resolved = await resolveGotypeType(
        client,
        document.uri,
        gotype.importPath,
        gotype.typeName,
      );
      if (!resolved) {
        const span = findGotypeValueRange(text);
        const range = span
          ? Range.create(document.positionAt(span.start), document.positionAt(span.end))
          : Range.create({ line: 0, character: 0 }, { line: 0, character: 0 });

        diagnostics.push({
          range,
          message: `gotype type "${gotype.importPath}.${gotype.typeName}" not found or not a struct type.`,
          severity: DiagnosticSeverity.Error,
          source: 'go-template',
        });
        return diagnostics;
      }

      // The gotype resolves: type-check the transpiled file with gopls and map
      // its diagnostics (undefined fields, wrong arity, type mismatches) back
      // onto the original template offsets.
      const funcMap = await funcMapIndexer.getIndex();
      const { uri, goSource, mapGoRange } = transpileTemplate(document.uri, text, gotype, funcMap);
      await client.openOrUpdate(uri, goSource);
      const goDiagnostics = await client.diagnostics(uri);
      for (const d of goDiagnostics) {
        if (isBuiltinUndefinedDiagnostic(d.message)) continue;
        const goStart = positionToOffset(goSource, d.range.start);
        const goEnd = positionToOffset(goSource, d.range.end);
        const mapped = mapGoRange(goStart, goEnd);
        if (!mapped) continue;
        diagnostics.push({
          range: Range.create(document.positionAt(mapped.start), document.positionAt(mapped.end)),
          message: d.message,
          severity: d.severity ?? DiagnosticSeverity.Error,
          source: 'go-template',
        });
      }
      return diagnostics;
    },

    dispose() {
      client.dispose();
    },
  };
}

/**
 * gopls resolves the token *containing* a position, but `mapOffset` returns the
 * Go boundary *after* the character under the template cursor. When that boundary
 * lands just past an identifier (the common "cursor at the end of a field name"
 * case), step back one so the position points inside the token instead of at the
 * following whitespace/newline.
 */
function resolveGoOffset(goSource: string, goOffset: number): number {
  if (goOffset > 0 && /[A-Za-z0-9_]/.test(goSource[goOffset - 1])) {
    return goOffset - 1;
  }
  return goOffset;
}

/**
 * Converts an LSP position to a byte offset in the given text. Inverse of the
 * offset-to-position helpers used elsewhere; needed to turn gopls diagnostic
 * ranges (relative to the synthetic Go source) into offsets for `mapGoRange`.
 */
function positionToOffset(text: string, position: Position): number {
  let line = 0;
  let lineStart = 0;
  while (line < position.line) {
    const nl = text.indexOf('\n', lineStart);
    if (nl === -1) return text.length;
    lineStart = nl + 1;
    line++;
  }
  return lineStart + position.character;
}

interface ResolvedGotype {
  gotype?: GotypeDescriptor;
  /** All inferred types (empty when a `gotype:` comment is present). */
  inferred: InferredType[];
}

/**
 * Resolves the root type for a template file: the explicit `gotype:` comment
 * always wins, otherwise fall back to execute-site inference (§2.2). `inferred`
 * carries the full inferred list so diagnostics can surface an ambiguity hint
 * instead of silently picking one when multiple distinct types are found.
 */
async function resolveGotype(
  document: TextDocument,
  executeSiteIndex: ExecuteSiteIndex,
): Promise<ResolvedGotype> {
  const comment = parseGotypeComment(document.getText());
  if (comment) return { gotype: comment, inferred: [] };

  const inferred = await executeSiteIndex.resolveGotype(document.uri);
  if (inferred.length === 1) {
    const first = inferred[0];
    return { gotype: { importPath: first.importPath, typeName: first.typeName }, inferred };
  }
  return { inferred };
}

const TEMPLATE_BUILTIN_NAMES = new Set(BUILTINS.map((b) => b.name));

/**
 * Template builtins (and/or/eq/index/printf/...) aren't Go functions, so the
 * transpiled file reports them as "undefined". Those are false positives for our
 * purposes — skip them. Go builtins like `len`/`print` resolve natively and never
 * produce this error.
 */
function isBuiltinUndefinedDiagnostic(message: string): boolean {
  const m = /undefined:\s*([A-Za-z_]\w*)/.exec(message);
  return m !== null && TEMPLATE_BUILTIN_NAMES.has(m[1]);
}

/**
 * Handles §4.1a completion while authoring the `gotype:` value itself: package
 * paths before the type-separator dot, exported struct names after it. Each item
 * carries a textEdit scoped to the template so acceptance replaces only the
 * partial value up to the cursor.
 */
async function completeGotypeValue(
  client: GoplsClient,
  document: TextDocument,
  offset: number,
  span: GotypeValueSpan,
): Promise<CompletionList> {
  const { packagePath, typePrefix, hasTypeSeparator } = splitGotypeValue(span.value);

  if (!hasTypeSeparator) {
    const items = await completePackagePath(client, document.uri, packagePath);
    const range = Range.create(document.positionAt(span.start), document.positionAt(offset));
    for (const item of items) item.textEdit = { range, newText: item.label };
    return CompletionList.create(items, true);
  }

  const items = await completeStructNames(client, document.uri, packagePath, typePrefix);
  const typeStart = span.start + packagePath.length + 1;
  const range = Range.create(document.positionAt(typeStart), document.positionAt(offset));
  for (const item of items) item.textEdit = { range, newText: item.label };
  return CompletionList.create(items, true);
}

/**
 * Offers registered FuncMap keys and template builtins when the cursor sits in a
 * call command's leading function-name span, with real signatures in the detail.
 * Returns undefined when the cursor is elsewhere so the caller falls through to
 * the gopls-backed argument/field completion path.
 */
function completeFunctionNames(
  pipeline: string,
  cursorRel: number,
  funcMap: ReadonlyMap<string, FuncMapEntry>,
): CompletionList | undefined {
  for (const cmd of parsePipeline(pipeline)) {
    if (cursorRel < cmd.nameStart || cursorRel > cmd.nameEnd) continue;

    const prefix = pipeline.slice(cmd.nameStart, cursorRel);
    const items: CompletionItem[] = [];
    for (const entry of [...funcMap.values(), ...BUILTINS]) {
      if (!entry.name.startsWith(prefix)) continue;
      items.push({
        label: entry.name,
        kind: CompletionItemKind.Function,
        detail: formatSignature(entry),
        sortText: `0${entry.name}`,
      });
    }
    return CompletionList.create(items, true);
  }
  return undefined;
}

function formatSignature(entry: FuncMapEntry): string {
  const params = entry.params
    .map((p, i) => {
      const type = entry.variadic && i === entry.params.length - 1 ? `...${p.type}` : p.type;
      return p.name ? `${p.name} ${type}` : type;
    })
    .join(', ');
  const results =
    entry.results.length === 0
      ? ''
      : entry.results.length === 1
        ? ` ${entry.results[0]}`
        : ` (${entry.results.join(', ')})`;
  return `func(${params})${results}`;
}
