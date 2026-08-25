import { getCSSLanguageService } from 'vscode-css-languageservice';
import { LanguageMode } from '../languageModes';
import { getEmbeddedDocument } from '../documentRegions';

const cssLanguageService = getCSSLanguageService();

export function getCSSMode(): LanguageMode {
  return {
    getId: () => 'css',
    doComplete(document, position, regions) {
      const embedded = getEmbeddedDocument(document, regions, 'css');
      const stylesheet = cssLanguageService.parseStylesheet(embedded);
      return cssLanguageService.doComplete(embedded, position, stylesheet);
    },
    doDiagnostics(document, regions) {
      const embedded = getEmbeddedDocument(document, regions, 'css');
      const stylesheet = cssLanguageService.parseStylesheet(embedded);
      return cssLanguageService.doValidation(embedded, stylesheet);
    },
  };
}
