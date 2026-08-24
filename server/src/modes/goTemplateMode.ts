import { CompletionList, Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { LanguageMode } from '../languageModes';
import { GoTemplateDocument } from '../documentRegions';
import { parseGotypeComment } from '../gotype';
import { buildSyntheticCompletion } from '../transpiler';
import { createGoplsClient, GoplsClient } from '../gopls/goplsClient';

export interface GoTemplateLanguageMode extends LanguageMode {
  dispose(): void;
}

/**
 * Strips the leading `{{`, any `-` trim marker, and whitespace off the action text
 * up to the cursor, leaving a bare dot-expression candidate like `.` or `.Na`.
 */
function extractFieldExpr(actionText: string): string {
  return actionText.replace(/^\{\{-?\s*/, '');
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

      const fieldExpr = extractFieldExpr(text.slice(span.start, offset));
      const target = buildSyntheticCompletion({ documentUri: document.uri, gotype, fieldExpr });
      if (!target) return CompletionList.create([], false);

      await client.openOrUpdate(target.uri, target.goSource);
      return client.completion(target.uri, target.offset);
    },

    dispose() {
      client.dispose();
    }
  };
}
