import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageModes } from '../languageModes';

function documentFor(text: string) {
  return TextDocument.create('file:///diag.gohtml', 'gotmpl', 1, text);
}

test('merges Go, CSS and JS diagnostics into one list', async () => {
  const languageModes = getLanguageModes('gopls', undefined);
  try {
    const doc = documentFor('<style>.x { color: ; }</style><script>const x = ;</script>{{end}}');
    const diags = await languageModes.doDiagnostics(doc);

    assert.ok(
      diags.some((d) => d.source === 'go-template' && /Unexpected \{\{end\}\}/.test(d.message)),
    );
    assert.ok(
      diags.some((d) => d.source === 'css'),
      'expected CSS diagnostics',
    );
    assert.ok(
      diags.some((d) => d.source === 'typescript'),
      'expected TS diagnostics',
    );
  } finally {
    languageModes.dispose();
  }
});

test('reports no diagnostics on a clean document', async () => {
  const languageModes = getLanguageModes('gopls', undefined);
  try {
    const doc = documentFor(
      '<style>.x { color: red; }</style><script>const x = 1;</script><p>hi</p>',
    );
    const diags = await languageModes.doDiagnostics(doc);
    assert.equal(diags.length, 0, diags.map((d) => `${d.source}: ${d.message}`).join('; '));
  } finally {
    languageModes.dispose();
  }
});
