import { CompletionList, Location, Position, ReferenceContext } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { EmbeddedLanguageId, GoTemplateDocument, getDocumentRegions, getLanguageAtOffset } from './documentRegions';
import { getHTMLMode } from './modes/htmlMode';
import { getCSSMode } from './modes/cssMode';
import { getJSMode } from './modes/jsMode';
import { getGoTemplateMode } from './modes/goTemplateMode';
import { getFuncMapIndexer } from './funcmap/funcMapIndex';
import { TemplateNameService } from './templateNameService';

export interface LanguageMode {
  getId(): EmbeddedLanguageId;
  doComplete(document: TextDocument, position: Position, regions: GoTemplateDocument): CompletionList | Promise<CompletionList>;
  doDefinition?(document: TextDocument, position: Position, regions: GoTemplateDocument): Location[] | undefined | Promise<Location[] | undefined>;
  doReferences?(
    document: TextDocument,
    position: Position,
    regions: GoTemplateDocument,
    context: ReferenceContext
  ): Location[] | undefined | Promise<Location[] | undefined>;
}

export interface ModeAtPosition {
  mode: LanguageMode;
  regions: GoTemplateDocument;
}

export interface LanguageModes {
  getModeAtPosition(document: TextDocument, position: Position): ModeAtPosition | undefined;
  onDocumentRemoved(document: TextDocument): void;
  onDocumentOpened(document: TextDocument): void;
  onDocumentChanged(document: TextDocument): void;
  onDocumentClosed(document: TextDocument): void;
  onTemplateFileEvent(uri: string, type: number): void;
  invalidateFuncMap(): void;
  dispose(): void;
}

export function getLanguageModes(goplsPath: string, rootUri: string | undefined): LanguageModes {
  const htmlMode = getHTMLMode();
  const cssMode = getCSSMode();
  const jsMode = getJSMode();
  const funcMapIndexer = getFuncMapIndexer(rootUri);
  const templateNames = new TemplateNameService(rootUri);
  const goTemplateMode = getGoTemplateMode(goplsPath, rootUri, funcMapIndexer, templateNames);

  const modes: Partial<Record<EmbeddedLanguageId, LanguageMode>> = {
    html: htmlMode,
    css: cssMode,
    javascript: jsMode,
    gotemplate: goTemplateMode
  };

  return {
    getModeAtPosition(document, position) {
      const regions = getDocumentRegions(document);
      const languageId = getLanguageAtOffset(regions, document.offsetAt(position));
      const mode = modes[languageId];
      if (!mode) return undefined;
      return { mode, regions };
    },
    onDocumentRemoved(document) {
      jsMode.onDocumentRemoved(document);
    },
    onDocumentOpened(document) {
      templateNames.indexDocument(document.uri, document.getText());
    },
    onDocumentChanged(document) {
      templateNames.indexDocument(document.uri, document.getText());
    },
    onDocumentClosed(document) {
      templateNames.onDocumentClosed(document.uri);
    },
    onTemplateFileEvent(uri, type) {
      templateNames.onFileEvent(uri, type);
    },
    invalidateFuncMap() {
      funcMapIndexer.invalidate();
    },
    dispose() {
      jsMode.dispose();
      goTemplateMode.dispose();
    }
  };
}
