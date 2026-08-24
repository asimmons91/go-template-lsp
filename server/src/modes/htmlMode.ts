import { getLanguageService } from 'vscode-html-languageservice';
import { LanguageMode } from '../languageModes';

const htmlLanguageService = getLanguageService();

export function getHTMLMode(): LanguageMode {
  return {
    getId: () => 'html',
    doComplete(_document, position, regions) {
      const htmlDocument = htmlLanguageService.parseHTMLDocument(regions.maskedDocument);
      return htmlLanguageService.doComplete(regions.maskedDocument, position, htmlDocument);
    }
  };
}
