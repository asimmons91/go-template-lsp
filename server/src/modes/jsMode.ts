import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import {
  CompletionItem,
  CompletionItemKind,
  CompletionList,
  Diagnostic,
  DiagnosticSeverity,
  Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LanguageMode } from '../languageModes';
import { getEmbeddedDocument } from '../documentRegions';

export interface JSLanguageMode extends LanguageMode {
  onDocumentRemoved(document: TextDocument): void;
  dispose(): void;
}

const KIND_MAP: Partial<Record<string, CompletionItemKind>> = {
  [ts.ScriptElementKind.keyword]: CompletionItemKind.Keyword,
  [ts.ScriptElementKind.classElement]: CompletionItemKind.Class,
  [ts.ScriptElementKind.localClassElement]: CompletionItemKind.Class,
  [ts.ScriptElementKind.interfaceElement]: CompletionItemKind.Interface,
  [ts.ScriptElementKind.typeElement]: CompletionItemKind.TypeParameter,
  [ts.ScriptElementKind.enumElement]: CompletionItemKind.Enum,
  [ts.ScriptElementKind.enumMemberElement]: CompletionItemKind.EnumMember,
  [ts.ScriptElementKind.variableElement]: CompletionItemKind.Variable,
  [ts.ScriptElementKind.localVariableElement]: CompletionItemKind.Variable,
  [ts.ScriptElementKind.functionElement]: CompletionItemKind.Function,
  [ts.ScriptElementKind.localFunctionElement]: CompletionItemKind.Function,
  [ts.ScriptElementKind.memberFunctionElement]: CompletionItemKind.Method,
  [ts.ScriptElementKind.memberGetAccessorElement]: CompletionItemKind.Property,
  [ts.ScriptElementKind.memberSetAccessorElement]: CompletionItemKind.Property,
  [ts.ScriptElementKind.memberVariableElement]: CompletionItemKind.Property,
  [ts.ScriptElementKind.constructorImplementationElement]: CompletionItemKind.Constructor,
  [ts.ScriptElementKind.parameterElement]: CompletionItemKind.Variable,
  [ts.ScriptElementKind.constElement]: CompletionItemKind.Constant,
  [ts.ScriptElementKind.letElement]: CompletionItemKind.Variable,
  [ts.ScriptElementKind.alias]: CompletionItemKind.Reference,
  [ts.ScriptElementKind.moduleElement]: CompletionItemKind.Module,
  [ts.ScriptElementKind.string]: CompletionItemKind.Text,
};

function toCompletionItemKind(kind: ts.ScriptElementKind | string): CompletionItemKind {
  return KIND_MAP[kind] ?? CompletionItemKind.Text;
}

function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ''));
}

class JsDocumentHost implements ts.LanguageServiceHost {
  private text = '';
  private version = 0;

  constructor(
    private readonly fileName: string,
    private readonly baseUrl: string | undefined,
  ) {}

  updateContent(newText: string): void {
    if (newText !== this.text) {
      this.text = newText;
      this.version++;
    }
  }

  getScriptFileNames(): string[] {
    return [this.fileName];
  }

  getScriptVersion(fileName: string): string {
    return fileName === this.fileName ? String(this.version) : '0';
  }

  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
    if (fileName === this.fileName) {
      return ts.ScriptSnapshot.fromString(this.text);
    }
    if (fs.existsSync(fileName)) {
      return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, 'utf8'));
    }
    return undefined;
  }

  getCurrentDirectory(): string {
    return path.dirname(this.fileName);
  }

  getCompilationSettings(): ts.CompilerOptions {
    return {
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      baseUrl: this.baseUrl,
      lib: ['lib.dom.d.ts', 'lib.es2022.d.ts'],
      jsx: ts.JsxEmit.None,
    };
  }

  getDefaultLibFileName(options: ts.CompilerOptions): string {
    return ts.getDefaultLibFilePath(options);
  }

  fileExists(fileName: string): boolean {
    return fileName === this.fileName || fs.existsSync(fileName);
  }

  readFile(fileName: string): string | undefined {
    return fileName === this.fileName ? this.text : fs.readFileSync(fileName, 'utf8');
  }
}

interface JsEntry {
  fileName: string;
  host: JsDocumentHost;
  service: ts.LanguageService;
}

export function getJSMode(roots: string | string[] | undefined): JSLanguageMode {
  const documents = new Map<string, JsEntry>();
  const rootList = (Array.isArray(roots) ? roots : roots ? [roots] : []).filter(
    (r) => typeof r === 'string' && r.length > 0,
  );
  const fallbackBaseUrl = rootList.length > 0 ? uriToPath(rootList[0]) : undefined;

  function baseUrlFor(uri: string): string | undefined {
    const target = uriToPath(uri);
    let best: string | undefined;
    let bestLen = -1;
    for (const root of rootList) {
      const rootPath = uriToPath(root);
      const rel = path.relative(rootPath, target);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (rootPath.length > bestLen) {
        best = rootPath;
        bestLen = rootPath.length;
      }
    }
    return best ?? fallbackBaseUrl;
  }

  function getEntry(uri: string): JsEntry {
    let entry = documents.get(uri);
    if (!entry) {
      const fileName = `${uriToPath(uri)}.embedded.js`;
      const host = new JsDocumentHost(fileName, baseUrlFor(uri));
      const service = ts.createLanguageService(host, ts.createDocumentRegistry());
      entry = { fileName, host, service };
      documents.set(uri, entry);
    }
    return entry;
  }

  return {
    getId: () => 'javascript',
    doComplete(document, position, regions) {
      const embedded = getEmbeddedDocument(document, regions, 'javascript');
      const entry = getEntry(document.uri);
      entry.host.updateContent(embedded.getText());

      const offset = embedded.offsetAt(position);
      const fileName = entry.fileName;
      const info = entry.service.getCompletionsAtPosition(fileName, offset, {});
      if (!info) {
        return CompletionList.create([], false);
      }

      const items: CompletionItem[] = info.entries.map((e) => ({
        label: e.name,
        kind: toCompletionItemKind(e.kind),
        sortText: e.sortText,
      }));

      return CompletionList.create(items, false);
    },
    doDiagnostics(document, regions) {
      const embedded = getEmbeddedDocument(document, regions, 'javascript');
      const entry = getEntry(document.uri);
      entry.host.updateContent(embedded.getText());

      const fileName = entry.fileName;
      const jsRegions = regions.regions.filter((r) => r.languageId === 'javascript');
      const inRegion = (offset: number): boolean =>
        jsRegions.some((r) => r.start <= offset && offset < r.end);

      const syntactic = entry.service.getSyntacticDiagnostics(fileName);
      const semantic = entry.service.getSemanticDiagnostics(fileName);

      const seen = new Set<string>();
      const diagnostics: Diagnostic[] = [];
      for (const d of [...syntactic, ...semantic]) {
        if (d.start === undefined || d.length === undefined) continue;
        if (!inRegion(d.start)) continue;

        const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
        const key = `${d.start}:${d.length}:${message}`;
        if (seen.has(key)) continue;
        seen.add(key);

        diagnostics.push({
          range: Range.create(
            embedded.positionAt(d.start),
            embedded.positionAt(d.start + d.length),
          ),
          message,
          severity:
            d.category === ts.DiagnosticCategory.Error
              ? DiagnosticSeverity.Error
              : DiagnosticSeverity.Warning,
          source: 'typescript',
        });
      }
      return diagnostics;
    },
    onDocumentRemoved(document) {
      documents.delete(document.uri);
    },
    dispose() {
      documents.clear();
    },
  };
}
