import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseTemplate, TemplateNode } from '../templateParser';

function single(text: string): TemplateNode {
  const nodes = parseTemplate(text);
  assert.equal(nodes.length, 1, `expected one top-level node, got ${nodes.length}`);
  return nodes[0];
}

test('parses a range with its body', () => {
  const node = single('{{range .Items}}{{ .Title }}{{end}}');
  assert.equal(node.kind, 'range');
  if (node.kind !== 'range') return;
  assert.equal(node.pipeline, '.Items');
  assert.equal(node.body.length, 1);
  assert.equal(node.body[0].kind, 'action');
});

test('parses a with block and records its pipeline', () => {
  const node = single('{{with .Address}}{{ .City }}{{end}}');
  assert.equal(node.kind, 'with');
  if (node.kind !== 'with') return;
  assert.equal(node.pipeline, '.Address');
  assert.equal(node.body.length, 1);
});

test('parses if/else branches', () => {
  const node = single('{{if .A}}{{ .B }}{{else}}{{ .C }}{{end}}');
  assert.equal(node.kind, 'if');
  if (node.kind !== 'if') return;
  assert.equal(node.pipeline, '.A');
  assert.equal(node.body.length, 1);
  assert.equal(node.elseBody?.length, 1);
});

test('parses else-if as a nested if', () => {
  const node = single('{{if .A}}{{ .B }}{{else if .C}}{{ .D }}{{end}}');
  assert.equal(node.kind, 'if');
  if (node.kind !== 'if') return;
  assert.equal(node.elseBody?.length, 1);
  assert.equal(node.elseBody?.[0].kind, 'if');
});

test('parses a range nested inside an if', () => {
  const node = single('{{if .A}}{{range .Items}}{{ .T }}{{end}}{{end}}');
  assert.equal(node.kind, 'if');
  if (node.kind !== 'if') return;
  assert.equal(node.body[0].kind, 'range');
});

test('auto-closes an unclosed range at EOF', () => {
  const node = single('{{range .Items}}{{ .T }}');
  assert.equal(node.kind, 'range');
  if (node.kind !== 'range') return;
  assert.equal(node.body[0].kind, 'action');
});

test('classifies a $var declaration', () => {
  const node = single('{{ $x := .Name }}');
  assert.equal(node.kind, 'var');
  if (node.kind !== 'var') return;
  assert.equal(node.name, '$x');
  assert.equal(node.assign, 'define');
  assert.equal(node.pipeline, '.Name');
});

test('classifies a $var reassignment', () => {
  const node = single('{{ $x = .Name }}');
  assert.equal(node.kind, 'var');
  if (node.kind !== 'var') return;
  assert.equal(node.assign, 'assign');
});

test('parses range with index and element variables', () => {
  const node = single('{{range $i, $v := .Items}}{{ $v }}{{end}}');
  assert.equal(node.kind, 'range');
  if (node.kind !== 'range') return;
  assert.deepEqual(node.vars, ['$i', '$v']);
});

test('parses with $var binding', () => {
  const node = single('{{with $x := .Address}}{{ $x }}{{end}}');
  assert.equal(node.kind, 'with');
  if (node.kind !== 'with') return;
  assert.equal(node.var, '$x');
  assert.equal(node.pipeline, '.Address');
});

test('consumes define/block bodies structurally without surfacing them', () => {
  const nodes = parseTemplate('{{define "x"}}{{ .A }}{{end}}{{ .B }}');
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, 'action');
  if (nodes[0].kind !== 'action') return;
  assert.equal(nodes[0].pipeline, '.B');
});

test('skips the gotype header comment', () => {
  const node = single('{{- /* gotype: a/b.T */ -}}{{ .N }}');
  assert.equal(node.kind, 'action');
  if (node.kind !== 'action') return;
  assert.equal(node.pipeline, '.N');
});

test('records pipeline offsets for cursor mapping', () => {
  const text = '{{ .Name }}';
  const node = single(text);
  assert.equal(node.kind, 'action');
  if (node.kind !== 'action') return;
  assert.equal(node.pipeStart, text.indexOf('.Name'));
  assert.equal(node.pipeEnd, text.indexOf('.Name') + '.Name'.length);
});
