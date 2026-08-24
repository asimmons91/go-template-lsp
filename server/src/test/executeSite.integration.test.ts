import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { getLanguageModes } from '../languageModes';

const fixtureRoot = path.join(__dirname, '..', '..', '..', 'fixtures', 'inference-fixture');
const templatesDir = path.join(fixtureRoot, 'templates');

function documentFor(file: string, text: string): TextDocument {
  return TextDocument.create(`file://${path.join(templatesDir, file)}`, 'gotmpl', 1, text);
}

async function diagnosticsFor(file: string, text: string) {
  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    return await languageModes.doDiagnostics(documentFor(file, text));
  } finally {
    languageModes.dispose();
  }
}

test('infers the root type from Execute sites and reports an undefined field', async () => {
  const diags = await diagnosticsFor('page.gohtml', '<p>{{ .Nope }}</p>');
  assert.ok(
    diags.some((d) => d.source === 'go-template' && /Nope/.test(d.message)),
    `expected an undefined-field diagnostic mentioning "Nope", got: ${diags
      .map((d) => `${d.source}: ${d.message}`)
      .join('; ')}`,
  );
});

test('does not flag a valid field access under inference', async () => {
  const diags = await diagnosticsFor('page.gohtml', '<p>{{ .Name }}</p>');
  const goDiags = diags.filter((d) => d.source === 'go-template');
  assert.equal(
    goDiags.length,
    0,
    `expected no go-template diagnostics for a valid field, got: ${goDiags
      .map((d) => d.message)
      .join('; ')}`,
  );
});

test('gotype comment wins over execute-site inference', async () => {
  const diags = await diagnosticsFor(
    'page.gohtml',
    '{{- /* gotype: example.com/inferencefixture/model.Admin */ -}}\n<p>{{ .Name }}</p>',
  );
  assert.ok(
    diags.some((d) => d.source === 'go-template' && /Name/.test(d.message)),
    `expected an undefined-field diagnostic on Admin (no Name field), got: ${diags
      .map((d) => `${d.source}: ${d.message}`)
      .join('; ')}`,
  );
});

test('surfaces an ambiguity hint when multiple types are inferred', async () => {
  const diags = await diagnosticsFor('ambiguous.gohtml', '<p>{{ .Name }}</p>');
  assert.ok(
    diags.some(
      (d) =>
        d.source === 'go-template' &&
        d.severity === DiagnosticSeverity.Hint &&
        /multiple types/.test(d.message),
    ),
    `expected an ambiguity hint, got: ${diags
      .map((d) => `${d.source}[${d.severity}]: ${d.message}`)
      .join('; ')}`,
  );
});

test('produces no type diagnostics for a template executed nowhere', async () => {
  const diags = await diagnosticsFor('unexecuted.gohtml', '<p>{{ .Name }}</p>');
  const goDiags = diags.filter((d) => d.source === 'go-template');
  assert.equal(
    goDiags.length,
    0,
    `expected no go-template diagnostics for an unexecuted template, got: ${goDiags
      .map((d) => d.message)
      .join('; ')}`,
  );
});

test('completes fields via execute-site inference', async () => {
  const file = 'page.gohtml';
  const text = '<p>{{ .Na }}</p>';
  const document = documentFor(file, text);
  const languageModes = getLanguageModes('gopls', `file://${fixtureRoot}`);
  try {
    const position = document.positionAt(text.indexOf('.Na') + '.Na'.length);
    const result = languageModes.getModeAtPosition(document, position);
    assert.ok(result, 'expected the gotemplate mode inside the action');

    const list = await result.mode.doComplete(document, position, result.regions);
    const labels = list.items.map((i) => i.label);
    assert.ok(
      labels.includes('Name'),
      `expected 'Name' among completions, got: ${labels.join(', ')}`,
    );
  } finally {
    languageModes.dispose();
  }
});
