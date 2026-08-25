import * as fs from 'fs';
import {
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  Diagnostic,
  DiagnosticSeverity,
  Hover,
  Location,
  ParameterInformation,
  Position,
  Range,
  ReferenceContext,
  SemanticTokens,
  SignatureHelp,
  SignatureInformation,
  TextEdit,
  WorkspaceEdit,
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
import {
  parseTemplate,
  findPipelineAtOffset,
  validateTemplateSyntax,
  scanActions,
  classify,
  ActionSpan,
} from '../templateParser';
import { scanTemplateDirectives, TemplateNameDirective } from '../templateDirectives';
import { parsePipeline, PipelineCommand } from '../pipeline';
import { transpileTemplate } from '../transpiler';
import { GoplsClient } from '../gopls/goplsClient';
import { createGoplsClientPool } from '../gopls/goplsClientPool';
import { BUILTINS, FuncMapEntry, FuncMapIndexer } from '../indexer/funcMapIndex';
import { TemplateNameService } from '../templateNameService';
import { annotateUnresolvedFields, buildSemanticTokens, tokenize } from '../semanticTokens';

export interface GoTemplateLanguageMode extends LanguageMode {
  getSemanticTokens(document: TextDocument): Promise<SemanticTokens>;
  dispose(): void;
}

export function getGoTemplateMode(
  goplsPath: string,
  workspaceRoots: string[],
  funcMapIndexer: FuncMapIndexer,
  templateNames: TemplateNameService,
  executeSiteIndex: ExecuteSiteIndex,
): GoTemplateLanguageMode {
  const client: GoplsClient = createGoplsClientPool(goplsPath, workspaceRoots);

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

    async doSignatureHelp(
      document: TextDocument,
      position: Position,
      regions: GoTemplateDocument,
    ): Promise<SignatureHelp | null> {
      const text = document.getText();
      const offset = document.offsetAt(position);

      const span = regions.actionSpans.find((s) => s.start <= offset && offset <= s.end);
      if (!span) return null;

      const nodes = parseTemplate(text);
      const pipe = findPipelineAtOffset(nodes, offset);
      if (!pipe) return null;

      const commands = parsePipeline(pipe.pipeline);
      const cursorRel = offset - pipe.pipeStart;

      let target: PipelineCommand | undefined;
      let targetIndex = -1;
      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        if (!cmd.isCall) continue;
        if (cursorRel >= cmd.start && cursorRel <= cmd.end) {
          target = cmd;
          targetIndex = i;
        }
      }
      if (!target) return null;

      let entry = BUILTINS.find((b) => b.name === target.name);
      if (!entry) entry = (await funcMapIndexer.getIndex()).get(target.name);
      if (!entry) return null;

      return {
        signatures: [buildSignatureInformation(entry)],
        activeSignature: 0,
        activeParameter: activeParameterFor(target, targetIndex, cursorRel, entry.params.length),
      };
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

      const nodes = parseTemplate(text);
      const pipe = findPipelineAtOffset(nodes, offset);
      if (!pipe) return undefined;

      const cursorRel = offset - pipe.pipeStart;
      const commands = parsePipeline(pipe.pipeline);
      const call = commands.find(
        (c) => c.isCall && cursorRel >= c.nameStart && cursorRel <= c.nameEnd,
      );
      if (call) {
        let entry = BUILTINS.find((b) => b.name === call.name);
        if (!entry) entry = (await funcMapIndexer.getIndex()).get(call.name);
        if (!entry) return undefined;
        if (!entry.file) return undefined;
        return [
          Location.create(
            pathToFileUri(entry.file),
            Range.create(
              Position.create(entry.line ?? 0, entry.character ?? 0),
              Position.create(entry.line ?? 0, entry.character ?? 0),
            ),
          ),
        ];
      }

      const gotype = (await resolveGotype(document, executeSiteIndex)).gotype;
      if (!gotype) return undefined;

      const funcMap = commands.some((c) => c.isCall) ? await funcMapIndexer.getIndex() : undefined;
      const { uri, goSource, mapOffset } = transpileTemplate(document.uri, text, gotype, funcMap);
      const goOffset = mapOffset(offset);
      if (goOffset < 0) return undefined;

      await client.openOrUpdate(uri, goSource);
      const defs = await client.definition(uri, resolveGoOffset(goSource, goOffset));
      return defs.filter((d) => !isSyntheticUri(d.uri));
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

    doPrepareRename(document: TextDocument, position: Position): Range | null {
      const text = document.getText();
      const offset = document.offsetAt(position);

      const directive = scanTemplateDirectives(text).find(
        (d) => d.nameStart <= offset && offset <= d.nameEnd,
      );
      if (directive) {
        return Range.create(
          document.positionAt(directive.nameStart),
          document.positionAt(directive.nameEnd),
        );
      }

      const field = findFieldAccessAt(text, offset);
      if (!field) return null;
      return Range.create(document.positionAt(field.start), document.positionAt(field.end));
    },

    async doRename(
      document: TextDocument,
      position: Position,
      newName: string,
    ): Promise<WorkspaceEdit | undefined> {
      const text = document.getText();
      const offset = document.offsetAt(position);

      const directive = scanTemplateDirectives(text).find(
        (d) => d.nameStart <= offset && offset <= d.nameEnd,
      );
      if (directive) {
        return renameTemplateName(directive.name, newName, templateNames);
      }

      const field = findFieldAccessAt(text, offset);
      if (!field) return undefined;
      return renameField(document, field, newName, client, executeSiteIndex, templateNames);
    },

    async doHover(document: TextDocument, position: Position): Promise<Hover | undefined> {
      const text = document.getText();
      const offset = document.offsetAt(position);

      const directive = scanTemplateDirectives(text).find(
        (d) =>
          (d.keyword === 'define' || d.keyword === 'block') &&
          d.nameStart <= offset &&
          offset <= d.nameEnd,
      );
      if (directive) {
        const comment = findDefineComment(text, directive);
        return comment ? { contents: { kind: 'markdown', value: comment } } : undefined;
      }

      const functionHover = await hoverFunctionName(text, offset, funcMapIndexer);
      if (functionHover) return functionHover;

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

      if (!(await client.health(document.uri))) return diagnostics;

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

    async getSemanticTokens(document: TextDocument): Promise<SemanticTokens> {
      const text = document.getText();
      const tokens = tokenize(text);

      const binding = await resolveGotype(document, executeSiteIndex);
      const gotype = binding.gotype;
      if (gotype && (await client.health(document.uri))) {
        const funcMap = await funcMapIndexer.getIndex();
        const { uri, goSource, mapOffset } = transpileTemplate(document.uri, text, gotype, funcMap);
        await client.openOrUpdate(uri, goSource);
        await annotateUnresolvedFields(tokens, async (offset) => {
          const goOffset = mapOffset(offset);
          if (goOffset < 0) return false;
          const defs = await client.definition(uri, resolveGoOffset(goSource, goOffset));
          return defs.some((d) => !isSyntheticUri(d.uri));
        });
      }

      return buildSemanticTokens(tokens, document);
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
  return resolveGotypeFor(document.uri, document.getText(), executeSiteIndex);
}

/**
 * Variant of {@link resolveGotype} that takes raw text + URI rather than a
 * TextDocument, so the field-rename sweep can resolve the root type for sibling
 * template files read straight from disk.
 */
async function resolveGotypeFor(
  uri: string,
  text: string,
  executeSiteIndex: ExecuteSiteIndex,
): Promise<ResolvedGotype> {
  const comment = parseGotypeComment(text);
  if (comment) return { gotype: comment, inferred: [] };

  const inferred = await executeSiteIndex.resolveGotype(uri);
  if (inferred.length === 1) {
    const first = inferred[0];
    return { gotype: { importPath: first.importPath, typeName: first.typeName }, inferred };
  }
  return { inferred };
}

interface FieldAccess {
  name: string;
  start: number;
  end: number;
}

/**
 * Locates a `.Field` selector under the cursor. Template field access is always
 * spelled `.Field` regardless of base (`.`, `$var`, or a nested chain), so the
 * only requirement is that the identifier token is preceded by a `.`.
 */
function findFieldAccessAt(text: string, offset: number): FieldAccess | undefined {
  let start = offset;
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start--;
  let end = offset;
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end++;
  if (start === end || !/[A-Za-z_]/.test(text[start])) return undefined;
  if (start === 0 || text[start - 1] !== '.') return undefined;
  return { name: text.slice(start, end), start, end };
}

function offsetToPosition(text: string, offset: number): Position {
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

function readFileFromUri(uri: string): string | undefined {
  try {
    return fs.readFileSync(decodeURIComponent(uri.replace(/^file:\/\//, '')), 'utf8');
  } catch {
    return undefined;
  }
}

const SYNTHETIC_SUFFIX = '.gotmpl_completion.go';

function isSyntheticUri(uri: string): boolean {
  return uri.endsWith(SYNTHETIC_SUFFIX);
}

function pathToFileUri(p: string): string {
  return 'file://' + encodeURI(p.replace(/\\/g, '/'));
}

function sameLocation(a: Location, b: Location): boolean {
  return (
    a.uri === b.uri &&
    a.range.start.line === b.range.start.line &&
    a.range.start.character === b.range.start.character
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every `.fieldName` selector occurrence in the source, as name offsets
 * (excluding the leading `.`). Word-boundary safe so a field named `Name`
 * doesn't match `NameLength`.
 */
function findSelectorOccurrences(
  text: string,
  fieldName: string,
): Array<{ start: number; end: number }> {
  const occurrences: Array<{ start: number; end: number }> = [];
  const re = new RegExp(`\\.(${escapeRegex(fieldName)})(?![A-Za-z0-9_])`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    occurrences.push({ start: m.index + 1, end: m.index + 1 + fieldName.length });
  }
  return occurrences;
}

function dedupeChanges(edits: Map<string, TextEdit[]>): Record<string, TextEdit[]> {
  const out: Record<string, TextEdit[]> = {};
  for (const [uri, list] of edits) {
    const seen = new Set<string>();
    const unique: TextEdit[] = [];
    for (const e of list) {
      const key = `${e.range.start.line}:${e.range.start.character}-${e.range.end.line}:${e.range.end.character}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(e);
    }
    unique.sort(
      (a, b) =>
        a.range.start.line - b.range.start.line ||
        a.range.start.character - b.range.start.character,
    );
    out[uri] = unique;
  }
  return out;
}

/** Extracts per-URI text edits from a WorkspaceEdit whether gopls used `changes` or `documentChanges`. */
function workspaceEditChanges(
  edit: WorkspaceEdit | undefined,
): Map<string, TextEdit[]> | undefined {
  if (!edit) return undefined;
  const out = new Map<string, TextEdit[]>();
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) out.set(uri, edits);
    return out;
  }
  if (edit.documentChanges) {
    for (const dc of edit.documentChanges) {
      if (!('textDocument' in dc)) continue;
      const uri = dc.textDocument.uri;
      const arr = out.get(uri) ?? [];
      arr.push(...dc.edits);
      out.set(uri, arr);
    }
    return out;
  }
  return undefined;
}

/**
 * §2.4 (name direction) — renames a `define`/`block` name across every
 * definition and `template`/`block` call site, reusing the workspace index built
 * for define/block navigation. A `block` is both a definition and a reference,
 * so the two lists are merged and de-duplicated.
 */
async function renameTemplateName(
  name: string,
  newName: string,
  templateNames: TemplateNameService,
): Promise<WorkspaceEdit> {
  await templateNames.ensureReady();
  const edits = new Map<string, TextEdit[]>();
  const push = (loc: Location): void => {
    const arr = edits.get(loc.uri) ?? [];
    arr.push(TextEdit.replace(loc.range, newName));
    edits.set(loc.uri, arr);
  };
  for (const loc of templateNames.getDefinitions(name)) push(loc);
  for (const loc of templateNames.getReferences(name)) push(loc);
  return { changes: dedupeChanges(edits) };
}

/**
 * §2.4 (field direction) — renames a struct field referenced by a `.Field` /
 * `$var.Field` selector. The Go-side rename is delegated to gopls (which
 * rewrites the declaration and every `.go` reference), and template-side
 * references across the workspace are rewritten after confirming each resolves
 * to the same field declaration via gopls (so a same-named field on a different
 * type — e.g. shadowed by a `range` element — is left untouched).
 */
async function renameField(
  document: TextDocument,
  field: FieldAccess,
  newName: string,
  client: GoplsClient,
  executeSiteIndex: ExecuteSiteIndex,
  templateNames: TemplateNameService,
): Promise<WorkspaceEdit | undefined> {
  const text = document.getText();
  const binding = await resolveGotype(document, executeSiteIndex);
  const gotype = binding.gotype;
  if (!gotype) return undefined;

  const current = transpileTemplate(document.uri, text, gotype);
  const goOffset = current.mapOffset(field.start);
  if (goOffset < 0) return undefined;

  await client.openOrUpdate(current.uri, current.goSource);
  const defs = await client.definition(current.uri, resolveGoOffset(current.goSource, goOffset));
  const fieldDecl = defs.find((d) => !isSyntheticUri(d.uri));
  if (!fieldDecl) return undefined;

  const changes = new Map<string, TextEdit[]>();

  const goText = readFileFromUri(fieldDecl.uri);
  if (goText !== undefined) {
    const declOffset = positionToOffset(goText, fieldDecl.range.start);
    await client.openOrUpdate(fieldDecl.uri, goText);
    const goChanges = workspaceEditChanges(await client.rename(fieldDecl.uri, declOffset, newName));
    if (goChanges) {
      for (const [uri, edits] of goChanges) {
        if (isSyntheticUri(uri)) continue;
        changes.set(uri, edits);
      }
    }
  }

  const files: Array<{ uri: string; text: string }> = [{ uri: document.uri, text }];
  for (const siblingUri of templateNames.getAllFiles()) {
    if (siblingUri === document.uri) continue;
    const siblingText = readFileFromUri(siblingUri);
    if (siblingText === undefined) continue;
    files.push({ uri: siblingUri, text: siblingText });
  }

  for (const file of files) {
    const fileBinding =
      file.uri === document.uri
        ? binding
        : await resolveGotypeFor(file.uri, file.text, executeSiteIndex);
    const fileGotype = fileBinding.gotype;
    if (!fileGotype) continue;

    const occurrences = await collectFieldOccurrences(
      file.uri,
      file.text,
      field.name,
      fileGotype,
      fieldDecl,
      client,
    );
    if (occurrences.length === 0) continue;

    const arr = changes.get(file.uri) ?? [];
    for (const occ of occurrences) {
      arr.push(
        TextEdit.replace(
          Range.create(
            offsetToPosition(file.text, occ.start),
            offsetToPosition(file.text, occ.end),
          ),
          newName,
        ),
      );
    }
    changes.set(file.uri, arr);
  }

  return { changes: dedupeChanges(changes) };
}

async function collectFieldOccurrences(
  fileUri: string,
  text: string,
  fieldName: string,
  gotype: GotypeDescriptor,
  fieldDecl: Location,
  client: GoplsClient,
): Promise<Array<{ start: number; end: number }>> {
  const { uri, goSource, mapOffset } = transpileTemplate(fileUri, text, gotype);
  await client.openOrUpdate(uri, goSource);

  const occurrences: Array<{ start: number; end: number }> = [];
  for (const occ of findSelectorOccurrences(text, fieldName)) {
    const goOffset = mapOffset(occ.start);
    if (goOffset < 0) continue;
    const defs = await client.definition(uri, resolveGoOffset(goSource, goOffset));
    if (defs.some((d) => !isSyntheticUri(d.uri) && sameLocation(d, fieldDecl))) {
      occurrences.push(occ);
    }
  }
  return occurrences;
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

/**
 * Builds a signature-help entry for a FuncMap/builtin function from its index
 * entry: one `ParameterInformation` per parameter, with the last marked variadic
 * when applicable, and the same label used in completion details.
 */
function buildSignatureInformation(entry: FuncMapEntry): SignatureInformation {
  const parameters: ParameterInformation[] = entry.params.map((p, i) => {
    const type = entry.variadic && i === entry.params.length - 1 ? `...${p.type}` : p.type;
    return { label: p.name ? `${p.name} ${type}` : type };
  });
  return { label: formatSignature(entry), parameters };
}

/**
 * Determines which parameter the cursor is editing. A chained command receives
 * the piped-in value as argument 0, so explicit arguments start at index 1; the
 * result is clamped to the last declared parameter (variadic functions fold all
 * trailing arguments into it).
 */
function activeParameterFor(
  cmd: PipelineCommand,
  commandIndex: number,
  cursorRel: number,
  paramCount: number,
): number {
  let active = commandIndex === 0 ? 0 : 1;
  for (const arg of cmd.args) {
    if (cursorRel <= arg.end) break;
    active++;
  }
  return Math.max(0, Math.min(active, paramCount - 1));
}

/**
 * Finds a `{{/* ... *\/}}` comment placed directly above a `{{define}}`/`{{block}}`
 * directive (only whitespace in between) and returns its inner text.
 */
function findDefineComment(text: string, directive: TemplateNameDirective): string | undefined {
  const spans = scanActions(text);

  let dirSpan: ActionSpan | undefined;
  for (const s of spans) {
    if (s.start <= directive.nameStart && directive.nameEnd <= s.end) {
      dirSpan = s;
      break;
    }
  }
  if (!dirSpan) return undefined;

  let nearest: ActionSpan | undefined;
  for (const s of spans) {
    if (s.end > dirSpan.start) break;
    nearest = s;
  }
  if (!nearest || classify(nearest.content).type !== 'comment') return undefined;
  if (/[^\s]/.test(text.slice(nearest.end, dirSpan.start))) return undefined;
  return commentText(nearest);
}

function commentText(span: ActionSpan): string {
  const start = span.content.indexOf('/*');
  const end = span.content.lastIndexOf('*/');
  if (start === -1 || end === -1 || end <= start) return '';
  return span.content.slice(start + 2, end).trim();
}

/**
 * Hovers the name of a FuncMap/builtin call command: its Go doc comment when the
 * indexer captured one, otherwise the formatted signature as a code block.
 */
async function hoverFunctionName(
  text: string,
  offset: number,
  funcMapIndexer: FuncMapIndexer,
): Promise<Hover | undefined> {
  const nodes = parseTemplate(text);
  const pipe = findPipelineAtOffset(nodes, offset);
  if (!pipe) return undefined;

  const cursorRel = offset - pipe.pipeStart;
  for (const cmd of parsePipeline(pipe.pipeline)) {
    if (!cmd.isCall || cursorRel < cmd.nameStart || cursorRel > cmd.nameEnd) continue;

    let entry = BUILTINS.find((b) => b.name === cmd.name);
    if (!entry) entry = (await funcMapIndexer.getIndex()).get(cmd.name);
    if (!entry) return undefined;

    const parts = [`\`\`\`go\n${formatSignature(entry)}\n\`\`\``];
    if (entry.doc?.trim()) {
      parts.push(entry.doc.trim());
    }
    return { contents: { kind: 'markdown', value: parts.join('\n\n') } };
  }
  return undefined;
}
