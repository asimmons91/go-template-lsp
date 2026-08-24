import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  annotateUnresolvedFields,
  buildSemanticTokens,
  SemanticToken,
  tokenize,
} from '../semanticTokens';

function tokens(text: string): Array<{ type: string; value: string; modifiers: string[] }> {
  return tokenize(text).map((t) => ({
    type: t.type,
    value: text.slice(t.offset, t.offset + t.length),
    modifiers: t.modifiers,
  }));
}

test('classifies control keywords, fields, and strings', () => {
  assert.deepEqual(tokens('{{if .Items}}'), [
    { type: 'keyword', value: 'if', modifiers: [] },
    { type: 'property', value: 'Items', modifiers: [] },
  ]);
});

test('classifies variable declaration, operator, builtin call, and field', () => {
  assert.deepEqual(tokens('{{ $x := index .List 0 }}'), [
    { type: 'variable', value: '$x', modifiers: ['declaration'] },
    { type: 'operator', value: ':=', modifiers: [] },
    { type: 'function', value: 'index', modifiers: [] },
    { type: 'property', value: 'List', modifiers: [] },
  ]);
});

test('classifies function call with string and field arguments', () => {
  assert.deepEqual(tokens('{{printf "%s" .Name}}'), [
    { type: 'function', value: 'printf', modifiers: [] },
    { type: 'string', value: '"%s"', modifiers: [] },
    { type: 'property', value: 'Name', modifiers: [] },
  ]);
});

test('marks range loop variables as declarations', () => {
  assert.deepEqual(tokens('{{range $i, $v := .Items}}'), [
    { type: 'keyword', value: 'range', modifiers: [] },
    { type: 'variable', value: '$i', modifiers: ['declaration'] },
    { type: 'variable', value: '$v', modifiers: ['declaration'] },
    { type: 'operator', value: ':=', modifiers: [] },
    { type: 'property', value: 'Items', modifiers: [] },
  ]);
});

test('classifies nested field selectors separately', () => {
  assert.deepEqual(tokens('{{ .A.B }}'), [
    { type: 'property', value: 'A', modifiers: [] },
    { type: 'property', value: 'B', modifiers: [] },
  ]);
});

test('classifies comments and closing keywords', () => {
  assert.deepEqual(tokens('{{/* gotype: x */}}{{end}}'), [
    { type: 'comment', value: '{{/* gotype: x */}}', modifiers: [] },
    { type: 'keyword', value: 'end', modifiers: [] },
  ]);
});

test('does not emit property/string tokens inside string literals', () => {
  assert.deepEqual(tokens('{{ printf ".NotField" }}'), [
    { type: 'function', value: 'printf', modifiers: [] },
    { type: 'string', value: '".NotField"', modifiers: [] },
  ]);
});

test('annotates unresolved fields via the resolver', async () => {
  const text = '{{ .Known .Missing }}';
  const list: SemanticToken[] = tokenize(text);
  await annotateUnresolvedFields(list, (_offset, name) => Promise.resolve(name === 'Known'));
  const properties = list.filter((t) => t.type === 'property');
  assert.equal(properties.length, 2);
  assert.deepEqual(properties[0].modifiers, []);
  assert.deepEqual(properties[1].modifiers, ['unresolved']);
});

test('buildSemanticTokens encodes one uint32 quintet per token', () => {
  const text = '{{if .Items}}{{end}}';
  const document = TextDocument.create('file:///a.gotmpl', 'gotmpl', 1, text);
  const list = tokenize(text);
  const result = buildSemanticTokens(list, document);
  assert.equal(result.data.length, list.length * 5);
});
