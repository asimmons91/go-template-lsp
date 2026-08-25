import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageModes } from '../languageModes';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'gotype-fixture');
const layoutFile = path.join(fixtureRoot, 'views', 'layout.gohtml');

async function completeAt(token: string): Promise<string[]> {
  const text = fs.readFileSync(layoutFile, 'utf8');
  const cursorOffset = text.indexOf(token) + token.length;
  assert.ok(cursorOffset > token.length, `fixture must contain "${token}"`);

  const document = TextDocument.create(`file://${layoutFile}`, 'gotmpl', 1, text);
  const position = document.positionAt(cursorOffset);

  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const result = languageModes.getModeAtPosition(document, position);
    assert.ok(result, 'expected the gotemplate mode to be resolved inside the {{ }} action');
    const list = await result.mode.doComplete(document, position, result.regions);
    return list.items.map((item) => item.label);
  } finally {
    languageModes.dispose();
  }
}

test('completes a struct field inside a {{define}} body', async () => {
  const labels = await completeAt('{{ .N');
  assert.ok(labels.includes('Name'), `expected 'Name' inside define, got: ${labels.join(', ')}`);
});

test('completes a field narrowed by a {{block}} pipeline', async () => {
  const labels = await completeAt('{{ .C');
  assert.ok(labels.includes('City'), `expected 'City' inside block, got: ${labels.join(', ')}`);
});
