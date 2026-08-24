import * as fs from 'fs';
import * as ts from 'typescript';
import { CompletionItem, CompletionItemKind, CompletionList } from 'vscode-languageserver/node';
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
  [ts.ScriptElementKind.string]: CompletionItemKind.Text
};

function toCompletionItemKind(kind: ts.ScriptElementKind | string): CompletionItemKind {
  return KIND_MAP[kind] ?? CompletionItemKind.Text;
}

class JsDocumentHost implements ts.LanguageServiceHost {
  private text = '';
  private version = 0;

  constructor(private readonly fileName: string) {}

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
    return process.cwd();
  }

  getCompilationSettings(): ts.CompilerOptions {
    return {
      allowJs: true,
      checkJs: false,
      target: ts.ScriptTarget.ES2022,
      lib: ['lib.dom.d.ts', 'lib.es2022.d.ts'],
      jsx: ts.JsxEmit.None
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
  host: JsDocumentHost;
  service: ts.LanguageService;
}

export function getJSMode(): JSLanguageMode {
  const documents = new Map<string, JsEntry>();

  function getEntry(uri: string): JsEntry {
    let entry = documents.get(uri);
    if (!entry) {
      const fileName = `${uri}.embedded.js`;
      const host = new JsDocumentHost(fileName);
      const service = ts.createLanguageService(host, ts.createDocumentRegistry());
      entry = { host, service };
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
      const fileName = `${document.uri}.embedded.js`;
      const info = entry.service.getCompletionsAtPosition(fileName, offset, {});
      if (!info) {
        return CompletionList.create([], false);
      }

      const items: CompletionItem[] = info.entries.map((e) => ({
        label: e.name,
        kind: toCompletionItemKind(e.kind),
        sortText: e.sortText
      }));

      return CompletionList.create(items, false);
    },
    onDocumentRemoved(document) {
      documents.delete(document.uri);
    },
    dispose() {
      documents.clear();
    }
  };
}
