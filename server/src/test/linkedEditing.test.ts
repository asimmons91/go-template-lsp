import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Position } from 'vscode-languageserver/node';
import { getLanguageModes } from '../languageModes';

function makeDocument(
  uri: string,
  textWithCursor: string,
): { document: TextDocument; position: Position } {
  const cursor = textWithCursor.indexOf('|');
  assert.ok(cursor !== -1, 'text must contain the "|" cursor marker');
  const text = textWithCursor.slice(0, cursor) + textWithCursor.slice(cursor + 1);
  const document = TextDocument.create(uri, 'gotmpl', 1, text);
  return { document, position: document.positionAt(cursor) };
}

test('linked editing returns the open and close tag name ranges', () => {
  const languageModes = getLanguageModes('gopls', undefined);
  const { document, position } = makeDocument(
    'file:///a.gohtml',
    '<html><body><di|v></div></body></html>',
  );
  const result = languageModes.getModeAtPosition(document, position);
  assert.ok(result?.mode.doLinkedEditing, 'expected doLinkedEditing on the html mode');
  const linked = result.mode.doLinkedEditing(document, position, result.regions);
  assert.ok(linked, 'expected linked editing ranges');
  assert.equal(linked.ranges.length, 2);
  assert.equal(document.getText(linked.ranges[0]), 'div');
  assert.equal(document.getText(linked.ranges[1]), 'div');
});

test('linked editing works from the closing tag name', () => {
  const languageModes = getLanguageModes('gopls', undefined);
  const { document, position } = makeDocument(
    'file:///b.gohtml',
    '<html><body><div></di|v></body></html>',
  );
  const result = languageModes.getModeAtPosition(document, position);
  assert.ok(result?.mode.doLinkedEditing);
  const linked = result.mode.doLinkedEditing(document, position, result.regions);
  assert.ok(linked, 'expected linked editing ranges');
  assert.equal(linked.ranges.length, 2);
  assert.equal(document.getText(linked.ranges[0]), 'div');
  assert.equal(document.getText(linked.ranges[1]), 'div');
});

test('linked editing returns null for void elements', () => {
  const languageModes = getLanguageModes('gopls', undefined);
  const { document, position } = makeDocument(
    'file:///c.gohtml',
    '<html><body><b|r></body></html>',
  );
  const result = languageModes.getModeAtPosition(document, position);
  assert.ok(result?.mode.doLinkedEditing);
  assert.equal(result.mode.doLinkedEditing(document, position, result.regions), null);
});

test('linked editing does not apply inside a {{ }} action', () => {
  const languageModes = getLanguageModes('gopls', undefined);
  const { document, position } = makeDocument(
    'file:///d.gohtml',
    '<html><body>{{ .Na|me }}</body></html>',
  );
  const result = languageModes.getModeAtPosition(document, position);
  assert.equal(result?.mode.getId(), 'gotemplate');
  assert.equal(result?.mode.doLinkedEditing, undefined);
});
