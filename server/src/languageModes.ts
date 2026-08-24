import { CompletionList, Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { EmbeddedLanguageId, GoTemplateDocument, getDocumentRegions, getLanguageAtOffset } from './documentRegions';
import { getHTMLMode } from './modes/htmlMode';
import { getCSSMode } from './modes/cssMode';
import { getJSMode } from './modes/jsMode';
import { getGoTemplateMode } from './modes/goTemplateMode';
import { getFuncMapIndexer } from './funcmap/funcMapIndex';

export interface LanguageMode {
  getId(): EmbeddedLanguageId;
  doComplete(document: TextDocument, position: Position, regions: GoTemplateDocument): CompletionList | Promise<CompletionList>;
}

export interface ModeAtPosition {
  mode: LanguageMode;
  regions: GoTemplateDocument;
}

export interface LanguageModes {
  getModeAtPosition(document: TextDocument, position: Position): ModeAtPosition | undefined;
  onDocumentRemoved(document: TextDocument): void;
  invalidateFuncMap(): void;
  dispose(): void;
}

export function getLanguageModes(goplsPath: string, rootUri: string | undefined): LanguageModes {
  const htmlMode = getHTMLMode();
  const cssMode = getCSSMode();
  const jsMode = getJSMode();
  const funcMapIndexer = getFuncMapIndexer(rootUri);
  const goTemplateMode = getGoTemplateMode(goplsPath, rootUri, funcMapIndexer);

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
    invalidateFuncMap() {
      funcMapIndexer.invalidate();
    },
    dispose() {
      jsMode.dispose();
      goTemplateMode.dispose();
    }
  };
}
