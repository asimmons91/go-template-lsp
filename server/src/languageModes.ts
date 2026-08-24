import { CompletionList, Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { EmbeddedLanguageId, GoTemplateDocument, getDocumentRegions, getLanguageAtOffset } from './documentRegions';
import { getHTMLMode } from './modes/htmlMode';
import { getCSSMode } from './modes/cssMode';
import { getJSMode } from './modes/jsMode';

export interface LanguageMode {
  getId(): EmbeddedLanguageId;
  doComplete(document: TextDocument, position: Position, regions: GoTemplateDocument): CompletionList;
}

export interface ModeAtPosition {
  mode: LanguageMode;
  regions: GoTemplateDocument;
}

export interface LanguageModes {
  getModeAtPosition(document: TextDocument, position: Position): ModeAtPosition | undefined;
  onDocumentRemoved(document: TextDocument): void;
  dispose(): void;
}

export function getLanguageModes(): LanguageModes {
  const htmlMode = getHTMLMode();
  const cssMode = getCSSMode();
  const jsMode = getJSMode();

  const modes: Partial<Record<EmbeddedLanguageId, LanguageMode>> = {
    html: htmlMode,
    css: cssMode,
    javascript: jsMode
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
    dispose() {
      jsMode.dispose();
    }
  };
}
