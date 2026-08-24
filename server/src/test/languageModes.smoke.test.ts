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

test('html tag completion outside any embedded region', () => {
  const languageModes = getLanguageModes();
  const { document, position } = makeDocument('file:///a.gohtml', '<html><body><d|</body></html>');

  const result = languageModes.getModeAtPosition(document, position);
  assert.ok(result, 'expected a language mode to be resolved');

  const list = result!.mode.doComplete(document, position, result!.regions);
  const labels = list.items.map((item) => item.label);
  assert.ok(labels.includes('div'), `expected 'div' among HTML tag completions, got: ${labels.join(', ')}`);
});

test('css property completion inside <style>', () => {
  const languageModes = getLanguageModes();
  const { document, position } = makeDocument(
    'file:///b.gohtml',
    '<html><head><style>.card { co| }</style></head><body></body></html>'
  );

  const result = languageModes.getModeAtPosition(document, position);
  assert.ok(result, 'expected a language mode to be resolved');

  const list = result!.mode.doComplete(document, position, result!.regions);
  const labels = list.items.map((item) => item.label);
  assert.ok(labels.includes('color'), `expected 'color' among CSS completions, got: ${labels.join(', ')}`);
});

test('js member completion inside <script>', () => {
  const languageModes = getLanguageModes();
  const { document, position } = makeDocument(
    'file:///c.gohtml',
    '<html><body><script>console.l|</script></body></html>'
  );

  const result = languageModes.getModeAtPosition(document, position);
  assert.ok(result, 'expected a language mode to be resolved');

  const list = result!.mode.doComplete(document, position, result!.regions);
  const labels = list.items.map((item) => item.label);
  assert.ok(labels.includes('log'), `expected 'log' among JS completions, got: ${labels.join(', ')}`);
});
