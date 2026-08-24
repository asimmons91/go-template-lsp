import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { findGotypeValueRange, findGotypeValueSpan, splitGotypeValue } from '../gotypeCompletion';

test('findGotypeValueRange locates a complete gotype value', () => {
  const text = '{{- /* gotype: example.com/gotypefixture/model.User */ -}}\n<p></p>';
  const range = findGotypeValueRange(text);
  assert.ok(range, 'expected a value range');
  assert.equal(range.value, 'example.com/gotypefixture/model.User');
  assert.equal(text.slice(range.start, range.end), 'example.com/gotypefixture/model.User');
});

test('findGotypeValueRange locates a partial, unterminated gotype value', () => {
  const text = '{{- /* gotype: example.com/gotypefixture/mo';
  const range = findGotypeValueRange(text);
  assert.ok(range, 'expected a value range for an unterminated comment');
  assert.equal(range.value, 'example.com/gotypefixture/mo');
});

test('findGotypeValueRange returns undefined without a gotype comment', () => {
  assert.equal(findGotypeValueRange('<html>{{ .Foo }}</html>'), undefined);
});

test('findGotypeValueSpan only matches when the cursor is inside the value', () => {
  const text = '{{- /* gotype: example.com/gotypefixture/model.User */ -}}';
  const start = text.indexOf('example.com');
  const inside = findGotypeValueSpan(text, start + 5);
  assert.ok(inside, 'expected a span inside the value');
  assert.equal(inside.value, 'example.com/gotypefixture/model.User');

  assert.equal(findGotypeValueSpan(text, 2), undefined);
});

test('splitGotypeValue keeps a dotted domain in the package path', () => {
  assert.deepEqual(splitGotypeValue('example.com/gotypefixture/model'), {
    packagePath: 'example.com/gotypefixture/model',
    typePrefix: '',
    hasTypeSeparator: false,
  });
});

test('splitGotypeValue splits the type name after the final slash segment', () => {
  assert.deepEqual(splitGotypeValue('example.com/gotypefixture/model.Us'), {
    packagePath: 'example.com/gotypefixture/model',
    typePrefix: 'Us',
    hasTypeSeparator: true,
  });
});

test('splitGotypeValue handles a trailing dot (empty type prefix)', () => {
  assert.deepEqual(splitGotypeValue('example.com/gotypefixture/model.'), {
    packagePath: 'example.com/gotypefixture/model',
    typePrefix: '',
    hasTypeSeparator: true,
  });
});

test('splitGotypeValue supports slash-less import paths like fmt', () => {
  assert.deepEqual(splitGotypeValue('fmt.Str'), {
    packagePath: 'fmt',
    typePrefix: 'Str',
    hasTypeSeparator: true,
  });
});
