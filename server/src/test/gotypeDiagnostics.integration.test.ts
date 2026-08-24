import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageModes } from '../languageModes';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'gotype-fixture');
const pageFile = path.join(fixtureRoot, 'views', 'page.gohtml');

function documentFor(text: string): TextDocument {
  return TextDocument.create(`file://${pageFile}`, 'gotmpl', 1, text);
}

test('reports an undefined field diagnostic from gopls', async () => {
  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const text = '{{- /* gotype: example.com/gotypefixture/model.User */ -}}\n<p>{{ .Nope }}</p>';
    const diags = await languageModes.doDiagnostics(documentFor(text));

    assert.ok(
      diags.some((d) => d.source === 'go-template' && /Nope/.test(d.message)),
      `expected an undefined-field diagnostic mentioning "Nope", got: ${diags
        .map((d) => `${d.source}: ${d.message}`)
        .join('; ')}`,
    );
  } finally {
    languageModes.dispose();
  }
});

test('reports an arity diagnostic for a FuncMap function', async () => {
  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const text =
      '{{- /* gotype: example.com/gotypefixture/model.User */ -}}\n<p>{{ upper .Name "extra" }}</p>';
    const diags = await languageModes.doDiagnostics(documentFor(text));

    assert.ok(
      diags.some((d) => d.source === 'go-template' && /too many arguments/.test(d.message)),
      `expected an arity diagnostic for "upper", got: ${diags
        .map((d) => `${d.source}: ${d.message}`)
        .join('; ')}`,
    );
  } finally {
    languageModes.dispose();
  }
});

test('does not flag a valid field access', async () => {
  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const text = '{{- /* gotype: example.com/gotypefixture/model.User */ -}}\n<p>{{ .Name }}</p>';
    const diags = await languageModes.doDiagnostics(documentFor(text));

    const goDiags = diags.filter((d) => d.source === 'go-template');
    assert.equal(
      goDiags.length,
      0,
      `expected no go-template diagnostics for a valid field, got: ${goDiags
        .map((d) => d.message)
        .join('; ')}`,
    );
  } finally {
    languageModes.dispose();
  }
});
