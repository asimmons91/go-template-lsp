import { CompletionList, Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LanguageMode } from '../languageModes';
import { GoTemplateDocument } from '../documentRegions';
import { parseGotypeComment } from '../gotype';
import { transpileTemplate } from '../transpiler';
import { createGoplsClient, GoplsClient } from '../gopls/goplsClient';

export interface GoTemplateLanguageMode extends LanguageMode {
  dispose(): void;
}

export function getGoTemplateMode(goplsPath: string, rootUri: string | undefined): GoTemplateLanguageMode {
  const client: GoplsClient = createGoplsClient(goplsPath, rootUri);

  return {
    getId: () => 'gotemplate',

    async doComplete(document: TextDocument, position: Position, regions: GoTemplateDocument): Promise<CompletionList> {
      const text = document.getText();
      const offset = document.offsetAt(position);

      const span = regions.actionSpans.find((s) => s.start <= offset && offset <= s.end);
      if (!span) return CompletionList.create([], false);

      const gotype = parseGotypeComment(text);
      if (!gotype) return CompletionList.create([], false);

      const { uri, goSource, mapOffset } = transpileTemplate(document.uri, text, gotype);
      const goOffset = mapOffset(offset);
      if (goOffset < 0) return CompletionList.create([], false);

      await client.openOrUpdate(uri, goSource);
      return client.completion(uri, goOffset);
    },

    dispose() {
      client.dispose();
    }
  };
}
