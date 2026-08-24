import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageModes } from '../languageModes';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'gotype-fixture');
const pageFile = path.join(fixtureRoot, 'views', 'page.gohtml');

async function completeAt(token: string): Promise<string[]> {
  const text = fs.readFileSync(pageFile, 'utf8');
  const cursorOffset = text.indexOf(token) + token.length;
  assert.ok(cursorOffset > token.length, `fixture must contain "${token}"`);

  const document = TextDocument.create(`file://${pageFile}`, 'gotmpl', 1, text);
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

test('completes a flat struct field via a real gopls subprocess', async () => {
  const labels = await completeAt('.N');
  assert.ok(
    labels.includes('Name'),
    `expected 'Name' among gopls completions, got: ${labels.join(', ')}`,
  );
});

test('completes a nested field chain', async () => {
  const labels = await completeAt('.Zi');
  assert.ok(labels.includes('ZipCode'), `expected 'ZipCode', got: ${labels.join(', ')}`);
});

test('completes a field narrowed by range', async () => {
  const labels = await completeAt('.T');
  assert.ok(labels.includes('Title'), `expected 'Title' inside range, got: ${labels.join(', ')}`);
});

test('completes a field narrowed by with', async () => {
  const labels = await completeAt('.C');
  assert.ok(labels.includes('City'), `expected 'City' inside with, got: ${labels.join(', ')}`);
});

test('completes a field on a $var binding', async () => {
  const labels = await completeAt('$x.C');
  assert.ok(labels.includes('City'), `expected 'City' on $var, got: ${labels.join(', ')}`);
});
