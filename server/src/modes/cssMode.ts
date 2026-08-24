import { getCSSLanguageService } from 'vscode-css-languageservice';
import { CompletionList } from 'vscode-languageserver/node';
import { LanguageMode } from '../languageModes';
import { getEmbeddedDocument } from '../documentRegions';
import { getEmmetCompletion } from './emmet';

const cssLanguageService = getCSSLanguageService();

export function getCSSMode(): LanguageMode {
  return {
    getId: () => 'css',
    doComplete(document, position, regions) {
      const embedded = getEmbeddedDocument(document, regions, 'css');
      const stylesheet = cssLanguageService.parseStylesheet(embedded);
      const result = cssLanguageService.doComplete(embedded, position, stylesheet);
      const emmet = getEmmetCompletion(embedded, position, 'css');
      if (!emmet) return result;
      return CompletionList.create(
        [...result.items, ...emmet.items],
        result.isIncomplete || emmet.isIncomplete,
      );
    },
    doDiagnostics(document, regions) {
      const embedded = getEmbeddedDocument(document, regions, 'css');
      const stylesheet = cssLanguageService.parseStylesheet(embedded);
      return cssLanguageService.doValidation(embedded, stylesheet);
    },
  };
}
