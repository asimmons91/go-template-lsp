import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Position } from 'vscode-languageserver/node';
import { getLanguageModes } from '../languageModes';

function makeDocument(uri: string, textWithCursor: string): { document: TextDocument; position: Position } {
  const cursor = textWithCursor.indexOf('|');
  const text = textWithCursor.slice(0, cursor) + textWithCursor.slice(cursor + 1);
  const document = TextDocument.create(uri, 'gotmpl', 1, text);
  return { document, position: document.positionAt(cursor) };
}

test('tag complete inserts closing tag after typing ">"', () => {
  const languageModes = getLanguageModes('gopls', undefined);
  const { document, position } = makeDocument('file:///a.gohtml', '<html><body><p>|</body></html>');
  assert.equal(languageModes.doTagComplete(document, position), '$0</p>');
});

test('tag complete ignores void elements', () => {
  const languageModes = getLanguageModes('gopls', undefined);
  const { document, position } = makeDocument('file:///b.gohtml', '<html><body><br>|</body></html>');
  assert.equal(languageModes.doTagComplete(document, position), null);
});

test('tag complete completes closing tag name after typing "/"', () => {
  const languageModes = getLanguageModes('gopls', undefined);
  const { document, position } = makeDocument('file:///c.gohtml', '<html><body><div></div></|</body></html>');
  assert.equal(languageModes.doTagComplete(document, position), 'body>');
});

test('tag complete does nothing inside a {{ }} action', () => {
  const languageModes = getLanguageModes('gopls', undefined);
  const { document, position } = makeDocument('file:///d.gohtml', '<html><body>{{ i|f .X }}</body></html>');
  assert.equal(languageModes.doTagComplete(document, position), null);
});
