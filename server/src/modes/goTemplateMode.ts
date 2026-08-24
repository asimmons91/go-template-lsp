import { CompletionItem, CompletionItemKind, CompletionList, Diagnostic, DiagnosticSeverity, Location, Position, Range, ReferenceContext } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LanguageMode } from '../languageModes';
import { GoTemplateDocument } from '../documentRegions';
import { parseGotypeComment } from '../gotype';
import { parseTemplate, findPipelineAtOffset, validateTemplateSyntax } from '../templateParser';
import { scanTemplateDirectives } from '../templateDirectives';
import { parsePipeline } from '../pipeline';
import { transpileTemplate } from '../transpiler';
import { createGoplsClient, GoplsClient } from '../gopls/goplsClient';
import { BUILTINS, FuncMapEntry, FuncMapIndexer } from '../funcmap/funcMapIndex';
import { TemplateNameService } from '../templateNameService';

export interface GoTemplateLanguageMode extends LanguageMode {
  dispose(): void;
}

export function getGoTemplateMode(
  goplsPath: string,
  rootUri: string | undefined,
  funcMapIndexer: FuncMapIndexer,
  templateNames: TemplateNameService
): GoTemplateLanguageMode {
  const client: GoplsClient = createGoplsClient(goplsPath, rootUri);

  return {
    getId: () => 'gotemplate',

    async doComplete(document: TextDocument, position: Position, regions: GoTemplateDocument): Promise<CompletionList> {
      const text = document.getText();
      const offset = document.offsetAt(position);

      const span = regions.actionSpans.find((s) => s.start <= offset && offset <= s.end);
      if (!span) return CompletionList.create([], false);

      const directive = scanTemplateDirectives(text).find((d) => d.nameStart <= offset && offset <= d.nameEnd);
      if (directive && directive.keyword === 'template') {
        await templateNames.ensureReady();
        const prefix = text.slice(directive.nameStart, offset);
        const items: CompletionItem[] = templateNames
          .getAllNames()
          .filter((n) => n.startsWith(prefix))
          .map((n) => ({ label: n, kind: CompletionItemKind.Module, sortText: `0${n}` }));
        return CompletionList.create(items, true);
      }

      const gotype = parseGotypeComment(text);
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

    async doDefinition(document: TextDocument, position: Position): Promise<Location[] | undefined> {
      const text = document.getText();
      const offset = document.offsetAt(position);
      const directive = scanTemplateDirectives(text).find((d) => d.nameStart <= offset && offset <= d.nameEnd);
      if (!directive) return undefined;
      await templateNames.ensureReady();
      return templateNames.getDefinitions(directive.name);
    },

    async doReferences(
      document: TextDocument,
      position: Position,
      _regions: GoTemplateDocument,
      context: ReferenceContext
    ): Promise<Location[] | undefined> {
      const text = document.getText();
      const offset = document.offsetAt(position);
      const directive = scanTemplateDirectives(text).find((d) => d.nameStart <= offset && offset <= d.nameEnd);
      if (!directive) return undefined;
      await templateNames.ensureReady();
      const refs = templateNames.getReferences(directive.name);
      return context.includeDeclaration ? refs.concat(templateNames.getDefinitions(directive.name)) : refs;
    },

    doDiagnostics(document: TextDocument): Diagnostic[] {
      const text = document.getText();
      return validateTemplateSyntax(text).map((issue) => ({
        range: Range.create(document.positionAt(issue.start), document.positionAt(issue.end)),
        message: issue.message,
        severity: DiagnosticSeverity.Error,
        source: 'go-template'
      }));
    },

    dispose() {
      client.dispose();
    }
  };
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
  funcMap: ReadonlyMap<string, FuncMapEntry>
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
        sortText: `0${entry.name}`
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
