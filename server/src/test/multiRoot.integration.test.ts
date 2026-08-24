import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageModes } from '../languageModes';
import { getGoIndexRunner } from '../goIndex';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'multi-root-fixture');
const rootA = path.join(fixtureRoot, 'app');
const rootB = path.join(fixtureRoot, 'shared');

test('resolves a template reference to a definition in another workspace root', async () => {
  const languageModes = getLanguageModes('gopls', [`file://${rootA}`, `file://${rootB}`]);
  try {
    const text = '{{template "card" .}}';
    const document = TextDocument.create(
      `file://${path.join(rootA, 'views', 'page.gohtml')}`,
      'gotmpl',
      1,
      text,
    );
    const position = document.positionAt(text.indexOf('card') + 1);
    const result = languageModes.getModeAtPosition(document, position);
    assert.ok(result, 'expected the gotemplate mode inside the template name');

    const defs = await result.mode.doDefinition!(document, position, result.regions);
    assert.ok(
      defs && defs.some((d) => d.uri.includes('shared')),
      `expected a definition in the shared root, got: ${JSON.stringify(defs)}`,
    );
  } finally {
    languageModes.dispose();
  }
});

test('merges the Go index across multiple workspace roots', async () => {
  const gotypeRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'gotype-fixture');
  const inferenceRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'inference-fixture');
  const runner = getGoIndexRunner([`file://${gotypeRoot}`, `file://${inferenceRoot}`]);

  const index = await runner.getIndex();
  assert.ok(
    index.functions.some((f) => f.name === 'upper'),
    `expected FuncMap entries from the first root, got: ${index.functions.map((f) => f.name).join(', ')}`,
  );
  assert.ok(
    index.executeSites.some((s) => s.type.typeName === 'User'),
    `expected execute sites from the second root, got: ${index.executeSites
      .map((s) => s.type.typeName)
      .join(', ')}`,
  );
});
