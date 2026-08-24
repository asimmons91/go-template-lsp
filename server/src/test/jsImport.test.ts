import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageModes } from '../languageModes';

test('resolves a relative import from the workspace inside <script>', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gotmpl-js-import-'));
  const templatePath = path.join(dir, 'page.gohtml');
  fs.writeFileSync(path.join(dir, 'helper.d.ts'), 'export declare const helperValue: number;\n');

  const template =
    '<html><body><script>import { helperValue } from "./helper";\nconst x = helperV|</script></body></html>';
  const cursor = template.indexOf('|');
  const text = template.slice(0, cursor) + template.slice(cursor + 1);
  fs.writeFileSync(templatePath, text);

  const document = TextDocument.create(`file://${templatePath}`, 'gotmpl', 1, text);
  const position = document.positionAt(cursor);

  const languageModes = getLanguageModes('gopls', `file://${dir}`);
  try {
    const result = languageModes.getModeAtPosition(document, position);
    assert.ok(result, 'expected the javascript mode to be resolved');
    const list = await result.mode.doComplete(document, position, result.regions);
    const labels = list.items.map((i) => i.label);
    assert.ok(
      labels.includes('helperValue'),
      `expected 'helperValue' among JS completions, got: ${labels.join(', ')}`,
    );
  } finally {
    languageModes.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
