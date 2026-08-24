import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import { buildSyntheticCompletion } from '../transpiler';

const gotype = { importPath: 'example.com/gotypefixture/model', typeName: 'User' };
const fixtureUri = `file://${path.join(__dirname, '..', '..', '..', 'fixtures', 'gotype-fixture', 'views', 'page.gohtml')}`;

test('builds a synthetic file for a partial field expression', () => {
  const target = buildSyntheticCompletion({ documentUri: fixtureUri, gotype, fieldExpr: '.N' });
  assert.ok(target);
  assert.equal(target!.uri, `${fixtureUri}.gotmpl_completion.go`);
  assert.match(target!.goSource, /^package views\n/);
  assert.match(target!.goSource, /import gotmpl0 "example\.com\/gotypefixture\/model"/);
  assert.match(target!.goSource, /var dot gotmpl0\.User/);
  assert.match(target!.goSource, /_ = dot\.N\n}\n$/);
  assert.equal(target!.goSource.slice(0, target!.offset).endsWith('dot.N'), true);
});

test('builds a synthetic file for an empty field expression (just the dot)', () => {
  const target = buildSyntheticCompletion({ documentUri: fixtureUri, gotype, fieldExpr: '.' });
  assert.ok(target);
  assert.match(target!.goSource, /_ = dot\.\n}\n$/);
});

test('rejects a chained/nested field expression (out of M3 scope)', () => {
  const target = buildSyntheticCompletion({ documentUri: fixtureUri, gotype, fieldExpr: '.Foo.Bar' });
  assert.equal(target, undefined);
});

test('rejects an expression that does not start with a dot', () => {
  const target = buildSyntheticCompletion({ documentUri: fixtureUri, gotype, fieldExpr: 'Foo' });
  assert.equal(target, undefined);
});
