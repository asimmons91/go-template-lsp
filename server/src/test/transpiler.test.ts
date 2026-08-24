import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { transpileTemplate } from '../transpiler';
import { FuncMapEntry } from '../funcmap/funcMapIndex';

const gotype = { importPath: 'example.com/gotypefixture/model', typeName: 'User' };
const uri = 'file:///tmp/project/views/page.gohtml';

const upperEntry: FuncMapEntry = {
  name: 'upper',
  params: [{ name: 's', type: 'string' }],
  results: ['string'],
  variadic: false
};
const funcMapWithUpper: ReadonlyMap<string, FuncMapEntry> = new Map([['upper', upperEntry]]);

test('transpiles a nested field chain verbatim', () => {
  const { goSource } = transpileTemplate(uri, '{{ .Address.ZipCode }}', gotype);
  assert.match(goSource, /_ = dot\.Address\.ZipCode\n/);
});

test('narrows dot inside a range to the loop element', () => {
  const { goSource } = transpileTemplate(uri, '{{range .Items}}{{ .Title }}{{end}}', gotype);
  assert.match(goSource, /for _, it0 := range dot\.Items \{/);
  assert.match(goSource, /_ = it0\.Title\n/);
});

test('binds range index and element variables', () => {
  const { goSource } = transpileTemplate(uri, '{{range $i, $v := .Items}}{{ $v.Title }}{{end}}', gotype);
  assert.match(goSource, /for i\d+, it\d+ := range dot\.Items \{/);
  assert.match(goSource, /_ = it\d+\.Title\n/);
});

test('rebinds dot inside a with block', () => {
  const { goSource } = transpileTemplate(uri, '{{with .Address}}{{ .City }}{{end}}', gotype);
  assert.match(goSource, /w0 := dot\.Address/);
  assert.match(goSource, /_ = w0\.City\n/);
});

test('with $var binds the variable but leaves dot unchanged', () => {
  const { goSource } = transpileTemplate(uri, '{{with $a := .Address}}{{ $a.City }}{{ .Name }}{{end}}', gotype);
  assert.match(goSource, /w0 := dot\.Address/);
  assert.match(goSource, /_ = w0\.City\n/);
  assert.match(goSource, /_ = dot\.Name\n/);
});

test('declares and references a $var', () => {
  const { goSource } = transpileTemplate(uri, '{{ $x := .Address }}{{ $x.City }}', gotype);
  assert.match(goSource, /v_x := dot\.Address/);
  assert.match(goSource, /_ = v_x\.City\n/);
});

test('auto-closes an unclosed range so the generated Go is balanced', () => {
  const { goSource } = transpileTemplate(uri, '{{range .Items}}{{ .Title }}', gotype);
  assert.match(goSource, /for _, it0 := range dot\.Items \{/);
  const opens = (goSource.match(/\{/g) ?? []).length;
  const closes = (goSource.match(/\}/g) ?? []).length;
  assert.equal(opens, closes);
});

test('nested range narrows dot at each level', () => {
  const { goSource } = transpileTemplate(uri, '{{range .Items}}{{range .Items}}{{ .Title }}{{end}}{{end}}', gotype);
  assert.match(goSource, /for _, it0 := range dot\.Items \{/);
  assert.match(goSource, /for _, it1 := range it0\.Items \{/);
  assert.match(goSource, /_ = it1\.Title\n/);
});

test('maps a cursor inside a range body to the generated Go offset', () => {
  const text = '{{range .Items}}<p>{{ .Ti }}</p>{{end}}';
  const cursor = text.indexOf('.Ti') + 3;
  const { goSource, mapOffset } = transpileTemplate(uri, text, gotype);
  const goOffset = mapOffset(cursor);
  assert.ok(goOffset >= 0);
  assert.equal(goSource.slice(0, goOffset).endsWith('it0.Ti'), true);
});

test('maps a nested field-chain cursor', () => {
  const text = '{{ .Address.Zi }}';
  const cursor = text.indexOf('.Zi') + 3;
  const { goSource, mapOffset } = transpileTemplate(uri, text, gotype);
  assert.equal(goSource.slice(0, mapOffset(cursor)).endsWith('dot.Address.Zi'), true);
});

test('returns -1 for an offset in template text', () => {
  const text = '<p>{{ .Name }}</p>';
  const { mapOffset } = transpileTemplate(uri, text, gotype);
  assert.equal(mapOffset(text.indexOf('<p>')), -1);
});

test('maps a lone dot to the end of the dot variable', () => {
  const text = '{{ . }}';
  const cursor = text.indexOf('.') + 1;
  const { goSource, mapOffset } = transpileTemplate(uri, text, gotype);
  assert.equal(goSource.slice(0, mapOffset(cursor)).endsWith('dot.'), true);
});

test('rewrites a function call to a Go call', () => {
  const { goSource } = transpileTemplate(uri, '{{ upper .Name }}', gotype, funcMapWithUpper);
  assert.match(goSource, /_ = upper\(dot\.Name\)\n/);
});

test('folds a pipe into a nested call', () => {
  const { goSource } = transpileTemplate(uri, '{{ .Name | upper }}', gotype, funcMapWithUpper);
  assert.match(goSource, /_ = upper\(dot\.Name\)\n/);
});

test('folds multiple pipes right-to-left', () => {
  const { goSource } = transpileTemplate(uri, '{{ .Name | upper | upper }}', gotype, funcMapWithUpper);
  assert.match(goSource, /_ = upper\(upper\(dot\.Name\)\)\n/);
});

test('emits synthetic declarations for funcMap entries', () => {
  const { goSource } = transpileTemplate(uri, '{{ .Name }}', gotype, funcMapWithUpper);
  assert.match(goSource, /func upper\(s string\) string \{ panic\("gotmpl"\) \}/);
});

test('skips synthetic declarations for Go predeclared names', () => {
  const lenEntry: FuncMapEntry = {
    name: 'len',
    params: [{ name: 'v', type: 'interface{}' }],
    results: ['int'],
    variadic: false
  };
  const { goSource } = transpileTemplate(uri, '{{ .Name }}', gotype, new Map([['len', lenEntry]]));
  assert.doesNotMatch(goSource, /func len\(/);
});

test('maps a cursor inside a call argument', () => {
  const text = '{{ upper .N }}';
  const cursor = text.indexOf('.N') + 2;
  const { goSource, mapOffset } = transpileTemplate(uri, text, gotype, funcMapWithUpper);
  assert.ok(mapOffset(cursor) >= 0);
  assert.equal(goSource.slice(0, mapOffset(cursor)).endsWith('upper(dot.N'), true);
});

test('rewrites a $var argument inside a call', () => {
  const { goSource } = transpileTemplate(uri, '{{ $x := .Name }}{{ upper $x }}', gotype, funcMapWithUpper);
  assert.match(goSource, /_ = upper\(v_x\)\n/);
});
