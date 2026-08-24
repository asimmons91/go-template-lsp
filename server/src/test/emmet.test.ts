import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CompletionList, Position } from 'vscode-languageserver/node';
import { getLanguageModes } from '../languageModes';

function makeDocument(
  uri: string,
  textWithCursor: string,
): { document: TextDocument; position: Position } {
  const cursor = textWithCursor.indexOf('|');
  const text = textWithCursor.slice(0, cursor) + textWithCursor.slice(cursor + 1);
  const document = TextDocument.create(uri, 'gotmpl', 1, text);
  return { document, position: document.positionAt(cursor) };
}

function completeAt(
  languageModes: ReturnType<typeof getLanguageModes>,
  document: TextDocument,
  position: Position,
): CompletionList {
  const mode = languageModes.getModeAtPosition(document, position);
  assert.ok(mode, 'expected a language mode at the position');
  const result = mode.mode.doComplete(document, position, mode.regions);
  return result instanceof Promise ? (result as unknown as CompletionList) : result;
}

test('emmet completion items appear in the HTML body', () => {
  const languageModes = getLanguageModes('gopls', undefined);
  const { document, position } = makeDocument('file:///a.gohtml', 'ul>li|');
  assert.equal(languageModes.getModeAtPosition(document, position)?.mode.getId(), 'html');
  const list = completeAt(languageModes, document, position);
  assert.ok(list.items.some((i) => i.detail === 'Emmet Abbreviation'));
  assert.ok(list.items.some((i) => i.label.includes('ul>li')));
});

test('emmet completion items do not appear inside a {{ }} action', () => {
  const languageModes = getLanguageModes('gopls', undefined);
  const { document, position } = makeDocument('file:///b.gohtml', '{{ ul>li| }}');
  assert.equal(languageModes.getModeAtPosition(document, position)?.mode.getId(), 'gotemplate');
});

test('emmet expansion returns a snippet outside an action', () => {
  const languageModes = getLanguageModes('gopls', undefined);
  const { document, position } = makeDocument('file:///c.gohtml', '<div>ul>li|</div>');
  const result = languageModes.doEmmetExpand(document, position);
  assert.ok(result);
  assert.ok(result.snippet.includes('<ul>'));
  assert.ok(result.snippet.includes('<li>'));
});

test('emmet expansion returns null inside a {{ }} action', () => {
  const languageModes = getLanguageModes('gopls', undefined);
  const { document, position } = makeDocument('file:///d.gohtml', '{{ .Na|me }}');
  assert.equal(languageModes.doEmmetExpand(document, position), null);
});

test('emmet expansion uses CSS syntax inside a <style> block', () => {
  const languageModes = getLanguageModes('gopls', undefined);
  const { document, position } = makeDocument('file:///e.gohtml', '<style>m10|</style>');
  assert.equal(languageModes.getModeAtPosition(document, position)?.mode.getId(), 'css');
  const result = languageModes.doEmmetExpand(document, position);
  assert.ok(result);
  assert.ok(result.snippet.includes('margin'));
});
