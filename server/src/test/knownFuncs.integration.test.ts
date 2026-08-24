import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionList } from 'vscode-languageserver/node';
import { getLanguageModes } from '../languageModes';
import { getFuncMapIndexer } from '../indexer/funcMapIndex';
import { getGoIndexRunner } from '../goIndex';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'sprig-fixture');
const tmplFile = path.join(fixtureRoot, 'views', 'tmpl.gohtml');

async function completeAt(token: string): Promise<CompletionList> {
  const text = fs.readFileSync(tmplFile, 'utf8');
  const cursorOffset = text.indexOf(token) + token.length;
  assert.ok(cursorOffset > token.length, `fixture must contain "${token}"`);

  const document = TextDocument.create(`file://${tmplFile}`, 'gotmpl', 1, text);
  const position = document.positionAt(cursorOffset);

  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const result = languageModes.getModeAtPosition(document, position);
    assert.ok(result, 'expected the gotemplate mode to be resolved inside the {{ }} action');
    return await result.mode.doComplete(document, position, result.regions);
  } finally {
    languageModes.dispose();
  }
}

test('indexes Sprig functions from a .Funcs(sprig.FuncMap()) merge without Sprig source', async () => {
  const runner = getGoIndexRunner(`file://${fixtureRoot}`);
  try {
    const indexer = getFuncMapIndexer(runner);
    const index = await indexer.getIndex();

    const upper = index.get('upper');
    assert.ok(upper, 'expected Sprig upper in index');
    assert.deepEqual(
      upper.params.map((p) => p.type),
      ['string'],
    );
    assert.deepEqual(upper.results, ['string']);

    const b64enc = index.get('b64enc');
    assert.ok(b64enc, 'expected Sprig b64enc in index');
  } finally {
    runner.dispose();
  }
});

test('completes a Sprig function name with its signature', async () => {
  const list = await completeAt('{{ up');
  const labels = list.items.map((i) => i.label);
  assert.ok(labels.includes('upper'), `expected 'upper', got: ${labels.join(', ')}`);

  const upper = list.items.find((i) => i.label === 'upper');
  assert.ok(
    upper!.detail?.includes('func(arg0 string) string'),
    `unexpected detail: ${upper!.detail}`,
  );
});
