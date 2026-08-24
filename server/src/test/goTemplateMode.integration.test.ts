import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageModes } from '../languageModes';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'gotype-fixture');
const pageFile = path.join(fixtureRoot, 'views', 'page.gohtml');

test('completes a flat struct field via a real gopls subprocess', async () => {
  const text = fs.readFileSync(pageFile, 'utf8');
  const cursorOffset = text.indexOf('.N') + 2; // right after ".N"
  assert.ok(cursorOffset > 1, 'fixture must contain a ".N" field access');

  const document = TextDocument.create(`file://${pageFile}`, 'gotmpl', 1, text);
  const position = document.positionAt(cursorOffset);

  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const result = languageModes.getModeAtPosition(document, position);
    assert.ok(result, 'expected the gotemplate mode to be resolved inside the {{ }} action');

    const list = await result!.mode.doComplete(document, position, result!.regions);
    const labels = list.items.map((item) => item.label);
    assert.ok(labels.includes('Name'), `expected 'Name' among gopls completions, got: ${labels.join(', ')}`);
  } finally {
    languageModes.dispose();
  }
});
