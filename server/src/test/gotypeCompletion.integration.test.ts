import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageModes } from '../languageModes';
import { LanguageMode } from '../languageModes';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'gotype-fixture');
const pageFile = path.join(fixtureRoot, 'views', 'page.gohtml');

function modeFor(text: string, relPath: string) {
  const uri = `file://${path.join(fixtureRoot, relPath)}`;
  const document = TextDocument.create(uri, 'gotmpl', 1, text);
  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  return { document, languageModes };
}

test('completes a package path while authoring the gotype value', async () => {
  const text = '{{- /* gotype: example.com/gotypefixture/mo */ -}}';
  const { document, languageModes } = modeFor(text, 'views/gotype_pkg.gohtml');
  try {
    const position = document.positionAt(text.indexOf('mo') + 2);
    const result = languageModes.getModeAtPosition(document, position);
    assert.ok(result, 'expected the gotemplate mode inside the action');

    const list = await (result!.mode as LanguageMode).doComplete(document, position, result!.regions);
    const labels = list.items.map((i) => i.label);
    assert.ok(
      labels.includes('example.com/gotypefixture/model'),
      `expected the model package path, got: ${labels.join(', ')}`
    );
  } finally {
    languageModes.dispose();
  }
});

test('completes exported struct names after the type dot', async () => {
  const text = '{{- /* gotype: example.com/gotypefixture/model.Us */ -}}';
  const { document, languageModes } = modeFor(text, 'views/gotype_members.gohtml');
  try {
    const position = document.positionAt(text.indexOf('Us') + 2);
    const result = languageModes.getModeAtPosition(document, position);
    assert.ok(result, 'expected the gotemplate mode inside the action');

    const list = await (result!.mode as LanguageMode).doComplete(document, position, result!.regions);
    const labels = list.items.map((i) => i.label);
    assert.ok(labels.includes('User'), `expected 'User', got: ${labels.join(', ')}`);
  } finally {
    languageModes.dispose();
  }
});

test('flags a gotype value that does not resolve to a struct', async () => {
  const text = '{{- /* gotype: example.com/gotypefixture/model.Nope */ -}}';
  const { document, languageModes } = modeFor(text, 'views/gotype_diag.gohtml');
  try {
    const diagnostics = await languageModes.doDiagnostics(document);
    assert.ok(
      diagnostics.some((d) => d.source === 'go-template' && /not found or not a struct/.test(d.message)),
      `expected a gotype validation diagnostic, got: ${diagnostics.map((d) => d.message).join('; ')}`
    );
  } finally {
    languageModes.dispose();
  }
});

test('does not flag a valid gotype value', async () => {
  const text = fs.readFileSync(pageFile, 'utf8');
  const { document, languageModes } = modeFor(text, 'views/page.gohtml');
  try {
    const diagnostics = await languageModes.doDiagnostics(document);
    assert.ok(
      !diagnostics.some((d) => d.source === 'go-template' && /not found or not a struct/.test(d.message)),
      `expected no gotype validation diagnostic, got: ${diagnostics.map((d) => d.message).join('; ')}`
    );
  } finally {
    languageModes.dispose();
  }
});

test('go-to-definition resolves a field to its Go source', async () => {
  const text = '{{- /* gotype: example.com/gotypefixture/model.User */ -}}\n{{ .Name }}';
  const { document, languageModes } = modeFor(text, 'views/gotype_def.gohtml');
  try {
    const token = '.Name';
    const position = document.positionAt(text.indexOf(token) + token.length);
    const result = languageModes.getModeAtPosition(document, position);
    assert.ok(result, 'expected the gotemplate mode inside the action');

    const locations = await (result!.mode as LanguageMode).doDefinition!(document, position, result!.regions);
    assert.ok(locations && locations.length > 0, 'expected a definition location');
    assert.ok(locations[0].uri.includes('model.go'), `expected model.go, got: ${locations[0].uri}`);
  } finally {
    languageModes.dispose();
  }
});

test('hover on a field returns contents', async () => {
  const text = '{{- /* gotype: example.com/gotypefixture/model.User */ -}}\n{{ .Name }}';
  const { document, languageModes } = modeFor(text, 'views/gotype_hover.gohtml');
  try {
    const token = '.Name';
    const position = document.positionAt(text.indexOf(token) + token.length);
    const result = languageModes.getModeAtPosition(document, position);
    assert.ok(result, 'expected the gotemplate mode inside the action');

    const hover = await (result!.mode as LanguageMode).doHover!(document, position, result!.regions);
    assert.ok(hover && hover.contents, 'expected hover contents');
  } finally {
    languageModes.dispose();
  }
});
