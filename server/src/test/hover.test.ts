import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Hover } from 'vscode-languageserver/node';
import { getLanguageModes, LanguageModes } from '../languageModes';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'gotype-fixture');

async function hoverAt(
  languageModes: LanguageModes,
  uri: string,
  text: string,
  token: string,
): Promise<Hover | undefined> {
  const document = TextDocument.create(uri, 'gotmpl', 1, text);
  const idx = text.indexOf(token);
  assert.ok(idx !== -1, `text must contain "${token}"`);
  const offset = idx + 1;
  const position = document.positionAt(offset);

  const result = languageModes.getModeAtPosition(document, position);
  assert.ok(result?.mode.doHover, 'expected doHover on the gotemplate mode');
  return result.mode.doHover(document, position, result.regions);
}

function hoverText(hover: Hover | undefined): string {
  assert.ok(hover, 'expected a hover');
  const contents = hover.contents;
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    return contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n');
  }
  return contents.value;
}

test('hovers the comment directly above a {{define}} name', async () => {
  const languageModes = getLanguageModes('gopls', undefined);
  try {
    const hover = await hoverAt(
      languageModes,
      'file:///def.gohtml',
      '{{/* Renders the page banner. */}}\n{{define "header"}}<h1>{{.}}</h1>{{end}}',
      'header',
    );
    assert.equal(hoverText(hover), 'Renders the page banner.');
  } finally {
    languageModes.dispose();
  }
});

test('hovers the comment directly above a {{block}} name', async () => {
  const languageModes = getLanguageModes('gopls', undefined);
  try {
    const hover = await hoverAt(
      languageModes,
      'file:///block.gohtml',
      '{{/* Primary layout slot. */}}\n{{block "content" .}}{{end}}',
      'content',
    );
    assert.equal(hoverText(hover), 'Primary layout slot.');
  } finally {
    languageModes.dispose();
  }
});

test('ignores a comment separated from the define by non-whitespace', async () => {
  const languageModes = getLanguageModes('gopls', undefined);
  try {
    const hover = await hoverAt(
      languageModes,
      'file:///sep.gohtml',
      '{{/* Not attached. */}}<div></div>\n{{define "header"}}{{end}}',
      'header',
    );
    assert.equal(hover, undefined);
  } finally {
    languageModes.dispose();
  }
});

test('hovers a FuncMap function doc comment from the indexer', async () => {
  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const hover = await hoverAt(
      languageModes,
      `file://${path.join(fixtureRoot, 'views', 'page.gohtml')}`,
      '{{ upperLen .Name }}',
      'upperLen',
    );
    assert.equal(
      hoverText(hover),
      'upperLen upper-cases its input and reports the resulting length.',
    );
  } finally {
    languageModes.dispose();
  }
});

test('falls back to the signature when a FuncMap function has no doc comment', async () => {
  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const hover = await hoverAt(
      languageModes,
      `file://${path.join(fixtureRoot, 'views', 'page.gohtml')}`,
      '{{ upper .Name }}',
      'upper',
    );
    assert.match(hoverText(hover), /func\(s string\) string/);
  } finally {
    languageModes.dispose();
  }
});
