import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { formatDocument } from '../formatting';

async function format(source: string, tabSize = 2): Promise<string | null> {
  const document = TextDocument.create('file:///a.gotmpl', 'gotmpl', 1, source);
  const edits = await formatDocument(document, { tabSize, insertSpaces: true });
  return edits ? edits[0].newText : null;
}

test('indents nested template blocks and the HTML they wrap', async () => {
  const out = await format(
    '<html>\n<body>\n{{if .Items}}\n<ul>\n{{range .Items}}\n<li>{{.Title}}</li>\n{{end}}\n</ul>\n{{end}}\n</body>\n</html>',
  );
  assert.equal(
    out,
    '<html>\n' +
      '  <body>\n' +
      '    {{if .Items}}\n' +
      '      <ul>\n' +
      '        {{range .Items}}\n' +
      '          <li>{{.Title}}</li>\n' +
      '        {{end}}\n' +
      '      </ul>\n' +
      '    {{end}}\n' +
      '  </body>\n' +
      '</html>\n',
  );
});

test('keeps inline actions inline within flowing text', async () => {
  assert.equal(await format('<p>Hello {{.Name}}!</p>'), '<p>Hello {{.Name}}!</p>\n');
});

test('preserves actions inside attribute values', async () => {
  assert.equal(await format('<a href="{{.Url}}">link</a>'), '<a href="{{.Url}}">link</a>\n');
});

test('indents {{define}} block bodies', async () => {
  assert.equal(
    await format('{{define "x"}}\n<div>{{.A}}</div>\n{{end}}'),
    '{{define "x"}}\n  <div>{{.A}}</div>\n{{end}}\n',
  );
});

test('is idempotent on already-formatted source', async () => {
  const formatted =
    '<html>\n  <body>\n    {{if .Items}}\n      <ul>\n        {{range .Items}}\n' +
    '          <li>{{.Title}}</li>\n        {{end}}\n      </ul>\n    {{end}}\n' +
    '  </body>\n</html>\n';
  assert.equal(await format(formatted), null);
});

test('uses configured tab size', async () => {
  const out = await format('{{if .X}}\n<p>x</p>\n{{end}}', 4);
  assert.equal(out, '{{if .X}}\n    <p>x</p>\n{{end}}\n');
});

test('returns null for a source with no changes', async () => {
  assert.equal(await format('<p>already formatted</p>\n'), null);
});
