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
  assert.ok(
    diags.some((d) => d.message.includes('span')),
    diags.map((d) => d.message).join('; '),
  );
});

test('reports an unclosed tag with no conditionals', async () => {
  const diags = await diagnosticsFor('<div>hello');
  assert.ok(
    diags.some((d) => d.message.includes('div')),
    diags.map((d) => d.message).join('; '),
  );
});

test('suppresses a tag whose open/close straddle if/else branches', async () => {
  const diags = await diagnosticsFor('{{if .X}}<div>{{else}}<div>{{end}}</div>');
  assert.equal(diags.length, 0, diags.map((d) => d.message).join('; '));
});

test('suppresses the split-open pattern across separate if guards', async () => {
  const diags = await diagnosticsFor('{{if .X}}<div>{{end}}content{{if .X}}</div>{{end}}');
  assert.equal(diags.length, 0, diags.map((d) => d.message).join('; '));
});

test('flags an unclosed tag that merely contains a conditional', async () => {
  const diags = await diagnosticsFor('<div>{{if .X}}hello{{end}}');
  assert.ok(
    diags.some((d) => d.message.includes('div')),
    diags.map((d) => d.message).join('; '),
  );
});

test('flags an unclosed tag opened in an else arm with no shared close', async () => {
  const diags = await diagnosticsFor('{{if .X}}a{{else}}<div>{{end}}');
  assert.ok(
    diags.some((d) => d.message.includes('div')),
    diags.map((d) => d.message).join('; '),
  );
});

test('suppresses a duplicated range-arm open with a shared close', async () => {
  const diags = await diagnosticsFor('{{range .Items}}<li>{{else}}<li>{{end}}</li>');
  assert.equal(diags.length, 0, diags.map((d) => d.message).join('; '));
});

test('flags an unclosed tag opened after an if with no close anywhere', async () => {
  const diags = await diagnosticsFor('{{if .X}}<div>{{end}}');
  assert.ok(
    diags.some((d) => d.message.includes('div')),
    diags.map((d) => d.message).join('; '),
  );
});
