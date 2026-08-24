import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageModes, LanguageModes } from '../languageModes';

const defineRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'define-block-fixture');
const renameRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'rename-fixture');

function readFile(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function makeDocument(
  root: string,
  rel: string,
  token: string,
): { document: TextDocument; offset: number } {
  const text = readFile(root, rel);
  const idx = text.indexOf(token);
  assert.ok(idx !== -1, `fixture must contain "${token}"`);
  const offset = idx + token.length;
  const document = TextDocument.create(`file://${path.join(root, rel)}`, 'gotmpl', 1, text);
  return { document, offset };
}

function modeAt(languageModes: LanguageModes, document: TextDocument, offset: number) {
  const result = languageModes.getModeAtPosition(document, document.positionAt(offset));
  assert.ok(result, 'expected the gotemplate mode to be resolved');
  return result;
}

function editsFor(edit: { changes?: Record<string, { newText: string }[]> } | null | undefined) {
  return edit?.changes ?? {};
}

test('renames a define name across definition and template call sites', async () => {
  const languageModes = getLanguageModes('gopls', `file://${defineRoot}`);
  try {
    const { document, offset } = makeDocument(
      defineRoot,
      'layouts/base.gohtml',
      '{{define "header',
    );
    const result = modeAt(languageModes, document, offset);
    assert.ok(result.mode.doRename, 'expected doRename on gotemplate mode');
    const edit = await result.mode.doRename(
      document,
      document.positionAt(offset),
      'header2',
      result.regions,
    );
    assert.ok(edit, 'expected a rename edit');

    const changes = editsFor(edit);
    const uris = Object.keys(changes).sort();
    assert.equal(uris.length, 3);
    assert.ok(
      uris.every(
        (u) =>
          u.endsWith('layouts/base.gohtml') ||
          u.endsWith('views/index.gohtml') ||
          u.endsWith('views/other.gohtml'),
      ),
      uris.join(', '),
    );
    for (const uri of uris) {
      for (const te of changes[uri]) assert.equal(te.newText, 'header2');
    }
  } finally {
    languageModes.dispose();
  }
});

test('renames a struct field across Go source and templates, honoring $var and shadowing', async () => {
  const languageModes = getLanguageModes('gopls', `file://${renameRoot}`);
  try {
    const { document, offset } = makeDocument(renameRoot, 'views/page.gohtml', '.Name');
    const result = modeAt(languageModes, document, offset);
    assert.ok(result.mode.doRename, 'expected doRename on gotemplate mode');
    const edit = await result.mode.doRename(
      document,
      document.positionAt(offset),
      'FullName',
      result.regions,
    );
    assert.ok(edit, 'expected a rename edit');

    const changes = editsFor(edit);

    const modelUri = Object.keys(changes).find((u) => u.endsWith('model/model.go'));
    assert.ok(modelUri, `expected an edit in model.go, got: ${Object.keys(changes).join(', ')}`);
    assert.equal(changes[modelUri].length, 1);
    assert.equal(changes[modelUri][0].newText, 'FullName');

    const pageUri = Object.keys(changes).find((u) => u.endsWith('views/page.gohtml'));
    assert.ok(pageUri, 'expected an edit in page.gohtml');
    // root `.Name` and `$u.Name` rename; the `range`-shadowed `.Name` (Item.Name) must not.
    assert.equal(changes[pageUri].length, 2);
    assert.ok(changes[pageUri].every((te) => te.newText === 'FullName'));

    const otherUri = Object.keys(changes).find((u) => u.endsWith('views/other.gohtml'));
    assert.ok(otherUri, 'expected an edit in other.gohtml');
    assert.equal(changes[otherUri].length, 1);
    assert.equal(changes[otherUri][0].newText, 'FullName');
  } finally {
    languageModes.dispose();
  }
});

test('prepareRename reports the name range for a define and a field selector', async () => {
  const languageModes = getLanguageModes('gopls', `file://${defineRoot}`);
  try {
    const { document, offset } = makeDocument(
      defineRoot,
      'layouts/base.gohtml',
      '{{define "header',
    );
    const result = modeAt(languageModes, document, offset);
    assert.ok(result.mode.doPrepareRename, 'expected doPrepareRename on gotemplate mode');
    const range = await result.mode.doPrepareRename(
      document,
      document.positionAt(offset),
      result.regions,
    );
    assert.ok(range, 'expected a prepareRename range');
    const start = document.positionAt(document.getText().indexOf('header'));
    const end = document.positionAt(document.getText().indexOf('header') + 'header'.length);
    assert.deepEqual(range, { start, end });
  } finally {
    languageModes.dispose();
  }
});
