import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageModes, LanguageModes } from '../languageModes';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'define-block-fixture');

function readFile(rel: string): string {
  return fs.readFileSync(path.join(fixtureRoot, rel), 'utf8');
}

function makeDocument(rel: string, token: string): { document: TextDocument; offset: number } {
  const text = readFile(rel);
  const idx = text.indexOf(token);
  assert.ok(idx !== -1, `fixture must contain "${token}"`);
  const offset = idx + token.length;
  const document = TextDocument.create(`file://${path.join(fixtureRoot, rel)}`, 'gotmpl', 1, text);
  return { document, offset };
}

function modeAt(languageModes: LanguageModes, document: TextDocument, offset: number) {
  const result = languageModes.getModeAtPosition(document, document.positionAt(offset));
  assert.ok(result, 'expected the gotemplate mode to be resolved');
  return result;
}

test('completes a template name', async () => {
  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const { document, offset } = makeDocument('views/index.gohtml', '{{template "hea');
    const result = modeAt(languageModes, document, offset);
    const list = await result.mode.doComplete(
      document,
      document.positionAt(offset),
      result.regions,
    );
    const labels = list.items.map((i) => i.label);
    assert.ok(labels.includes('header'), `expected 'header', got: ${labels.join(', ')}`);
  } finally {
    languageModes.dispose();
  }
});

test('goes to definition from a template reference', async () => {
  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const { document, offset } = makeDocument('views/index.gohtml', '{{template "header');
    const result = modeAt(languageModes, document, offset);
    assert.ok(result.mode.doDefinition, 'expected doDefinition on gotemplate mode');
    const defs =
      (await result.mode.doDefinition(document, document.positionAt(offset), result.regions)) ?? [];
    assert.equal(defs.length, 1);
    assert.ok(
      defs[0].uri.endsWith('layouts/base.gohtml'),
      `expected base.gohtml, got: ${defs[0].uri}`,
    );
  } finally {
    languageModes.dispose();
  }
});

test('finds references to a define', async () => {
  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const { document, offset } = makeDocument('layouts/base.gohtml', '{{define "header');
    const result = modeAt(languageModes, document, offset);
    assert.ok(result.mode.doReferences, 'expected doReferences on gotemplate mode');
    const refs =
      (await result.mode.doReferences(document, document.positionAt(offset), result.regions, {
        includeDeclaration: false,
      })) ?? [];
    assert.equal(refs.length, 2);
    const uris = refs.map((r) => r.uri).sort();
    assert.ok(
      uris.every((u) => u.endsWith('views/index.gohtml') || u.endsWith('views/other.gohtml')),
      uris.join(', '),
    );
  } finally {
    languageModes.dispose();
  }
});

test('includes the declaration when requested', async () => {
  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const { document, offset } = makeDocument('layouts/base.gohtml', '{{define "header');
    const result = modeAt(languageModes, document, offset);
    const refs =
      (await result.mode.doReferences!(document, document.positionAt(offset), result.regions, {
        includeDeclaration: true,
      })) ?? [];
    assert.equal(refs.length, 3);
  } finally {
    languageModes.dispose();
  }
});

test('block is both a definition and a reference', async () => {
  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const { document, offset } = makeDocument('views/other.gohtml', '{{template "sidebar');
    const result = modeAt(languageModes, document, offset);
    const defs =
      (await result.mode.doDefinition!(document, document.positionAt(offset), result.regions)) ??
      [];
    assert.equal(defs.length, 1);
    assert.ok(
      defs[0].uri.endsWith('views/index.gohtml'),
      `expected index.gohtml, got: ${defs[0].uri}`,
    );
  } finally {
    languageModes.dispose();
  }

  const languageModes2 = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const { document, offset } = makeDocument('views/index.gohtml', '{{block "sidebar');
    const result = modeAt(languageModes2, document, offset);
    const refs =
      (await result.mode.doReferences!(document, document.positionAt(offset), result.regions, {
        includeDeclaration: false,
      })) ?? [];
    assert.equal(refs.length, 2);
  } finally {
    languageModes2.dispose();
  }
});
