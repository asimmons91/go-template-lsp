import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionList } from 'vscode-languageserver/node';
import { getLanguageModes } from '../languageModes';
import { getFuncMapIndexer } from '../funcmap/funcMapIndex';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'gotype-fixture');
const funcMapFile = path.join(fixtureRoot, 'views', 'funcmap.gohtml');

async function completeAt(token: string): Promise<CompletionList> {
  const text = fs.readFileSync(funcMapFile, 'utf8');
  const cursorOffset = text.indexOf(token) + token.length;
  assert.ok(cursorOffset > token.length, `fixture must contain "${token}"`);

  const document = TextDocument.create(`file://${funcMapFile}`, 'gotmpl', 1, text);
  const position = document.positionAt(cursorOffset);

  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const result = languageModes.getModeAtPosition(document, position);
    assert.ok(result, 'expected the gotemplate mode to be resolved inside the {{ }} action');
    return await result!.mode.doComplete(document, position, result!.regions);
  } finally {
    languageModes.dispose();
  }
}

test('indexes FuncMap entries with signatures from the fixture', async () => {
  const indexer = getFuncMapIndexer(`file://${fixtureRoot}`);
  const index = await indexer.getIndex();

  const upper = index.get('upper');
  assert.ok(upper, 'expected upper in index');
  assert.deepEqual(upper!.params.map((p) => p.type), ['string']);
  assert.deepEqual(upper!.results, ['string']);

  const asUser = index.get('asUser');
  assert.ok(asUser, 'expected asUser in index');
  assert.equal(asUser!.params[0].type, 'model.User');
});

test('completes a registered function name with its signature', async () => {
  const list = await completeAt('{{ up');
  const labels = list.items.map((i) => i.label);
  assert.ok(labels.includes('upper'), `expected 'upper', got: ${labels.join(', ')}`);

  const upper = list.items.find((i) => i.label === 'upper');
  assert.ok(upper!.detail?.includes('func(s string) string'), `unexpected detail: ${upper!.detail}`);
});

test('completes a builtin function name', async () => {
  const list = await completeAt('{{ pri');
  const labels = list.items.map((i) => i.label);
  assert.ok(labels.includes('printf'), `expected 'printf', got: ${labels.join(', ')}`);
});

test('completes a field inside a function argument via gopls', async () => {
  const list = await completeAt('{{ upper .N');
  const labels = list.items.map((i) => i.label);
  assert.ok(labels.includes('Name'), `expected 'Name' among arg completions, got: ${labels.join(', ')}`);
});
