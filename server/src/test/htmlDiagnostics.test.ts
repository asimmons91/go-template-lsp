import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getHTMLMode } from '../modes/htmlMode';
import { getDocumentRegions } from '../documentRegions';

const htmlMode = getHTMLMode();

async function diagnosticsFor(text: string) {
  const document = TextDocument.create('file:///a.gohtml', 'gotmpl', 1, text);
  const regions = getDocumentRegions(document);
  return await htmlMode.doDiagnostics!(document, regions);
}

test('reports a genuinely unclosed tag', async () => {
  const diags = await diagnosticsFor('<div><span>text</div>');
  assert.ok(diags.some((d) => d.message.includes('span')), diags.map((d) => d.message).join('; '));
});

test('reports an unclosed tag with no conditionals', async () => {
  const diags = await diagnosticsFor('<div>hello');
  assert.ok(diags.some((d) => d.message.includes('div')), diags.map((d) => d.message).join('; '));
});

test('suppresses a tag whose open/close straddle if/else branches', async () => {
  const diags = await diagnosticsFor('{{if .X}}<div>{{else}}<div>{{end}}</div>');
  assert.equal(diags.length, 0, diags.map((d) => d.message).join('; '));
});

test('suppresses the split-open pattern across separate if guards', async () => {
  const diags = await diagnosticsFor('{{if .X}}<div>{{end}}content{{if .X}}</div>{{end}}');
  assert.equal(diags.length, 0, diags.map((d) => d.message).join('; '));
});
