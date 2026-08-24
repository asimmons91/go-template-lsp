import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseGotypeComment } from '../gotype';

test('parses a gotype comment with trim markers', () => {
  const result = parseGotypeComment(
    '{{- /* gotype: example.com/gotypefixture/model.User */ -}}\n<p></p>',
  );
  assert.deepEqual(result, { importPath: 'example.com/gotypefixture/model', typeName: 'User' });
});

test('parses a gotype comment without trim markers', () => {
  const result = parseGotypeComment('{{/* gotype: pkg/path.Widget */}}');
  assert.deepEqual(result, { importPath: 'pkg/path', typeName: 'Widget' });
});

test('returns undefined when no gotype comment is present', () => {
  assert.equal(parseGotypeComment('<html>{{ .Foo }}</html>'), undefined);
});

test('returns undefined for a malformed reference with no type name', () => {
  assert.equal(
    parseGotypeComment('{{- /* gotype: example.com/gotypefixture/model */ -}}'),
    undefined,
  );
});
